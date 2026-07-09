// PII/LGPD (Onda 4): (a) auditoria de SCHEMA por nome de coluna — dicionário LGPD determinístico
// sobre o índice (dbt + snapshots de warehouse), 100% local, com sugestão de mascaramento por
// dialeto; (b) mascaramento de AMOSTRAS — valores que casam padrões de dado pessoal brasileiro
// (CPF/CNPJ, e-mail, telefone, cartão) viram ▇ antes de qualquer exibição/contexto. PURO.
import { DbtIndex } from "../dbt/artifacts";

export interface PiiFinding {
  table: string;
  column: string;
  category: string;
  confidence: "alta" | "média";
}

// Dicionário LGPD por nome de coluna (pt-BR + en comuns em warehouses brasileiros).
const PII_CATEGORIES: { category: string; re: RegExp; confidence: "alta" | "média" }[] = [
  { category: "documento (CPF/CNPJ/RG)", re: /\b(cpf|cnpj|rg|passaporte|cpf_cnpj|nr_?doc|num_?doc)\b/i, confidence: "alta" },
  { category: "nome de pessoa", re: /\b(nome|nome_?(completo|cliente|mae|pai|social)|first_?name|last_?name|full_?name)\b/i, confidence: "média" },
  { category: "e-mail", re: /\b(email|e_?mail|ds_?email)\b/i, confidence: "alta" },
  { category: "telefone", re: /\b(telefone|celular|fone|phone|msisdn|nr_?tel)\b/i, confidence: "alta" },
  { category: "endereço", re: /\b(endereco|logradouro|cep|address|zip_?code|complemento|bairro)\b/i, confidence: "média" },
  { category: "nascimento/idade", re: /\b(nascimento|dt_?nasc|birth|idade)\b/i, confidence: "alta" },
  { category: "financeiro pessoal", re: /\b(salario|renda|score|limite_?credito)\b/i, confidence: "média" },
  { category: "cartão de pagamento", re: /\b(cartao|card_?number|pan|cvv|bin)\b/i, confidence: "alta" },
  { category: "credencial", re: /\b(senha|password|passwd|token|secret|api_?key)\b/i, confidence: "alta" },
  { category: "dado sensível (LGPD art. 5º II)", re: /\b(saude|cid|diagnostico|religiao|etnia|raca|orientacao|biometria|genero|sexo)\b/i, confidence: "média" },
  { category: "geolocalização", re: /\b(latitude|longitude|geoloc|lat_?lng)\b/i, confidence: "média" },
];

export function scanIndexForPii(index: DbtIndex): PiiFinding[] {
  const out: PiiFinding[] = [];
  for (const node of index.relationalNodes()) {
    for (const col of node.columns) {
      const hit = PII_CATEGORIES.find((c) => c.re.test(col.name));
      if (hit) out.push({ table: node.relation, column: col.name, category: hit.category, confidence: hit.confidence });
    }
  }
  return out.sort((a, b) => (a.confidence === b.confidence ? a.table.localeCompare(b.table) : a.confidence === "alta" ? -1 : 1));
}

export function renderPiiCard(findings: PiiFinding[], tablesScanned: number): string {
  const head = "### Auditoria PII / LGPD (por nome de coluna)";
  if (tablesScanned === 0) {
    return `${head}\n\nSem schema para auditar — rode \`dbt parse\` (projeto dbt) ou \`/schema-db\` (warehouse) primeiro.`;
  }
  if (findings.length === 0) {
    return `${head}\n\n✅ Nenhuma coluna com nome típico de dado pessoal em ${tablesScanned} tabelas. (Heurística por NOME — conteúdo não foi lido.)`;
  }
  const rows = findings.slice(0, 40).map((f) => `| \`${f.table}\` | \`${f.column}\` | ${f.category} | ${f.confidence} |`);
  return [
    head,
    "",
    `⚠ **${findings.length} coluna${findings.length === 1 ? "" : "s"} candidatas a dado pessoal** em ${tablesScanned} tabelas (heurística por NOME — o conteúdo não foi lido):`,
    "",
    "| tabela | coluna | categoria | confiança |",
    "|---|---|---|---|",
    ...rows,
    findings.length > 40 ? `\n_… +${findings.length - 40} colunas._` : "",
    "",
    "Próximos passos: mascaramento no warehouse (Oracle: `DBMS_REDACT`/Data Redaction; BigQuery: policy tags + column-level access; Postgres: views com máscara + GRANT por coluna) e minimização nos marts (não propague documento/contato para camadas de consumo).",
    "_O FORGE já mascara amostras exibidas no chat; a auditoria orienta a proteção NA ORIGEM._",
  ].join("\n");
}

// ---- mascaramento de amostras -------------------------------------------------------------------

const SAMPLE_MASKS: RegExp[] = [
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, // CPF
  /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, // CNPJ
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, // e-mail
  /\b(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?9?\d{4}[-\s]?\d{4}\b/g, // telefone BR
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{2,4}\b/g, // cartão
];

// Mascara valores com CARA de dado pessoal numa amostra (CSV/texto) ANTES de exibir/anexar.
// Conservador por natureza: melhor mascarar um número inocente que vazar um CPF no trace.
export function maskDataSample(text: string): string {
  let out = text ?? "";
  for (const re of SAMPLE_MASKS) out = out.replace(re, "▇▇▇");
  return out;
}
