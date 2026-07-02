import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_REASONING_EFFORT,
  effectiveTimeoutSeconds,
  REASONING_EFFORTS,
  supportsReasoningEffort,
  supportsTemperature,
  TIMEOUT_BY_EFFORT,
} from "../shared/protocol";

// Os modelos de raciocínio da OpenAI (o-series, gpt-5) rejeitam temperature != 1 com 400 — o campo
// NÃO deve ser enviado a eles (regressão: blueprint/charter quebravam com 400 nesses modelos).
test("supportsTemperature: falso só para modelos de raciocínio da OpenAI; verdadeiro no resto", () => {
  assert.equal(supportsTemperature("openai", "o1"), false);
  assert.equal(supportsTemperature("openai", "o3-mini"), false);
  assert.equal(supportsTemperature("openai", "o4-mini"), false);
  assert.equal(supportsTemperature("openai", "gpt-5"), false);
  assert.equal(supportsTemperature("openai", "gpt-4o"), true);
  assert.equal(supportsTemperature("openai", "gpt-4.1"), true);
  // gateways OpenAI-compatíveis (HubGPU/vLLM) e Anthropic aceitam temperature 0
  assert.equal(supportsTemperature("openai-compatible", "openai/gpt-oss-120b"), true);
  assert.equal(supportsTemperature("anthropic", "claude-sonnet-4-6"), true);
  // fronteira: "o1"/"o3" só como token isolado (não casar substring tipo "solo13")
  assert.equal(supportsTemperature("openai", "solo13-custom"), true);
});

test("timeout efetivo cresce monotonicamente com o esforço (low < medium < high)", () => {
  assert.equal(effectiveTimeoutSeconds("low"), 120);
  assert.equal(effectiveTimeoutSeconds("medium"), 300);
  assert.equal(effectiveTimeoutSeconds("high"), 600);
  assert.ok(TIMEOUT_BY_EFFORT.low < TIMEOUT_BY_EFFORT.medium);
  assert.ok(TIMEOUT_BY_EFFORT.medium < TIMEOUT_BY_EFFORT.high);
});

test("esforço ausente cai no default (médio = 300s, o comportamento histórico)", () => {
  assert.equal(effectiveTimeoutSeconds(undefined), 300);
  assert.equal(DEFAULT_REASONING_EFFORT, "medium");
  assert.equal(effectiveTimeoutSeconds(DEFAULT_REASONING_EFFORT), 300);
});

test("a ordem de ciclagem do seletor é low → medium → high", () => {
  assert.deepEqual(REASONING_EFFORTS, ["low", "medium", "high"]);
});

test("supportsReasoningEffort: só gpt-oss em provedor OpenAI-compatível", () => {
  assert.ok(supportsReasoningEffort("openai-compatible", "openai/gpt-oss-120b"));
  assert.ok(supportsReasoningEffort("openai-compatible", "openai/gpt-oss-20b"));
  assert.ok(!supportsReasoningEffort("openai-compatible", "meta/llama-3.1"), "outro modelo compat não suporta");
  assert.ok(!supportsReasoningEffort("anthropic", "claude-sonnet-4-6"));
  assert.ok(!supportsReasoningEffort("openai", "gpt-4o"));
  assert.ok(!supportsReasoningEffort("openai-compatible", undefined));
});
