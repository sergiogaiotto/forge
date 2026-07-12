import assert from "node:assert/strict";
import { test } from "node:test";
import { extractReferencedPaths, isSensitiveFile, looksLikePrivateKey } from "../util/errorRefs";

// Frame de traceback Python: o path vem entre aspas (pode conter ':' do drive Windows e barras invertidas).
test("extractReferencedPaths: frame de traceback Python (path entre aspas, drive Windows)", () => {
  const tb =
    'Traceback (most recent call last):\n' +
    '  File "C:\\_PERSONAL\\prj_code\\teste\\src\\domain\\entities\\appointment.py", line 20, in <module>\n' +
    "    @dataclass\n" +
    "TypeError: non-default argument 'technician_id' follows default argument";
  const paths = extractReferencedPaths(tb);
  assert.ok(
    paths.includes("C:\\_PERSONAL\\prj_code\\teste\\src\\domain\\entities\\appointment.py"),
    "extrai o arquivo citado no frame"
  );
});

// Compilador / mypy / pytest: PATH:linha (relativo ou absoluto).
test("extractReferencedPaths: linha PATH:linha de compilador/mypy (relativo e absoluto)", () => {
  const err =
    "src/adapters/http/fastapi_router.py:54: error: Argument 1 ...\n" +
    "src/domain/entities/book.py:12: note: ...\n" +
    "C:\\ws\\src\\main.py:3: error: ...";
  const paths = extractReferencedPaths(err);
  assert.ok(paths.includes("src/adapters/http/fastapi_router.py"));
  assert.ok(paths.includes("src/domain/entities/book.py"));
  assert.ok(paths.includes("C:\\ws\\src\\main.py"));
});

// O util EXTRAI todos os frames (inclusive stdlib); a contenção no workspace é do safeWorkspacePath (host).
test("extractReferencedPaths: extrai todos os frames — o host descarta stdlib via safeWorkspacePath", () => {
  const tb =
    '  File "C:\\Users\\x\\AppData\\Local\\Programs\\Python\\Python311\\Lib\\dataclasses.py", line 585, in _init_fn\n' +
    '  File "src/app.py", line 3, in <module>';
  const paths = extractReferencedPaths(tb);
  assert.ok(paths.some((p) => p.endsWith("dataclasses.py")), "extrai o frame stdlib (o host filtra depois)");
  assert.ok(paths.includes("src/app.py"));
});

// Texto sem erro/path → nada (auto-leitura não dispara num brief normal de geração).
test("extractReferencedPaths: brief normal / vazio → sem candidatos", () => {
  assert.deepEqual(extractReferencedPaths("crie uma app simples de lista de tarefas"), []);
  assert.deepEqual(extractReferencedPaths(""), []);
});

// Anti-ReDoS (achado da revisão): uma linha gigante sem delimitador (base64/data-URI/minificado) NÃO pode
// disparar backtracking quadrático que trava o extension host — é pulada (> MAX_LINE), e retorna rápido.
test("extractReferencedPaths: linha gigante sem delimitador é pulada (anti-ReDoS) e retorna rápido", () => {
  const huge = "a".repeat(200_000) + ".py:1"; // uma linha só, muito acima de MAX_LINE
  const t0 = Date.now();
  const paths = extractReferencedPaths(huge + '\nFile "src/real.py", line 3');
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `deve retornar rápido (foi ${ms}ms) — sem blowup quadrático`);
  assert.ok(!paths.some((p) => p.length > 2000), "não extrai o token gigante");
  assert.ok(paths.includes("src/real.py"), "ainda extrai caminhos de linhas normais");
});

// Denylist de segredos (achado #02): o auto-read NUNCA pode ler estes tipos e mandá-los ao gateway.
test("isSensitiveFile: bloqueia .env, chaves privadas, credenciais e keystores", () => {
  for (const p of [
    ".env",
    ".env.local",
    ".env.production",
    "config/.env.qa",
    "id_rsa",
    "C:\\Users\\x\\.ssh\\id_ed25519",
    "server.pem",
    "certs/private.key",
    "app.pfx",
    "store.p12",
    "keystore.jks",
    "deploy.ppk",
    "aws_credentials",
    "credentials.json",
    "secrets.yaml",
    "app_secret.txt",
    "my-private-key.txt", // não-fonte → bloqueado por nome; conteúdo faz backstop se for PEM
    "backup_id_rsa", // não-fonte, id_rsa embutido
    // Dotfiles de credencial (achado #04): extensionless → sempre bloqueados.
    ".envrc",
    "project/.envrc",
    ".netrc",
    "_netrc",
    ".pgpass",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
  ]) {
    assert.equal(isSensitiveFile(p), true, `deve bloquear ${p}`);
  }
});

test("isSensitiveFile: NÃO bloqueia código-fonte legítimo citado num traceback", () => {
  for (const p of [
    "src/domain/entities/appointment.py",
    "src/adapters/http/fastapi_router.py",
    "C:\\ws\\src\\main.py",
    "environment.py", // 'environment' não é '.env'
    "secretary.py", // 'secret' só casa em fronteira de palavra/sep, não substring
    "keyboard.ts", // 'key' não é '.key'
    "README.md",
    // Módulos-FONTE cujo nome contém credentials/secrets/private_key → tratados pela redação e pelo
    // content-guard, não bloqueados (over-block de fonte degradaria o auto-read; achados #03/#02).
    "src/services/credential_service.py",
    "src/security/secrets_manager.py",
    "credentials.py",
    "app/secret.ts",
    "src/crypto/private_key.py", // módulo de cripto legítimo; looksLikePrivateKey faz backstop se vier PEM
    "id_rsa.py",
    "privkey.ts",
  ]) {
    assert.equal(isSensitiveFile(p), false, `NÃO deve bloquear ${p}`);
  }
});

// Rede de segurança de conteúdo: nome escapou à denylist, mas o corpo é uma chave privada PEM.
test("looksLikePrivateKey: detecta bloco PEM de chave privada (PKCS#1/#8/EC/OpenSSH)", () => {
  assert.equal(looksLikePrivateKey("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"), true);
  assert.equal(looksLikePrivateKey("prefixo\n-----BEGIN PRIVATE KEY-----\nMII...\n"), true);
  assert.equal(looksLikePrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blb..."), true);
  assert.equal(looksLikePrivateKey("-----BEGIN EC PRIVATE KEY-----"), true);
  assert.equal(looksLikePrivateKey("class Foo:\n    pass\n"), false);
  assert.equal(looksLikePrivateKey("-----BEGIN CERTIFICATE-----"), false, "certificado público não é chave privada");
});
