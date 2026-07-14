// PII/LGPD (Onda 4): (a) auditoria de SCHEMA por nome de coluna — dicionário LGPD determinístico
// sobre o índice (dbt + snapshots de warehouse), 100% local, com sugestão de mascaramento por
// dialeto; (b) mascaramento de AMOSTRAS — valores que casam padrões de dado pessoal brasileiro
// (CPF/CNPJ, e-mail, telefone, cartão) viram ▇ antes de qualquer exibição/contexto. PURO.
import { DbtIndex } from "../dbt/artifacts";
import { hostT, HostMessageKey } from "../i18n";

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

// CÓDIGO→TEXTO exibido da confiança PII, resolvido por locale via hostT (o enum nunca muda — este era
// o ponto de inserção da i18n declarado desde o PR 3).
export function piiConfidenceLabel(c: PiiConfidence): string {
  return c === "alta" ? hostT("conf.alta") : c === "média" ? hostT("conf.media") : c;
}

// category dos achados é o CÓDIGO estável pt-BR (fonte, comparável em testes); o texto exibido no
// cartão resolve por locale aqui — fallback no próprio código quando não mapeado.
const PII_CATEGORY_KEY: Record<string, HostMessageKey> = {
  "documento (CPF/CNPJ/RG)": "pii.cat.doc",
  "nome de pessoa": "pii.cat.nome",
  "e-mail": "pii.cat.email",
  telefone: "pii.cat.telefone",
  "endereço": "pii.cat.endereco",
  "nascimento/idade": "pii.cat.nascimento",
  "financeiro pessoal": "pii.cat.financeiro",
  "cartão de pagamento": "pii.cat.cartao",
  credencial: "pii.cat.credencial",
  "dado sensível (LGPD art. 5º II)": "pii.cat.sensivel",
  "geolocalização": "pii.cat.geo",
};
function piiCategoryLabel(category: string): string {
  const key = PII_CATEGORY_KEY[category];
  return key ? hostT(key) : category;
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
  const head = hostT("pii.head");
  if (tablesScanned === 0) {
    return `${head}\n\n${hostT("pii.noSchema")}`;
  }
  if (findings.length === 0) {
    return `${head}\n\n${hostT("pii.clean", { tables: tablesScanned })}`;
  }
  const rows = findings.slice(0, 40).map((f) => `| \`${f.table}\` | \`${f.column}\` | ${piiCategoryLabel(f.category)} | ${piiConfidenceLabel(f.confidence)} |`);
  return [
    head,
    "",
    hostT("pii.found", { count: findings.length, tables: tablesScanned }),
    "",
    hostT("pii.cols"),
    "|---|---|---|---|",
    ...rows,
    findings.length > 40 ? `\n${hostT("pii.more", { n: findings.length - 40 })}` : "",
    "",
    hostT("pii.next"),
    hostT("pii.footer"),
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

// Divide UMA linha CSV em campos respeitando aspas RFC4180: vírgula dentro de "…" NÃO separa, e "" é uma aspa
// literal. O split(",") ingênuo quebrava `"Silva, João"` em 2 células → as colunas DESLOCAVAM e a coluna
// sensível (ex.: cpf nu, que os regex acima não pegam sem formatação) caía fora do índice mascarado → PII NUA
// vazava. Preserva o texto CRU de cada campo (com aspas) para rejuntar mantendo os não-mascarados. Puro.
function splitCsvRow(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '""';
        i++;
      } else if (ch === '"') {
        cur += '"';
        inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      cur += '"';
      inQ = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else cur += ch;
  }
  fields.push(cur);
  return fields;
}

// Valor "nu" de um campo CSV (tira as aspas externas e desdobra "" → ") — para os testes de sensibilidade/vazio.
function csvValue(field: string): string {
  const t = field.trim();
  return /^".*"$/s.test(t) ? t.slice(1, -1).replace(/""/g, '"') : t;
}

// Mascara valores com CARA de dado pessoal numa amostra (CSV/texto) ANTES de exibir/anexar. Além dos
// padrões formatados, mascara a COLUNA inteira quando o cabeçalho do CSV a nomeia como sensível
// (pega CPF/telefone nus sem falso-positivo em contagens).
export function maskDataSample(text: string): string {
  let out = text ?? "";
  for (const re of SAMPLE_MASKS) out = out.replace(re, "▇▇▇");
  // mascaramento por coluna: se a 1ª linha é cabeçalho e alguma coluna é sensível, apaga os valores dela.
  // Campos são separados por RFC4180 (splitCsvRow) — não por split(",") ingênuo, que desalinhava as colunas
  // quando um valor tinha vírgula-entre-aspas e deixava a coluna sensível NUA passar.
  const lines = out.split(/\r?\n/);
  if (lines.length >= 2 && lines[0].includes(",")) {
    const headers = splitCsvRow(lines[0]).map(csvValue);
    const sensitiveIdx = headers.map((h, i) => (SENSITIVE_HEADER.test(h) ? i : -1)).filter((i) => i >= 0);
    if (sensitiveIdx.length > 0) {
      for (let r = 1; r < lines.length; r++) {
        if (!lines[r].includes(",")) continue;
        const cells = splitCsvRow(lines[r]);
        for (const i of sensitiveIdx) if (i < cells.length && csvValue(cells[i])) cells[i] = "▇▇▇";
        lines[r] = cells.join(",");
      }
      out = lines.join("\n");
    }
  }
  return out;
}
