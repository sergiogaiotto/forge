import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error — módulo .mjs puro do gateway (sem tipos), importado só para teste.
import { extractUsage, withIncludeUsage } from "../../gateway/usage.mjs";

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

// withIncludeUsage: força include_usage em streaming (fecha o bypass do teto FinOps — achado do survey).
test("withIncludeUsage: injeta stream_options.include_usage=true em request de streaming", () => {
  const out = JSON.parse(withIncludeUsage('{"stream":true,"messages":[]}'));
  assert.equal(out.stream_options.include_usage, true);
});

test("withIncludeUsage: SOBREPÕE include_usage=false do cliente (adversário não desliga)", () => {
  const out = JSON.parse(withIncludeUsage('{"stream":true,"stream_options":{"include_usage":false},"model":"x"}'));
  assert.equal(out.stream_options.include_usage, true, "força true mesmo se o cliente pediu false");
  assert.equal(out.model, "x", "preserva o resto do corpo");
});

test("withIncludeUsage: include_usage já true → repassa INALTERADO (sem re-serializar; preserva big-int)", () => {
  const body = '{"stream":true,"stream_options":{"include_usage":true},"seed":12345678901234567890}';
  assert.equal(withIncludeUsage(body), body, "não re-serializa quando já correto (evita perda de precisão do seed)");
});

test("withIncludeUsage: não-streaming e corpo malformado passam inalterados", () => {
  assert.equal(withIncludeUsage('{"stream":false,"messages":[]}'), '{"stream":false,"messages":[]}', "não-streaming: sem mudança (usage sempre presente)");
  assert.equal(withIncludeUsage('{"messages":[]}'), '{"messages":[]}', "sem stream: sem mudança");
  assert.equal(withIncludeUsage("{ malformado"), "{ malformado", "malformado → repassa cru (não quebra o proxy)");
});
