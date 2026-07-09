import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIngestion } from "../obs/langfuseMap";
import { GatewayRelaySink } from "../obs/GatewayRelaySink";
import { RoutingObsSink } from "../obs/RoutingObsSink";
import { IngestionEvent, ObsMode, ObsSink } from "../obs/types";

const NOW = "2026-07-09T12:00:00.000Z";
let n = 0;
const id = () => `id${++n}`;
const genEnd = (usage: { inputTokens: number; outputTokens: number }) =>
  ({ type: "generation.end", taskId: "t", durationMs: 1000, model: "claude-sonnet-4-6", input: "in", output: "out", usage, proposals: 1 }) as const;

// ---- custo no mapeamento Langfuse ----

test("buildIngestion: custo é anexado à usage quando há preço; ausente sem preço", () => {
  const withCost = buildIngestion(genEnd({ inputTokens: 1_000_000, outputTokens: 500_000 }), {
    traceId: "tr", id, nowIso: NOW, capture: "masked", environment: "test",
    pricing: { "claude-sonnet-4-6": { input: 18, output: 90 } }, currency: "US$",
  })[0];
  const usage = (withCost.body as { usage: Record<string, unknown> }).usage;
  assert.equal(usage.input, 1_000_000);
  assert.equal(usage.totalCost, 63);
  assert.equal(usage.inputCost, 18);
  assert.equal((withCost.body as { metadata: Record<string, unknown> }).metadata.costCurrency, "US$");

  const noCost = buildIngestion(genEnd({ inputTokens: 100, outputTokens: 50 }), {
    traceId: "tr", id, nowIso: NOW, capture: "masked", environment: "test", pricing: {}, currency: "R$",
  })[0];
  const u2 = (noCost.body as { usage: Record<string, unknown> }).usage;
  assert.equal(u2.totalCost, undefined, "sem preço → nenhum custo emitido");
  assert.equal(u2.input, 100, "mas os tokens seguem");
});

// ---- RoutingObsSink ----

class SpySink implements ObsSink {
  events: IngestionEvent[] = [];
  flushed = 0;
  enqueue(e: IngestionEvent[]) { this.events.push(...e); }
  async flush() { this.flushed++; }
}

test("RoutingObsSink: enqueue vai para o sink do modo; off descarta; flush drena AMBOS", async () => {
  const direct = new SpySink();
  const gateway = new SpySink();
  let mode: ObsMode = "direct";
  const r = new RoutingObsSink(() => mode, direct, gateway);
  const ev = [{ id: "1", type: "event-create", timestamp: NOW, body: {} }] as IngestionEvent[];

  r.enqueue(ev);
  assert.equal(direct.events.length, 1);
  assert.equal(gateway.events.length, 0);

  mode = "gateway";
  r.enqueue(ev);
  assert.equal(gateway.events.length, 1);

  mode = "off";
  r.enqueue(ev);
  assert.equal(direct.events.length, 1, "off não enfileira");
  assert.equal(gateway.events.length, 1);

  // num modo ATIVO, flush drena os dois (não perde resíduo de uma troca direct↔gateway)
  mode = "gateway";
  await r.flush();
  assert.equal(direct.flushed, 1);
  assert.equal(gateway.flushed, 1, "flush drena os dois (resíduo de troca de modo)");
});

test("REGRESSÃO: modo 'off' NÃO drena o resíduo bufferizado ('off = nada sai')", async () => {
  const direct = new SpySink();
  const gateway = new SpySink();
  let mode: ObsMode = "off";
  const r = new RoutingObsSink(() => mode, direct, gateway);
  await r.flush();
  assert.equal(direct.flushed, 0, "off retém o resíduo (simétrico ao LangfuseDirectSink)");
  assert.equal(gateway.flushed, 0);
});

// ---- GatewayRelaySink ----

const okEgress = { assertAllowed: () => undefined };
const blockEgress = { assertAllowed: () => { throw new Error("blocked"); } };

test("GatewayRelaySink: POST /obs/ingest com Bearer da sessão e batch no corpo", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 202 } as Response;
  }) as unknown as typeof fetch;
  const sink = new GatewayRelaySink(() => "https://gw.claro/", () => "tok123", okEgress, { fetch: fakeFetch });
  sink.enqueue([{ id: "1", type: "event-create", timestamp: NOW, body: { name: "proposal.applied" } }]);
  await sink.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gw.claro/obs/ingest");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok123");
  assert.match(String(calls[0].init.body), /proposal\.applied/);
});

test("GatewayRelaySink: sem token ou sem gateway não envia (segura a fila)", async () => {
  let called = 0;
  const fakeFetch = (async () => { called++; return { ok: true, status: 202 } as Response; }) as unknown as typeof fetch;
  const noTok = new GatewayRelaySink(() => "https://gw", () => undefined, okEgress, { fetch: fakeFetch });
  noTok.enqueue([{ id: "1", type: "event-create", timestamp: NOW, body: {} }]);
  await noTok.flush();
  assert.equal(called, 0);
});

test("GatewayRelaySink: egress bloqueado limpa a fila e não chama fetch", async () => {
  let called = 0;
  const fakeFetch = (async () => { called++; return { ok: true, status: 202 } as Response; }) as unknown as typeof fetch;
  const sink = new GatewayRelaySink(() => "https://evil", () => "tok", blockEgress, { fetch: fakeFetch });
  sink.enqueue([{ id: "1", type: "event-create", timestamp: NOW, body: {} }]);
  await sink.flush();
  assert.equal(called, 0);
});

test("GatewayRelaySink: 403 (sessão revogada) descarta o lote sem re-enfileirar", async () => {
  let calls = 0;
  const fakeFetch = (async () => { calls++; return { ok: false, status: 403 } as Response; }) as unknown as typeof fetch;
  const sink = new GatewayRelaySink(() => "https://gw", () => "tok", okEgress, { fetch: fakeFetch });
  sink.enqueue([{ id: "1", type: "event-create", timestamp: NOW, body: {} }]);
  await sink.flush();
  await sink.flush(); // fila deve estar vazia — não re-tenta
  assert.equal(calls, 1, "403 não re-enfileira (evita loop contra gateway que recusa)");
});
