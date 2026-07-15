import assert from "node:assert/strict";
import { test } from "node:test";
import {
  probeProviderHealth,
  healthProbeUrl,
  flattenErrorChain,
  HEALTH_RETRY_MS,
  HEALTH_GREEN_RECHECK_MS,
} from "../util/providerHealth";
import { EgressEnforcer } from "../net/EgressEnforcer";

const egressOk = new EgressEnforcer({ allowExternal: true, allowedHosts: [] }, () => {});
const now = () => 1_000;

function fakeFetch(handler: (url: string) => Response | Error): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const r = handler(String(input));
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
}

test("probeProviderHealth: resposta 200 → ok com status e latência", async () => {
  const h = await probeProviderHealth("https://gw.example.com/v1", {}, egressOk, 4000, fakeFetch(() => new Response("{}", { status: 200 })), now);
  assert.ok(h);
  assert.equal(h.ok, true);
  assert.equal(h.status, 200);
  assert.equal(h.checkedAt, 1_000);
});

test("probeProviderHealth: 401/403/404 ainda é ALCANÇÁVEL (rota viva; auth/rota é outro problema)", async () => {
  for (const status of [401, 403, 404]) {
    const h = await probeProviderHealth("https://gw.example.com/v1", {}, egressOk, 4000, fakeFetch(() => new Response("x", { status })), now);
    assert.equal(h?.ok, true, `status ${status} deve contar como alcançável`);
    assert.equal(h?.status, status);
  }
});

test("probeProviderHealth: 5xx = FORA (LB vivo com upstream morto → a geração VAI falhar)", async () => {
  for (const status of [500, 502, 503, 504]) {
    const h = await probeProviderHealth("https://gw.example.com/v1", {}, egressOk, 4000, fakeFetch(() => new Response("x", { status })), now);
    assert.equal(h?.ok, false, `status ${status} não pode contar como saudável`);
    assert.equal(h?.status, status, "o status fica disponível para o tooltip");
    assert.equal(h?.blocked, undefined);
  }
});

test("probeProviderHealth: falha de rede → ok=false com a CADEIA de causas (não só 'fetch failed')", async () => {
  const inner = new Error("connect ECONNREFUSED 127.0.0.1:443");
  const outer = new TypeError("fetch failed");
  (outer as TypeError & { cause?: unknown }).cause = inner;
  const h = await probeProviderHealth("https://gw.example.com/v1", {}, egressOk, 4000, fakeFetch(() => outer), now);
  assert.equal(h?.ok, false);
  assert.match(h?.error ?? "", /fetch failed/);
  assert.match(h?.error ?? "", /ECONNREFUSED/, "a causa real (undici a embrulha em .cause) aparece no tooltip");
});

test("probeProviderHealth: sem baseUrl (SaaS gerido) → null (badge ausente, não vermelho)", async () => {
  assert.equal(await probeProviderHealth(undefined, {}, egressOk, 4000, fakeFetch(() => new Response("{}")), now), null);
  assert.equal(await probeProviderHealth("", {}, egressOk, 4000, fakeFetch(() => new Response("{}")), now), null);
});

test("probeProviderHealth: egress nega o host → ok=false + blocked=true SEM disparar fetch (fail-closed; sem retry automático)", async () => {
  const egressDeny = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => {});
  let fetched = false;
  const h = await probeProviderHealth(
    "https://fora-da-allowlist.example.com/v1",
    {},
    egressDeny,
    4000,
    fakeFetch(() => {
      fetched = true;
      return new Response("{}");
    }),
    now
  );
  assert.equal(h?.ok, false);
  assert.equal(h?.blocked, true, "bloqueio de egress é CONFIG, não rede — o chamador não agenda retry");
  assert.equal(fetched, false, "a sonda não pode contornar o EgressEnforcer");
});

test("flattenErrorChain: achata causas aninhadas sem duplicar e com teto de profundidade", () => {
  const a = new Error("nivel-1");
  const b = new Error("nivel-2");
  const c = new Error("nivel-3");
  (a as Error & { cause?: unknown }).cause = b;
  (b as Error & { cause?: unknown }).cause = c;
  assert.equal(flattenErrorChain(a), "nivel-1 ← nivel-2 ← nivel-3");
  assert.equal(flattenErrorChain("texto cru"), "texto cru");
  assert.equal(flattenErrorChain(undefined), "erro desconhecido");
});

test("healthProbeUrl: junta /models sem duplicar barras", () => {
  assert.equal(healthProbeUrl("https://gw/v1"), "https://gw/v1/models");
  assert.equal(healthProbeUrl("https://gw/v1///"), "https://gw/v1/models");
});

test("cadências: retry vermelho curto (recupera sozinho) << batimento verde lento (anti-fóssil, sem spam)", () => {
  assert.ok(HEALTH_RETRY_MS >= 30_000 && HEALTH_RETRY_MS <= 300_000);
  assert.ok(HEALTH_GREEN_RECHECK_MS >= 120_000, "verde re-sonda devagar — é só anti-fóssil");
  assert.ok(HEALTH_GREEN_RECHECK_MS > HEALTH_RETRY_MS, "verde mais lento que vermelho");
});
