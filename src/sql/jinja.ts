// Pré-processamento de Jinja (dbt) para a camada determinística: {{ ref('x') }} e {{ source('a','b') }}
// viram os identificadores REAIS que representam ({{ ref }} é exatamente uma referência de tabela), o
// resto do Jinja vira neutro — preservando o Nº DE LINHAS para os achados apontarem a linha certa no
// arquivo do modelo. É o que permite analisar modelos dbt CRUS (o calcanhar de Aquiles declarado do
// altimate-core: "sqlglot não parseia {{ }}"); quando o SQL compilado existir em target/compiled, ele é
// preferível a este strip. PURO/testável.

export interface JinjaStripResult {
  sql: string;
  hadJinja: boolean; // qualquer substituição → camadas acima degradam a CONFIANÇA dos achados
}

// Preserva as quebras de linha do trecho substituído (offsets de linha continuam válidos).
function keepNewlines(match: string, replacement: string): string {
  const newlines = match.split("\n").length - 1;
  return replacement + "\n".repeat(newlines);
}

const REF_RE = /\{\{-?\s*ref\s*\(\s*(?:'([^']*)'|"([^"]*)")\s*(?:,\s*(?:'([^']*)'|"([^"]*)")\s*)?\)\s*-?\}\}/gi;
const SOURCE_RE = /\{\{-?\s*source\s*\(\s*(?:'([^']*)'|"([^"]*)")\s*,\s*(?:'([^']*)'|"([^"]*)")\s*\)\s*-?\}\}/gi;

export function stripJinja(sql: string): JinjaStripResult {
  const src = sql ?? "";
  if (!src.includes("{{") && !src.includes("{%") && !src.includes("{#")) {
    return { sql: src, hadJinja: false };
  }
  let out = src;

  // {{ ref('a') }} → a · {{ ref('pkg','a') }} → a (o 2º argumento é o nome do modelo)
  out = out.replace(REF_RE, (m, s1, d1, s2, d2) => keepNewlines(m, s2 ?? d2 ?? s1 ?? d1 ?? "__ref__"));
  // {{ source('raw','orders') }} → raw.orders (é assim que o modelo enxerga a tabela)
  out = out.replace(SOURCE_RE, (m, s1, d1, s2, d2) => keepNewlines(m, `${s1 ?? d1}.${s2 ?? d2}`));
  // {{ this }} → alvo do próprio modelo (aparece em incrementais: WHERE x > (SELECT max(x) FROM {{ this }}))
  out = out.replace(/\{\{-?\s*this\s*-?\}\}/gi, (m) => keepNewlines(m, "__this__"));
  // {{ config(...) }} é declaração do dbt, não SQL — some (um `__jinja__` no TOPO desancoraria o WITH).
  out = out.replace(/\{\{-?\s*config\s*\([\s\S]*?\)\s*-?\}\}/gi, (m) => keepNewlines(m, ""));
  // Comentários {# … #} e tags {% … %} somem (config/macros/if — estrutura não-SQL).
  out = out.replace(/\{#[\s\S]*?#\}/g, (m) => keepNewlines(m, ""));
  out = out.replace(/\{%-?[\s\S]*?-?%\}/g, (m) => keepNewlines(m, ""));
  // Qualquer outra expressão {{ … }} vira identificador neutro (num SELECT parece uma coluna — inócuo).
  out = out.replace(/\{\{-?[\s\S]*?-?\}\}/g, (m) => keepNewlines(m, "__jinja__"));

  return { sql: out, hadJinja: out !== src };
}

// O conteúdo parece um modelo dbt? (Jinja de dbt OU caminho típico models/ num projeto dbt.)
export function looksLikeDbtModel(relPath: string, content: string): boolean {
  const p = (relPath ?? "").replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)(models|snapshots|seeds|analyses|macros)\//.test(p)) return true;
  return /\{\{\s*(ref|source|config)\s*[(\s]/i.test(content ?? "");
}
