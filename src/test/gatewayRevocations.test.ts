import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error — módulo .mjs puro do gateway (sem tipos), importado só para teste.
import { createRevocationChecker } from "../../gateway/revocations.mjs";

// Simula um revocations.json em memória com controle de mtime/size/clock — sem tocar o disco.
function fakeFs(initial: { present: boolean; mtimeMs: number; content: string }) {
  const state = { ...initial, nowMs: 0 };
  return {
    state,
    deps: {
      existsSync: () => state.present,
      statSync: () => {
        if (!state.present) throw new Error("ENOENT");
        return { mtimeMs: state.mtimeMs, size: Buffer.byteLength(state.content) };
      },
      readFileSync: () => state.content,
      onError: () => undefined,
      now: () => state.nowMs,
    },
  };
}

const revList = (...subjects: string[]) => JSON.stringify(subjects.map((s) => ({ subject: s, at: "2026-07-09" })));

test("revogação: subject na lista é detectado; ausente não é; subject vazio nunca", () => {
  const f = fakeFs({ present: true, mtimeMs: 100, content: revList("alice@claro", "bob@claro") });
  const r = createRevocationChecker("x", f.deps);
  assert.equal(r.isRevoked("alice@claro"), true);
  assert.equal(r.isRevoked("carol@claro"), false);
  assert.equal(r.isRevoked(""), false);
  assert.equal(r.isRevoked(undefined), false);
});

test("revogação: sem arquivo = ninguém revogado (estado conhecido)", () => {
  const f = fakeFs({ present: false, mtimeMs: 0, content: "" });
  const r = createRevocationChecker("x", f.deps);
  assert.equal(r.isRevoked("alice@claro"), false);
});

test("revogação: recarrega quando o mtime muda (adicionar um subject passa a bloquear)", () => {
  const f = fakeFs({ present: true, mtimeMs: 100, content: revList("alice@claro") });
  const r = createRevocationChecker("x", f.deps);
  assert.equal(r.isRevoked("bob@claro"), false);
  // admin revoga bob → arquivo muda (mtime avança)
  f.state.content = revList("alice@claro", "bob@claro");
  f.state.mtimeMs = 200;
  assert.equal(r.isRevoked("bob@claro"), true, "recarrega ao detectar mtime novo — o gap era não reler");
});

test("revogação: NÃO relê quando o mtime não muda (cache — barato por request)", () => {
  let reads = 0;
  const f = fakeFs({ present: true, mtimeMs: 100, content: revList("alice@claro") });
  const deps = { ...f.deps, readFileSync: () => { reads++; return f.state.content; } };
  const r = createRevocationChecker("x", deps);
  r.isRevoked("a"); r.isRevoked("b"); r.isRevoked("c");
  assert.equal(reads, 1, "mesmo mtime → uma leitura só");
});

test("revogação: JSON corrompido mantém a última lista boa (fail-safe, não libera geral)", () => {
  const f = fakeFs({ present: true, mtimeMs: 100, content: revList("alice@claro") });
  const r = createRevocationChecker("x", f.deps);
  assert.equal(r.isRevoked("alice@claro"), true);
  // arquivo corrompe (mtime muda, conteúdo inválido)
  f.state.content = "{ nao eh json";
  f.state.mtimeMs = 300;
  assert.equal(r.isRevoked("alice@claro"), true, "revogado continua revogado apesar do JSON quebrado");
});

test("revogação: reaparecer da lista (admin desfaz) volta a liberar após novo mtime", () => {
  const f = fakeFs({ present: true, mtimeMs: 100, content: revList("alice@claro") });
  const r = createRevocationChecker("x", f.deps);
  assert.equal(r.isRevoked("alice@claro"), true);
  f.state.content = revList(); // lista esvaziada
  f.state.mtimeMs = 400;
  assert.equal(r.isRevoked("alice@claro"), false);
});

// ---- regressões da revisão adversarial ----

test("REGRESSÃO: subject canonicalizado (case/espaço) — Dev@Claro.com casa dev@claro.com", () => {
  const f = fakeFs({ present: true, mtimeMs: 100, content: revList("dev@claro.com") });
  const r = createRevocationChecker("x", f.deps);
  assert.equal(r.isRevoked("Dev@Claro.com"), true, "e-mail é case-insensitive na prática");
  assert.equal(r.isRevoked("  dev@claro.com  "), true, "espaço à volta não escapa");
  // e o inverso: lista com caixa mista, query minúscula
  f.state.content = revList("Alice@CLARO.com");
  f.state.mtimeMs = 200;
  assert.equal(r.isRevoked("alice@claro.com"), true);
});

test("REGRESSÃO: reescrita com MESMO mtime mas tamanho diferente recarrega (assinatura mtime+size)", () => {
  const f = fakeFs({ present: true, mtimeMs: 1000, content: revList("alice@claro") });
  const r = createRevocationChecker("x", f.deps);
  assert.equal(r.isRevoked("bob@claro"), false);
  // admin revoga bob → conteúdo cresce, mas o mtime colide (mesma resolução de ~1ms)
  f.state.content = revList("alice@claro", "bob@claro");
  // mtimeMs permanece 1000 — o size muda de tamanho e é o que salva
  assert.equal(r.isRevoked("bob@claro"), true, "size diferente força releitura mesmo com mtime colidido");
});

test("REGRESSÃO: TTL de segurança relê mesmo com assinatura idêntica após a janela", () => {
  const f = fakeFs({ present: true, mtimeMs: 1000, content: revList("alice@claro") });
  const r = createRevocationChecker("x", f.deps);
  assert.equal(r.isRevoked("alice@claro"), true);
  // conteúdo trocado por outro de MESMO tamanho e MESMO mtime (colisão total) — só o TTL salva
  const sameLen = revList("bobby@claro"); // "bobby@claro" tem o mesmo comprimento de "alice@claro"
  assert.equal(Buffer.byteLength(sameLen), Buffer.byteLength(revList("alice@claro")), "pré-condição do teste");
  f.state.content = sameLen;
  f.state.nowMs = 100; // dentro do TTL → ainda stale
  assert.equal(r.isRevoked("bobby@claro"), false, "dentro do TTL, assinatura idêntica → cache");
  f.state.nowMs = 10000; // além do TTL (5s) → relê
  assert.equal(r.isRevoked("bobby@claro"), true, "além do TTL relê e pega a troca");
});

test("REGRESSÃO: cold-start com JSON corrompido NÃO cacheia a falha — auto-cura ao corrigir", () => {
  const f = fakeFs({ present: true, mtimeMs: 100, content: "{ corrompido" });
  const r = createRevocationChecker("x", f.deps);
  assert.equal(r.isReady(), false);
  assert.equal(r.isRevoked("alice@claro"), false); // sem lista boa ainda; janela aberta (logada em ERROR)
  assert.equal(r.isReady(), false, "cold-start ilegível não vira 'pronto'");
  // operador corrige o arquivo (mesmo mtime!) — como não cacheamos a falha, a próxima chamada relê
  f.state.content = revList("alice@claro");
  assert.equal(r.isRevoked("alice@claro"), true, "auto-cura sem depender de mudança de mtime");
  assert.equal(r.isReady(), true);
});
