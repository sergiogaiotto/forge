// Blueprint do Modo Projeto (Fase F): o plano de arquivos aprovável ANTES de gerar código. O modelo
// devolve um array JSON de {path, purpose, deps}; este parser é TOLERANTE (extrai o primeiro array
// JSON do texto, mesmo cercado por prosa/```json) e normaliza. Puro/testável.
import type { BlueprintFile } from "../shared/protocol";
import { isSafeRelPath } from "./safePath";

export function parseBlueprint(text: string): BlueprintFile[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: BlueprintFile[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const path = String(f.path ?? "").trim().replace(/^[./\\]+/, ""); // sem ./ ou / inicial
    // Descarta caminhos que escapariam o workspace (`..` interior, absoluto, drive/UNC) — o path vem do modelo.
    if (!path || seen.has(path) || !isSafeRelPath(path)) continue;
    seen.add(path);
    out.push({
      path,
      purpose: String(f.purpose ?? "").trim().slice(0, 200),
      deps: Array.isArray(f.deps) ? f.deps.map((d) => String(d).trim()).filter(Boolean).slice(0, 20) : [],
    });
  }
  return out;
}

// Ordena os arquivos em ordem topológica pelas dependências declaradas (deps antes dos dependentes).
// Estável e tolerante a ciclos/deps desconhecidas (mantém a ordem original como desempate). Usada para
// gerar/aplicar na ordem certa (interfaces → domínio → adapters → wiring → testes).
export function topoSort(files: BlueprintFile[]): BlueprintFile[] {
  const byPath = new Map(files.map((f, i) => [f.path, i]));
  const visited = new Set<string>();
  const temp = new Set<string>();
  const order: BlueprintFile[] = [];
  const visit = (f: BlueprintFile) => {
    if (visited.has(f.path) || temp.has(f.path)) return; // ciclo → corta
    temp.add(f.path);
    for (const d of f.deps) {
      const idx = byPath.get(d);
      if (idx !== undefined) visit(files[idx]);
    }
    temp.delete(f.path);
    visited.add(f.path);
    order.push(f);
  };
  for (const f of files) visit(f);
  return order;
}
