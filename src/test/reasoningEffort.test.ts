import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_REASONING_EFFORT,
  effectiveTimeoutSeconds,
  REASONING_EFFORTS,
  supportsReasoningEffort,
  TIMEOUT_BY_EFFORT,
} from "../shared/protocol";

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
