import assert from "node:assert/strict";
import { test } from "node:test";
import { getModelMeta, resolveMaxOutput } from "../api/modelCatalog";

test("gpt-oss-120b: janela 128k, saída generosa e suporta reasoning effort", () => {
  const m = getModelMeta("openai-compatible", "openai/gpt-oss-120b");
  assert.equal(m.contextWindow, 131072);
  assert.ok(m.maxOutputTokens >= 16384, "saída deve ser generosa (> teto antigo de 16384)");
  assert.equal(m.supportsReasoningEffort, true);
});

test("gpt-oss-20b: casa por padrão (não exato), mesma janela", () => {
  const m = getModelMeta("openai-compatible", "openai/gpt-oss-20b");
  assert.equal(m.contextWindow, 131072);
  assert.equal(m.supportsReasoningEffort, true);
});

test("Claude: janela grande, mas NÃO usa reasoning_effort estilo gpt-oss", () => {
  const m = getModelMeta("anthropic", "claude-sonnet-4-6");
  assert.ok(m.contextWindow >= 128000);
  assert.equal(m.supportsReasoningEffort, false);
});

test("gpt-4o: janela 128k; effort false (não é gpt-oss)", () => {
  const m = getModelMeta("openai", "gpt-4o");
  assert.equal(m.contextWindow, 128000);
  assert.equal(m.supportsReasoningEffort, false);
});

test("modelo desconhecido: defaults conservadores (nunca estoura por otimismo)", () => {
  const m = getModelMeta("openai-compatible", "algum/modelo-novo-xyz");
  assert.equal(m.contextWindow, 8192);
  assert.equal(m.maxOutputTokens, 4096);
  assert.equal(m.supportsReasoningEffort, false);
});

test("o-series casa só com fronteira — sem falso-positivo de substring (histo1ry, algo3)", () => {
  // legítimos casam
  assert.equal(getModelMeta("openai", "o1").contextWindow, 128000);
  assert.equal(getModelMeta("openai", "o3-mini").contextWindow, 128000);
  assert.equal(getModelMeta("openai", "openai/o3-mini").contextWindow, 128000);
  // falso-positivos NÃO casam (caem no default conservador)
  assert.equal(getModelMeta("openai-compatible", "histo1ry").contextWindow, 8192);
  assert.equal(getModelMeta("openai-compatible", "meta/llama-foo3-x").contextWindow, 8192);
});

test("famílias OpenAI-compatíveis comuns têm janela 128k e saída conservadora", () => {
  for (const id of ["meta/llama-3-70b", "qwen2.5-coder", "mistral-large", "deepseek-v3"]) {
    const m = getModelMeta("openai-compatible", id);
    assert.equal(m.contextWindow, 128000, `janela de ${id}`);
    assert.equal(m.maxOutputTokens, 8192, `saída conservadora de ${id}`);
    assert.equal(m.supportsReasoningEffort, false);
  }
});

test("resolveMaxOutput: override válido vence; inválido cai no catálogo; nunca acima da janela", () => {
  const meta = getModelMeta("openai-compatible", "openai/gpt-oss-120b"); // 131072 / 32768
  assert.equal(resolveMaxOutput(0, meta), 32768); // 0 = usa catálogo
  assert.equal(resolveMaxOutput(-5, meta), 32768); // negativo = catálogo
  assert.equal(resolveMaxOutput(NaN, meta), 32768); // NaN = catálogo
  assert.equal(resolveMaxOutput(8000, meta), 8000); // override válido vence
  assert.equal(resolveMaxOutput(9999999, meta), 131072); // limitado à janela
  assert.equal(resolveMaxOutput(4096.9, meta), 4096); // floor
});
