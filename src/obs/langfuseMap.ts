import { createHash } from "node:crypto";
import { CaptureMode, IngestionEvent, ObsEvent } from "./types";

// Mascaramento defensivo: redige segredos/PII no payload capturado. As classes incluem hífen para
// pegar chaves modernas (sk-ant-, sk-proj-, sk-lf-) e há padrões para Bearer/JWT — segredos colados
// pelo dev (ex.: .env) não devem vazar no input/output.
const MASK_PATTERNS = [
  /sk-[A-Za-z0-9-]{16,}/g, // secret OpenAI/Anthropic/Langfuse (com hífen)
  /pk-lf-[A-Za-z0-9-]{8,}/g, // public Langfuse (redação defensiva)
  /\bBearer\s+[A-Za-z0-9._-]+/gi, // Authorization: Bearer ...
  /\beyJ[A-Za-z0-9._-]{20,}/g, // JWT
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // e-mail
  /\b\d{11,16}\b/g, // cartão/documento
];

export function mask(value: unknown, capture: CaptureMode): string | undefined {
  if (capture === "metadata-only") return undefined;
  if (value === undefined || value === null) return undefined; // campo ausente (ex.: systemPrompt opcional)
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof s !== "string") return undefined; // JSON.stringify pode devolver undefined (função/símbolo)
  if (capture === "full") return cap(s);
  for (const re of MASK_PATTERNS) s = s.replace(re, "‹redacted›");
  return cap(s);
}

// Identidade (userId) honra a captura: cru só em 'full'; fora disso vira um hash estável (preserva
// o agrupamento por usuário sem expor o e-mail) — seguro também quando a camada for reusada pelo
// gateway-relay (destino governado/compartilhado).
export function maskUserId(userId: string | undefined, capture: CaptureMode): string | undefined {
  if (!userId) return undefined;
  if (capture === "full") return userId;
  return "u_" + createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

function cap(s: string, max = 24000): string {
  return s.length > max ? s.slice(0, max) + "…[truncado]" : s;
}

export interface BuildOpts {
  traceId: string;
  id: () => string;
  nowIso: string;
  capture: CaptureMode;
  environment: string;
}

// Mapeia um evento de domínio para eventos de ingestão do Langfuse. Puro — ids/tempo/traceId vêm
// de fora (determinístico em teste). generation.start abre o trace; generation.end registra a
// observação de geração; os demais viram observações "event" anexadas ao MESMO trace.
export function buildIngestion(e: ObsEvent, o: BuildOpts): IngestionEvent[] {
  switch (e.type) {
    case "generation.start":
      return [
        {
          id: o.id(),
          type: "trace-create",
          timestamp: o.nowIso,
          body: {
            id: o.traceId,
            name: "forge.generation",
            userId: maskUserId(e.userId, o.capture),
            environment: o.environment,
            metadata: {
              mode: e.mode,
              model: e.model,
              provider: e.provider,
              skills: e.skills,
              sessionId: e.sessionId,
              org: e.org,
              // P3 + PRIVACIDADE: o systemPrompt agrega perfil/RAG/anexos — onde vivem segredos (.env, chaves
              // de nuvem, connection strings) que o mask() por-padrão NÃO cobre bem. Para o sink REMOTO
              // (governado/compartilhado) o prompt só vai em capture 'full' (opt-in explícito do admin, cru);
              // em 'masked'/'metadata-only' é OMITIDO. O prompt REDIGIDO para diagnóstico fica no log LOCAL
              // (obs/diagnostics.ts, redactSecrets+mask), no disco do dev. Os tokens/params seguem (não são
              // conteúdo sensível) e bastam para a análise de trace.
              systemPrompt: o.capture === "full" ? mask(e.systemPrompt, o.capture) : undefined,
              systemPromptTokens: e.systemPromptTokens,
              reasoningEffort: e.reasoningEffort,
              maxOutputTokens: e.maxOutputTokens,
              inputBudgetTokens: e.inputBudgetTokens,
            },
          },
        },
      ];
    case "generation.end": {
      const endMs = Date.parse(o.nowIso);
      const startIso = Number.isFinite(endMs) ? new Date(endMs - Math.max(0, e.durationMs)).toISOString() : o.nowIso;
      return [
        {
          id: o.id(),
          type: "generation-create",
          timestamp: o.nowIso,
          body: {
            id: o.id(),
            traceId: o.traceId,
            name: "generation",
            model: e.model,
            input: mask(e.input, o.capture),
            output: mask(e.output, o.capture),
            usage: e.usage ? { input: e.usage.inputTokens, output: e.usage.outputTokens, unit: "TOKENS" } : undefined,
            level: e.error ? "ERROR" : "DEFAULT",
            statusMessage: e.error,
            startTime: startIso,
            endTime: o.nowIso,
            metadata: { proposals: e.proposals },
          },
        },
      ];
    }
    default:
      return [eventObservation(e, o)];
  }
}

// Trace-create mínimo para eventos de workflow SEM geração prévia (ex.: rodar testes/definir papel
// sem gerar código) — evita event-create órfão referenciando um trace inexistente.
export function orphanTrace(id: string, traceId: string, nowIso: string, environment: string): IngestionEvent {
  return { id, type: "trace-create", timestamp: nowIso, body: { id: traceId, name: "forge.event", environment } };
}

function eventObservation(e: ObsEvent, o: BuildOpts): IngestionEvent {
  // WARNING: gate reprovado, OU um Aplicar FORÇADO por cima do gate (override consciente — auditável).
  const gateFail = (e.type === "validation.result" && !e.gateOk) || (e.type === "proposal.applied" && e.forced === true);
  return {
    id: o.id(),
    type: "event-create",
    timestamp: o.nowIso,
    body: {
      id: o.id(),
      traceId: o.traceId,
      name: e.type,
      level: gateFail ? "WARNING" : "DEFAULT",
      metadata: eventMeta(e),
    },
  };
}

function eventMeta(e: ObsEvent): Record<string, unknown> {
  switch (e.type) {
    case "phase.timing":
      return { phase: e.phase, durationMs: e.durationMs, taskId: e.taskId };
    case "skill.activated":
      return { skill: e.skill };
    case "proposal.created":
      return { filePath: e.filePath, change: e.change, language: e.language };
    case "proposal.applied":
      // forced = o dev aplicou por cima de um gate reprovado ("Aplicar assim mesmo, revisei") — override
      // consciente e AUDITÁVEL. WARNING no trace para o override saltar aos olhos na análise.
      return { filePath: e.filePath, forced: e.forced };
    case "proposal.discarded":
      return { filePath: e.filePath };
    case "validation.result":
      return { filePath: e.filePath, gateOk: e.gateOk, validators: e.validators };
    case "run.result":
      return { filePath: e.filePath, label: e.label, ok: e.ok, exitCode: e.exitCode, durationMs: e.durationMs };
    case "profile.roleSet":
      return { role: e.role };
    case "review.done":
    case "profile.ruleAdded":
      return {};
    default:
      return {};
  }
}
