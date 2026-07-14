import { createHash } from "node:crypto";
import { estimateCost, PricingTable } from "../api/pricing";
import { redactSecrets } from "../util/redact";
import { CaptureMode, IngestionEvent, ObsEvent } from "./types";

// Mascaramento defensivo do conteúdo capturado (input/output/systemPrompt) antes de ir ao sink do Langfuse.
// A redação usa a FONTE ÚNICA compartilhada com o gateway e o cliente (gateway/redaction.cjs via redactSecrets):
// antes esta camada tinha um MASK_PATTERNS PRÓPRIO que só pegava sk-/pk-/Bearer/JWT/email/dígitos — divergia da
// unificada do #8, então github_pat_/sk_live_(Stripe)/AKIA/AWS_SECRET_ACCESS_KEY=/connection-string/PEM
// VAZAVAM no trace remoto (masked) e no bundle de diagnóstico. Agora obs↔gateway↔cliente redigem idêntico. (#8)
export function mask(value: unknown, capture: CaptureMode): string | undefined {
  if (capture === "metadata-only") return undefined;
  if (value === undefined || value === null) return undefined; // campo ausente (ex.: systemPrompt opcional)
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof s !== "string") return undefined; // JSON.stringify pode devolver undefined (função/símbolo)
  if (capture === "full") return cap(s); // 'full' = opt-in explícito do admin: conteúdo cru (redação é só do remoto masked; o log LOCAL força redactSecrets à parte)
  return cap(redactSecrets(s));
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
  // FinOps: quando o admin configurou preços, o custo estimado (R$/US$) é anexado à observação de
  // geração — é o que dá ao SRE visibilidade monetária. Ausente/vazio = nenhum custo emitido.
  pricing?: PricingTable;
  currency?: string;
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
              // P3 + PRIVACIDADE: o systemPrompt agrega perfil/RAG/anexos — superfície ALTA (mesmo redigido pode
              // conter contexto sensível de negócio). Conservadorismo: para o sink REMOTO (governado/compartilhado)
              // o prompt só vai em capture 'full' (opt-in explícito do admin, cru); em 'masked'/'metadata-only' é
              // OMITIDO — não é falta de redação (mask() já redige via a fonte unificada #8), é escolha de privacidade.
              // O prompt REDIGIDO fica só no log LOCAL (obs/diagnostics.ts), no disco do dev. Tokens/params seguem
              // (não são conteúdo sensível) e bastam para a análise de trace.
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
      // Custo estimado (FinOps): os campos inputCost/outputCost/totalCost são reconhecidos pelo Langfuse
      // e aparecem na análise de custo. Só quando o admin configurou preços para este modelo.
      const cost = e.usage ? estimateCost(e.model, e.usage, o.pricing ?? {}, o.currency ?? "R$") : undefined;
      const usage = e.usage
        ? {
            input: e.usage.inputTokens,
            output: e.usage.outputTokens,
            unit: "TOKENS",
            ...(cost ? { inputCost: cost.inputCost, outputCost: cost.outputCost, totalCost: cost.totalCost } : {}),
          }
        : undefined;
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
            usage,
            level: e.error ? "ERROR" : "DEFAULT",
            // statusMessage é mensagem LIVRE do provider (pode ecoar prompt/connstring/token/stack) — passa pelo
            // MESMO mask() do input/output: redigido em 'masked' (antes ia CRU aqui, enquanto input/output eram
            // mascarados — a assimetria do tema 3), cru só em 'full' (opt-in do admin). O `level` já sinaliza o erro.
            statusMessage: mask(e.error, o.capture),
            startTime: startIso,
            endTime: o.nowIso,
            metadata: { proposals: e.proposals, ...(cost ? { costCurrency: cost.currency } : {}) },
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
  // WARNING: gate reprovado, um Aplicar FORÇADO por cima do gate (override consciente — auditável), OU
  // uma permissão de ESCRITA aprovada pelo dev (escrita confirmada/forçada deve saltar aos olhos na análise).
  const gateFail =
    (e.type === "validation.result" && !e.gateOk) ||
    (e.type === "proposal.applied" && e.forced === true) ||
    (e.type === "permission.decision" && e.scope === "write" && e.outcome === "approved");
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
    case "permission.decision":
      // O detail (SQL/args) NÃO vai ao trace — só metadados da decisão (o conteúdo segue a política de
      // captura da geração; aqui é trilha de auditoria, não corpo).
      return { kind: e.kind, action: e.action, scope: e.scope, outcome: e.outcome, via: e.via, subject: e.subject };
    case "review.done":
    case "profile.ruleAdded":
      return {};
    default:
      return {};
  }
}
