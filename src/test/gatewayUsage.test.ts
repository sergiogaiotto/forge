import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error — módulo .mjs puro do gateway (sem tipos), importado só para teste.
import { extractUsage } from "../../gateway/usage.mjs";

// O bug corrigido: extractUsage INVERTIA input↔output na ordem PADRÃO do OpenAI (prompt_tokens antes de
// completion_tokens). Testa AS DUAS ordens — um teste só com completion-first passaria contra o código
// bugado. O mapeamento correto é sempre prompt→input, completion→output.

test("REGRESSÃO: ordem PADRÃO OpenAI (prompt_tokens antes) NÃO inverte", () => {
  const sse = 'data: {"usage":{"prompt_tokens":100,"completion_tokens":42,"total_tokens":142}}';
  const u = extractUsage(sse);
  assert.equal(u.inputTokens, 100, "prompt_tokens → inputTokens");
  assert.equal(u.outputTokens, 42, "completion_tokens → outputTokens");
});

test("ordem INVERTIDA (completion_tokens antes) também mapeia certo", () => {
  const sse = 'data: {"usage":{"completion_tokens":42,"prompt_tokens":100}}';
  const u = extractUsage(sse);
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 42);
});

test("sem bloco de usage → zeros (nunca lança)", () => {
  assert.deepEqual(extractUsage('data: {"choices":[]}'), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(extractUsage(""), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(extractUsage(undefined), { inputTokens: 0, outputTokens: 0 });
});

test("usage:null nos chunks intermediários é ignorado; pega o bloco final numérico", () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"x"}}],"usage":null}',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
    "data: [DONE]",
  ].join("\n");
  const u = extractUsage(sse);
  assert.equal(u.inputTokens, 7);
  assert.equal(u.outputTokens, 3);
});

test("usage cumulativo em múltiplos chunks → usa a ÚLTIMA (total) ocorrência", () => {
  const sse = [
    'data: {"usage":{"prompt_tokens":50,"completion_tokens":10}}',
    'data: {"usage":{"prompt_tokens":50,"completion_tokens":25}}',
  ].join("\n");
  const u = extractUsage(sse);
  assert.equal(u.inputTokens, 50);
  assert.equal(u.outputTokens, 25, "pega o total do último chunk, não o parcial");
});
