// Léxico SQL de baixo nível para a camada determinística: remoção de ruído (comentários e literais
// de string viram espaços PRESERVANDO comprimento e quebras de linha — offsets e nº de linha continuam
// válidos), split de statements no `;` de nível zero e mapa de profundidade de parênteses. PURO/testável.
// É a fundação do classificador, das regras anti-padrão e do lineage — heurístico por construção
// (dialeto-agnóstico), nunca um parser completo: na dúvida, as camadas acima degradam confiança.

export interface StrippedSql {
  text: string;
  // Um literal de string abriu e NUNCA fechou: o resto do statement foi apagado da análise. As camadas
  // acima devem DEGRADAR (achado de segurança vira advisory) em vez de opinar com confiança alta —
  // achado da revisão adversarial: o descompasso pode tanto bloquear um UPDATE filtrado quanto deixar
  // passar um sem WHERE (o texto apagado pode conter ou fabricar o WHERE).
  unterminated: boolean;
}

// Substitui comentários (`--`, `/* */`, `#` NÃO — em MySQL `#` comenta, mas em Snowflake/BQ é parte de
// identificadores; fica de fora por segurança) e literais de string (aspas simples com escape `''` E
// `\'` — MySQL/BigQuery/Spark usam backslash; aceitar ambos é seguro para uma camada heurística,
// dollar-quoting $tag$...$tag$ do Postgres) por espaços. Aspas duplas/backticks/colchetes delimitam
// IDENTIFICADORES — o conteúdo é mantido, EXCETO `;`/`(`/`)` (viram espaço para não corromper o split
// de statements e o mapa de profundidade). Quebras de linha nos trechos apagados são preservadas.
export function stripSqlNoiseEx(sql: string): StrippedSql {
  const src = sql ?? "";
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let unterminated = false;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };

  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : "";

    if (c === "-" && next === "-") {
      const end = src.indexOf("\n", i);
      const to = end === -1 ? n : end;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const to = end === -1 ? n : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2; // \' (MySQL/BigQuery/Spark) — escape por backslash
          continue;
        }
        if (src[j] === "'" && src[j + 1] === "'") {
          j += 2; // '' = aspas escapadas dentro do literal (ANSI)
          continue;
        }
        if (src[j] === "'") {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) unterminated = true;
      const to = Math.min(j + 1, n);
      // Mantém as aspas delimitadoras (regras como LIKE '%…' inspecionam o ORIGINAL; aqui o
      // conteúdo vira espaço para nenhum FROM/JOIN dentro de string virar tabela fantasma).
      blank(i + 1, to - 1);
      i = to;
      continue;
    }
    if (c === "$") {
      // Dollar-quoting do Postgres: $$…$$ ou $tag$…$tag$.
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i));
      if (m) {
        const open = m[0];
        const close = src.indexOf(open, i + open.length);
        if (close === -1) unterminated = true;
        const to = close === -1 ? n : close + open.length;
        blank(i, to);
        i = to;
        continue;
      }
    }
    if (c === '"' || c === "`" || c === "[") {
      // Identificador quotado: conteúdo preservado (normIdent/lookups extraem o interior), mas os
      // caracteres ESTRUTURAIS internos viram espaço — um `"tab;ela"` não pode dividir o statement
      // nem desbalancear o depthMap (achado da revisão adversarial).
      const closeCh = c === "[" ? "]" : c;
      const close = src.indexOf(closeCh, i + 1);
      const to = close === -1 ? n : close;
      for (let k = i + 1; k < to; k++) {
        if (out[k] === ";" || out[k] === "(" || out[k] === ")") out[k] = " ";
      }
      i = close === -1 ? n : close + 1;
      continue;
    }
    i++;
  }
  return { text: out.join(""), unterminated };
}

export function stripSqlNoise(sql: string): string {
  return stripSqlNoiseEx(sql).text;
}

// Profundidade de parênteses ANTES de cada caractere (depth[i] = profundidade em que src[i] vive).
// Sobre o texto JÁ limpo (parênteses dentro de string/comentário não existem mais).
export function depthMap(stripped: string): Int32Array {
  const d = new Int32Array(stripped.length);
  let depth = 0;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === "(") {
      d[i] = depth;
      depth++;
    } else if (stripped[i] === ")") {
      depth = Math.max(0, depth - 1);
      d[i] = depth;
    } else {
      d[i] = depth;
    }
  }
  return d;
}

export interface StatementSlice {
  start: number; // offset no texto original/limpo (mesmos offsets)
  end: number; // exclusivo
  line: number; // 1-based, linha do primeiro caractere não-branco
}

// Divide no `;` de nível 0. Statements vazios (só espaço) são descartados.
export function splitStatements(stripped: string): StatementSlice[] {
  const d = depthMap(stripped);
  const out: StatementSlice[] = [];
  let start = 0;
  const pushSlice = (from: number, to: number) => {
    const text = stripped.slice(from, to);
    const m = /\S/.exec(text);
    if (!m) return;
    const line = lineOf(stripped, from + m.index);
    out.push({ start: from, end: to, line });
  };
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === ";" && d[i] === 0) {
      pushSlice(start, i);
      start = i + 1;
    }
  }
  pushSlice(start, stripped.length);
  return out;
}

// Linha 1-based de um offset.
export function lineOf(text: string, offset: number): number {
  let line = 1;
  const to = Math.min(offset, text.length);
  for (let i = 0; i < to; i++) if (text[i] === "\n") line++;
  return line;
}

// Palavras-chave que ENCERRAM uma cláusula (FROM/WHERE/ON…) no mesmo nível de profundidade.
export const CLAUSE_BOUNDARY_RE =
  /\b(WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|QUALIFY|WINDOW|LIMIT|OFFSET|FETCH|UNION|EXCEPT|INTERSECT|RETURNING|INTO|SET|VALUES)\b/gi;

// Fim da cláusula iniciada em `from` (offset APÓS a keyword de abertura), no nível `depth`:
// primeira boundary-keyword no mesmo nível, primeiro `)` que fecha abaixo do nível, ou fim do texto.
export function clauseEnd(stripped: string, d: Int32Array, from: number, depth: number): number {
  CLAUSE_BOUNDARY_RE.lastIndex = from;
  let m: RegExpExecArray | null;
  let boundary = stripped.length;
  while ((m = CLAUSE_BOUNDARY_RE.exec(stripped))) {
    if (d[m.index] === depth) {
      boundary = m.index;
      break;
    }
    if (d[m.index] < depth) {
      boundary = m.index;
      break;
    }
  }
  for (let i = from; i < boundary; i++) {
    if (stripped[i] === ")" && d[i] < depth) return i;
  }
  return boundary;
}
