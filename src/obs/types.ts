// Eventos de observabilidade do FORGE (domínio). Capturam a geração de código E "tudo ao redor"
// — skill ativada, decisão humana (aplicar/descartar), quality gate, execução, testes, revisão,
// mudanças de perfil — que NUNCA chegam ao gateway (acontecem só no cliente). O sink (direto ou
// gateway-relay) decide o destino; o Admin governa pelo modo escolhido.

export type ObsEvent =
  | {
      type: "generation.start";
      taskId: string;
      mode: "normal" | "tdd" | "review" | "project";
      model: string;
      provider: string;
      skills: string[];
      sessionId: string;
      userId: string;
      org?: string;
    }
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
  | { type: "proposal.applied"; filePath: string }
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

export interface ObsConfig {
  enabled: boolean;
  baseUrl: string;
  publicKey: string;
  environment: string;
  sampleRate: number;
  capture: CaptureMode;
}

// Destino plugável dos eventos de ingestão. Hoje: sink DIRETO (Langfuse com as chaves do dev).
// Futuro: GatewayRelaySink (eventos vão pelo gateway; secretKey server-side, governado pelo Admin).
export interface ObsSink {
  enqueue(events: IngestionEvent[]): void;
  flush(): Promise<void>;
}
