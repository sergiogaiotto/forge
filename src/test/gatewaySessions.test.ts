import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error — módulo .mjs puro do gateway (sem tipos), importado só para teste.
import { admitSession, authorizeScope, pruneExpired, renewedExpiry } from "../../gateway/sessions.mjs";

const mk = (entries: [string, number][]) =>
  new Map(entries.map(([t, exp]) => [t, { subject: "s", org: "o", expiresAt: exp }]));

test("pruneExpired remove só as sessões vencidas", () => {
  const s = mk([["a", 100], ["b", 200], ["c", 50]]);
  const removed = pruneExpired(s, 150);
  assert.equal(removed, 2);
  assert.deepEqual([...s.keys()], ["b"]);
});

test("REGRESSÃO (DoS): admitSession NÃO desloga sessões VIVAS — recusa quando cheio de vivas", () => {
  const s = mk([["a", 999], ["b", 999]]); // ambas vivas
  assert.equal(admitSession(s, 2, 10), false, "cheio de vivas → sem vaga");
  assert.equal(s.size, 2, "sessões VIVAS preservadas (o antigo force-sweep deslogava todo mundo)");
});

test("admitSession abre vaga expirando as vencidas, sem tocar nas vivas", () => {
  const s = mk([["a", 5], ["b", 999]]); // a vencida, b viva
  assert.equal(admitSession(s, 2, 10), true, "expira 'a' → há vaga");
  assert.equal(s.has("a"), false);
  assert.equal(s.has("b"), true);
});

test("authorizeScope: escopo vazio/ausente = grandfather (licença legada não trava)", () => {
  assert.deepEqual(authorizeScope([], true), { ok: true, missing: [] });
  assert.deepEqual(authorizeScope(undefined, true), { ok: true, missing: [] });
});

test("authorizeScope: exige codegen; skills só quando a requisição ativa skills", () => {
  assert.equal(authorizeScope(["codegen", "skills"], true).ok, true, "licença default passa");
  assert.equal(authorizeScope(["codegen"], false).ok, true, "codegen sem skills passa");
  assert.deepEqual(authorizeScope(["codegen"], true), { ok: false, missing: ["skills"] }, "ativa skills sem escopo → 403");
  assert.deepEqual(authorizeScope(["skills"], false), { ok: false, missing: ["codegen"] }, "sem codegen → 403");
});

test("renewedExpiry: renovação normal = now+ttl quando abaixo da expiração da licença", () => {
  assert.equal(renewedExpiry(10000, 1000, 3600), 4600, "now+ttl (não atinge o teto)");
});

test("REGRESSÃO: renewedExpiry NUNCA estende além da expiração da licença", () => {
  assert.equal(renewedExpiry(2000, 1000, 3600), 2000, "teto na expiração da licença, não now+ttl=4600");
});

test("REGRESSÃO: renewedExpiry recusa (null) quando a licença JÁ expirou — sessão não sobrevive à licença", () => {
  assert.equal(renewedExpiry(1000, 1000, 3600), null, "expiry == now → expirada");
  assert.equal(renewedExpiry(500, 1000, 3600), null, "expiry < now → expirada");
});

test("renewedExpiry: sem licenseExpiry (legado) cai em now+ttl", () => {
  assert.equal(renewedExpiry(undefined, 1000, 3600), 4600);
  assert.equal(renewedExpiry(0, 1000, 3600), 4600);
});
