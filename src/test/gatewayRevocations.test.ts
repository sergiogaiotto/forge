import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error — módulo .mjs puro do gateway (sem tipos), importado só para teste.
import { createRevocationChecker } from "../../gateway/revocations.mjs";

// Simula um revocations.json em memória com controle de mtime — sem tocar o disco.
function fakeFs(initial: { present: boolean; mtimeMs: number; content: string }) {
  const state = { ...initial };
  return {
    state,
    deps: {
      existsSync: () => state.present,
      statSync: () => {
        if (!state.present) throw new Error("ENOENT");
        return { mtimeMs: state.mtimeMs };
      },
      readFileSync: () => state.content,
      onError: () => undefined,
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
