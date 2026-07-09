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

// Resolve o binário REAL no PATH (inclui shims .cmd/.bat/.exe do Windows) para spawnar SEM shell:true —
// a razão de o shell existir era executar esses shims; resolvendo o caminho, o Node quota os args e
// nenhum metacaractere é interpretado. `env` injetável para teste; default = process.env.
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
