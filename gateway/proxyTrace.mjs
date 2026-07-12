// Constrói os eventos de ingestão do Langfuse para a rota de PROXY DIRETO (server-side), DISTINTA do
// relay do cliente (obsRelay.processRelayBatch). PURO: ids/tempo/mask injetados (determinístico em teste).
//
// IDENTIDADE: o userId do trace é ATESTADO pela sessão (session.subject, verificado por assinatura no
// activate), NÃO pelo header x-forge-email — que é do cliente e livremente spoofável. É mascarado por
// captura via attestedUserId (hash estável "u_"+sha256 em masked/metadata-only; e-mail cru só em 'full',
// opt-in explícito do Admin). Isso espelha obsRelay.stampIdentity — as duas rotas agora emitem o MESMO
// userId para o mesmo subject (fecha o vazamento de e-mail cru + spoof + a divergência de hash proxy↔relay).
//
// PII: o metadata NÃO carrega e-mail/login crus (o antigo `metadata: ctx` despejava ambos sem máscara,
// um 2º vazamento além do userId) — só org/model/provider/sessionId/skills.
//
// USAGE: mantém o shape server-side { inputTokens, outputTokens } (contagem correta após o fix do swap),
// de PROPÓSITO distinto do shape reconhecido pelo Langfuse ({ input, output, unit }) que o relay do
// cliente emite JÁ com custo — assim o proxy NÃO alimenta a análise de custo do Langfuse e as duas rotas
// não fazem dupla contagem na config primária (provider=gateway + obs=gateway).
import { attestedUserId } from "./obsRelay.mjs";

export function buildProxyTraceEvents(ctx, record, opts) {
  const { capture, environment, mask, newId, nowIso } = opts;
  const userId = attestedUserId(ctx.subject, capture);
  const metadata = {
    org: ctx.org,
    environment,
    model: ctx.model,
    provider: ctx.provider,
    sessionId: ctx.sessionId,
    skills: ctx.skills,
  };
  const traceId = newId();
  const genId = newId();
  return [
    {
      id: newId(),
      type: "trace-create",
      timestamp: nowIso,
      body: { id: traceId, name: "forge.generation", userId, environment, metadata },
    },
    {
      id: newId(),
      type: "generation-create",
      timestamp: nowIso,
      body: {
        id: genId,
        traceId,
        name: "generation",
        model: ctx.model,
        input: mask(record.input),
        output: mask(record.output),
        usage: record.usage,
        startTime: new Date(record.startTime).toISOString(),
        completionStartTime: record.completionStartTime ? new Date(record.completionStartTime).toISOString() : undefined,
        endTime: new Date(record.endTime).toISOString(),
        metadata,
      },
    },
  ];
}
