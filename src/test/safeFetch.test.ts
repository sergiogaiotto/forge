import assert from "node:assert/strict";
import { test } from "node:test";
import { safeFetch } from "../net/safeFetch";

// Captura o (url, init) que o safeFetch repassa ao fetch, para inspecionar a política de redirect.
function capturing(): { calls: { url: string; init: RequestInit }[]; impl: typeof fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("safeFetch força redirect:'error' (fail-closed contra 307/308)", async () => {
  const { calls, impl } = capturing();
  await safeFetch("https://hub-gpus.claro.com.br/v1/chat/completions", {
    method: "POST",
    body: "{}",
    fetchImpl: impl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, "error");
});

test("safeFetch SOBRESCREVE um redirect:'follow' passado pelo chamador", async () => {
  const { calls, impl } = capturing();
  // Mesmo que alguém tente afrouxar a política, o helper vence (redirect por último no spread).
  await safeFetch("https://gw.example", { redirect: "follow", fetchImpl: impl });
  assert.equal(calls[0].init.redirect, "error");
});

test("safeFetch preserva method/headers/body/signal e NÃO vaza fetchImpl no init", async () => {
  const { calls, impl } = capturing();
  const ctrl = new AbortController();
  await safeFetch("https://gw.example", {
    method: "POST",
    headers: { authorization: "Bearer x" },
    body: '{"a":1}',
    signal: ctrl.signal,
    fetchImpl: impl,
  });
  const init = calls[0].init as RequestInit & { fetchImpl?: unknown };
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>).authorization, "Bearer x");
  assert.equal(init.body, '{"a":1}');
  assert.equal(init.signal, ctrl.signal);
  assert.equal(init.fetchImpl, undefined, "fetchImpl não pode vazar para o fetch real");
});

test("safeFetch usa o fetchImpl injetado (não o fetch global)", async () => {
  let hit = 0;
  const impl = (async () => {
    hit++;
    return { ok: true, status: 202 } as Response;
  }) as unknown as typeof fetch;
  const res = await safeFetch("https://gw.example", { fetchImpl: impl });
  assert.equal(hit, 1);
  assert.equal(res.status, 202);
});
