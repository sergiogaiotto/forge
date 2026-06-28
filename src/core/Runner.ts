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

// Comandos de execução por extensão. {file} é substituído pelo caminho absoluto.
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

// Decide o comando de execução para um arquivo (função pura — testável).
export function resolveRunCommand(relPath: string, commands: Record<string, string>): ResolvedRun {
  const ext = path.extname(relPath).toLowerCase();
  const tpl = commands[ext] ?? DEFAULT_RUN_COMMANDS[ext];
  if (!tpl) {
    return { skippedReason: `Tipo "${ext || "(sem extensão)"}" não tem comando de execução. Configure em forge.run.commands.` };
  }
  return { template: tpl };
}

function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

// Executa um arquivo do workspace localmente, capturando saída e exit code para
// o loop de auto-cura. Execução local; o egress deny-by-default continua valendo.
export class Runner {
  constructor(private readonly cwd: string | undefined) {}

  async run(relPath: string, commands: Record<string, string>, timeoutMs: number): Promise<RunResult> {
    const resolved = resolveRunCommand(relPath, commands);
    if ("skippedReason" in resolved) {
      return { command: "", ok: false, exitCode: null, output: "", durationMs: 0, skippedReason: resolved.skippedReason };
    }
    const abs = this.cwd ? path.join(this.cwd, relPath) : relPath;
    const command = resolved.template.replace(/\{file\}/g, quote(abs));
    const started = Date.now();

    return new Promise<RunResult>((resolve) => {
      exec(command, { cwd: this.cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
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
