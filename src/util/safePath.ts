// Contenção de caminho no workspace. O `path=` dos blocos forge-file e o `path` do blueprint vêm 100%
// do MODELO — sem esta guarda, `path.join(ws, "../../etc/x")` ou um caminho absoluto escreveria FORA do
// workspace (sobrescrever chaves SSH, .bashrc, tarefas de startup → RCE/persistência). Puro/testável.
import * as path from "node:path";

// Resolve `relPath` dentro de `workspaceRoot` e devolve o caminho absoluto SÓ se ele permanecer contido
// no workspace; senão devolve null (traversal `..`, caminho absoluto, outra unidade, ou a própria raiz).
export function safeWorkspacePath(workspaceRoot: string, relPath: string): string | null {
  if (!relPath || typeof relPath !== "string") return null;
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}

// Um caminho relativo é "seguro" (contido) para um workspace hipotético? Independente de plataforma para
// filtrar cedo (ex.: no parse do blueprint), rejeitando `..` interior, caminho absoluto e drive/UNC.
export function isSafeRelPath(relPath: string): boolean {
  if (!relPath) return false;
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || relPath.startsWith("\\\\")) return false;
  return !relPath
    .split(/[\\/]+/)
    .some((seg) => seg === "..");
}
