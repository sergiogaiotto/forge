import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderRuntimeResolver } from "../core/ProviderRuntimeResolver";

// Deps mutáveis (closures) p/ simular a config do admin sem vscode.
function make(cfg: { maxContextWindow?: number; maxOutput?: number } = {}) {
  const state = { maxContextWindow: cfg.maxContextWindow ?? 0, maxOutput: cfg.maxOutput ?? 0 };
  const r = new ProviderRuntimeResolver({ maxContextWindow: () => state.maxContextWindow, maxOutput: () => state.maxOutput });
  return { r, state };
}

const OC = "openai-compatible" as const;

test("effectiveContextWindow: config do admin (>0) VENCE; senão a servida (cache); senão 0", () => {
  const { r, state } = make();
  // sem config, sem cache → 0 (usar o catálogo)
  assert.equal(r.effectiveContextWindow(OC, "http://gw", "m"), 0);
  // registra a janela servida → passa a valer
  r.recordServed(OC, "http://gw", "m", 12000);
  assert.equal(r.effectiveContextWindow(OC, "http://gw", "m"), 12000);
  // config do admin > 0 VENCE mesmo com cache
  state.maxContextWindow = 32000;
  assert.equal(r.effectiveContextWindow(OC, "http://gw", "m"), 32000);
});

test("probe-once: recordServed(0) (falha) ainda conta como probado — não re-proba", () => {
  const { r } = make();
  assert.equal(r.hasProbed(OC, "http://gw", "m"), false);
  r.recordServed(OC, "http://gw", "m", 0); // falha cacheada como 0
  assert.equal(r.hasProbed(OC, "http://gw", "m"), true, "0 é presença → não re-proba");
  assert.equal(r.effectiveContextWindow(OC, "http://gw", "m"), 0, "0 servido → usar o catálogo");
});

test("chave por (type::baseUrl::modelId): gateways/modelos diferentes não colidem", () => {
  const { r } = make();
  r.recordServed(OC, "http://a", "m1", 8000);
  assert.equal(r.hasProbed(OC, "http://a", "m1"), true);
  assert.equal(r.hasProbed(OC, "http://b", "m1"), false, "baseUrl diferente = chave diferente");
  assert.equal(r.hasProbed(OC, "http://a", "m2"), false, "modelId diferente = chave diferente");
  r.recordServed(OC, "http://b", "m1", 4000);
  assert.equal(r.effectiveContextWindow(OC, "http://a", "m1"), 8000);
  assert.equal(r.effectiveContextWindow(OC, "http://b", "m1"), 4000, "cada gateway mantém a sua janela");
});

test("resolveOutputTokens: a janela SERVIDA rebaixa o teto (clamp anti-HTTP-400)", () => {
  const { r } = make({ maxOutput: 100000 }); // config pede muito
  const model = "gpt-oss-120b"; // janela de catálogo grande (128k)
  const semServida = r.resolveOutputTokens(OC, "http://gw", model, 0);
  r.recordServed(OC, "http://gw", model, 8000); // o gateway serve só 8000
  const comServida = r.resolveOutputTokens(OC, "http://gw", model, 0);
  assert.ok(comServida <= 8000, `teto rebaixado à janela servida (${comServida} <= 8000)`);
  assert.ok(comServida < semServida, `servida (${comServida}) < sem-servida (${semServida}) — o clamp mordeu`);
});

test("resolveOutputTokens: o teto por-SESSÃO vence a config do admin (sessionMaxOutput > 0)", () => {
  const { r } = make({ maxOutput: 1000 }); // config baixa
  const model = "gpt-oss-120b";
  const comConfig = r.resolveOutputTokens(OC, "http://gw", model, 0); // sessão=0 → usa config (1000)
  const comSessao = r.resolveOutputTokens(OC, "http://gw", model, 50000); // sessão pede muito mais
  assert.ok(comSessao > comConfig, `sessão (${comSessao}) vence a config (${comConfig})`);
});
