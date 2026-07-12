// Redação UNIFICADA de segredos + PII — a ÚNICA fonte de verdade, importada pelo CLIENTE (src/util/redact.ts,
// bundlada pelo esbuild) E pelo GATEWAY (server.mjs). Antes DIVERGIAM: o cliente só pegava KV+Bearer; o gateway
// só sk-*/pk-lf-*/email/dígitos. Ambos perdiam o segredo MAIS COMUM em config de dados. Puro/testável. (#8)
//
// CommonJS (.cjs): o gateway é ESM e importa CJS sem atrito; o cliente é CJS (esbuild/Node16) e NÃO pode
// importar ESM (.mjs) por `require` (TS1479). CJS é o denominador comum dos dois lados.
//
// Filosofia: defesa em profundidade no EGRESSO (conteúdo que sai do cliente ao gateway/diagnóstico/Langfuse) —
// NÃO é fronteira de segurança. CONSERVADOR com conteúdo legítimo (o valor precisa PARECER segredo — tem
// dígito), agressivo com formatos INEQUÍVOCOS. Endurecido por DUAS rodadas de stress adversarial (184 casos):
// 0 ReDoS; leaks (sk-proj/github/slack/stripe/google/azure/npm) e falsos-positivos (color_key/pwd/prosa/CSS)
// fechados. ReDoS: TODO quantificador é BOUNDED; o bloco PEM é NÃO-guloso ancorado no END (O(n)).
// Limitação conhecida (long-tail aceito): `bearer <termo-técnico-com-dígito>` em prosa (ex.: "bearer md5sum")
// pode ser mascarado — raríssimo, e só afeta trace de observabilidade, não a saída do usuário.

const R = "«oculto»";

// Bloco PEM de chave PRIVADA. Cobre RSA/EC/DSA/OPENSSH/PGP/ENCRYPTED.
const PEM = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?:[- ]BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?:[- ]BLOCK)?-----/g;

// userinfo de URL: scheme://user:SENHA@host → mascara SÓ a senha (preserva user/host). BOUNDED (anti-ReDoS).
const URL_USERINFO = /([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,255}:)([^\s@/]{1,255})(@)/gi;

// KV: chave-que-parece-segredo = valor SECRET-LIKE. `account_key` (Azure Storage) incluído; `pwd` REMOVIDO
// (ambíguo: 'print working dir'/cwd — FP de caminho). Sem o genérico `_key` e sem connection-string/dsn (a
// senha é pega pelo URL_USERINFO na forma URL e pelo `password=` INTERNO na forma keyword). Achados do stress.
const SECRET_KEY =
  "(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|" +
  "account[_-]?key|client[_-]?secret|secret|password|passwd|authorization|auth[_-]?token|" +
  "[a-z0-9]{0,30}[_-](?:token|secret|password|passwd|apikey))";
// valor SECRET-LIKE com DÍGITO (o dígito mata o FP de "background-primary"/"/home/path"/"IDENTIFIER"): string
// entre aspas, OU token cru até espaço/aspas (charset AMPLO — inclui '~!@#...' de senhas Azure/AD; o valor já
// veio depois de uma chave secreta confirmada). BOUNDED (anti-ReDoS).
const SECRET_VALUE = "(['\"](?=[^'\"\\n]*[0-9])[^'\"\\n]{5,255}['\"]|(?=[^\\s'\"]{0,512}[0-9])[^\\s'\"]{8,512})";
const KV = new RegExp(`(${SECRET_KEY}\\s*[:=]\\s*)${SECRET_VALUE}`, "gi");

// Bearer com valor SECRET-LIKE (dígito) — mata o FP de prosa ("Bearer authentication" → passa limpo).
const BEARER = /(bearer\s+)((?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{8,512})/gi;
// JWT: header.payload.signature em base64url (o header começa com `eyJ`).
const JWT = /\beyJ[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]{5,512}/g;
// AWS access key id.
const AWS_AKIA = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

// Tokens de provedor por PREFIXO conhecido. sk-/pk- são PRECISOS (sk-proj-/sk-lf- explícitos, ou 40+ contíguos
// do clássico) → NÃO pegam classe CSS (sk-h2-heading, sk-col-12: segmentos curtos com hífen). Todos BOUNDED.
const PROVIDER_TOKENS = [
  /\bsk-proj-[A-Za-z0-9]{16,120}/g, // OpenAI project key
  /\b[sp]k-lf-[A-Za-z0-9-]{16,120}/g, // Langfuse sk-lf-/pk-lf- (uuid com hífen)
  /\bsk-[A-Za-z0-9]{20,120}/g, // OpenAI clássico. 20+ CONTÍGUOS (sem hífen) → CSS (sk-h2-heading, segmentos curtos hifenados) não casa
  /\b[srp]k_(?:live|test)_[A-Za-z0-9]{10,120}/gi, // Stripe sk_live_/rk_test_/pk_live_
  /\bgh[pousr]_[A-Za-z0-9]{20,120}/g, // GitHub clássico ghp_/gho_/ghu_/ghs_/ghr_
  /\bgithub_pat_[A-Za-z0-9_]{20,120}/g, // GitHub fine-grained PAT
  /\bnpm_[A-Za-z0-9]{30,50}/g, // npm automation/publish token (~36 chars, range tolerante)
  /\bxox[baprs]-[A-Za-z0-9-]{10,120}/g, // Slack xoxb-/xoxp-/xoxa-/xoxr-/xoxs-
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/]{20,120}/g, // Slack incoming-webhook URL
  /\bAIza[A-Za-z0-9_-]{30,45}/g, // Google API key
];

// PII (LGPD) em formatos INEQUÍVOCOS:
const CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g; // 123.456.789-01
const CNPJ = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g; // 12.345.678/0001-90
const PHONE_BR = /(?:\+55[\s-]?)?\(\d{2}\)[\s-]?9?\d{4}[\s-]?\d{4}\b/g; // exige (DD) → sem falso-positivo
const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g; // BOUNDED (RFC)
const RAW_DIGITS = /\b\d{11,16}\b/g; // CPF/CNPJ/cartão sem formatação. Por ÚLTIMO.

/** Mascara segredos e PII num texto. Idempotente, sem exceção. */
function redact(text) {
  if (!text || typeof text !== "string") return text;
  let s = text
    .replace(PEM, R)
    .replace(URL_USERINFO, `$1${R}$3`)
    .replace(KV, `$1${R}`)
    .replace(BEARER, `$1${R}`)
    .replace(JWT, R)
    .replace(AWS_AKIA, R);
  for (const re of PROVIDER_TOKENS) s = s.replace(re, R);
  return s
    .replace(CPF, R)
    .replace(CNPJ, R)
    .replace(PHONE_BR, R)
    .replace(EMAIL, R)
    .replace(RAW_DIGITS, R);
}

module.exports = { redact };
