import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateCost, matchPrice, sanitizePricing } from "../api/pricing";

const TABLE = {
  claude: { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 18, output: 90 },
  "gpt-oss": { input: 0, output: 0 },
};

test("matchPrice: a chave mais específica (mais longa) vence", () => {
  assert.deepEqual(matchPrice("claude-sonnet-4-6", TABLE), { input: 18, output: 90 });
  assert.deepEqual(matchPrice("claude-opus-4-8", TABLE), { input: 3, output: 15 }); // só casa "claude"
  assert.deepEqual(matchPrice("openai/gpt-oss-120b", TABLE), { input: 0, output: 0 });
  assert.equal(matchPrice("llama-3", TABLE), undefined);
  assert.equal(matchPrice("", TABLE), undefined);
});

test("estimateCost: sem usage OU sem preço → undefined (nunca custo fabricado)", () => {
  assert.equal(estimateCost("claude", undefined, TABLE), undefined);
  assert.equal(estimateCost("modelo-sem-preco", { inputTokens: 1000, outputTokens: 500 }, TABLE), undefined);
});

test("estimateCost: calcula por 1M tokens e soma; moeda é rótulo", () => {
  const c = estimateCost("claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 500_000 }, TABLE, "US$")!;
  assert.equal(c.inputCost, 18); // 1M * 18/1M
  assert.equal(c.outputCost, 45); // 0.5M * 90/1M
  assert.equal(c.totalCost, 63);
  assert.equal(c.currency, "US$");
  // gpt-oss self-hosted = custo zero REAL (configurado), não fabricado
  const z = estimateCost("gpt-oss-120b", { inputTokens: 10_000, outputTokens: 5_000 }, TABLE)!;
  assert.equal(z.totalCost, 0);
});

test("sanitizePricing: descarta lixo, mantém entradas válidas; nega negativos e não-número", () => {
  const clean = sanitizePricing({
    claude: { input: 3, output: 15 },
    ruim1: { input: -1, output: 2 },
    ruim2: { input: "x", output: 2 },
    ruim3: "não é objeto",
    ruim4: { input: 1 }, // output ausente → NaN → descarta
  });
  assert.deepEqual(clean, { claude: { input: 3, output: 15 } });
  assert.deepEqual(sanitizePricing(null), {});
  assert.deepEqual(sanitizePricing([{ input: 1, output: 1 }]), {});
});

test("REGRESSÃO: sanitizePricing exige NÚMERO real — rejeita lixo coagido por Number()", () => {
  // "" → 0, true → 1, [3] → 3, null → 0 seriam ACEITOS por Number(); agora são rejeitados
  const clean = sanitizePricing({
    a: { input: 3, output: "" },
    b: { input: true, output: 2 },
    c: { input: [3], output: 1 },
    d: { input: null, output: 5 },
    e: { input: "3", output: 15 }, // string numérica também é rejeitada (só number literal)
    ok: { input: 3, output: 15 },
  });
  assert.deepEqual(clean, { ok: { input: 3, output: 15 } }, "só a entrada com dois números reais sobrevive");
});
