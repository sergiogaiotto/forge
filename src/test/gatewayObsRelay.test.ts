import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error — módulo .mjs puro do gateway (sem tipos), importado só para teste.
import { attestedUserId, processRelayBatch } from "../../gateway/obsRelay.mjs";

// mask() de teste: redige e-mail e chave sk-.
const mask = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.replace(/[\w.+-]+@[\w.-]+/g, "‹email›").replace(/sk-[\w-]+/g, "‹secret›");
};
const session = { subject: "dev@claro.com", org: "claro" };
type Ev = { type: string; body: Record<string, unknown> };
const traceEv = (over: Record<string, unknown> = {}): Ev => ({ type: "trace-create", body: { id: "tr1", userId: "vitima@outra.org", ...over } });
const genEv = (over: Record<string, unknown> = {}): Ev => ({ type: "generation-create", body: { traceId: "tr1", input: "in", output: "out", ...over } });

const opts = (over: Record<string, unknown> = {}) => ({ capture: "masked", mask, environment: "prod", session, sampleRate: 1, rand: () => 0, ...over });

test("R4: 'masked' OMITE input+systemPrompt (não só redige) e redige o output (política do Admin prevalece)", () => {
  // input e systemPrompt carregam o prompt inteiro + RAG do codebase PRIVADO → omitidos em masked (a redação
  // só tira segredos, não código proprietário). O output (a geração) segue redigido.
  const { events } = processRelayBatch(
    [genEv({ input: "from app.secret import KEY", output: "chave sk-abc123def", metadata: { systemPrompt: "prompt com RAG privado" } })],
    opts()
  );
  const b = events[0].body as Record<string, any>;
  assert.equal(b.input, undefined, "input OMITIDO no servidor (não só redigido)");
  assert.equal(b.metadata?.systemPrompt, undefined, "systemPrompt OMITIDO no servidor");
  assert.ok(!String(b.output).includes("sk-abc123def"), "output redigido no servidor");
});

test("REGRESSÃO: captura 'metadata-only' remove conteúdo; 'full' passa cru", () => {
  const meta = processRelayBatch([genEv({ input: "segredo", output: "segredo2" })], opts({ capture: "metadata-only" }));
  const bm = meta.events[0].body as Record<string, unknown>;
  assert.equal(bm.input, undefined);
  assert.equal(bm.output, undefined);
  const full = processRelayBatch([genEv({ input: "joao@claro.com" })], opts({ capture: "full" }));
  assert.equal((full.events[0].body as Record<string, string>).input, "joao@claro.com", "full é opt-in do Admin");
});

test("REGRESSÃO: identidade carimbada pela sessão — cliente não forja userId de outra org", () => {
  const { events } = processRelayBatch([traceEv()], opts());
  const b = events[0].body as Record<string, unknown>;
  assert.notEqual(b.userId, "vitima@outra.org", "o userId forjado pelo cliente é sobrescrito");
  assert.equal(b.userId, attestedUserId("dev@claro.com", "masked"));
  assert.equal(b.environment, "prod");
  assert.equal((b.metadata as Record<string, unknown>).org, "claro");
  // em full, o userId atestado é o subject cru da sessão (não o do cliente)
  const full = processRelayBatch([traceEv()], opts({ capture: "full" }));
  assert.equal((full.events[0].body as Record<string, unknown>).userId, "dev@claro.com");
});

test("REGRESSÃO: amostragem POR-TRACE mantém o trace inteiro junto (não fragmenta)", () => {
  const batch = [traceEv(), genEv(), { type: "event-create", body: { traceId: "tr1", name: "proposal.applied" } }];
  // rand=0 (<=0.5) → mantém o trace inteiro; rand=1 (>0.5) → dropa o trace inteiro
  const kept = processRelayBatch(batch, opts({ sampleRate: 0.5, rand: () => 0 }));
  assert.equal(kept.events.length, 3, "trace + generation + event mantidos juntos");
  const dropped = processRelayBatch(batch, opts({ sampleRate: 0.5, rand: () => 1 }));
  assert.equal(dropped.events.length, 0, "trace inteiro dropado — nunca meio-trace");
});

test("REGRESSÃO: teto de eventos por request (anti-DoS na fila compartilhada)", () => {
  const big = Array.from({ length: 900 }, () => genEv());
  const { events, dropped } = processRelayBatch(big, opts({ maxEvents: 500 }));
  assert.equal(events.length, 500);
  assert.equal(dropped, 400);
});

test("processRelayBatch: ignora eventos malformados; batch não-array vira vazio", () => {
  const { events } = processRelayBatch([null, 42, { type: "x" }, genEv()], opts());
  assert.equal(events.length, 1);
  assert.deepEqual(processRelayBatch("nao-array" as unknown as unknown[], opts()).events, []);
});
