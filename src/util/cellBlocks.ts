import { FORGE_CELL_BLOCK_LANG } from "../core/systemPrompt";
import { scanFencedBlocks } from "./fences";

export interface CellBlock {
  path: string;
  op: "add" | "replace";
  index?: number; // fallback para notebooks antigos ou células sem id
  after?: number; // op=add: insere após esta célula (omitido = ao final)
  cellId?: string; // op=replace: id estável do nbformat 4.5+
  kind?: "code" | "markdown";
  language?: string;
  tags?: string[];
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
    if (info.cellId !== undefined && validCellId(info.cellId)) block.cellId = info.cellId;
    if (info.kind === "code" || info.kind === "markdown") block.kind = info.kind;
    if (info.language !== undefined && validLanguage(info.language)) block.language = info.language;
    if (info.tags !== undefined) {
      const tags = info.tags.split(",").map((tag) => tag.trim()).filter(validTag);
      if (tags.length > 0) block.tags = [...new Set(tags)];
    }
    if (op === "replace" && block.index === undefined && block.cellId === undefined) continue;
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
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function validCellId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function validLanguage(value: string): boolean {
  return /^[A-Za-z0-9_+#.-]{1,40}$/.test(value);
}

function validTag(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}

export interface NotebookCell {
  id?: string;
  kind: "code" | "markdown";
  language?: string;
  tags: string[];
  source: string;
}

// Lê as células de um .ipynb (JSON) na ordem ABSOLUTA. Tolerante a notebook malformado.
export function parseNotebookCells(content: string): NotebookCell[] {
  try {
    const nb = JSON.parse(content);
    if (!Array.isArray(nb.cells)) return [];
    return nb.cells.map((c: any) => ({
      id: typeof c.id === "string" && validCellId(c.id) ? c.id : undefined,
      kind: c.cell_type === "markdown" ? "markdown" : "code",
      language:
        typeof c.metadata?.vscode?.languageId === "string" && validLanguage(c.metadata.vscode.languageId)
          ? c.metadata.vscode.languageId
          : undefined,
      tags: Array.isArray(c.metadata?.tags) ? c.metadata.tags.filter((tag: unknown): tag is string => typeof tag === "string" && validTag(tag)) : [],
      source: Array.isArray(c.source) ? c.source.join("") : String(c.source ?? ""),
    }));
  } catch {
    return [];
  }
}
