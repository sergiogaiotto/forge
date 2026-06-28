import { FORGE_CELL_BLOCK_LANG } from "../core/systemPrompt";

export interface CellBlock {
  path: string;
  op: "add" | "replace";
  index?: number; // op=replace: índice absoluto da célula
  after?: number; // op=add: insere após esta célula (omitido = ao final)
  code: string;
}

// Extrai os blocos ```forge-cell path=... op=add|replace ...``` da resposta do modelo.
export function parseCellBlocks(text: string): CellBlock[] {
  const re = new RegExp("```" + FORGE_CELL_BLOCK_LANG + "\\s+([^\\n`]+)\\n([\\s\\S]*?)```", "g");
  const out: CellBlock[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const info = parseInfo(m[1]);
    const path = (info.path ?? "").replace(/^["']|["']$/g, "");
    const op = info.op === "replace" ? "replace" : "add";
    if (!path) continue;
    let code = m[2];
    if (code.endsWith("\n")) code = code.slice(0, -1);
    const block: CellBlock = { path, op, code };
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
