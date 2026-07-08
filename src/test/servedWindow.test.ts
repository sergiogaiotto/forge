import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServedContextWindow } from "../util/servedWindow";

test("parseServedContextWindow: casa por id exato e devolve max_model_len", () => {
  const body = { object: "list", data: [{ id: "openai/gpt-oss-120b", max_model_len: 131072, object: "model" }] };
  assert.equal(parseServedContextWindow(body, "openai/gpt-oss-120b"), 131072);
});

test("parseServedContextWindow: casa por SUFIXO (config pede 'gpt-oss-120b', gateway serve 'openai/gpt-oss-120b')", () => {
  const body = { data: [{ id: "openai/gpt-oss-120b", max_model_len: 32768 }] };
  assert.equal(parseServedContextWindow(body, "gpt-oss-120b"), 32768);
  // e o inverso
  assert.equal(parseServedContextWindow({ data: [{ id: "gpt-oss-120b", max_model_len: 8192 }] }, "openai/gpt-oss-120b"), 8192);
});

test("parseServedContextWindow: gateway mono-modelo → usa o único mesmo sem casar o id", () => {
  const body = { data: [{ id: "some-served-name", max_model_len: 40960 }] };
  assert.equal(parseServedContextWindow(body, "gpt-oss-120b"), 40960);
});

test("parseServedContextWindow: multi-modelo sem casar o id → null (não adivinha)", () => {
  const body = { data: [{ id: "model-a", max_model_len: 4096 }, { id: "model-b", max_model_len: 8192 }] };
  assert.equal(parseServedContextWindow(body, "gpt-oss-120b"), null);
});

test("parseServedContextWindow: ausente/implausível/malformado → null (fail-open)", () => {
  assert.equal(parseServedContextWindow({ data: [{ id: "openai/gpt-oss-120b" }] }, "openai/gpt-oss-120b"), null); // sem max_model_len
  assert.equal(parseServedContextWindow({ data: [{ id: "m", max_model_len: 0 }] }, "m"), null); // 0 = implausível
  assert.equal(parseServedContextWindow({ data: [{ id: "m", max_model_len: -1 }] }, "m"), null);
  assert.equal(parseServedContextWindow({ data: "nope" }, "m"), null);
  assert.equal(parseServedContextWindow(null, "m"), null);
  assert.equal(parseServedContextWindow({}, "m"), null);
  assert.equal(parseServedContextWindow({ data: [{ id: "m", max_model_len: 4096.9 }] }, "m"), 4096); // floor
});
