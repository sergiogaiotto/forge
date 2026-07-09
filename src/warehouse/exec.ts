// Primitivas de execução segura de CLI (extraídas do WarehouseService para serem testáveis em Node
// puro — sem vscode). São o coração da correção do RCE crítico: resolver o binário no PATH e spawnar
// com shell:FALSE (o Node quota os args, nenhum metacaractere é interpretado), e rejeitar valores de
// settings com metacaractere ANTES de qualquer spawn. PURO.
import { existsSync } from "node:fs";
import * as path from "node:path";

// Metacaracteres de shell PROIBIDOS em qualquer valor vindo do settings de conexão (defesa contra RCE
// mesmo com shell:false, e contra strings de conexão malformadas). A validação roda ANTES de qualquer
// spawn — um workspace malicioso não pode injetar comando via forge.warehouse.connections.
export const SHELL_METACHARS = /[&|;<>^`$\n\r\0]|\$\(|\|\|/;

export function unsafeField(v: string | undefined): boolean {
  return typeof v === "string" && SHELL_METACHARS.test(v);
}

// Resolve o binário REAL no PATH (inclui shims .cmd/.bat do Windows). `env` injetável para teste.
export function resolveExecutable(tool: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  if (tool.includes("/") || tool.includes("\\")) return existsSync(tool) ? tool : null;
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, tool + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
      const upper = path.join(dir, tool + ext);
      if (existsSync(upper)) return upper;
    }
  }
  return null;
}

// Quota um argumento para a linha de comando do cmd.exe (aspas duplas; aspas internas dobradas).
export function cmdQuote(s: string): string {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

export interface SpawnPlan {
  file: string;
  args: string[];
  useShell: boolean;
}

// Decide COMO spawnar o binário já resolvido. Para .exe (e todo POSIX): shell:FALSE — o Node quota os
// args e nenhum metacaractere é interpretado (defesa em profundidade). Para SHIMS .bat/.cmd/.com no
// Windows: o Node RECUSA rodá-los sob shell:false (EINVAL, endurecimento do CVE-2024-27980), então
// roda via shell com o caminho e os args MANUALMENTE quotados. Isso é seguro AQUI porque `unsafeField`
// já rejeitou metacaracteres de shell nos campos de settings ANTES do spawn — a linha de comando só
// tem flags constantes, valores de conexão validados e caminhos temporários (sem metacaractere).
export function buildSpawn(toolPath: string, args: string[], platform: string = process.platform): SpawnPlan {
  const isShim = platform === "win32" && /\.(cmd|bat|com)$/i.test(toolPath);
  if (!isShim) return { file: toolPath, args, useShell: false };
  return { file: cmdQuote(toolPath), args: args.map(cmdQuote), useShell: true };
}
