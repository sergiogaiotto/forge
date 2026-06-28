import { Chunk } from "./types";

const LANG_BY_EXT: Record<string, string> = {
  ".py": "python", ".ipynb": "python", ".sql": "sql", ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".r": "r", ".scala": "scala", ".java": "java",
  ".md": "markdown", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
};

export function languageForPath(relPath: string): string {
  const dot = relPath.lastIndexOf(".");
  const ext = dot >= 0 ? relPath.slice(dot).toLowerCase() : "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

// Início de uma unidade lógica (função/classe/célula/heading/declaração SQL).
const BOUNDARY_RE =
  /^\s*(?:async\s+def\s+|def\s+|class\s+|function\s+|export\s+(?:default\s+)?(?:async\s+)?function\s+|export\s+(?:const|class|interface|type)\s+|const\s+\w+\s*=\s*(?:async\s*)?\(|public\s+|private\s+|protected\s+|@app|@task|@dag|@pytest|#\s*%%|#{1,6}\s+|CREATE\s+|INSERT\s+|WITH\s+|SELECT\s+)/i;

const MAX_LINES = 55;
const MIN_LINES = 6;
const OVERLAP = 6;

function symbolFor(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Divide o conteúdo em trechos respeitando fronteiras lógicas, com teto de
 * tamanho e leve sobreposição. Notebooks `.ipynb` têm seu código de células
 * extraído antes de chunkar.
 */
export function chunkFile(relPath: string, content: string): Chunk[] {
  const language = languageForPath(relPath);
  const source = relPath.toLowerCase().endsWith(".ipynb") ? extractNotebookCode(content) : content;
  const lines = source.split("\n");
  if (lines.length === 0) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  let currentSymbol: string | undefined;

  const flush = (end: number) => {
    // Apara linhas em branco nas pontas.
    let s = start;
    let e = end;
    while (s < e && lines[s].trim() === "") s++;
    while (e > s && lines[e - 1].trim() === "") e--;
    if (e - s <= 0) return;
    const text = lines.slice(s, e).join("\n");
    if (text.trim().length === 0) return;
    chunks.push({
      id: `${relPath}#${s + 1}`,
      relPath,
      language,
      symbol: currentSymbol,
      startLine: s + 1,
      endLine: e,
      text,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const isBoundary = BOUNDARY_RE.test(lines[i]);
    const size = i - start;
    if ((isBoundary && size >= MIN_LINES) || size >= MAX_LINES) {
      flush(i);
      start = Math.max(i - (isBoundary ? 0 : OVERLAP), 0);
      if (start < i && !isBoundary) start = i - OVERLAP;
      else start = i;
    }
    if (isBoundary) currentSymbol = symbolFor(lines[i]);
  }
  flush(lines.length);
  return chunks;
}

/** Extrai apenas o código (source) das células de um notebook .ipynb. */
function extractNotebookCode(content: string): string {
  try {
    const nb = JSON.parse(content);
    if (!Array.isArray(nb.cells)) return content;
    return nb.cells
      .filter((c: any) => c.cell_type === "code")
      .map((c: any) => (Array.isArray(c.source) ? c.source.join("") : String(c.source ?? "")))
      .join("\n\n# %%\n");
  } catch {
    return content; // .ipynb malformado → trata como texto
  }
}
