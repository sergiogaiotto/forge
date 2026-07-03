import { ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { ExtToWebview } from "../shared/protocol";
import { resolvePythonRunCommand } from "../util/pythonEnv";
import { buildCommand, chooseRunMode, makeAnsiFilter, resolveRunCommand } from "./Runner";

const TERMINAL_NAME = "FORGE · Run";
const ETX = String.fromCharCode(3); // Ctrl+C — interrompe a execucao no terminal
const SI_WAIT_MS = 3000; // espera a shell integration ativar antes de cair no spawn neste run
const SI_MAX_MISSES = 3; // apos N misses seguidos, desiste do terminal de vez (shell sem SI)
const FORCE_FINISH_MS = 2500; // apos cancelar/timeout no terminal, finaliza o cartao mesmo sem o end-event
const OUTPUT_CAP = 8000; // cauda da saida enviada ao resultado e ao loop de auto-cura
const MEM_CAP = 200_000; // limite de memoria do buffer de saida durante o streaming

export interface RunServiceDeps {
  post: (msg: ExtToWebview) => void;
  workspaceRoot: () => string | undefined;
  runConfig: () => { enabled: boolean; commands: Record<string, string>; timeoutSeconds: number };
  onResult?: (r: { filePath: string; label?: string; ok: boolean; exitCode: number | null; durationMs: number }) => void;
  openPreview?: (relPath: string) => void; // artefatos renderáveis (.html/.svg) abrem no PreviewService
  // Interpretador Python do venv do projeto (findVenvPython), quando existe. O "Executar" de .py usa
  // este interpretador em vez do python do PATH — o mesmo ambiente do "Preparar ambiente"/"Testes".
  venvPython?: () => string | undefined;
}

interface FinishData {
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  cancelled: boolean;
  timedOut: boolean;
  skippedReason?: string;
}

// Executa um arquivo do workspace e transmite o ciclo de vida (run/start -> run/output -> run/result)
// para a webview. Roda no TERMINAL integrado quando ha shell integration (saida + exit code capturados
// e visiveis na area central); senao, faz spawn e transmite a saida para o cartao lateral.
//
// Apenas UMA execucao por vez: o terminal "FORGE · Run" e compartilhado, entao serializamos os runs
// (uma flag `busy` sincrona impede colisao e a corrida check-then-act). Cancelamento/timeout matam a
// ARVORE de processos (taskkill /T no Windows, kill do grupo no POSIX) e SEMPRE emitem um run/result
// (o botao nunca fica preso em "Executando...").
export class RunService implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private siUnavailable = false; // shell integration nao ativa neste shell — vai direto ao spawn
  private siMisses = 0;
  private busy = false; // ha uma execucao em andamento (serializa o terminal compartilhado)
  private activeRunId: string | undefined;
  private activeCancel: (() => void) | undefined;
  private seq = 0;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly deps: RunServiceDeps) {
    this.subs.push(
      vscode.window.onDidCloseTerminal((t) => {
        if (t === this.terminal) this.terminal = undefined;
      })
    );
  }

  dispose(): void {
    this.terminal?.dispose();
    this.subs.forEach((d) => d.dispose());
  }

  isBusy(): boolean {
    return this.busy;
  }

  cancel(runId: string): void {
    if (this.activeRunId === runId) this.activeCancel?.();
  }

  focusTerminal(): void {
    this.terminal?.show(false);
  }

  async runFile(relPath: string, proposalId?: string): Promise<void> {
    const cfg = this.deps.runConfig();
    if (!cfg.enabled) return this.notice("warn", "Execução desabilitada (forge.run.enabled = false).");
    const ws = this.deps.workspaceRoot();
    if (!ws) return this.notice("error", "Abra uma pasta no VSCode para executar.");
    // Guarda síncrona (antes de qualquer await) — serializa o terminal compartilhado e fecha a corrida.
    if (this.busy) return this.notice("info", "Já há uma execução em andamento. Aguarde ou cancele.");
    this.busy = true;
    const runId = `run_${++this.seq}`;
    this.activeRunId = runId;
    this.activeCancel = undefined;

    try {
      const resolved = resolveRunCommand(relPath, cfg.commands);
      // Artefato renderável (.html/.svg): abre no preview em vez de rodar como processo.
      if ("renderable" in resolved && this.deps.openPreview) {
        this.deps.openPreview(relPath);
        return;
      }
      if ("skippedReason" in resolved || "renderable" in resolved) {
        const reason = "skippedReason" in resolved ? resolved.skippedReason : `Artefato "${resolved.ext}" se visualiza — use "Visualizar".`;
        this.deps.post({ type: "run/result", runId, proposalId, filePath: relPath, command: "", ok: false, exitCode: null, output: "", durationMs: 0, skippedReason: reason });
        return;
      }
      const abs = path.join(ws, relPath);
      // Reescreve `python {file}` para o interpretador do venv (ambiente preparado). Se o caminho
      // precisou de aspas (espaços), força o spawn: no terminal integrado o shell pode ser PowerShell,
      // que não invoca executável por string entre aspas sem `&` — cmd.exe/sh (spawn) aceitam.
      const command = resolvePythonRunCommand(buildCommand(resolved.template, abs), this.deps.venvPython?.());
      const timeoutMs = Math.max(1000, cfg.timeoutSeconds * 1000);
      const forceSpawn = command.startsWith('"');

      const { term, si } = forceSpawn ? { term: undefined, si: undefined } : await this.acquireTerminal(ws);
      const where = chooseRunMode(!!si);
      this.deps.post({ type: "run/start", runId, proposalId, filePath: relPath, command, where });

      let data: FinishData;
      try {
        data = si && term ? await this.runInTerminal(term, si, command, timeoutMs, runId) : await this.runSpawn(command, ws, timeoutMs, runId);
      } catch (e) {
        // Garante o run/result mesmo se executeCommand/show/spawn lançarem — senão o botão trava.
        data = { ok: false, exitCode: null, output: `[erro ao iniciar a execução] ${(e as Error)?.message ?? String(e)}`, durationMs: 0, cancelled: false, timedOut: false };
      }
      this.finishResult(runId, proposalId, relPath, command, data);
    } finally {
      this.busy = false;
      this.activeRunId = undefined;
      this.activeCancel = undefined;
    }
  }

  // Executa um COMANDO arbitrário (ex.: "Preparar ambiente": venv + pip install) com streaming para o
  // cartão lateral. Usa SEMPRE o spawn (cmd.exe/sh via shell:true), não o terminal integrado — assim o
  // encadeamento `&&` funciona mesmo quando o terminal do usuário é PowerShell 5.1 (que não aceita `&&`).
  // É cancelável (killTree) e serializado pela mesma flag `busy` das execuções de arquivo.
  // Devolve { started:true, ok } do comando concluído, ou { started:false } quando a execução NEM
  // COMEÇOU (guardas: run desabilitado / sem workspace / busy) — o chamador que encadeia passos
  // (ex.: instalar pytest e rodar os testes) precisa distinguir "recusou iniciar" de "rodou e
  // falhou": confundi-los gera mensagem falsa apontando para um cartão que não existe.
  async runCommand(label: string, command: string, timeoutMsOverride?: number): Promise<{ started: false } | { started: true; ok: boolean }> {
    const notStarted = { started: false as const };
    const cfg = this.deps.runConfig();
    if (!cfg.enabled) {
      this.notice("warn", "Execução desabilitada (forge.run.enabled = false).");
      return notStarted;
    }
    const ws = this.deps.workspaceRoot();
    if (!ws) {
      this.notice("error", "Abra uma pasta no VSCode.");
      return notStarted;
    }
    if (this.busy) {
      this.notice("info", "Já há uma execução em andamento. Aguarde ou cancele.");
      return notStarted;
    }
    this.busy = true;
    const runId = `run_${++this.seq}`;
    this.activeRunId = runId;
    this.activeCancel = undefined;
    try {
      // Override p/ comandos longos por natureza (ex.: "ambiente": pip install pesado > 120s do run).
      const timeoutMs = Math.max(1000, timeoutMsOverride ?? cfg.timeoutSeconds * 1000);
      this.deps.post({ type: "run/start", runId, filePath: "", label, command, where: "panel" });
      let data: FinishData;
      try {
        data = await this.runSpawn(command, ws, timeoutMs, runId);
      } catch (e) {
        data = { ok: false, exitCode: null, output: `[erro ao iniciar] ${(e as Error)?.message ?? String(e)}`, durationMs: 0, cancelled: false, timedOut: false };
      }
      this.finishResult(runId, undefined, "", command, data, label);
      return { started: true, ok: data.ok };
    } finally {
      this.busy = false;
      this.activeRunId = undefined;
      this.activeCancel = undefined;
    }
  }

  private notice(level: "info" | "warn" | "error", message: string): void {
    this.deps.post({ type: "notice", level, message });
  }

  // Reusa o terminal "FORGE · Run" (recria se o usuario o fechou) e o mantem AQUECIDO entre runs: a
  // shell integration costuma demorar para ativar no primeiro terminal, entao um miss neste run nao
  // desabilita o terminal — o proximo run provavelmente ja o encontra pronto. So apos SI_MAX_MISSES
  // seguidos concluimos que o shell nao tem SI e desistimos de vez (vai sempre ao spawn).
  private async acquireTerminal(cwd: string): Promise<{ term?: vscode.Terminal; si?: vscode.TerminalShellIntegration }> {
    if (this.siUnavailable) return {};
    if (!this.terminal || this.terminal.exitStatus !== undefined) {
      this.terminal = vscode.window.createTerminal({
        name: TERMINAL_NAME,
        cwd,
        env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        iconPath: new vscode.ThemeIcon("flame"),
      });
    }
    const term = this.terminal;
    if (term.shellIntegration) {
      this.siMisses = 0;
      return { term, si: term.shellIntegration };
    }
    const si = await new Promise<vscode.TerminalShellIntegration | undefined>((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve(undefined);
      }, SI_WAIT_MS);
      const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === term) {
          clearTimeout(timer);
          sub.dispose();
          resolve(e.shellIntegration);
        }
      });
    });
    if (si) {
      this.siMisses = 0;
      return { term, si };
    }
    this.siMisses++;
    if (this.siMisses >= SI_MAX_MISSES) {
      this.siUnavailable = true;
      this.terminal?.dispose();
      this.terminal = undefined;
    }
    return {}; // este run vai ao spawn; o terminal (se mantido) esquenta para o proximo
  }

  // Modo TERMINAL: roda via shell integration, transmite a saida (read()) e pega o exit code no
  // onDidEndTerminalShellExecution. Cancelar/timeout enviam Ctrl+C; se o processo ignorar, um timer de
  // graca finaliza o cartao assim mesmo (botao destrava). Retorna o resultado para o chamador emitir.
  private async runInTerminal(
    term: vscode.Terminal,
    si: vscode.TerminalShellIntegration,
    command: string,
    timeoutMs: number,
    runId: string
  ): Promise<FinishData> {
    term.show(true);
    const started = Date.now();
    const execution = si.executeCommand(command);
    const ansi = makeAnsiFilter();
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let output = "";
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const endSub = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.execution === execution) settle(e.exitCode ?? null);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      term.sendText(ETX);
      scheduleForce();
    }, timeoutMs);

    function settle(code: number | null): void {
      if (settled) return;
      settled = true;
      exitCode = code;
      endSub.dispose();
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolveDone();
    }
    const self = this;
    function scheduleForce(): void {
      if (forceTimer || settled) return;
      forceTimer = setTimeout(() => {
        // Ctrl+C nao encerrou a execucao a tempo: se foi cancel/timeout, descarta o terminal (hard-kill
        // do processo) — isso tambem encerra o execution.read() e desbloqueia o for-await pendente.
        // O terminal e recriado no proximo run.
        if (cancelled || timedOut) {
          term.dispose();
          self.terminal = undefined;
        }
        settle(null);
      }, FORCE_FINISH_MS);
    }

    this.activeCancel = () => {
      cancelled = true;
      term.sendText(ETX);
      term.show(false);
      scheduleForce();
    };

    void (async () => {
      try {
        for await (const chunk of execution.read()) {
          if (settled) break; // run ja finalizou (cancel/timeout/force) — para de transmitir
          const clean = ansi(chunk);
          if (!clean) continue;
          this.deps.post({ type: "run/output", runId, delta: clean });
          output += clean;
          if (output.length > MEM_CAP) output = output.slice(-MEM_CAP);
        }
      } catch {
        // leitura interrompida (cancelamento/Ctrl+C)
      }
      scheduleForce(); // leitura acabou; se o end-event nao veio, finaliza apos a graca
    })();

    await done;
    const ok = exitCode === 0 && !cancelled && !timedOut;
    return { ok, exitCode, output, durationMs: Date.now() - started, cancelled, timedOut };
  }

  // Modo PAINEL (fallback): spawn com a saida transmitida para o cartao lateral. Cancelar/timeout matam
  // a ARVORE de processos (o shell:true cria cmd.exe/sh como pai; child.kill() so mataria o shell).
  private runSpawn(command: string, cwd: string, timeoutMs: number, runId: string): Promise<FinishData> {
    return new Promise<FinishData>((resolve) => {
      const env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
      const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== "win32" });
      const started = Date.now();
      // Um filtro ANSI POR STREAM — stdout e stderr sao independentes; um filtro compartilhado cruzaria
      // o estado `pending` entre os dois (comendo/vazando caracteres).
      const ansiOut = makeAnsiFilter();
      const ansiErr = makeAnsiFilter();
      let output = "";
      let cancelled = false;
      let timedOut = false;
      let done = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;

      const settle = (ok: boolean, exitCode: number | null, skippedReason?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        resolve({ ok, exitCode, output, durationMs: Date.now() - started, cancelled, timedOut, skippedReason });
      };
      // Rede de seguranca: se o kill nao resultar em 'close' (processo nao morre / taskkill indisponivel),
      // finaliza assim mesmo para o botao destravar e `busy` liberar.
      const scheduleForce = () => {
        if (forceTimer || done) return;
        forceTimer = setTimeout(() => settle(false, null), FORCE_FINISH_MS);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        scheduleForce();
      }, timeoutMs);
      this.activeCancel = () => {
        cancelled = true;
        killTree(child);
        scheduleForce();
      };

      // setEncoding garante a decodificacao UTF-8 nas BORDAS dos buffers (caractere multibyte cortado).
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      const emit = (clean: string) => {
        if (done || !clean) return;
        this.deps.post({ type: "run/output", runId, delta: clean });
        output += clean;
        if (output.length > MEM_CAP) output = output.slice(-MEM_CAP);
      };
      child.stdout?.on("data", (s: string) => emit(ansiOut(s)));
      child.stderr?.on("data", (s: string) => emit(ansiErr(s)));
      child.on("error", (err) => settle(false, null, (err as NodeJS.ErrnoException).code === "ENOENT" ? "Ferramenta não encontrada no PATH." : err.message));
      child.on("close", (code) => settle(code === 0 && !cancelled && !timedOut, code));
    });
  }

  private finishResult(runId: string, proposalId: string | undefined, relPath: string, command: string, data: FinishData, label?: string): void {
    if (data.skippedReason) {
      this.deps.post({ type: "run/result", runId, proposalId, filePath: relPath, label, command, ok: false, exitCode: null, output: "", durationMs: data.durationMs, skippedReason: data.skippedReason });
      this.deps.onResult?.({ filePath: relPath, label, ok: false, exitCode: null, durationMs: data.durationMs });
      return;
    }
    const suffix = data.cancelled ? "\n[execução cancelada]" : data.timedOut ? "\n[execução interrompida após o tempo limite]" : "";
    this.deps.post({
      type: "run/result",
      runId,
      proposalId,
      filePath: relPath,
      label,
      command,
      ok: data.ok,
      exitCode: data.exitCode,
      output: data.output.slice(-OUTPUT_CAP) + suffix,
      durationMs: data.durationMs,
    });
    this.deps.onResult?.({ filePath: relPath, label, ok: data.ok, exitCode: data.exitCode, durationMs: data.durationMs });
  }
}

// Mata a arvore de processos do run. No Windows, child.kill() so atinge o cmd.exe (shell:true) e deixa
// o neto (python/node) orfao — taskkill /T /F mata a arvore. No POSIX, o spawn usou detached:true, entao
// o processo e lider de grupo e kill(-pid) mata o grupo inteiro.
function killTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    // taskkill reporta falha de lancamento de forma ASSINCRONA (evento 'error'); sem listener, um ENOENT
    // (taskkill fora do PATH / bloqueado por policy) viraria uncaughtException e derrubaria o extension
    // host. O listener degrada para child.kill() (mata ao menos o cmd.exe).
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    killer.on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // processo ja morto
      }
    }
  }
}
