// Processamento PURO do lote de observabilidade relayado (Fase 2). O gateway NÃO confia nos eventos que
// o cliente manda: aplica teto de eventos (anti-DoS na fila compartilhada), amostragem POR-TRACE (não
// por-evento — senão fragmenta o trace), CARIMBA a identidade atestada pela sessão (anti-impersonação)
// e rebaixa/redige o conteúdo conforme a captura do ADMIN (a política do servidor prevalece sobre a do
// cliente). Injetável (mask, rand) para teste. Achados da revisão adversarial da Fase 2.
import * as crypto from "node:crypto";

export function attestedUserId(subject, capture) {
  return capture === "full"
    ? subject
    : "u_" + crypto.createHash("sha256").update(String(subject)).digest("hex").slice(0, 16);
}

// Rebaixa/redige input/output/systemPrompt conforme a captura do Admin. "full" passa cru (opt-in
// explícito); "metadata-only" remove o conteúdo; "masked" (default) redige via `mask`.
export function applyCaptureToEvent(e, capture, mask) {
  const b = e.body;
  if (!b || typeof b !== "object") return e;
  if (capture === "full") return e;
  const scrub = (v) => (v === undefined || v === null ? v : capture === "metadata-only" ? undefined : mask(v));
  if ("input" in b) b.input = scrub(b.input);
  if ("output" in b) b.output = scrub(b.output);
  if (b.metadata && typeof b.metadata === "object" && "systemPrompt" in b.metadata) {
    b.metadata.systemPrompt = scrub(b.metadata.systemPrompt);
  }
  return e;
}

// Carimba a identidade da SESSÃO no trace (o cliente não escolhe por quem responde). userId cru só em
// capture full; senão hash estável. Também fixa environment e org do servidor.
export function stampIdentity(e, session, capture, environment) {
  const b = e.body;
  if (!b || typeof b !== "object") return e;
  if (e.type === "trace-create") {
    b.userId = attestedUserId(session.subject, capture);
    b.environment = environment;
    b.metadata = { ...(b.metadata && typeof b.metadata === "object" ? b.metadata : {}), org: session.org };
  }
  return e;
}

// Processa o lote inteiro: retorna { events (a enfileirar), total (após cap), dropped (excedente do cap) }.
export function processRelayBatch(rawBatch, opts) {
  const { capture, mask, environment, session, sampleRate } = opts;
  const maxEvents = opts.maxEvents ?? 500;
  const rand = opts.rand ?? Math.random;
  const arr = Array.isArray(rawBatch) ? rawBatch : [];
  const batch = arr.slice(0, maxEvents);
  // Amostragem POR-TRACE: uma decisão por traceId (mantém trace-create + generation + eventos juntos).
  const decided = new Map();
  const keep = (tid) => {
    if (!tid) return rand() <= sampleRate;
    if (!decided.has(tid)) decided.set(tid, rand() <= sampleRate);
    return decided.get(tid);
  };
  const events = [];
  for (const e of batch) {
    if (!e || typeof e !== "object" || !e.body || typeof e.body !== "object") continue;
    const tid = e.type === "trace-create" ? e.body.id : e.body.traceId;
    if (!keep(tid)) continue;
    stampIdentity(e, session, capture, environment);
    applyCaptureToEvent(e, capture, mask);
    events.push(e);
  }
  return { events, total: batch.length, dropped: arr.length - batch.length };
}
