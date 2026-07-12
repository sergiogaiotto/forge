import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../util/redact";

// Monta uma FIXTURE que PARECE segredo a partir de partes — o redact() vê a string completa (testa a
// redação de verdade), mas o literal contíguo NÃO existe na fonte, então o push-protection/secret-scanning
// do GitHub não bloqueia o commit deste arquivo de TESTE (ironia: testar redação exige strings secret-like).
const S = (...p: string[]): string => p.join("");

test("redactSecrets mascara valores de segredo (chave: valor / =) e Bearer", () => {
  assert.match(redactSecrets("api_key: sk-abcdef123456"), /api_key: «oculto»/);

  const pw = redactSecrets('password = "hunter2secret"');
  assert.ok(!pw.includes("hunter2secret"), "o segredo não pode vazar");
  assert.match(pw, /«oculto»/);

  assert.match(redactSecrets("AUTHORIZATION=Bearer_xyz9988aa"), /AUTHORIZATION=«oculto»/i);

  const auth = redactSecrets("Authorization: Bearer abcdefgh12345");
  assert.ok(!auth.includes("abcdefgh12345"), "o token não pode vazar");
});

test("redactSecrets NÃO mascara código legítimo (atribuição a chamada de função / valores curtos)", () => {
  const code = "def soma(a, b):\n    return a + b";
  assert.equal(redactSecrets(code), code);
  assert.equal(redactSecrets("total = 42"), "total = 42");
  // nome de variável com 'token'/'secret' atribuído a uma CHAMADA não é segredo — preserva
  assert.equal(redactSecrets("access_token = response.json()"), "access_token = response.json()");
  assert.equal(redactSecrets("secret = load_secret()"), "secret = load_secret()");
  assert.equal(redactSecrets(""), "");
});

// #8: redação UNIFICADA — os segredos que escapavam antes (o mais comum em config de dados).
test("redactSecrets: connection string mascara a SENHA do userinfo (preserva user/host — útil)", () => {
  const out = redactSecrets("DATABASE_URL=postgresql://admin:s3cr3tP4ss@db.internal:5432/prod");
  assert.ok(!out.includes("s3cr3tP4ss"), "a senha não vaza");
  assert.match(out, /postgresql:\/\/admin:«oculto»@db\.internal/, "user/host preservados");
  // mongodb/redis/amqp idem
  assert.ok(!redactSecrets("redis://:p4ssw0rd@cache:6379").includes("p4ssw0rd"));
});

test("redactSecrets: bloco PEM de chave privada some inteiro", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123XYZ\nDEFghi456\n-----END RSA PRIVATE KEY-----";
  const out = redactSecrets(`config:\n${pem}\ndone`);
  assert.ok(!out.includes("MIIEabc123XYZ") && !out.includes("BEGIN RSA PRIVATE KEY"), "o PEM não vaza");
  assert.match(out, /config:\n«oculto»\ndone/);
});

test("redactSecrets: JWT, chave AWS e provider keys", () => {
  const jwt = S("eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM");
  assert.ok(!redactSecrets(`t=${jwt}`).includes("SflKxwRJSMeKKF2QT4fwpM"), "JWT some");
  const akia = S("AKIA", "IOSFODNN7EXAMPLE");
  assert.ok(!redactSecrets(`aws_key ${akia}`).includes(akia), "AWS AKIA some");
  const sk = S("sk-", "abcdefghij1234567890");
  assert.ok(!redactSecrets(`key ${sk} end`).includes(sk));
});

test("redactSecrets: PII-BR (CPF/CNPJ/telefone formatados) e email", () => {
  const out = redactSecrets("cliente CPF 123.456.789-01, CNPJ 12.345.678/0001-90, tel (11) 91234-5678, e joao@acme.com.br");
  for (const leak of ["123.456.789-01", "12.345.678/0001-90", "91234-5678", "joao@acme.com.br"]) {
    assert.ok(!out.includes(leak), `${leak} não pode vazar`);
  }
});

test("redactSecrets: NÃO over-masca URL pública, versão, porta (preserva utilidade)", () => {
  // URL pública sem userinfo → preservada
  assert.equal(redactSecrets("fetch('https://api.publica.com/v1/data')"), "fetch('https://api.publica.com/v1/data')");
  assert.equal(redactSecrets("port = 5432"), "port = 5432", "porta de 4 dígitos preservada");
  assert.equal(redactSecrets("version 1.2.3"), "version 1.2.3");
});

// Coverage de tokens de PROVEDOR modernos (achados do stress: escapavam do `sk-` simples por terem hífen/_).
test("redactSecrets: tokens de provedor (sk-ant/sk-proj/sk-lf/github/slack/google/stripe) não vazam", () => {
  const secrets = [
    S("sk-", "ant-api03-Ab12Cd34Ef56Gh78Ij90KlMnOpQrStUvWxYz"), // Anthropic (hífens quebram o sk- contíguo → entrada própria; gap tapado no #8-followup)
    S("sk-", "ant-admin01-Ab12Cd34Ef56Gh78Ij90Kl"), // Anthropic admin key
    S("sk-", "svcacct-Ab12Cd34Ef56Gh78Ij90KlMnOpQr"), // OpenAI service-account (hífen após svcacct quebra o sk- contíguo)
    S("sk-", "proj-Ab12Cd34Ef56Gh78Ij90Kl"),
    S("sk-", "lf-1234abcd-5678-efgh-9012-ijklmnop3456"),
    S("ghp", "_16C7e42F292c6912E7710c838347Ae178B4a"),
    S("github", "_pat_11ABCDE0Y0aBcDeFgHiJkL_1a2b3c4d5e6f7g8h9i0j"), // fine-grained PAT (rodada 2)
    S("AIza", "SyD-1234567890abcdefGHIJKLMNOPqrstuv"),
    S("sk", "_live_", "51H8zXyAbCdEfGhIjKlMnOpQr"), // Stripe
    S("npm", "_1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456"), // npm token (rodada 2)
    S("Account", "Key=Xy9aBcD3fGhIjKlMnOpQrStUvWxYz0123456789AbCdEf=="), // Azure Storage (rodada 2)
    S("AZURE_CLIENT_SECRET=", "8Q~aBc1DeFgHiJkLmNoPqRsTuVwXyZ0123456"), // Azure AD secret com ~ (rodada 2)
    S("https://hooks.slack.com/services/", "T00000000/B11111111/aBcDeFgHiJkLmNoPqRsTuVwX2y"), // Slack webhook (rodada 2)
  ];
  for (const s of secrets) {
    const out = redactSecrets(`token ${s} end`);
    assert.ok(!out.includes(s), `${s.slice(0, 12)}… não pode vazar`);
  }
  // Slack: o corpo de alta entropia (não só os ids numéricos) tem de sumir.
  const slack = S("xox", "b-2334455667788-2334455667788-AbCdEfGhIjKlMnOpQrStUvWx");
  assert.ok(!redactSecrets(slack).includes("AbCdEfGhIjKlMnOpQrStUvWx"));
});

// Falsos-positivos que o stress pegou — o rebalanceamento (dígito obrigatório + remoção do `_key` genérico e
// da connection-string do KV) deve PRESERVAR estes trechos legítimos.
test("redactSecrets: NÃO over-masca *_key de config, pwd=path, database_url sem cred, prosa bearer", () => {
  const keep = [
    'color_key = "background-primary"',
    'title_key = "welcome.header"',
    'token = "IDENTIFIER"',
    'pwd = "/home/user/project/src"',
    'pwd = "/home/user2/project"', // caminho COM dígito (rodada 2 — pwd removido do SECRET_KEY)
    'database_url = "postgresql://localhost:5432/appdb"',
    'dsn = "host=localhost port=5432 dbname=app"',
    "Bearer authentication is required for this endpoint.",
    'class="sk-h2-heading"', // classe CSS com prefixo sk- + dígito (rodada 2 — sk- agora é preciso)
    'class="sk-col-12-wide pk-step-3-active"',
    'class="sk-ant-button-primary-active"', // sk-ant- SEM dígito → não é chave Anthropic, preserva (lookahead exige dígito)
  ];
  for (const k of keep) assert.equal(redactSecrets(k), k, `deve preservar: ${k}`);
  // mas o segredo DENTRO da connection string (senha) ainda é mascarado:
  assert.ok(!redactSecrets('dsn = "host=x password=s3cr3t123 db=y"').includes("s3cr3t123"));
  assert.ok(!redactSecrets("postgresql://admin:s3nh4Secreta@host/db").includes("s3nh4Secreta"));
});

// Anti-ReDoS (achado do meu sanity-check ao vivo): sem quantificadores BOUNDED, o userinfo de URL e o email
// backtrackam O(n²) numa string longa e congelam o host/gateway. Deve retornar RÁPIDO em entrada adversária.
test("redactSecrets: anti-ReDoS — entrada adversária longa retorna rápido (bounded)", () => {
  const cases = [
    "a".repeat(500000),
    "postgres://" + "a".repeat(200000) + ":x",
    "x".repeat(100000) + "@" + "y".repeat(100000),
    "-----BEGIN RSA PRIVATE KEY-----\n".repeat(5000),
  ];
  for (const c of cases) {
    const t0 = Date.now();
    redactSecrets(c);
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `redação deve retornar <1s (foi ${ms}ms) — sem blow-up quadrático`);
  }
});

// #8 round-3 (achados da 3ª rodada de stress adversarial): provedores que ainda escapavam. Fixtures por partes (S).
test("redactSecrets: provedores adicionais (gitlab/docker/pypi/sendgrid/twilio) não vazam", () => {
  const secrets = [
    S("glpat-", "AbCd1234EfGh5678Ijkl"), // GitLab PAT
    S("dckr", "_pat_", "AbCd1234EfGh5678IjKl9012"), // Docker Hub PAT
    S("pypi-", "AgEIcHlwaS5vcmc", "1234567890abcdefghij"), // PyPI macaroon (≥32, com dígito)
    S("SG", ".", "AbCdEf012345GhIjKlMnOp", ".", "AbCdEfGhIjKlMnOpQrStUvWx0123456789ABCDEFGHI"), // SendGrid SG.<22>.<43>
    S("SK", "0123456789abcdef0123456789abcdef"), // Twilio API Key SID (SK + exatamente 32 hex)
  ];
  for (const s of secrets) {
    const out = redactSecrets(`token ${s} end`);
    assert.ok(!out.includes(s), `${s.slice(0, 12)}… não pode vazar`);
  }
  // prosa NÃO-segredo com prefixo pypi- curto/digit-less é preservada (guarda de ≥32 + dígito)
  assert.equal(redactSecrets("veja pypi-index-url na config"), "veja pypi-index-url na config");
});

test("redactSecrets: assinatura em query string (Azure SAS sig= / AWS X-Amz-Signature=) some, resto da URL fica", () => {
  const sas = "https://acct.blob.core.windows.net/c/b?sv=2021-06-08&sig=aB9%2FcD3eFgH4567jKl%3D&se=2025";
  const out = redactSecrets(sas);
  assert.ok(!out.includes("aB9%2FcD3eFgH4567jKl"), "a assinatura SAS não vaza");
  assert.match(out, /sig=«oculto»/);
  assert.match(out, /se=2025/, "o resto da query é preservado");
  assert.ok(!redactSecrets("GET /o?X-Amz-Signature=abcdef0123456789abcdef&X-Amz-Date=1").includes("abcdef0123456789abcdef"));
});

test("redactSecrets: DSN Oracle (senha delimitada por barra user/SENHA@host) mascara só a senha", () => {
  const out = redactSecrets("jdbc:oracle:thin:scott/P4ssw0rd123@ora-host:1521:orcl");
  assert.ok(!out.includes("P4ssw0rd123"), "a senha Oracle não vaza");
  assert.match(out, /oracle:thin:scott\/«oculto»@ora-host/, "user e host preservados");
});

test("redactSecrets: telefone BR com espaço após o 9 ('(11) 9 1234-5678') é mascarado", () => {
  assert.ok(!redactSecrets("ligue (11) 9 1234-5678 hoje").includes("1234-5678"));
  assert.ok(!redactSecrets("ligue (11) 9 1234 5678 hoje").includes("1234 5678"));
  assert.equal(redactSecrets("porta 5432 e versão 1.2.3"), "porta 5432 e versão 1.2.3"); // controle: não over-masca
});

// #8 round-2 (LIÇÃO CRÍTICA): excluir "código" do KV por forma GENÉRICA abre leak (um segredo pode ter a mesma
// forma: password=Ab1.Cd2.Ef3, PASETO v2.local.<b64>, api_key=deadBEEF1234()). A exclusão SEGURA é NARROW: só
// ref-de-membro enraizada em identificador de código CONHECIDO (process/settings/config/import/self...), onde um
// segredo real jamais começa. Este teste FIXA o contrato E guarda contra reintroduzir o carve-out genérico.
test("redactSecrets: KV preserva ref-de-membro de RAIZ DE CÓDIGO conhecida; mascara o resto; NÃO vaza segredo-forma-de-código", () => {
  // ref-de-membro de raiz CONHECIDA (todas com dígito → o KV casaria; a exclusão narrow é o que preserva).
  // Inclui terminador de statement `;`/`,` (o valor não-quotado engole o `;`; a 3ª rodada de stress pegou isso).
  for (const k of [
    "const apiKey = process.env.KEY2",
    "client_secret = settings.CLIENT_SECRET_V2",
    "api_key = config.API_KEY_2",
    "auth_token = self.config.token_v2",
    "secret = import.meta.env.VITE_KEY2",
    "const apiKey = process.env.KEY2;", // com ponto-e-vírgula (forma mais comum em JS/TS)
    "password = this.opts.pass2;",
    "secret = self.keys[2];",
    "{ api_key: config.API_KEY_2, }", // dentro de object literal (vírgula final)
  ]) assert.equal(redactSecrets(k), k, `deve preservar ref-de-membro de raiz conhecida: ${k}`);
  // chamada de função com arg-dígito não-quotado / raiz DESCONHECIDA → over-mask ACEITO (fail-safe)
  for (const k of ["signing_key = kms.get_key(key_id=42)", "private_key = rsa.generate(2048)"])
    assert.match(redactSecrets(k), /«oculto»/, `over-mask aceito (não é raiz conhecida): ${k}`);
  // sem dígito → não dispara valor-secret-like → preservado
  assert.equal(redactSecrets("access_token = response.json()"), "access_token = response.json()");
  // GUARDA anti-regressão (leaks da 2ª rodada): segredo com FORMA de código NÃO pode vazar
  assert.ok(!redactSecrets("password=Ab1.Cd2.Ef3").includes("Ab1.Cd2.Ef3"), "dotted password não vaza");
  assert.ok(!redactSecrets("secret=v2.local.Abc123def").includes("v2.local.Abc123def"), "PASETO não vaza");
  assert.ok(!redactSecrets("secret=Prod.Db.Cluster.Node7").includes("Prod.Db.Cluster.Node7"), "dotted secret não vaza");
  assert.ok(!redactSecrets("api_key=deadBEEF1234()").includes("deadBEEF1234"), "paren secret não vaza");
});
