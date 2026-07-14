import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error — módulo .mjs puro do gateway (sem tipos), importado só para teste.
import { rateLimited, pruneRateBuckets } from "../../gateway/rateLimit.mjs";

type Bucket = { tokens: number; updatedAt: number };

test("rateLimited: consome 1 por chamada e BLOQUEIA ao esgotar o cap (mesma chave = mesmo balde)", () => {
  const buckets = new Map<string, Bucket>();
  const cap = 3;
  const t0 = 1_000_000;
  assert.equal(rateLimited(buckets, "s:alice", cap, t0), false);
  assert.equal(rateLimited(buckets, "s:alice", cap, t0), false);
  assert.equal(rateLimited(buckets, "s:alice", cap, t0), false);
  assert.equal(rateLimited(buckets, "s:alice", cap, t0), true, "4ª (mesma chave, mesmo instante) esgota o cap");
});

// A GARANTIA do fix: a chave é POR SUBJECT. Duas chaves distintas (dois subjects) têm baldes independentes;
// mas o server passa a MESMA chave "proxy:<subject>" para todas as sessões do subject → um só balde
// compartilhado (N tokens NÃO multiplicam o limite). Aqui provamos o isolamento por-chave que sustenta isso.
test("rateLimited: chaves DISTINTAS têm baldes independentes; a MESMA chave compartilha (base do per-subject)", () => {
  const buckets = new Map<string, Bucket>();
  const cap = 2;
  const t0 = 0;
  rateLimited(buckets, "proxy:alice", cap, t0);
  rateLimited(buckets, "proxy:alice", cap, t0);
  assert.equal(rateLimited(buckets, "proxy:alice", cap, t0), true, "alice esgotou o balde dela");
  assert.equal(rateLimited(buckets, "proxy:bob", cap, t0), false, "bob (outra chave) é independente");
  // duas 'sessões' do mesmo subject = MESMA chave → dividem o balde já esgotado (não ganham cap novo)
  assert.equal(rateLimited(buckets, "proxy:alice", cap, t0), true, "2ª sessão de alice NÃO multiplica o limite");
});

test("rateLimited: REABASTECE com o tempo (cap/60000 por ms) — relógio injetado", () => {
  const buckets = new Map<string, Bucket>();
  const cap = 60; // 60/min = 1 token/segundo
  const t0 = 0;
  for (let i = 0; i < 60; i++) rateLimited(buckets, "k", cap, t0);
  assert.equal(rateLimited(buckets, "k", cap, t0), true, "esgotado em t0");
  assert.equal(rateLimited(buckets, "k", cap, t0 + 1000), false, "+1 token reabastecido em 1s");
  assert.equal(rateLimited(buckets, "k", cap, t0 + 1000), true, "só 1 reabasteceu");
});

test("pruneRateBuckets: remove só os baldes reabastecidos ao CAP (==ausentes); mantém os ainda consumidos", () => {
  const buckets = new Map<string, Bucket>();
  const cap = 10;
  const t0 = 0;
  rateLimited(buckets, "quase", cap, t0); // consumiu 1 → tokens 9
  for (let i = 0; i < 9; i++) rateLimited(buckets, "gasto", cap, t0); // consumiu 9 → tokens 1
  // 6s depois: refill = 10/60000·6000 = +1 token. "quase" 9+1=10 (cheio→podar); "gasto" 1+1=2 (<cap→manter)
  const removed = pruneRateBuckets(buckets, cap, t0 + 6000);
  assert.equal(removed, 1, "só o balde reabastecido ao cap é removido");
  assert.ok(buckets.has("gasto") && !buckets.has("quase"));
  // o balde podado é recriado CHEIO na próxima chamada — poda é behavior-preserving
  assert.equal(rateLimited(buckets, "quase", cap, t0 + 6000), false, "recriado cheio (== nunca visto)");
});

test("pruneRateBuckets: NÃO remove um balde ainda ESGOTADO — a decisão de limite é preservada", () => {
  const buckets = new Map<string, Bucket>();
  const cap = 5;
  const t0 = 100_000;
  for (let i = 0; i < 5; i++) rateLimited(buckets, "k", cap, t0); // esgotado agora
  assert.equal(pruneRateBuckets(buckets, cap, t0), 0, "esgotado no MESMO instante não reabasteceu → não podado");
  assert.equal(rateLimited(buckets, "k", cap, t0), true, "segue limitado (a poda não abriu brecha)");
});
