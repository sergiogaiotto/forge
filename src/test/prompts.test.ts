import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBasePrompt, buildReviewPrompt, buildTddPrompt } from "../core/systemPrompt";

test("prompt TDD inclui o prompt base e instruções de test-first", () => {
  const p = buildTddPrompt("meu-projeto");
  assert.ok(p.includes("FORGE"));
  assert.ok(p.includes("meu-projeto"));
  assert.match(p, /MODO TDD/);
  assert.match(p, /pytest/);
  assert.match(p, /test_/);
  // mantém o protocolo de edição de arquivos do prompt base
  assert.ok(p.includes("forge-file"));
});

test("prompt de revisão é multi-lente e em pt-BR", () => {
  const p = buildReviewPrompt();
  assert.match(p, /FORGE Review/);
  assert.match(p, /Segurança/);
  assert.match(p, /LGPD/);
  assert.match(p, /severidade/);
  assert.match(p, /pt-BR/);
});

test("prompt base exige pt-BR", () => {
  assert.match(buildBasePrompt("x"), /pt-BR/);
});

test("prompt base proíbe elipses/omissões para forçar o arquivo completo", () => {
  const p = buildBasePrompt("x");
  assert.match(p, /PROIBIDO/);
  assert.match(p, /restante do código/); // veta o placeholder exato observado no print
  assert.match(p, /linha por linha/);
});

test("prompt de revisão também proíbe omissões no bloco corrigido", () => {
  const p = buildReviewPrompt();
  // mesma regra compartilhada (NO_ELLIPSIS_RULE) que o prompt base
  assert.match(p, /PROIBIDO/);
  assert.match(p, /restante do código/);
});
