// Eventos de observabilidade do FORGE (domínio). Capturam a geração de código E "tudo ao redor"
// — skill ativada, decisão humana (aplicar/descartar), quality gate, execução, testes, revisão,
// mudanças de perfil — que NUNCA chegam ao gateway (acontecem só no cliente). O sink (direto ou
// gateway-relay) decide o destino; o Admin governa pelo modo escolhido.

// Fases da geração cronometradas (P3): do montar-prompt ao gate/reparo. Alinha OTel GenAI (spans).
export type ObsPhase = "assemble" | "rag" | "stream" | "continuation" | "gate" | "repair";

export type ObsEvent =
  | {
      type: "generation.start";
      taskId: string;
      mode: "normal" | "tdd" | "review" | "project" | "charter";
      model: string;
      provider: string;
      skills: string[];
      sessionId: string;
      userId: string;
      org?: string;
      // P3 (evidência nº1 do sintoma do print): o prompt de sistema MONTADO + os params EFETIVOS da geração.
      // Opcionais (chamadores/testes antigos não os fornecem). O systemPrompt é REDIGIDO no sink (mask) e
      // respeita o capture mode; systemPromptTokens é a contagem do prompt COMPLETO (o valor cru pode ser
      // capado no sink, mas o tamanho real fica visível).
      systemPrompt?: string;
      systemPromptTokens?: number;
      reasoningEffort?: string;
      maxOutputTokens?: number;
      inputBudgetTokens?: number;
    }
  | { type: "phase.timing"; taskId: string; phase: ObsPhase; durationMs: number }
  | {
      type: "generation.end";
      taskId: string;
      durationMs: number;
      model: string;
      input: string;
      output: string;
      usage?: { inputTokens?: number; outputTokens?: number };
      proposals: number;
      error?: string;
    }
  | { type: "skill.activated"; skill: string }
  | { type: "proposal.created"; filePath: string; change: "novo" | "edição" | "célula"; language: string }
  | { type: "proposal.applied"; filePath: string; forced?: boolean }
  | { type: "proposal.discarded"; filePath: string }
  | { type: "validation.result"; filePath: string; gateOk: boolean; validators: { id: string; status: string }[] }
  | { type: "run.result"; filePath: string; label?: string; ok: boolean; exitCode: number | null; durationMs: number }
  | { type: "review.done" }
  | { type: "profile.roleSet"; role: string }
  | { type: "profile.ruleAdded" };

// Evento de ingestão do Langfuse (formato /api/public/ingestion). Mantido genérico de propósito.
export interface IngestionEvent {
  id: string;
  type: "trace-create" | "generation-create" | "event-create";
  timestamp: string;
  body: Record<string, unknown>;
}

export type CaptureMode = "full" | "masked" | "metadata-only";

// Destino da observabilidade. "off" = nada sai. "direct" = sink Langfuse com as chaves do DEV (modo
// pessoal/PoC — a secretKey vive no cliente). "gateway" = GatewayRelaySink: os eventos vão pelo gateway
// (secretKey server-side, governado pelo Admin) — fecha o gap da observabilidade governada dos eventos
// de workflow do cliente (aplicar/gate/run), que nunca passam pelo proxy de geração.
export type ObsMode = "off" | "direct" | "gateway";

import type { PricingTable } from "../api/pricing";

export interface ObsConfig {
  enabled: boolean; // = (mode !== "off"); derivado, mantido para compat dos chamadores existentes
  mode: ObsMode;
  baseUrl: string;
  publicKey: string;
  environment: string;
  sampleRate: number;
  capture: CaptureMode;
  // FinOps: tabela de preços por modelo (configurável; vazia = sem custo emitido) + rótulo da moeda.
  pricing: PricingTable;
  currency: string;
}

// Destino plugável dos eventos de ingestão: LangfuseDirectSink (direto) ou GatewayRelaySink (governado),
// selecionados por `mode` via RoutingObsSink.
export interface ObsSink {
  enqueue(events: IngestionEvent[]): void;
  flush(): Promise<void>;
}
