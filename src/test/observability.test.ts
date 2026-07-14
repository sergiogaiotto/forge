import assert from "node:assert/strict";
import { test } from "node:test";
import { Observability } from "../obs/Observability";
import { buildIngestion, mask, maskUserId } from "../obs/langfuseMap";
import { IngestionEvent, ObsConfig, ObsSink, resolveObsMode } from "../obs/types";

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

test("REGRESSÃO resolveObsMode: legado enabled=true sem mode explícito ⇒ direct (o default 'off' do contributes não pode matar o legado)", () => {
  // upgrade da 2.7.0: dev com langfuse.enabled=true e sem mode definido NÃO perde a observabilidade
  assert.equal(resolveObsMode(undefined, true), "direct");
  assert.equal(resolveObsMode(undefined, false), "off");
  // valor explícito do usuário sempre prevalece sobre o legado
  assert.equal(resolveObsMode("off", true), "off");
  assert.equal(resolveObsMode("gateway", false), "gateway");
  assert.equal(resolveObsMode("direct", false), "direct");
  // valor inválido explícito é fail-safe (não liga nada, nem resgata o legado)
  assert.equal(resolveObsMode("banana", true), "off");
});

test("permission.decision: aprovação de ESCRITA vira WARNING no trace (salta aos olhos); leitura/auto vira DEFAULT", () => {
  const opts = { traceId: "TR", id: () => "i", nowIso: NOW, capture: "masked" as const, environment: "test" };
  const [ev] = buildIngestion({ type: "permission.decision", kind: "sql.write", action: "escrita confirmada", scope: "write", outcome: "approved", via: "dialog", subject: "dw" }, opts);
  assert.equal(ev.type, "event-create");
  assert.equal((ev.body as any).level, "WARNING");
  assert.equal((ev.body as any).metadata.kind, "sql.write");
  assert.equal((ev.body as any).metadata.outcome, "approved");
  const [ev2] = buildIngestion({ type: "permission.decision", kind: "mcp.tool", action: "srv.tool", scope: "read", outcome: "auto", via: "auto" }, opts);
  assert.equal((ev2.body as any).level, "DEFAULT");
});

test("mask: full passa cru, masked redige PII/segredos, metadata-only some", () => {
  assert.equal(mask("contato a@b.com", "full"), "contato a@b.com");
  const m = mask("email a@b.com chave sk-proj-AbCdEfGhIjKlMnOpQr", "masked")!;
  assert.ok(!m.includes("a@b.com") && !m.includes("sk-proj-AbCdEfGhIjKlMnOpQr"));
  assert.match(m, /«oculto»/); // placeholder da fonte unificada (#8) — antes era ‹redacted› do MASK_PATTERNS próprio
  assert.equal(mask("qualquer", "metadata-only"), undefined);
});

test("mask cobre chaves com hífen, Langfuse secret, Bearer e JWT (fonte unificada #8)", () => {
  // Formatos REAIS que a fonte unificada cobre. Bearer exige DÍGITO e JWT exige 3 partes (o antigo MASK_PATTERNS
  // pegava também `Bearer md5sum`/`eyJ…` de 2 partes — mas eram FP-prone e não-formatos-de-segredo; a troca é
  // estritamente melhor para segredos REAIS, ganhando github_pat_/Stripe/AWS-KV/PEM/connstring).
  const secrets = [
    "sk-ant-api03-AbCdEfGhIjKlMnOpQr", // Anthropic — gap tapado na fonte unificada (hífens quebram o sk- contíguo)
    "sk-proj-AbCdEfGhIjKlMnOpQr",
    "sk-lf-1234abcd-5678efgh- effff",
    "Authorization: Bearer abc123.def-ghi_jkl", // com dígito
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM", // JWT 3 partes
  ];
  for (const s of secrets) {
    const out = mask(s, "masked")!;
    assert.match(out, /«oculto»/, `deveria redigir: ${s}`);
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

// #8 (completa a unificação da obs): o caminho REMOTO (buildIngestion generation.end, 'masked'=default) tinha um
// MASK_PATTERNS PRÓPRIO que só pegava sk-/pk-/Bearer/JWT/email/dígitos — github_pat_/Stripe/AWS-KV/connection-string
// VAZAVAM crus no trace. Não havia teste sobre a redação do input/output do buildIngestion (por isso o leak passou).
// Fixture montada por PARTES (S) para não tripar o secret-scanning do commit deste teste.
test("buildIngestion: generation.end em 'masked' redige os segredos que o MASK_PATTERNS próprio deixava vazar (#8)", () => {
  const S = (...p: string[]): string => p.join("");
  const opts = { traceId: "TR", id: () => "i", nowIso: NOW, capture: "masked" as const, environment: "test" };
  const cases = [
    { s: S("github", "_pat_11ABCDE0Y0aBcDeFgHiJkL_1a2b3c4d5e6f7g8h9i0j"), leak: S("github", "_pat_11ABCDE0Y0aBcDeFgHiJkL") },
    { s: S("sk", "_live_", "51H8zXyAbCdEfGhIjKlMnOpQr"), leak: S("51H8zXyAbCdEfGhIjKlMnOpQr") }, // Stripe
    { s: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIexampleKEY0abc123", leak: "wJalrXUtnFEMIexampleKEY0abc123" },
    { s: "DATABASE_URL=postgresql://admin:s3cr3tP4ss@db:5432/prod", leak: "s3cr3tP4ss" }, // connection string
  ];
  for (const { s, leak } of cases) {
    const [ev] = buildIngestion(
      { type: "generation.end", taskId: "t1", durationMs: 1, model: "m", input: `use ${s} no cliente`, output: `e de novo ${s}`, error: `provider falhou: ${s}`, proposals: 0 },
      opts
    );
    const b = ev.body as any;
    assert.ok(!String(b.input).includes(leak), `input deveria redigir ${leak.slice(0, 12)}…`);
    assert.ok(!String(b.output).includes(leak), `output deveria redigir ${leak.slice(0, 12)}…`);
    // statusMessage (o error do provider) era CRU aqui enquanto input/output eram mascarados — a assimetria do tema 3
    assert.ok(!String(b.statusMessage).includes(leak), `statusMessage deveria redigir ${leak.slice(0, 12)}…`);
    assert.equal(b.level, "ERROR", "o level continua sinalizando o erro");
  }
});

test("buildIngestion: generation.end em 'full' (opt-in do admin) leva input/output crus ao remoto", () => {
  const [ev] = buildIngestion(
    { type: "generation.end", taskId: "t1", durationMs: 1, model: "m", input: "conteúdo cru p/ debug sk-proj-x", output: "saída crua", proposals: 0 },
    { traceId: "TR", id: () => "i", nowIso: NOW, capture: "full", environment: "test" }
  );
  assert.match(String((ev.body as any).input), /conteúdo cru p\/ debug sk-proj-x/);
  assert.equal((ev.body as any).output, "saída crua");
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

test("Observability: permission.decision é ISENTO de amostragem (auditoria não some no sampleRate)", () => {
  // geração fora da amostra (0.99 > 0.5) — proposal.applied some, mas a decisão de permissão NÃO
  const h = harness(cfg({ sampleRate: 0.5 }), 0.99);
  h.obs.record({ type: "generation.start", taskId: "t", mode: "project", model: "m", provider: "p", skills: [], sessionId: "s", userId: "u" });
  h.obs.record({ type: "proposal.applied", filePath: "a.py" });
  assert.equal(h.captured.length, 0); // confirma que o trace não foi amostrado
  h.obs.record({ type: "permission.decision", kind: "sql.write", action: "escrita", scope: "write", outcome: "approved", via: "dialog" });
  // a decisão aterrissa num trace PRÓPRIO (orphan trace + event-create) apesar do trace da geração ter sido descartado
  assert.ok(h.captured.length >= 1, "permission.decision deveria aterrissar mesmo fora da amostra");
  assert.ok(h.captured.some((ev) => (ev.body as any)?.name === "permission.decision"));
});
