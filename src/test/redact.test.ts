import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../util/redact";

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
