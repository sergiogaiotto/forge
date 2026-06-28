import { FORGE_CELL_BLOCK_LANG } from "../core/systemPrompt";
import { scanFencedBlocks } from "./fences";

export interface CellBlock {
  path: string;
  op: "add" | "replace";
  index?: number; // op=replace: índice absoluto da célula
  after?: number; // op=add: insere após esta célula (omitido = ao final)
  code: string;
}

// Extrai os blocos forge-cell COMPLETOS (op=add|replace) da resposta do modelo. Usa o mesmo scanner
// de cercas do forge-file (cerca de N>=3 crases, ver fences.ts), então o CÓDIGO da célula pode conter
// suas próprias cercas de 3 crases (ex.: uma docstring com um ```sql) sem fechar o bloco antes da hora.
export function parseCellBlocks(text: string): CellBlock[] {
  const out: CellBlock[] = [];
  for (const f of scanFencedBlocks(text, FORGE_CELL_BLOCK_LANG)) {
    if (!f.closed) continue;
    const info = parseInfo(f.info);
    const path = (info.path ?? "").replace(/^["']|["']$/g, "");
    const op = info.op === "replace" ? "replace" : "add";
    if (!path) continue;
    const block: CellBlock = { path, op, code: f.content };
    if (info.index !== undefined) block.index = toInt(info.index);
    if (info.after !== undefined) block.after = toInt(info.after);
    if (op === "replace" && block.index === undefined) continue; // replace exige index
    out.push(block);
  }
  return out;
}

function parseInfo(info: string): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const tok of info.trim().split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq > 0) obj[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return obj;
}

function toInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : undefined;
}

export interface NotebookCell {
  kind: "code" | "markdown";
  source: string;
}

// Lê as células de um .ipynb (JSON) na ordem ABSOLUTA. Tolerante a notebook malformado.
export function parseNotebookCells(content: string): NotebookCell[] {
  try {
    const nb = JSON.parse(content);
    if (!Array.isArray(nb.cells)) return [];
    return nb.cells.map((c: any) => ({
      kind: c.cell_type === "markdown" ? "markdown" : "code",
      source: Array.isArray(c.source) ? c.source.join("") : String(c.source ?? ""),
    }));
  } catch {
    return [];
  }
}
