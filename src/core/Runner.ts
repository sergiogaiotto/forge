import { exec } from "node:child_process";
import * as path from "node:path";

export interface RunResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  skippedReason?: string;
}

// Comandos de execucao por extensao. {file} e substituido pelo caminho absoluto.
export const DEFAULT_RUN_COMMANDS: Record<string, string> = {
  ".py": "python {file}",
  ".ipynb": "jupyter nbconvert --to notebook --execute --inplace {file}",
  ".js": "node {file}",
  ".mjs": "node {file}",
  ".ts": "npx -y tsx {file}",
  ".sh": "bash {file}",
  ".r": "Rscript {file}",
  ".rb": "ruby {file}",
  ".go": "go run {file}",
};

export type ResolvedRun = { template: string } | { skippedReason: string };

// Decide o comando de execucao para um arquivo (funcao pura, testavel).
export function resolveRunCommand(relPath: string, commands: Record<string, string>): ResolvedRun {
  const ext = path.extname(relPath).toLowerCase();
  const tpl = commands[ext] ?? DEFAULT_RUN_COMMANDS[ext];
  if (!tpl) {
    return { skippedReason: `Tipo "${ext || "(sem extensão)"}" não tem comando de execução. Configure em forge.run.commands.` };
  }
  return { template: tpl };
}

// Monta o comando final substituindo {file} pelo caminho absoluto (citando se houver espaco).
export function buildCommand(template: string, absFile: string): string {
  return template.replace(/\{file\}/g, quote(absFile));
}

// Onde a execucao acontece: terminal central (quando ha shell integration, que da saida + exit code)
// ou painel lateral (fallback via spawn). Funcao pura para ser testavel sem o VSCode.
export function chooseRunMode(hasShellIntegration: boolean): "terminal" | "panel" {
  return hasShellIntegration ? "terminal" : "panel";
}

// Remove sequencias de escape ANSI/OSC (cores, controle e os marcadores OSC 633 da shell integration
// do VSCode) da saida capturada, para o log e o loop de auto-cura ficarem limpos.
// - CSI: ESC [ ... letra-final (cores, movimento de cursor)
// - OSC: ESC ] ... (BEL ou ESC barra-invertida); inclui o protocolo OSC 633 do VSCode
// - Fe: ESC seguido de um byte em @-Z / barra-invertida / ]-_
const ANSI_RE = new RegExp(
  "\\u001b\\[[0-9;?]*[ -/]*[@-~]" +
    "|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)" +
    "|\\u001b[@-Z\\\\\\]-_]",
  "g"
);
// Controles de 1 byte (0x00-08, 0x0b, 0x0c, 0x0e-1f, 0x7f); tab/LF/CR ficam de fora.
const CTRL_RE = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g");

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(CTRL_RE, "");
}

// Um escape ANSI no FIM da string, ainda incompleto (CSI sem letra-final, ou OSC sem terminador) —
// usado para segurar a borda entre chunks de streaming.
const PARTIAL_TAIL_RE = new RegExp("\\u001b(?:\\[[0-9;?]*[ -/]*)?$|\\u001b\\][^\\u0007\\u001b]*$");

// Maior escape parcial que seguramos entre chunks. Limita a memoria e impede que um OSC sem terminador
// (ex.: ESC]8;;url... sem o BEL/ST) engula TODA a saida seguinte: se o "parcial" passar disso, tratamos
// como nao-escape e deixamos passar (no maximo vaza um pedaco cosmetico), em vez de reter sem limite.
const MAX_PARTIAL = 256;

// Filtro ANSI COM ESTADO para saida em streaming: se um escape e cortado na borda de um chunk
// (ex.: "...ESC[3" e depois "1mRED"), o stripAnsi por-chunk deixaria o "[31m" vazar. Este filtro
// segura um escape incompleto do fim de um chunk e o completa no proximo. Use UMA instancia POR STREAM
// (stdout e stderr precisam de filtros separados — estado compartilhado cruzaria os dois).
export function makeAnsiFilter(): (chunk: string) => string {
  let pending = "";
  return (chunk: string): string => {
    const s = pending + chunk;
    const m = s.match(PARTIAL_TAIL_RE);
    if (m && m[0].length <= MAX_PARTIAL) {
      pending = m[0];
      return stripAnsi(s.slice(0, s.length - m[0].length));
    }
    pending = "";
    return stripAnsi(s);
  };
}

function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

// Executa um arquivo do workspace localmente, capturando saida e exit code para o loop de auto-cura.
// Execucao local; o egress deny-by-default continua valendo.
export class Runner {
  constructor(private readonly cwd: string | undefined) {}

  async run(relPath: string, commands: Record<string, string>, timeoutMs: number): Promise<RunResult> {
    const resolved = resolveRunCommand(relPath, commands);
    if ("skippedReason" in resolved) {
      return { command: "", ok: false, exitCode: null, output: "", durationMs: 0, skippedReason: resolved.skippedReason };
    }
    const abs = this.cwd ? path.join(this.cwd, relPath) : relPath;
    const command = buildCommand(resolved.template, abs);
    return this.runRaw(command, timeoutMs);
  }

  // Executa um comando arbitrario na raiz do workspace (ex.: a suite de testes).
  runRaw(command: string, timeoutMs: number): Promise<RunResult> {
    const started = Date.now();
    // No Windows o console usa cp1252 por padrao: o Python emitiria acentos em cp1252 e o Node,
    // decodificando como UTF-8, mostraria mojibake (emojis chegariam a causar UnicodeEncodeError).
    // Forcamos a saida do processo em UTF-8 e a capturamos como UTF-8.
    const env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
    return new Promise<RunResult>((resolve) => {
      exec(command, { cwd: this.cwd, env, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        const durationMs = Date.now() - started;
        let output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        const code = err ? (err as NodeJS.ErrnoException).code : undefined;

        if (code === "ENOENT") {
          resolve({ command, ok: false, exitCode: null, output: "", durationMs, skippedReason: "Ferramenta não encontrada no PATH." });
          return;
        }
        const e = err as (Error & { killed?: boolean; signal?: string; code?: number | string }) | null;
        if (e?.killed && e?.signal) {
          output = (output ? output + "\n" : "") + `[execução interrompida após o tempo limite]`;
        }
        const exitCode = !err ? 0 : typeof e?.code === "number" ? e.code : 1;
        resolve({ command, ok: !err, exitCode, output: output.slice(0, 8000), durationMs });
      });
    });
  }
}
