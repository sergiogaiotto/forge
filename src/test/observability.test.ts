import assert from "node:assert/strict";
import { test } from "node:test";
import { Observability } from "../obs/Observability";
import { buildIngestion, mask, maskUserId } from "../obs/langfuseMap";
import { IngestionEvent, ObsConfig, ObsSink } from "../obs/types";

const NOW = "2026-06-28T12:00:00.000Z";
const cfg = (over: Partial<ObsConfig> = {}): ObsConfig => ({
  enabled: true,
  mode: "direct",
  baseUrl: "https://cloud.langfuse.com",
  publicKey: "pk",
  environment: "test",
  sampleRate: 1,
  capture: "masked",
  pricing: {},
  currency: "R$",
  ...over,
});

test("mask: full passa cru, masked redige PII/segredos, metadata-only some", () => {
  assert.equal(mask("contato a@b.com", "full"), "contato a@b.com");
  const m = mask("email a@b.com chave sk-abcdefghijklmnopqr", "masked")!;
  assert.ok(!m.includes("a@b.com") && !m.includes("sk-abcdefghijklmnopqr"));
  assert.match(m, /‹redacted›/);
  assert.equal(mask("qualquer", "metadata-only"), undefined);
});

test("mask cobre chaves com hífen, Langfuse secret, Bearer e JWT", () => {
  const secrets = [
    "sk-ant-api03-AbCdEfGhIjKlMnOpQr",
    "sk-proj-AbCdEfGhIjKlMnOpQr",
    "sk-lf-1234abcd-5678efgh- effff",
    "Authorization: Bearer abc.def-ghi_jkl",
    "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload",
  ];
  for (const s of secrets) {
    const out = mask(s, "masked")!;
    assert.match(out, /‹redacted›/, `deveria redigir: ${s}`);
  }
  // os prefixos sensíveis não permanecem crus
  assert.ok(!mask("sk-ant-api03-AbCdEfGhIjKlMnOpQr", "masked")!.includes("api03"));
  assert.ok(!mask("sk-lf-1234abcd-5678efgh", "masked")!.includes("5678efgh"));
});

test("maskUserId: cru só em full; hash estável fora dele", () => {
  assert.equal(maskUserId("u@x.com", "full"), "u@x.com");
  const h = maskUserId("u@x.com", "masked")!;
  assert.ok(h.startsWith("u_") && !h.includes("u@x.com"));
  assert.equal(maskUserId("u@x.com", "masked"), maskUserId("u@x.com", "metadata-only")); // estável
  assert.equal(maskUserId(undefined, "full"), undefined);
});

test("buildIngestion: generation.start abre o trace com userId", () => {
  const [ev] = buildIngestion(
    { type: "generation.start", taskId: "t1", mode: "normal", model: "m", provider: "openai-compatible", skills: ["s"], sessionId: "sess", userId: "u@x.com" },
    { traceId: "TR", id: () => "i", nowIso: NOW, capture: "full", environment: "test" }
  );
  assert.equal(ev.type, "trace-create");
  assert.equal((ev.body as any).id, "TR");
  assert.equal((ev.body as any).userId, "u@x.com");
  assert.equal((ev.body as any).name, "forge.generation");
});

// PRIVACIDADE (P3): o systemPrompt agrega perfil/RAG/anexos (onde vivem segredos). Para o sink REMOTO, o
// prompt SÓ vai em capture 'full' (opt-in do admin); em 'masked' (default) e 'metadata-only' é OMITIDO — só
// tokens/params (não-sensíveis) sobem. O prompt REDIGIDO para diagnóstico fica no log LOCAL.
test("buildIngestion: generation.start em 'masked' (default) OMITE o prompt do remoto, mas mantém tokens/params", () => {
  const [ev] = buildIngestion(
    { type: "generation.start", taskId: "t1", mode: "project", model: "m", provider: "p", skills: [], sessionId: "s", userId: "u@x.com", systemPrompt: "prompt com AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIexampleKEY dentro", systemPromptTokens: 1234, reasoningEffort: "high", maxOutputTokens: 16000, inputBudgetTokens: 80000 },
    { traceId: "TR", id: () => "i", nowIso: NOW, capture: "masked", environment: "test" }
  );
  const meta = (ev.body as any).metadata;
  assert.equal(meta.systemPrompt, undefined); // prompt NÃO vai ao remoto em masked
  assert.equal(meta.systemPromptTokens, 1234); // tamanho segue (métrica)
  assert.equal(meta.reasoningEffort, "high");
  assert.equal(meta.maxOutputTokens, 16000);
  assert.equal(meta.inputBudgetTokens, 80000);
});

test("buildIngestion: generation.start em 'full' (opt-in explícito) leva o prompt cru ao remoto", () => {
  const [ev] = buildIngestion(
    { type: "generation.start", taskId: "t1", mode: "project", model: "m", provider: "p", skills: [], sessionId: "s", userId: "u", systemPrompt: "prompt inteiro", systemPromptTokens: 3 },
    { traceId: "TR", id: () => "i", nowIso: NOW, capture: "full", environment: "test" }
  );
  assert.match(String((ev.body as any).metadata.systemPrompt), /prompt inteiro/);
});

test("buildIngestion: generation.start em metadata-only OMITE o prompt (params seguem)", () => {
  const [ev] = buildIngestion(
    { type: "generation.start", taskId: "t1", mode: "normal", model: "m", provider: "p", skills: [], sessionId: "s", userId: "u", systemPrompt: "segredo", reasoningEffort: "low" },
    { traceId: "TR", id: () => "i", nowIso: NOW, capture: "metadata-only", environment: "test" }
  );
  const meta = (ev.body as any).metadata;
  assert.equal(meta.systemPrompt, undefined);
  assert.equal(meta.reasoningEffort, "low");
});

test("buildIngestion: phase.timing (P3) vira event-create com fase e duração", () => {
  const [ev] = buildIngestion(
    { type: "phase.timing", taskId: "t1", phase: "gate", durationMs: 850 },
    { traceId: "TR", id: () => "i", nowIso: NOW, capture: "masked", environment: "test" }
  );
  assert.equal(ev.type, "event-create");
  assert.equal((ev.body as any).name, "phase.timing");
  assert.equal((ev.body as any).metadata.phase, "gate");
  assert.equal((ev.body as any).metadata.durationMs, 850);
});

test("buildIngestion: generation.end vira generation-create com usage e máscara", () => {
  const [ev] = buildIngestion(
    { type: "generation.end", taskId: "t1", durationMs: 1000, model: "m", input: "in a@b.com", output: "out", usage: { inputTokens: 10, outputTokens: 20 }, proposals: 2 },
    { traceId: "TR", id: () => "i", nowIso: NOW, capture: "masked", environment: "test" }
  );
  assert.equal(ev.type, "generation-create");
  assert.equal((ev.body as any).traceId, "TR");
  assert.deepEqual((ev.body as any).usage, { input: 10, output: 20, unit: "TOKENS" });
  assert.ok(!String((ev.body as any).input).includes("a@b.com"));
});

test("buildIngestion: eventos de workflow viram event-create no mesmo trace", () => {
  const [ev] = buildIngestion(
    { type: "validation.result", filePath: "a.py", gateOk: false, validators: [{ id: "ruff", status: "failed" }] },
    { traceId: "TR", id: () => "i", nowIso: NOW, capture: "masked", environment: "test" }
  );
  assert.equal(ev.type, "event-create");
  assert.equal((ev.body as any).traceId, "TR");
  assert.equal((ev.body as any).name, "validation.result");
  assert.equal((ev.body as any).level, "WARNING"); // gate reprovado
});

test("buildIngestion: proposal.applied FORÇADO (override do gate) vira event-create WARNING com forced", () => {
  const [forced] = buildIngestion(
    { type: "proposal.applied", filePath: "a.py", forced: true },
    { traceId: "TR", id: () => "i", nowIso: NOW, capture: "masked", environment: "test" }
  );
  assert.equal(forced.type, "event-create");
  assert.equal((forced.body as any).level, "WARNING"); // override salta na análise
  assert.equal((forced.body as any).metadata.forced, true);
  // aplicar NORMAL (não forçado) segue DEFAULT
  const [normal] = buildIngestion(
    { type: "proposal.applied", filePath: "a.py" },
    { traceId: "TR", id: () => "i", nowIso: NOW, capture: "masked", environment: "test" }
  );
  assert.equal((normal.body as any).level, "DEFAULT");
});

function harness(c: ObsConfig, rand = 0) {
  const captured: IngestionEvent[] = [];
  const sink: ObsSink = { enqueue: (es) => captured.push(...es), flush: async () => {} };
  let n = 0;
  const obs = new Observability(() => c, sink, { id: () => `id-${n++}`, now: () => NOW, rand: () => rand });
  return { obs, captured };
}

test("Observability linka eventos de workflow ao trace da geração", () => {
  const { obs, captured } = harness(cfg());
  obs.record({ type: "generation.start", taskId: "t", mode: "normal", model: "m", provider: "p", skills: [], sessionId: "s", userId: "u" });
  obs.record({ type: "proposal.applied", filePath: "a.py" });
  const trace = captured.find((e) => e.type === "trace-create")!;
  const applied = captured.find((e) => e.type === "event-create" && (e.body as any).name === "proposal.applied")!;
  assert.ok(trace && applied);
  assert.equal((applied.body as any).traceId, (trace.body as any).id); // mesmo trace
});

test("Observability: evento de workflow sem geração cria trace-create órfão", () => {
  const { obs, captured } = harness(cfg());
  obs.record({ type: "review.done" });
  assert.equal(captured[0].type, "trace-create");
  assert.equal((captured[0].body as any).name, "forge.event");
  assert.equal(captured[1].type, "event-create");
  assert.equal((captured[1].body as any).traceId, (captured[0].body as any).id);
});

test("Observability: gerações concorrentes não cruzam o trace (key por taskId)", () => {
  const { obs, captured } = harness(cfg());
  obs.record({ type: "generation.start", taskId: "A", mode: "normal", model: "m", provider: "p", skills: [], sessionId: "s", userId: "u" });
  obs.record({ type: "generation.start", taskId: "B", mode: "review", model: "m", provider: "p", skills: [], sessionId: "s", userId: "u" });
  obs.record({ type: "generation.end", taskId: "A", durationMs: 5, model: "m", input: "i", output: "o", proposals: 0 });
  const traceA = (captured.find((e) => e.type === "trace-create" && (e.body as any).metadata?.mode === "normal")!.body as any).id;
  const gen = captured.find((e) => e.type === "generation-create")!;
  assert.equal((gen.body as any).traceId, traceA); // o end de A linka ao trace de A, não ao de B
});

test("Observability.record é fail-open (sink que lança não quebra)", () => {
  const sink: ObsSink = {
    enqueue: () => {
      throw new Error("boom");
    },
    flush: async () => {},
  };
  const obs = new Observability(() => cfg(), sink, { id: () => "x", now: () => NOW, rand: () => 0 });
  assert.doesNotThrow(() => obs.record({ type: "review.done" }));
});

test("Observability respeita enabled=false e amostragem", () => {
  const off = harness(cfg({ enabled: false }));
  off.obs.record({ type: "review.done" });
  assert.equal(off.captured.length, 0);

  const sampledOut = harness(cfg({ sampleRate: 0.5 }), 0.99); // 0.99 > 0.5 => fora da amostra
  sampledOut.obs.record({ type: "generation.start", taskId: "t", mode: "normal", model: "m", provider: "p", skills: [], sessionId: "s", userId: "u" });
  sampledOut.obs.record({ type: "proposal.applied", filePath: "a.py" });
  assert.equal(sampledOut.captured.length, 0);
});
