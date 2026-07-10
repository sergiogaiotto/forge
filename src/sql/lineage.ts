// Lineage de coluna determinístico (Onda 2): para um SELECT (o statement final de um modelo dbt),
// mapeia cada coluna de SAÍDA às colunas/tabelas de ORIGEM, atravessando CTEs — a resposta a "de onde
// vem este número?". Heurístico sobre a tokenização (não é um resolvedor de tipos): expressões viram
// transform "expressao", SELECT * degrada confiança, ambiguidade (coluna sem qualificador com 2+
// tabelas no FROM) vira origem "?". Não existe lib TS madura para isso — este módulo é a semente do
// diferencial. PURO/testável.
import { SqlStatement } from "./classify";
import { confidenceLabel, SqlConfidence } from "./antipatterns";
import { depthMap } from "./lex";

export interface ColumnLineage {
  output: string; // nome da coluna de saída (alias ou o próprio nome)
  sources: string[]; // "tabela.coluna" resolvidos (tabela física ou "?" quando ambíguo)
  transform: "direta" | "expressao";
}

export interface LineageResult {
  columns: ColumnLineage[];
  star: boolean; // o select final usa * (lineage incompleto por construção)
  confidence: SqlConfidence; // código interno estável — exibir via confidenceLabel()
}

const NOT_COLUMN = new Set([
  "select", "distinct", "as", "case", "when", "then", "else", "end", "and", "or", "not", "in", "is",
  "null", "true", "false", "like", "ilike", "between", "over", "partition", "by", "order", "rows",
  "range", "unbounded", "preceding", "following", "current", "row", "interval", "cast", "asc", "desc",
  "from", "where", "group", "having", "union", "all", "exists", "extract", "filter", "ignore", "nulls",
]);

// Itens do select list (split por vírgula no nível do SELECT).
function splitSelectList(span: string): string[] {
  const d = depthMap(span);
  const items: string[] = [];
  let start = 0;
  for (let i = 0; i < span.length; i++) {
    if (span[i] === "," && d[i] === 0) {
      items.push(span.slice(start, i));
      start = i + 1;
    }
  }
  items.push(span.slice(start));
  return items.map((x) => x.trim()).filter(Boolean);
}

// Localiza o span do select list FINAL do statement (após o WITH, do SELECT ao FROM do mesmo nível).
function finalSelectSpan(stripped: string): { span: string; tail: string } | null {
  const d = depthMap(stripped);
  const re = /\bSELECT\b(\s+DISTINCT\b)?/gi;
  let m: RegExpExecArray | null;
  let best: { start: number } | null = null;
  while ((m = re.exec(stripped))) {
    if (d[m.index] === 0) best = { start: m.index + m[0].length }; // último SELECT de nível 0 = o final
  }
  if (!best) return null;
  let end = stripped.length;
  const fromRe = /\bFROM\b/gi;
  fromRe.lastIndex = best.start;
  let f: RegExpExecArray | null;
  while ((f = fromRe.exec(stripped))) {
    if (d[f.index] === 0) {
      end = f.index;
      break;
    }
  }
  return { span: stripped.slice(best.start, end), tail: stripped.slice(end) };
}

// Apaga da expressão os identificadores que são NOMES DE TIPO ou date-parts, não colunas — sem isto,
// `CAST(x AS DECIMAL)` inventaria a coluna "decimal" e `EXTRACT(YEAR FROM x)` a coluna "year"
// (achado da revisão adversarial). Filtro por CONTEXTO lexical, não por lista de nomes (year/date são
// nomes de coluna legítimos em marts).
function blankTypeContexts(expr: string): string {
  return expr
    .replace(/::\s*[A-Za-z_][\w$]*(\s*\(\s*\d+(\s*,\s*\d+)?\s*\))?/g, (m) => " ".repeat(m.length)) // x::int / x::numeric(10,2)
    .replace(/\b(CAST|TRY_CAST|SAFE_CAST)\s*\(([^()]*?)\s+AS\s+[A-Za-z_][\w$]*(\s*\(\s*\d+(\s*,\s*\d+)?\s*\))?\s*\)/gi, (m, fn, inner) => `${fn}(${inner})`.padEnd(m.length)) // CAST(x AS DECIMAL(10,2))
    .replace(/\b(EXTRACT|DATE_PART|DATEPART)\s*\(\s*[A-Za-z_][\w$]*\s+FROM\b/gi, (m) => m.replace(/\(\s*[A-Za-z_][\w$]*/, (p) => "(" + " ".repeat(p.length - 1))) // EXTRACT(YEAR FROM …
    .replace(/\bINTERVAL\s+'[^']*'\s+[A-Za-z_][\w$]*/gi, (m) => " ".repeat(m.length)); // INTERVAL '1' DAY
}

// Referências de coluna dentro de uma expressão: identificadores (qualificados ou não) que não são
// função (sem `(` em seguida) nem keyword/número/nome-de-tipo.
function columnRefs(rawExpr: string): { qualifier?: string; column: string }[] {
  const expr = blankTypeContexts(rawExpr);
  const out: { qualifier?: string; column: string }[] = [];
  const re = /(?:([A-Za-z_][\w$]*)\s*\.\s*)?([A-Za-z_][\w$]*)\b(?!\s*\(|\s*\.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) {
    const col = m[2].toLowerCase();
    if (!m[1] && NOT_COLUMN.has(col)) continue;
    if (/^__\w+__$/.test(col)) continue;
    out.push({ qualifier: m[1]?.toLowerCase(), column: col });
  }
  return out;
}

// Nome de saída de um item do select list: alias (`… AS nome` / `… nome`) ou a própria coluna.
function outputName(item: string): { name: string; expr: string } {
  const asM = /\s+AS\s+("?[A-Za-z_][\w$]*"?)\s*$/i.exec(item);
  if (asM) return { name: asM[1].replace(/"/g, "").toLowerCase(), expr: item.slice(0, asM.index) };
  // alias implícito: `expr nome` (nome simples no fim, precedido de espaço, sem operador imediato)
  const impl = /^(.*\S)\s+([A-Za-z_][\w$]*)\s*$/.exec(item);
  if (impl && !NOT_COLUMN.has(impl[2].toLowerCase()) && /[)\w$"']$/.test(impl[1].trim())) {
    // só quando a expressão NÃO termina em `.`-chain incompleta e o "alias" não é a própria coluna
    const refs = columnRefs(impl[2]);
    const exprRefs = columnRefs(impl[1]);
    if (!(exprRefs.length === 0 && refs.length === 1)) {
      const single = /^(?:[A-Za-z_][\w$]*\s*\.\s*)?[A-Za-z_][\w$]*$/.test(item.trim());
      if (!single) return { name: impl[2].toLowerCase(), expr: impl[1] };
    }
  }
  const refs = columnRefs(item);
  const name = refs.length > 0 ? refs[refs.length - 1].column : item.trim().toLowerCase().slice(0, 40);
  return { name, expr: item };
}

// Lineage de um statement SELECT. Resolve qualificadores por alias→tabela e atravessa CTEs
// (a origem "cte.col" é substituída pelas origens da coluna equivalente no lineage da CTE).
export function selectLineage(stmt: SqlStatement): LineageResult {
  const s = stmt.stripped;
  const final = finalSelectSpan(s);
  if (!final || stmt.kind !== "select") return { columns: [], star: false, confidence: "baixa" };

  // lineage por CTE (na ordem de definição — CTEs só referenciam anteriores)
  const cteLineage = new Map<string, Map<string, LinEntry>>();
  for (const cte of stmt.ctes) {
    const bodyRe = new RegExp(String.raw`\b${cte.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*(\([^)]*\))?\s+AS\s*\(`, "i");
    const bm = bodyRe.exec(s);
    if (!bm) continue;
    const d = depthMap(s);
    const open = bm.index + bm[0].length - 1;
    let close = s.length;
    for (let i = open + 1; i < s.length; i++) {
      if (s[i] === ")" && d[i] === d[open]) {
        close = i;
        break;
      }
    }
    const body = s.slice(open + 1, close);
    cteLineage.set(cte, lineageOfQuery(body, cteLineage));
  }

  const resolved = lineageOfQuery(s, cteLineage, final);
  const star = /(?:^|\s|,)(?:[A-Za-z_][\w$]*\s*\.\s*)?\*\s*(?:,|$)/.test(final.span.trim()) || final.span.trim() === "*";
  const columns: ColumnLineage[] = [];
  for (const [name, entry] of resolved) {
    columns.push({ output: name, sources: entry.sources, transform: entry.direct ? "direta" : "expressao" });
  }
  // UNION/EXCEPT/INTERSECT no nível 0: o mapa reflete só o ÚLTIMO branch — sinaliza a incompletude
  // degradando a confiança (achado da revisão adversarial).
  const dTop = depthMap(s);
  let hasSetOp = false;
  const setOpRe = /\b(UNION|EXCEPT|INTERSECT|MINUS)\b/gi;
  let so: RegExpExecArray | null;
  while ((so = setOpRe.exec(s))) {
    if (dTop[so.index] === 0) {
      hasSetOp = true;
      break;
    }
  }
  const confidence = star || hasSetOp ? "baixa" : stmt.ctes.length > 0 ? "média" : "alta";
  return { columns, star, confidence };
}

// Entrada do lineage de uma coluna: origens + se ainda é uma referência PURA (sem transformação).
interface LinEntry {
  sources: string[];
  direct: boolean;
}

// Lineage de UMA query (corpo de CTE ou o select final): mapa saída → origens "tabela.coluna".
function lineageOfQuery(
  query: string,
  cteLineage: Map<string, Map<string, LinEntry>>,
  precomputed?: { span: string; tail: string }
): Map<string, LinEntry> {
  const out = new Map<string, LinEntry>();
  const final = precomputed ?? finalSelectSpan(query);
  if (!final) return out;

  // aliases LOCAIS desta query (o FROM/JOIN que vem depois do select list). Só matches no NÍVEL 0 do
  // tail: um FROM em subquery/função (EXTRACT(DAY FROM col) no WHERE) não é relação local desta query.
  const localAliases = new Map<string, string>();
  const relRe = /\b(FROM|JOIN)\s+((?:[A-Za-z_][\w$]*\s*\.\s*)*[A-Za-z_][\w$]*)(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?/gi;
  const tailD = depthMap(final.tail);
  let rm: RegExpExecArray | null;
  const localTables: string[] = [];
  while ((rm = relRe.exec(final.tail))) {
    if (tailD[rm.index] !== 0) continue;
    const table = rm[2].replace(/\s+/g, "").toLowerCase();
    if (/^__\w+__$/.test(table)) continue;
    localTables.push(table);
    const alias = rm[3]?.toLowerCase();
    if (alias && !["on", "using", "where", "group", "order", "left", "right", "inner", "full", "cross", "join", "as", "limit", "qualify", "having"].includes(alias)) {
      localAliases.set(alias, table);
    }
  }
  const singleTable = localTables.length === 1 ? localTables[0] : undefined;

  const resolveSource = (qualifier: string | undefined, column: string): LinEntry => {
    const table = qualifier ? (localAliases.get(qualifier) ?? qualifier) : (singleTable ?? "?");
    const viaCte = cteLineage.get(table);
    if (viaCte) {
      const inner = viaCte.get(column);
      if (inner && inner.sources.length > 0) return inner;
      return { sources: [`${table}.${column}`], direct: true }; // coluna não mapeada na CTE (ex.: veio de *)
    }
    return { sources: [`${table}.${column}`], direct: true };
  };

  for (const item of splitSelectList(final.span)) {
    if (item === "*" || /^[A-Za-z_][\w$]*\s*\.\s*\*$/.test(item)) continue; // star: lineage incompleto por construção
    const { name, expr } = outputName(item);
    // Referência PURA (só `col` ou `alias.col`) = direta; qualquer outra coisa é expressão.
    const isBare = /^(?:[A-Za-z_][\w$]*\s*\.\s*)?[A-Za-z_][\w$]*$/.test(expr.trim());
    const refs = columnRefs(expr);
    const entries = refs.map((r) => resolveSource(r.qualifier, r.column));
    const sources = [...new Set(entries.flatMap((e) => e.sources))];
    const direct = isBare && entries.every((e) => e.direct);
    out.set(name, { sources, direct });
  }
  return out;
}

// Render compacto do lineage para o cartão do /impacto (top N colunas).
export function renderLineage(result: LineageResult, cap = 14): string {
  if (result.columns.length === 0) return "";
  const rows = result.columns.slice(0, cap).map((c) => {
    const src = c.sources.length > 0 ? c.sources.join(", ") : "—";
    return `| \`${c.output}\` | ${c.transform} | ${src} |`;
  });
  const more = result.columns.length > cap ? `\n_… +${result.columns.length - cap} colunas._` : "";
  const star = result.star ? "\n_⚠ O SELECT final usa `*` — colunas propagadas do upstream não aparecem no mapa._" : "";
  return [
    `**Lineage de coluna** (confiança ${confidenceLabel(result.confidence)}):`,
    "",
    "| saída | transformação | origem |",
    "|---|---|---|",
    ...rows,
  ].join("\n") + more + star;
}
