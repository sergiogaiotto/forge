// Regras anti-padrão compiladas para SQL (a "camada fria": o LLM raciocina, o motor valida). Catálogo
// derivado do que é público na literatura de análise SQL determinística (SELECT *, produto cartesiano,
// predicado não-sargável, NOT IN + NULL, UNION sem ALL, CTE não usada, LIMIT em modelo dbt…), com
// CONFIANÇA declarada por achado — heurísticas sobre tokenização, não parser completo: baixa confiança
// significa "olhe você"; nunca é bloqueio. Achados de SEGURANÇA (DELETE/UPDATE sem WHERE, DROP/TRUNCATE)
// têm severidade "error" e são os únicos candidatos a gate (modo conservador). PURO/testável.
import { hostT } from "../i18n";
import { SqlStatement } from "./classify";
import { clauseEnd, depthMap, lineOf } from "./lex";

export type SqlSeverity = "info" | "warn" | "error";
// CÓDIGOS INTERNOS ESTÁVEIS de confiança — usados em LÓGICA (degrade/comparações). NUNCA traduzir nem
// exibir crus: o texto para o usuário vem de confidenceLabel() (é lá que a i18n futura entra). Traduzir
// estes valores quebraria `c === "alta"` e o degrade em silêncio (label-que-é-chave).
export type SqlConfidence = "alta" | "média" | "baixa";

// CÓDIGO→TEXTO exibido da confiança, resolvido por locale via hostT (o enum nunca muda — este era o
// ponto de inserção da i18n declarado desde o PR 3).
export function confidenceLabel(c: SqlConfidence): string {
  return c === "alta" ? hostT("conf.alta") : c === "média" ? hostT("conf.media") : c === "baixa" ? hostT("conf.baixa") : c;
}

export interface SqlFinding {
  rule: string;
  message: string;
  severity: SqlSeverity;
  confidence: SqlConfidence;
  line: number; // 1-based no conteúdo analisado
}

export interface AntipatternOptions {
  isDbtModel?: boolean; // muda o que é anti-padrão (LIMIT em modelo é bug; SELECT * em staging é comum)
  hadJinja?: boolean; // análise sobre Jinja "achatado" → degrada confiança em um nível
}

function degrade(c: SqlConfidence): SqlConfidence {
  return c === "alta" ? "média" : "baixa";
}

// Keywords que introduzem subquery quando seguidas de `(` — o que vier depois de identificador comum
// é chamada de função (ARRAY_AGG(… ORDER BY …)) e não deve disparar regra de subquery.
const SUBQUERY_INTRODUCERS = new Set([
  "from", "join", "in", "exists", "union", "all", "select", "where", "and", "or", "on", "as", "not",
  "intersect", "except", "having", "when", "then", "else", "using", "lateral",
]);

// Regras aplicadas por statement. `baseLine` é a linha do statement no conteúdo original.
export function findAntipatterns(stmt: SqlStatement, baseLine: number, opts: AntipatternOptions = {}): SqlFinding[] {
  const out: SqlFinding[] = [];
  const s = stmt.stripped;
  const d = depthMap(s);
  const lineAt = (off: number) => baseLine + lineOf(s, off) - 1;
  const add = (rule: string, message: string, severity: SqlSeverity, confidence: SqlConfidence, off: number) => {
    out.push({ rule, message, severity, confidence: opts.hadJinja ? degrade(confidence) : confidence, line: lineAt(off) });
  };

  // ---- segurança (candidatos a gate) ------------------------------------------------------------
  if (stmt.kind === "delete" && !stmt.hasTopLevelWhere) {
    add("delete-sem-where", hostT("ap.deleteSemWhere"), "error", "alta", 0);
  }
  if (stmt.kind === "update" && !stmt.hasTopLevelWhere) {
    add("update-sem-where", hostT("ap.updateSemWhere"), "error", "alta", 0);
  }
  if (stmt.destructive) {
    add("statement-destrutivo", hostT("ap.destrutivo", { kind: stmt.kind.toUpperCase() }), "error", "alta", 0);
  }

  // ---- SELECT * ----------------------------------------------------------------------------------
  const starRe = /\bSELECT\s+(?:DISTINCT\s+)?(?:(?:[A-Za-z_][\w$]*|"[^"]+")\s*\.\s*)?\*/gi;
  let m: RegExpExecArray | null;
  while ((m = starRe.exec(s))) {
    const depth = d[m.index];
    if (depth === 0) {
      add("select-star", opts.isDbtModel ? hostT("ap.selectStarDbt") : hostT("ap.selectStar"), "warn", "média", m.index);
    } else {
      // EXISTS (SELECT * …) é idiomático — não é achado.
      const before = s.slice(Math.max(0, m.index - 32), m.index).toUpperCase();
      if (!/EXISTS\s*\($/.test(before.trimEnd())) {
        add("select-star-em-subquery", hostT("ap.selectStarSub"), "warn", "média", m.index);
      }
    }
  }

  // ---- FROM a, b (join implícito / produto cartesiano) -------------------------------------------
  // Cada vírgula é avaliada individualmente: vírgula seguida de relação CORRELACIONADA (LATERAL,
  // UNNEST(…), TABLE(FLATTEN(…)), GENERATE_SERIES(…) ou qualquer função-relação `ident(`) é o idioma
  // canônico de explodir arrays em BigQuery/Snowflake/Postgres — NÃO multiplica N×M e não pode virar
  // achado de gate (falso-positivo crítico da revisão adversarial). Só vírgula "plana" conta.
  const CORRELATED_AFTER_COMMA = /^\s*(LATERAL\b|UNNEST\s*\(|FLATTEN\s*\(|TABLE\s*\(|VALUES\s*\(|[A-Za-z_][\w$]*\s*\()/i;
  const fromRe = /\bFROM\s/gi;
  while ((m = fromRe.exec(s))) {
    const depth = d[m.index];
    const end = clauseEnd(s, d, m.index + m[0].length, depth);
    const span = s.slice(m.index, end);
    const spanD = depthMap(span);
    let flatComma = false;
    for (let i = 0; i < span.length; i++) {
      if (span[i] === "," && spanD[i] === 0) {
        if (CORRELATED_AFTER_COMMA.test(span.slice(i + 1))) continue;
        flatComma = true;
        break;
      }
    }
    if (flatComma) {
      if (stmt.hasTopLevelWhere || depth > 0) {
        add("join-implicito", hostT("ap.joinImplicito"), "warn", "média", m.index);
      } else {
        add("produto-cartesiano", hostT("ap.produtoCartesiano"), "error", "alta", m.index);
      }
    }
  }

  // ---- CROSS JOIN explícito (às vezes intencional) ------------------------------------------------
  const crossRe = /\bCROSS\s+JOIN\b/gi;
  while ((m = crossRe.exec(s))) {
    add("cross-join", hostT("ap.crossJoin"), "info", "média", m.index);
  }

  // ---- NOT IN (SELECT …) — armadilha de NULL -----------------------------------------------------
  const notInRe = /\bNOT\s+IN\s*\(\s*SELECT\b/gi;
  while ((m = notInRe.exec(s))) {
    add("not-in-subquery", hostT("ap.notIn"), "warn", "alta", m.index);
  }

  // ---- UNION sem ALL ------------------------------------------------------------------------------
  const unionRe = /\bUNION\b(?!\s+ALL\b)/gi;
  while ((m = unionRe.exec(s))) {
    add("union-sem-all", hostT("ap.unionSemAll"), "warn", "média", m.index);
  }

  // ---- ORDER BY em subquery (sem LIMIT) ------------------------------------------------------------
  const obRe = /\bORDER\s+BY\b/gi;
  while ((m = obRe.exec(s))) {
    const depth = d[m.index];
    if (depth === 0) continue;
    // dentro de OVER(…) ou de função (paren aberto precedido de identificador) é legítimo
    let open = -1;
    for (let i = m.index - 1; i >= 0; i--) {
      if (s[i] === "(" && d[i] === depth - 1) {
        open = i;
        break;
      }
    }
    if (open > 0) {
      // Palavra imediatamente antes do `(`: keyword (FROM/JOIN/IN/EXISTS…) → é SUBQUERY;
      // identificador comum (ARRAY_AGG, OVER, GROUP_CONCAT…) → é função/janela, legítimo.
      const before = s.slice(Math.max(0, open - 40), open);
      const w = /([A-Za-z_][\w$]*)\s*$/.exec(before);
      if (w && !SUBQUERY_INTRODUCERS.has(w[1].toLowerCase())) continue;
    }
    const end = clauseEnd(s, d, m.index + 8, depth);
    const rest = s.slice(m.index, end + 64); // LIMIT/FETCH vem logo depois, no mesmo nível
    if (!/\b(LIMIT|FETCH|TOP)\b/i.test(rest)) {
      add("order-by-em-subquery", hostT("ap.orderBySub"), "warn", "média", m.index);
    }
  }

  // ---- LIKE '%…' (curinga inicial mata índice/pruning) ---------------------------------------------
  const likeRe = /\b(I?LIKE)\s+'%/gi;
  while ((m = likeRe.exec(stmt.original))) {
    add("like-curinga-inicial", hostT("ap.likeCuringa"), "warn", "alta", m.index);
  }

  // ---- IN (lista gigante) ---------------------------------------------------------------------------
  const inRe = /\bIN\s*\(/gi;
  while ((m = inRe.exec(s))) {
    const openIdx = m.index + m[0].length - 1;
    const depth = d[openIdx];
    let commas = 0;
    let hasSelect = false;
    for (let i = openIdx + 1; i < s.length; i++) {
      if (s[i] === ")" && d[i] === depth) break;
      if (s[i] === "," && d[i] === depth + 1) commas++;
      if (/[Ss]/.test(s[i]) && /^SELECT\b/i.test(s.slice(i, i + 7))) hasSelect = true;
    }
    if (!hasSelect && commas >= 50) {
      add("in-lista-grande", hostT("ap.inListaGrande", { count: commas + 1 }), "warn", "média", m.index);
    }
  }

  // ---- função sobre coluna em filtro (não-sargável) --------------------------------------------------
  const whereRe = /\bWHERE\b/gi;
  while ((m = whereRe.exec(s))) {
    const depth = d[m.index];
    const end = clauseEnd(s, d, m.index + 5, depth);
    const span = s.slice(m.index, end);
    // A coluna pode ser o 1º argumento (UPPER(col)) ou vir após um literal (DATE_TRUNC('day', col)).
    const fnRe =
      /\b(UPPER|LOWER|TRIM|LTRIM|RTRIM|SUBSTR|SUBSTRING|CAST|TO_CHAR|TO_DATE|DATE_TRUNC|DATE|YEAR|MONTH|DAY|CONVERT|NVL|IFNULL|COALESCE)\s*\(\s*(?:'[^']*'\s*,\s*)?[A-Za-z_][\w.$]*\s*(?:,[^()]*|\s+AS\s+\w+)?\)\s*(?:=|!=|<>|>=|<=|>|<|\bIN\b|\bLIKE\b|\bBETWEEN\b)/gi;
    let f: RegExpExecArray | null;
    while ((f = fnRe.exec(span))) {
      add("funcao-em-filtro", hostT("ap.funcaoEmFiltro", { fn: f[1].toUpperCase() }), "warn", "média", m.index + f.index);
    }
  }

  // ---- CTE definida e nunca usada ---------------------------------------------------------------------
  for (const cte of stmt.ctes) {
    const defRe = new RegExp(String.raw`\b${escapeRe(cte)}\s*(\([^)]*\))?\s+AS\s*\(`, "i");
    const def = defRe.exec(s);
    if (!def) continue;
    // fim do corpo da definição
    const openIdx = def.index + def[0].length - 1;
    const depth = d[openIdx];
    let close = s.length;
    for (let i = openIdx + 1; i < s.length; i++) {
      if (s[i] === ")" && d[i] === depth) {
        close = i;
        break;
      }
    }
    const useRe = new RegExp(String.raw`\b${escapeRe(cte)}\b`, "gi");
    let used = false;
    let u: RegExpExecArray | null;
    while ((u = useRe.exec(s))) {
      if (u.index < def.index || u.index > close) {
        used = true;
        break;
      }
      if (u.index > def.index + cte.length && u.index < close) {
        // referência dentro do PRÓPRIO corpo = recursiva (WITH RECURSIVE) — conta como uso
        used = true;
        break;
      }
    }
    if (!used) add("cte-nao-usada", hostT("ap.cteNaoUsada", { cte }), "warn", "alta", def.index);
  }

  // ---- janela sem PARTITION BY -------------------------------------------------------------------------
  const overRe = /\bOVER\s*\(\s*(ORDER\b|\))/gi;
  while ((m = overRe.exec(s))) {
    add("janela-sem-partition", hostT("ap.janelaSemPartition"), "info", "baixa", m.index);
  }

  // ---- INSERT sem lista de colunas ------------------------------------------------------------------------
  if (stmt.kind === "insert" && !/\bINSERT\s+INTO\s+(?:"[^"]+"|[\w$.]+)\s*\(/i.test(s)) {
    add("insert-sem-colunas", hostT("ap.insertSemColunas"), "warn", "média", 0);
  }

  // ---- LIMIT em modelo dbt ----------------------------------------------------------------------------------
  if (opts.isDbtModel) {
    const limRe = /\bLIMIT\s+\d+/gi;
    while ((m = limRe.exec(s))) {
      if (d[m.index] === 0) {
        add("limit-em-modelo-dbt", hostT("ap.limitDbt"), "warn", "alta", m.index);
      }
    }
  }

  return out;
}

function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Formata achados para exibição no cartão do validador (uma linha por achado, no locale ativo).
export function renderFindings(findings: SqlFinding[]): string {
  const icon: Record<SqlSeverity, string> = { error: "✖", warn: "⚠", info: "ℹ" };
  return findings
    .map((f) => hostT("ap.line", { icon: icon[f.severity], line: f.line, rule: f.rule, conf: confidenceLabel(f.confidence), message: f.message }))
    .join("\n");
}
