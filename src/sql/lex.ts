// Léxico SQL de baixo nível para a camada determinística: remoção de ruído (comentários e literais
// de string viram espaços PRESERVANDO comprimento e quebras de linha — offsets e nº de linha continuam
// válidos), split de statements no `;` de nível zero e mapa de profundidade de parênteses. PURO/testável.
// É a fundação do classificador, das regras anti-padrão e do lineage — heurístico por construção
// (dialeto-agnóstico), nunca um parser completo: na dúvida, as camadas acima degradam confiança.

// Substitui comentários (`--`, `/* */`, `#` NÃO — em MySQL `#` comenta, mas em Snowflake/BQ é parte de
// identificadores; fica de fora por segurança) e literais de string (aspas simples com escape `''`,
// dollar-quoting $tag$...$tag$ do Postgres) por espaços. Aspas duplas/backticks/colchetes delimitam
// IDENTIFICADORES — o conteúdo é mantido. Quebras de linha dentro do trecho apagado são preservadas.
export function stripSqlNoise(sql: string): string {
  const src = sql ?? "";
  const out = src.split("");
  const n = src.length;
  let i = 0;

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
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") {
          j += 2; // '' = aspas escapadas dentro do literal
          continue;
        }
        if (src[j] === "'") break;
        j++;
      }
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
        const to = close === -1 ? n : close + open.length;
        blank(i, to);
        i = to;
        continue;
      }
    }
    if (c === '"' || c === "`") {
      // Identificador quotado: pula o corpo inteiro (conteúdo preservado) para um `"a -- b"` não
      // ser confundido com comentário.
      const close = src.indexOf(c, i + 1);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (c === "[") {
      const close = src.indexOf("]", i + 1);
      i = close === -1 ? n : close + 1;
      continue;
    }
    i++;
  }
  return out.join("");
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
