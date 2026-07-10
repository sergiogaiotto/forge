// PII/LGPD (Onda 4): (a) auditoria de SCHEMA por nome de coluna — dicionário LGPD determinístico
// sobre o índice (dbt + snapshots de warehouse), 100% local, com sugestão de mascaramento por
// dialeto; (b) mascaramento de AMOSTRAS — valores que casam padrões de dado pessoal brasileiro
// (CPF/CNPJ, e-mail, telefone, cartão) viram ▇ antes de qualquer exibição/contexto. PURO.
import { DbtIndex } from "../dbt/artifacts";

// "alta"/"média" são CÓDIGOS INTERNOS ESTÁVEIS — usados como CHAVE de ordenação (=== "alta" em
// scanIndexForPii). NUNCA traduzir/exibir crus: o texto para o usuário vem de piiConfidenceLabel() (é
// lá que a i18n futura entra). Traduzir estes valores quebraria a ordenação em silêncio (mesmo padrão
// do SqlConfidence).
export type PiiConfidence = "alta" | "média";

export interface PiiFinding {
  table: string;
  column: string;
  category: string;
  confidence: PiiConfidence;
}

// Mapa CÓDIGO→TEXTO exibido da confiança PII (identidade por ora; a i18n troca ESTE mapa, não o enum).
const PII_CONFIDENCE_LABEL: Record<PiiConfidence, string> = { alta: "alta", "média": "média" };
export function piiConfidenceLabel(c: PiiConfidence): string {
  return PII_CONFIDENCE_LABEL[c] ?? c;
}

// Dicionário LGPD por nome de coluna (pt-BR + en comuns em warehouses brasileiros).
const PII_CATEGORIES: { category: string; re: RegExp; confidence: PiiConfidence }[] = [
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
  const rows = findings.slice(0, 40).map((f) => `| \`${f.table}\` | \`${f.column}\` | ${f.category} | ${piiConfidenceLabel(f.confidence)} |`);
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

// Padrões de dado pessoal em amostras. Exigem PONTUAÇÃO/FORMATO plausível para NÃO engolir inteiros
// nus (um COUNT de 8 dígitos ou um id não podem virar ▇ — a revisão adversarial mostrou máscara
// corrompendo agregados). CPF/CNPJ/telefone só casam formatados OU com marcador de contexto; e-mail é
// inequívoco. O caminho de AGREGADOS (paridade/inventário/custo) ainda passa skipMask, defesa dupla.
const SAMPLE_MASKS: RegExp[] = [
  /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, // CPF formatado
  /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, // CNPJ formatado
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, // e-mail (inequívoco)
  /\+?55\s?\(?\d{2}\)?\s?9?\d{4}[-\s]\d{4}\b/g, // telefone BR com DDI/DDD e separador
  /\(\d{2}\)\s?9?\d{4}[-\s]?\d{4}\b/g, // telefone com DDD entre parênteses
  /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{2,4}\b/g, // cartão com separadores
];

// Colunas cujo VALOR deve ser mascarado mesmo sem formatação (CPF/telefone nus numa coluna nomeada).
// Usado quando o CSV tem cabeçalho conhecido — casamento por posição de coluna.
const SENSITIVE_HEADER = /\b(cpf|cnpj|rg|telefone|celular|fone|phone|cartao|card|pan|senha|password|token|email)\b/i;

// Mascara valores com CARA de dado pessoal numa amostra (CSV/texto) ANTES de exibir/anexar. Além dos
// padrões formatados, mascara a COLUNA inteira quando o cabeçalho do CSV a nomeia como sensível
// (pega CPF/telefone nus sem falso-positivo em contagens).
export function maskDataSample(text: string): string {
  let out = text ?? "";
  for (const re of SAMPLE_MASKS) out = out.replace(re, "▇▇▇");
  // mascaramento por coluna: se a 1ª linha é cabeçalho e alguma coluna é sensível, apaga os valores dela
  const lines = out.split(/\r?\n/);
  if (lines.length >= 2 && lines[0].includes(",")) {
    const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const sensitiveIdx = headers.map((h, i) => (SENSITIVE_HEADER.test(h) ? i : -1)).filter((i) => i >= 0);
    if (sensitiveIdx.length > 0) {
      for (let r = 1; r < lines.length; r++) {
        if (!lines[r].includes(",")) continue;
        const cells = lines[r].split(",");
        for (const i of sensitiveIdx) if (i < cells.length && cells[i].trim()) cells[i] = "▇▇▇";
        lines[r] = cells.join(",");
      }
      out = lines.join("\n");
    }
  }
  return out;
}
