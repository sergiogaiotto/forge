// Parser de markdown mínimo, seguro e SEM dependências para renderizar a resposta do assistente.
// Cobre o subconjunto que LLMs produzem: headings, listas, cercas de código, tabelas GFM, citações,
// régua e inline (código, negrito, itálico, link). A saída é uma AST de blocos — a renderização
// (Markdown.tsx) monta nós React a partir dela, sem nunca usar HTML cru (evita XSS).
//
// Decisão de projeto (ADR informal): preferimos este parser próprio a uma dependência pesada
// (react-markdown puxa dezenas de pacotes), coerente com a postura in-network/supply-chain do FORGE.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type TableAlign = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "heading"; level: number; c: Inline[] }
  // `open` = cerca ainda não fechada (estado transitório do streaming). A UI estiliza como "em progresso".
  | { t: "code"; lang: string; v: string; open: boolean }
  | { t: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { t: "table"; head: Inline[][]; align: TableAlign[]; rows: Inline[][][] }
  | { t: "quote"; c: Inline[] }
  | { t: "hr" };

// ---- Inline -----------------------------------------------------------------

// Só permitimos destinos de link seguros. Qualquer outro esquema (javascript:, data:, etc.) é
// degradado para texto puro — nunca vira href clicável. O caminho relativo "/x" é aceito, mas
// "//host" (URL protocol-relative, navega para domínio externo arbitrário) NÃO — daí o (?!/).
export function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|#|\/(?!\/))/i.test(href.trim());
}

// Acha o match mais à esquerda entre os padrões inline; empate de posição resolve por prioridade
// (código > link > negrito > itálico). Código é literal (não formata o conteúdo interno).
// Os marcadores de ênfase (* _ ** __) exigem fronteira de palavra (?<!\w) ... (?!\w): assim
// identificadores com underscore/asterisco (user_id_field, a*b*c, snake_case) NÃO viram itálico —
// essencial para uma audiência de dados, onde snake_case é onipresente na prosa.
const INLINE_PATTERNS: { kind: "code" | "link" | "strong" | "em"; re: RegExp }[] = [
  { kind: "code", re: /`([^`]+)`/ },
  { kind: "link", re: /\[([^\]]*)\]\(([^()\s]+)\)/ },
  { kind: "strong", re: /(?<!\w)\*\*([^*]+)\*\*(?!\w)|(?<!\w)__([^_]+)__(?!\w)/ },
  { kind: "em", re: /(?<!\w)\*([^*\n]+)\*(?!\w)|(?<!\w)_([^_\n]+)_(?!\w)/ },
];

// Escape de markdown: "\*" vira "*" literal (não formata). Cobre os marcadores inline.
const ESCAPE_RE = /\\([\\`*_[\]()])/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest.length > 0) {
    let best: { idx: number; len: number; node: Inline } | null = null;
    for (const { kind, re } of INLINE_PATTERNS) {
      const m = re.exec(rest);
      if (!m) continue;
      if (best && m.index >= best.idx) continue;
      let node: Inline;
      if (kind === "code") {
        node = { t: "code", v: m[1] };
      } else if (kind === "link") {
        const href = m[2];
        // destino inseguro: cai para texto (tratado abaixo como "sem match" se não houver outro)
        if (!isSafeHref(href)) continue;
        node = { t: "link", href, c: parseInline(m[1]) };
      } else if (kind === "strong") {
        node = { t: "strong", c: parseInline(m[1] ?? m[2]) };
      } else {
        node = { t: "em", c: parseInline(m[1] ?? m[2]) };
      }
      best = { idx: m.index, len: m[0].length, node };
    }
    // Um escape antes do melhor match vence: emite o caractere escapado como texto literal.
    const esc = ESCAPE_RE.exec(rest);
    if (esc && (!best || esc.index < best.idx)) {
      if (esc.index > 0) out.push({ t: "text", v: rest.slice(0, esc.index) });
      out.push({ t: "text", v: esc[1] });
      rest = rest.slice(esc.index + 2);
      continue;
    }
    if (!best) {
      out.push({ t: "text", v: rest });
      break;
    }
    if (best.idx > 0) out.push({ t: "text", v: rest.slice(0, best.idx) });
    out.push(best.node);
    rest = rest.slice(best.idx + best.len);
  }
  return out;
}

// ---- Blocos -----------------------------------------------------------------

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // separa por | que não esteja escapado com \
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("-") || !line.includes("|")) return false;
  return splitRow(line).every((c) => /^:?-+:?$/.test(c));
}

function alignOf(cell: string): TableAlign {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return null;
}

export function parseMarkdownBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Cerca de código (``` ou ~~~). Fecha com a mesma marca e comprimento >=, sozinha na linha.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const len = fence[2].length;
      const lang = fence[3].trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const close = new RegExp(`^\\s*${marker === "`" ? "`" : "~"}{${len},}\\s*$`).test(lines[i]);
        if (close) {
          i++;
          closed = true;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      // open=true quando o laço terminou por fim-de-buffer (cerca ainda chegando no streaming).
      blocks.push({ t: "code", lang, v: body.join("\n"), open: !closed });
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ t: "heading", level: heading[1].length, c: parseInline(heading[2].trim()) });
      i++;
      continue;
    }

    // Tabela GFM: linha com `|` seguida de uma linha separadora `|---|:--:|`.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const head = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ t: "table", head, align, rows });
      continue;
    }

    // Citação: linhas consecutivas iniciadas por `>`.
    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(QUOTE_RE.exec(lines[i])![1]);
        i++;
      }
      blocks.push({ t: "quote", c: parseInline(buf.join(" ").trim()) });
      continue;
    }

    // Listas (não ordenadas ou ordenadas). Agrupa itens consecutivos do mesmo tipo.
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const ordered = !!ol;
      const start = ol ? parseInt(ol[2], 10) : 1;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const u = UL_RE.exec(lines[i]);
        const o = OL_RE.exec(lines[i]);
        if (ordered && o) items.push(parseInline(o[3]));
        else if (!ordered && u) items.push(parseInline(u[2]));
        else break;
        i++;
      }
      blocks.push({ t: "list", ordered, start, items });
      continue;
    }

    // Parágrafo: linhas consecutivas até uma linha em branco ou o início de outro bloco.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      const l = lines[i];
      if (FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || UL_RE.test(l) || OL_RE.test(l)) break;
      if (l.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break;
      para.push(l.trim());
      i++;
    }
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join(" ")) });
  }

  return blocks;
}
