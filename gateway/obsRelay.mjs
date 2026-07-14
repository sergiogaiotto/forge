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

// Rebaixa/redige input/output/systemPrompt conforme a captura do Admin. "full" passa cru (opt-in explícito);
// "metadata-only" remove todo conteúdo; "masked" (default) OMITE input+systemPrompt e redige o output.
// R4 (redação/egresso): input e systemPrompt carregam o PROMPT INTEIRO (base + skills + RAG do codebase
// PRIVADO). Em masked eles são OMITIDOS, não só redigidos: a redação tira SEGREDOS/PII, NÃO código proprietário
// — redigir e enviar ainda exfiltraria o codebase ao Langfuse. O output (a GERAÇÃO) segue redigido em masked
// (útil p/ debug). Simétrico com proxyTrace.buildProxyTraceEvents. Só 'full' (opt-in do Admin) envia o input.
export function applyCaptureToEvent(e, capture, mask) {
  const b = e.body;
  if (!b || typeof b !== "object") return e;
  if (capture === "full") return e;
  if ("input" in b) b.input = undefined; // omitido em masked E metadata-only (prompt/RAG privado)
  if (b.metadata && typeof b.metadata === "object" && "systemPrompt" in b.metadata) {
    b.metadata.systemPrompt = undefined; // idem — o prompt do sistema não sai do gateway fora de 'full'
  }
  if ("output" in b) b.output = capture === "metadata-only" ? undefined : mask(b.output); // geração: redigida em masked
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
