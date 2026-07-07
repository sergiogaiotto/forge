// Execução + normalização de um processo de validação num ValidatorResult. Extraído de
// SkillValidator.runOne para ser COMPARTILHADO entre a validação por-arquivo das skills e o gate
// workspace-wide do Modo Projeto (compileall/mypy sobre a árvore inteira). Puro no mapeamento
// (classifyCheck é testável sem spawnar processo); os runners fazem o I/O.
//
// Regra de mapeamento (a mesma da SkillValidator original, mais o refinamento de timeout):
// - ENOENT (executável não está no PATH) → `skipped`: a ferramenta não existe aqui; NUNCA bloqueia.
// - processo morto por timeout (killed/signal) → `skipped`: um run INCONCLUSIVO não pode reprovar
//   (senão um linter que trava viraria um bloqueio falso). Degradação segura.
// - saída != 0 (a ferramenta rodou e reprovou) → `failed`.
// - saída 0 → `ok`.
import { exec, execFile } from "node:child_process";
import { ValidatorResult } from "../shared/protocol";

const DEFAULT_OUTPUT_CAP = 4000;

export interface CheckSpec {
  id: string;
  label: string;
  gate: boolean;
}

// Mapeia o resultado bruto de um processo (err/stdout/stderr) para um ValidatorResult normalizado.
// Sem I/O — testável diretamente com um `err` sintético. `outputCap` limita a saída guardada: o padrão
// (4000) serve à SkillValidator; o gate do projeto pede um teto maior para não truncar a atribuição
// por-arquivo quando MUITOS arquivos falham (perder atribuição só SUB-bloquearia — nunca falso-bloqueia).
export function classifyCheck(
  spec: CheckSpec,
  err: (Error & { code?: string | number | null; killed?: boolean; signal?: string | null }) | null,
  stdout: string,
  stderr: string,
  outputCap = DEFAULT_OUTPUT_CAP
): ValidatorResult {
  const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
  if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
    return { id: spec.id, label: spec.label, status: "skipped", gate: spec.gate, output: "", reason: "ferramenta não disponível no PATH" };
  }
  // Timeout: o processo foi morto antes de terminar (execFile/exec com { timeout }). O veredito é
  // desconhecido — advisory, não reprova. `killed` é o sinal confiável; `signal` cobre o resto.
  if (err && (err.killed === true || (typeof err.signal === "string" && err.signal))) {
    return { id: spec.id, label: spec.label, status: "skipped", gate: spec.gate, output: output.slice(0, outputCap), reason: "tempo esgotado (inconclusivo)" };
  }
  const failed = !!err;
  return { id: spec.id, label: spec.label, status: failed ? "failed" : "ok", gate: spec.gate, output: output.slice(0, outputCap) };
}

// Runner via SHELL (cmd.exe / sh -c): a skill descreve o comando com `{file}` já substituído. Mantém o
// comportamento histórico da SkillValidator (que resolve a config do projeto via cwd).
export function runShellCheck(spec: CheckSpec, command: string, opts: { cwd?: string; timeoutMs: number }): Promise<ValidatorResult> {
  return new Promise((resolve) => {
    exec(command, { cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true }, (err, stdout, stderr) => resolve(classifyCheck(spec, err, stdout, stderr)));
  });
}

// Runner via EXECFILE (sem shell): invoca o binário direto, para que um executável ausente produza
// ENOENT de verdade (cross-plataforma) — o shell mascararia isso com um código de saída genérico. É o
// runner do gate workspace-wide (python -m compileall / -m mypy). maxBuffer alto: a saída do mypy sobre
// a árvore inteira pode ser grande.
export function runFileCheck(
  spec: CheckSpec,
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; outputCap?: number }
): Promise<ValidatorResult> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: opts.env }, (err, stdout, stderr) =>
        resolve(classifyCheck(spec, err, stdout, stderr, opts.outputCap))
      );
    } catch (err) {
      // execFile pode LANÇAR de forma SÍNCRONA (ex.: `spawn EINVAL` ao tentar um .cmd/.bat no Windows —
      // endurecimento da CVE-2024-27980), o que REJEITARIA esta Promise e derrubaria o chamador. Trata como
      // ferramenta INDISPONÍVEL (skipped, nunca reprova/rejeita) — degradação segura. Achado da revisão do gate TS.
      resolve({ id: spec.id, label: spec.label, status: "skipped", gate: spec.gate, output: "", reason: "não pôde executar (spawn)" });
    }
  });
}
