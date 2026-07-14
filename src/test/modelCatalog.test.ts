import assert from "node:assert/strict";
import { test } from "node:test";
import { clampOutputToServed, getModelMeta, resolveMaxOutput } from "../api/modelCatalog";
import { MAX_OUTPUT_PRESETS, maxOutputLabel } from "../shared/protocol";

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

// Clamp contra a janela SERVIDA, reservando a ENTRADA proporcional (≥30%) + margem — evita o footgun de um
// teto de saída que o gateway recusaria com 400 E o colapso da entrada (R6). A reserva NÃO é mais fixa (era 4096).
test("clampOutputToServed: rebaixa o teto reservando entrada proporcional + margem", () => {
  const meta = getModelMeta("openai-compatible", "openai/gpt-oss-120b"); // janela nominal 131072
  // servedWindow=0 → nominal 131072: reserva = max(4096, 30%·128k=39322) + margem 13108 → teto 78642
  assert.equal(clampOutputToServed(131072, meta, 0), 131072 - 39322 - 13108);
  // gateway serve só 8192 → reserva = max(4096, 30%·8192)=4096 + margem 820 → teto 3276
  assert.equal(clampOutputToServed(131072, meta, 8192), 8192 - 4096 - 820);
  // pedido já pequeno cabe sem rebaixar (16384 < teto)
  assert.equal(clampOutputToServed(16384, meta, 65536), 16384);
  // piso útil de 1024: janela minúscula onde a reserva excederia o espaço → nunca abaixo de 1024
  assert.equal(clampOutputToServed(131072, meta, 2000), 1024);
  // servedWindow acima do nominal do catálogo é limitado ao nominal
  assert.equal(clampOutputToServed(131072, meta, 999999), 131072 - 39322 - 13108);
});

test("MAX_OUTPUT_PRESETS/maxOutputLabel: presets até 128k e rótulos legíveis", () => {
  assert.deepEqual(MAX_OUTPUT_PRESETS, [0, 16384, 32768, 65536, 131072]);
  assert.equal(maxOutputLabel(0), "auto");
  assert.equal(maxOutputLabel(undefined), "auto");
  assert.equal(maxOutputLabel(32768), "32k");
  assert.equal(maxOutputLabel(131072), "128k");
});
