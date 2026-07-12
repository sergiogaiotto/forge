import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error — módulo .mjs puro do gateway (sem tipos), importado só para teste.
import { attestedUserId } from "../../gateway/obsRelay.mjs";
// @ts-expect-error — módulo .mjs puro do gateway (sem tipos), importado só para teste.
import { buildProxyTraceEvents } from "../../gateway/proxyTrace.mjs";

type Ev = { type: string; body: Record<string, any> };

const mask = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)).replace(/[\w.+-]+@[\w.-]+/g, "‹email›");
let n = 0;
const opts = (over: Record<string, unknown> = {}) => ({
  capture: "masked",
  environment: "prod",
  mask,
  newId: () => `id${++n}`,
  nowIso: "2026-07-12T00:00:00.000Z",
  ...over,
});
const ctx = (over: Record<string, unknown> = {}) => ({
  subject: "dev@claro.com",
  org: "claro",
  sessionId: "sess1",
  provider: "openai-compatible",
  model: "gpt120",
  skills: [],
  ...over,
});
const record = (over: Record<string, unknown> = {}) => ({
  input: "oi",
  output: "resp",
  usage: { inputTokens: 10, outputTokens: 5 },
  startTime: 0,
  completionStartTime: 1,
  endTime: 2,
  ...over,
});

test("REGRESSÃO (PII): userId ATESTADO da sessão e HASHEADO em masked — e-mail cru não vaza", () => {
  const ev = buildProxyTraceEvents(ctx(), record(), opts()) as Ev[];
  const trace = ev.find((e) => e.type === "trace-create")!;
  assert.equal(trace.body.userId, attestedUserId("dev@claro.com", "masked"));
  assert.ok(String(trace.body.userId).startsWith("u_"), "pseudônimo estável em masked");
  assert.ok(!String(trace.body.userId).includes("@"), "e-mail cru NÃO aparece no userId");
});

test("userId cru só em capture 'full' (opt-in explícito do Admin — honra RF-063)", () => {
  const ev = buildProxyTraceEvents(ctx(), record(), opts({ capture: "full" })) as Ev[];
  const trace = ev.find((e) => e.type === "trace-create")!;
  assert.equal(trace.body.userId, "dev@claro.com");
});

test("REGRESSÃO (PII): metadata NÃO contém e-mail/login crus — só campos seguros", () => {
  const ev = buildProxyTraceEvents(ctx(), record(), opts()) as Ev[];
  for (const e of ev) {
    const meta = e.body.metadata;
    assert.ok(!("email" in meta), "sem e-mail cru no metadata");
    assert.ok(!("login" in meta), "sem login do SO no metadata");
    assert.equal(meta.org, "claro");
    assert.equal(meta.model, "gpt120");
  }
});

test("input/output passam pelo mask; usage mantém o shape server-side {inputTokens,outputTokens}", () => {
  const ev = buildProxyTraceEvents(ctx(), record({ input: "meu email joao@x.com" }), opts()) as Ev[];
  const gen = ev.find((e) => e.type === "generation-create")!;
  assert.ok(!String(gen.body.input).includes("joao@x.com"), "input redigido pela captura masked");
  assert.deepEqual(gen.body.usage, { inputTokens: 10, outputTokens: 5 }, "shape server-side preservado");
});
