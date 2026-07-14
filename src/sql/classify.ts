// Classificação determinística de statements SQL: tipo (select/DML/DDL/destrutivo), tabelas
// referenciadas, aliases e CTEs — a peça que fundamenta a governança por MOTOR (não por prompt):
// SELECT é leitura; INSERT/UPDATE/DELETE são escrita; DROP/TRUNCATE são destrutivos. Heurístico por
// tokenização (dialeto-agnóstico, sobre o texto já limpo pelo lex) — nunca bloqueia por si só: quem
// decide o que fazer com a classificação são as camadas acima (engine/gates). PURO/testável.
import { depthMap, splitStatements, stripSqlNoiseEx } from "./lex";

export type StatementKind =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "merge"
  | "create"
  | "alter"
  | "drop"
  | "truncate"
  | "grant"
  | "block" // bloco PL/SQL / execução dinâmica (BEGIN/DECLARE/CALL/EXEC/DO) — sempre tratado como escrita
  | "other";

export interface SqlStatement {
  kind: StatementKind;
  line: number; // 1-based no conteúdo analisado
  stripped: string; // texto do statement com strings/comentários apagados
  original: string; // texto original do statement (mesmos offsets)
  write: boolean; // muda estado (DML/DDL)
  destructive: boolean; // DROP/TRUNCATE (irreversíveis) — DELETE/UPDATE sem WHERE é achado, não classe
  hasTopLevelWhere: boolean;
  tables: string[]; // tabelas físicas referenciadas (FROM/JOIN/INTO/UPDATE/TABLE), sem CTEs
  ctes: string[]; // nomes definidos no WITH deste statement
  aliases: Map<string, string>; // alias → tabela (para resolução de colunas qualificadas)
  // O conteúdo tinha string não-terminada: parte do texto foi APAGADA da análise — as camadas acima
  // degradam achados de segurança para advisory (a análise pode estar vendo/perdendo um WHERE falso).
  unterminated: boolean;
}

const KIND_RE: Record<string, StatementKind> = {
  select: "select",
  insert: "insert",
  update: "update",
  delete: "delete",
  merge: "merge",
  create: "create",
  alter: "alter",
  drop: "drop",
  truncate: "truncate",
  grant: "grant",
  revoke: "grant",
  // Blocos procedurais / execução dinâmica: podem esconder QUALQUER escrita (EXECUTE IMMEDIATE, CALL de
  // procedure). Classificados como "block" e tratados como ESCRITA — a governança nunca os libera como
  // leitura (achado crítico da revisão: BEGIN/CALL/EXEC/DO viravam "other" e rodavam com verdict auto).
  begin: "block",
  declare: "block",
  call: "block",
  exec: "block",
  execute: "block",
  do: "block",
  merge_into: "merge",
};

const WRITE_KINDS = new Set<StatementKind>(["insert", "update", "delete", "merge", "create", "alter", "drop", "truncate", "grant", "block"]);

// Palavras que NUNCA são alias de tabela (aparecem logo após o nome da tabela).
const NOT_ALIAS = new Set([
  "on", "using", "where", "group", "order", "having", "qualify", "window", "limit", "offset", "fetch",
  "union", "except", "intersect", "join", "inner", "left", "right", "full", "cross", "outer", "lateral",
  "natural", "as", "set", "values", "select", "when", "then", "else", "and", "or", "not", "returning",
  "sample", "tablesample", "partition", "for", "into", "match_recognize", "pivot", "unpivot",
]);

// Identificador (possivelmente qualificado e/ou quotado): a.b.c, "A b".c, `x`.y — capturado cru.
const IDENT_CHAIN = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*))*`;

// Normaliza um pedaço de identificador: tira aspas/backticks/colchetes e baixa a caixa (heurística:
// case-insensitive é o comum; quem usa aspas para diferenciar caixa é raro o bastante para o hint).
export function normIdent(raw: string): string {
  return raw
    .split(".")
    .map((p) => p.trim().replace(/^["`[]/, "").replace(/["`\]]$/, "").toLowerCase())
    .join(".");
}

// Extrai os nomes das CTEs de um `WITH a AS (…), b AS (…)` no nível 0 do statement, E os KINDS dos
// corpos: data-modifying CTEs (`WITH d AS (DELETE … RETURNING …) SELECT …`, válido em Postgres/Oracle
// 21c+) escondem escrita atrás de um SELECT externo — o classificador precisa vê-las, senão a
// governança de execução as trata como leitura (achado crítico da revisão adversarial).
function collectCtes(stripped: string, d: Int32Array): { names: string[]; bodyEnd: number; bodyKinds: StatementKind[] } {
  const names: string[] = [];
  const bodyKinds: StatementKind[] = [];
  // Tolera placeholders `__jinja__` sobrando de macros no TOPO do modelo dbt antes do WITH.
  const withM = /^\s*(?:__jinja__\s*)*WITH\b(\s+RECURSIVE\b)?/i.exec(stripped);
  if (!withM) return { names, bodyEnd: 0, bodyKinds };
  let i = withM[0].length;
  while (i < stripped.length) {
    const rest = stripped.slice(i);
    const m = /^\s*([A-Za-z_][\w$]*|"[^"]+")\s*(\([^)]*\))?\s*AS\s*(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/i.exec(rest);
    if (!m) break;
    names.push(normIdent(m[1]));
    // pula até o `)` que fecha o corpo desta CTE (profundidade volta ao nível do WITH)
    let j = i + m[0].length; // primeiro char DENTRO do parêntese do corpo
    const openDepth = d[i + m[0].length - 1]; // profundidade do próprio '('
    const bodyStart = j;
    while (j < stripped.length) {
      if (stripped[j] === ")" && d[j] === openDepth) break;
      j++;
    }
    // verbo líder do corpo (pula WITH aninhado/__jinja__/parêntese de subquery) → kind da CTE
    const bodyVerb = /^\s*(?:__jinja__\s*|\(\s*)*([A-Za-z]+)/.exec(stripped.slice(bodyStart, j));
    bodyKinds.push(bodyVerb ? (KIND_RE[bodyVerb[1].toLowerCase()] ?? "other") : "other");
    j++; // após o ')'
    const after = /^\s*,/.exec(stripped.slice(j));
    if (after) {
      i = j + after[0].length;
      continue;
    }
    return { names, bodyEnd: j, bodyKinds };
  }
  return { names, bodyEnd: i, bodyKinds };
}

// Keywords que introduzem subquery quando precedem `(` — o mesmo critério da regra de ORDER BY.
// Um `(` precedido de identificador COMUM é chamada de função: `FROM` dentro dele (EXTRACT(DAY FROM
// col), SUBSTRING(x FROM 2), TRIM(BOTH FROM y)) NÃO introduz relação (achado da revisão adversarial).
const SUBQUERY_INTRODUCERS = new Set([
  "from", "join", "in", "exists", "union", "all", "select", "where", "and", "or", "on", "as", "not",
  "intersect", "except", "having", "when", "then", "else", "using", "lateral", ",", "(",
]);

// O `FROM` neste offset está dentro de uma CHAMADA DE FUNÇÃO? (o `(` que abre a profundidade atual é
// precedido de identificador comum, não de keyword introdutora de subquery).
function insideFunctionCall(stripped: string, d: Int32Array, offset: number): boolean {
  const depth = d[offset];
  if (depth === 0) return false;
  for (let i = offset - 1; i >= 0; i--) {
    if (stripped[i] === "(" && d[i] === depth - 1) {
      const before = stripped.slice(Math.max(0, i - 40), i);
      const w = /([A-Za-z_][\w$]*)\s*$/.exec(before);
      return !!w && !SUBQUERY_INTRODUCERS.has(w[1].toLowerCase());
    }
  }
  return false;
}

// Coleta tabelas + aliases a partir das keywords que introduzem relações. Ignora subqueries `FROM (`,
// funções de tabela `FROM f(...)` e `FROM` dentro de função (EXTRACT/SUBSTRING/TRIM). Alias reutilizado
// para tabelas DIFERENTES (subquery sem escopo) é ENVENENADO — sem resolução, o schemaCheck não opina
// (fail-open) em vez de ligar a coluna à tabela errada. `USING` só em MERGE.
function collectTables(stripped: string, d: Int32Array, ctes: Set<string>): { tables: string[]; aliases: Map<string, string> } {
  const tables: string[] = [];
  const aliases = new Map<string, string>();
  const poisoned = new Set<string>();
  const setAlias = (alias: string, table: string) => {
    const a = alias.toLowerCase();
    if (poisoned.has(a)) return;
    const prev = aliases.get(a);
    if (prev !== undefined && prev !== table) {
      aliases.delete(a); // mesmo alias, tabelas diferentes (escopos distintos) → ambíguo, ninguém opina
      poisoned.add(a);
      return;
    }
    aliases.set(a, table);
  };
  const re = new RegExp(String.raw`\b(FROM|JOIN|INTO|UPDATE|USING|TABLE)\s+(${IDENT_CHAIN})`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const kw = m[1].toUpperCase();
    if (kw === "FROM" && insideFunctionCall(stripped, d, m.index)) continue; // EXTRACT(DAY FROM col)…
    const rawIdent = m[2];
    const after = stripped.slice(m.index + m[0].length);
    // função de tabela: FROM generate_series(...) / TABLE(FLATTEN(...))
    if (/^\s*\(/.test(after) && !/^\s*\(\s*(NOLOCK|INDEX)/i.test(after)) continue;
    const name = normIdent(rawIdent);
    if (!name || KIND_RE[name]) continue;
    // Placeholders do strip de Jinja não são tabelas físicas ({{ this }} é a PRÓPRIA relação).
    if (/^__\w+__$/.test(name)) continue;
    const isCte = ctes.has(name);
    if (!isCte && !tables.includes(name)) tables.push(name);
    // alias: `FROM tabela [AS] t` (t não pode ser keyword)
    const aliasM = /^\s*(?:AS\s+)?([A-Za-z_][\w$]*)/i.exec(after);
    if (aliasM && !NOT_ALIAS.has(aliasM[1].toLowerCase())) {
      setAlias(aliasM[1], name);
    }
    if (kw === "FROM") {
      // vírgulas no mesmo nível continuam listando relações: FROM a, b c, d
      let base = m.index + m[0].length;
      // pula o alias se houver
      if (aliasM && !NOT_ALIAS.has(aliasM[1].toLowerCase())) {
        base += aliasM[0].length;
      }
      const commaRe = new RegExp(String.raw`^\s*,\s*(LATERAL\s+)?(${IDENT_CHAIN})`, "i");
      for (;;) {
        const cm = commaRe.exec(stripped.slice(base));
        if (!cm) break;
        base += cm[0].length;
        const afterIdent = stripped.slice(base);
        if (/^\s*\(/.test(afterIdent)) {
          // relação-função (UNNEST(x), FLATTEN(...), GENERATE_SERIES(...)): não é tabela — pula a
          // lista de argumentos inteira para continuar varrendo `FROM a, UNNEST(x) u, b`.
          const openRel = base + afterIdent.indexOf("(");
          const openDepth = d[openRel];
          let close = openRel + 1;
          while (close < stripped.length && !(stripped[close] === ")" && d[close] === openDepth)) close++;
          base = close + 1;
          const alias = /^\s*(?:AS\s+)?([A-Za-z_][\w$]*)/i.exec(stripped.slice(base));
          if (alias && !NOT_ALIAS.has(alias[1].toLowerCase())) base += alias[0].length;
          continue;
        }
        const nm = normIdent(cm[2]);
        if (nm && !ctes.has(nm) && !/^__\w+__$/.test(nm) && !tables.includes(nm)) tables.push(nm);
        const alias = /^\s*(?:AS\s+)?([A-Za-z_][\w$]*)/i.exec(afterIdent);
        if (alias && !NOT_ALIAS.has(alias[1].toLowerCase())) {
          setAlias(alias[1], nm);
          base += alias[0].length;
        }
      }
    }
  }
  return { tables, aliases };
}

// CTAS / SELECT-INTO: um `SELECT … INTO <alvo>` no TOP LEVEL (d=0) GRAVA — cria uma tabela (T-SQL/Postgres/
// Sybase `SELECT … INTO nova_tabela`) ou escreve um arquivo (MySQL `INTO OUTFILE/DUMPFILE`). O verbo líder é
// SELECT, então o classificador o dava como LEITURA e a governança de execução rodava o CREATE numa conexão
// READONLY (achado do survey). Distingue da atribuição a VARIÁVEL do MySQL (`INTO @var`, que não grava no
// banco); `:bind`/PL-var não casam o regex (ficam leitura); `INTO` em subquery/função (d>0) é ignorado. Puro.
function selectIntoIsWrite(stripped: string, d: Int32Array): boolean {
  // `\s*` (não `\s+`): identificador quotado é AUTO-DELIMITADO, então `INTO"foo"` (sem espaço) é CTAS válido
  // no Postgres/Oracle (o `\bINTO\b` já garante a fronteira p/ um alvo BARE, que sempre tem separador). O alvo
  // bare usa \p{L} (com /u): nomes de tabela podem começar com letra NÃO-ASCII (T-SQL) — crítico em pt-BR
  // (`índice`, `últimos_precos`) e geral (Cyrillic/CJK); sem isto o INTO era perdido e o CREATE rodava readonly.
  const re = /\bINTO\b\s*(@|"[^"]+"|`[^`]+`|\[[^\]]+\]|#{1,2}[\p{L}\p{N}_]|[\p{L}_][\p{L}\p{N}\p{M}_$]*)/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    if (d[m.index] !== 0) continue; // INTO dentro de subquery/função não é o alvo do statement
    if (m[1] === "@") return false; // MySQL variável de usuário (INTO @var) — não grava no banco
    return true; // tabela (incl. #temp do T-SQL, nome Unicode) ou OUTFILE/DUMPFILE → escrita
  }
  return false;
}

// Classifica todos os statements de um conteúdo SQL (já sem Jinja, se dbt). Nunca lança: entrada
// impossível de analisar rende `kind: "other"` — fail-open, como os demais gates do FORGE.
export function classifySql(content: string): SqlStatement[] {
  const { text: stripped, unterminated } = stripSqlNoiseEx(content ?? "");
  const slices = splitStatements(stripped);
  const out: SqlStatement[] = [];
  for (const s of slices) {
    const st = stripped.slice(s.start, s.end);
    const orig = (content ?? "").slice(s.start, s.end);
    const d = depthMap(st);
    const { names: ctes, bodyEnd, bodyKinds } = collectCtes(st, d);
    const afterWith = st.slice(bodyEnd);
    const isWith = ctes.length > 0 || /^\s*(?:__jinja__\s*)*WITH\b/i.test(st);
    const kindM = /^\s*(?:__jinja__\s*)*([A-Za-z]+)/.exec(isWith ? afterWith : st);
    const outerKind: StatementKind = kindM ? (KIND_RE[kindM[1].toLowerCase()] ?? "other") : "other";
    // Uma data-modifying CTE torna o statement uma ESCRITA mesmo que o SELECT externo o mascare. O
    // `kind` reportado prioriza o verbo mais "forte" para o rótulo do modal e da auditoria.
    const writeCte = bodyKinds.find((k) => WRITE_KINDS.has(k));
    let kind: StatementKind = WRITE_KINDS.has(outerKind) ? outerKind : (writeCte ?? outerKind);
    // CTAS / SELECT-INTO: um SELECT com `INTO <tabela>` (ou OUTFILE) no top level ESCREVE → create. Sem isto,
    // o verbo líder SELECT o daria como leitura e a governança executaria o CREATE numa conexão readonly.
    if (kind === "select" && selectIntoIsWrite(st, d)) kind = "create";
    const cteSet = new Set(ctes);
    const { tables, aliases } = collectTables(st, d, cteSet);
    let hasTopLevelWhere = false;
    const whereRe = /\bWHERE\b/gi;
    let wm: RegExpExecArray | null;
    while ((wm = whereRe.exec(st))) {
      if (d[wm.index] === 0) {
        hasTopLevelWhere = true;
        break;
      }
    }
    out.push({
      kind,
      line: s.line,
      stripped: st,
      original: orig,
      write: WRITE_KINDS.has(kind),
      destructive: kind === "drop" || kind === "truncate" || bodyKinds.includes("drop") || bodyKinds.includes("truncate"),
      hasTopLevelWhere,
      tables,
      ctes,
      aliases,
      unterminated,
    });
  }
  return out;
}
