import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ValidatorResult } from "../shared/protocol";
import { log } from "../util/logger";
import { SkillValidatorSpec } from "./types";

// RF-039: executa os validadores anexados a uma skill (linter/type-checker/formatter ou
// scripts) localmente sobre o código gerado e retorna o resultado. Executa totalmente
// offline. Um validador marcado como `gate: true` bloqueia a aceitação do diff em caso de falha.
export class SkillValidator {
  constructor(private readonly cwd: string | undefined) {}

  async run(
    validators: SkillValidatorSpec[],
    content: string,
    targetRelPath: string,
    timeoutMs = 60_000
  ): Promise<ValidatorResult[]> {
    const ext = path.extname(targetRelPath) || ".txt";
    const applicable = validators.filter((v) => !v.appliesTo || v.appliesTo.includes(ext));
    if (applicable.length === 0) return [];

    // Valida contra um arquivo temporário que espelha o conteúdo proposto. Escreve DENTRO do
    // workspace (.forge/) quando há cwd: assim linters/type-checkers descobrem a config do projeto
    // (pyproject/.flake8/eslintrc) e resolvem imports internos, em vez de rodar com defaults. Sem
    // workspace, cai no tmp do SO. O diretório é removido no finally.
    const baseDir = this.cwd ? path.join(this.cwd, ".forge") : os.tmpdir();
    await fs.mkdir(baseDir, { recursive: true });
    const tmpDir = await fs.mkdtemp(path.join(baseDir, "val-"));
    const tmpFile = path.join(tmpDir, "candidate" + ext);
    await fs.writeFile(tmpFile, content, "utf8");

    const results: ValidatorResult[] = [];
    try {
      for (const v of applicable) {
        results.push(await this.runOne(v, tmpFile, timeoutMs));
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return results;
  }

  private runOne(v: SkillValidatorSpec, tmpFile: string, timeoutMs: number): Promise<ValidatorResult> {
    const command = v.command.replace(/\{file\}/g, quote(tmpFile));
    return new Promise((resolve) => {
      exec(command, { cwd: this.cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ id: v.id, label: v.label, status: "skipped", gate: v.gate, output: "", reason: "ferramenta não disponível no PATH" });
          return;
        }
        // Algumas ferramentas (ruff/mypy) saem com código diferente de zero ao encontrar problemas, sem ENOENT.
        const failed = !!err;
        if (failed) log.info(`Validador ${v.id} reprovou (${v.label}).`);
        resolve({
          id: v.id,
          label: v.label,
          status: failed ? "failed" : "ok",
          gate: v.gate,
          output: output.slice(0, 4000),
        });
      });
    });
  }
}

export function gatePassed(results: ValidatorResult[]): boolean {
  // O gate só falha quando um validador de gate realmente reprovou (skipped ≠ failed).
  return !results.some((r) => r.gate && r.status === "failed");
}

function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}
