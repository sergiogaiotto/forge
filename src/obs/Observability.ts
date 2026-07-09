import { randomUUID } from "node:crypto";
import { buildIngestion, orphanTrace } from "./langfuseMap";
import { ObsConfig, ObsEvent, ObsSink } from "./types";

// Camada de observabilidade do cliente: instrumenta a geração de código E "tudo ao redor"
// (skill, decisão humana, gate, execução, testes, revisão, perfil) e roteia para um sink plugável.
// Linka os eventos de workflow ao trace da geração mais recente (lastTraceId), para que o trace
// no Langfuse mostre: a geração + se o dev aplicou + se passou no gate + se os testes passaram.
//
// Amostragem e traceId ficam aqui (estado); o mapeamento Langfuse fica em langfuseMap (puro). Os
// geradores de id/tempo/aleatório são injetáveis para teste determinístico.
interface TraceCtx {
  traceId: string;
  sampled: boolean;
}

export class Observability {
  // Trace por task: gerações concorrentes (chat + revisão) não cruzam start/end. Eventos de
  // workflow (sem taskId) anexam ao trace da geração mais recente (`last`).
  private readonly traces = new Map<string, TraceCtx>();
  private last: TraceCtx | undefined;

  constructor(
    private readonly getConfig: () => ObsConfig,
    private readonly sink: ObsSink,
    private readonly deps: { id?: () => string; now?: () => string; rand?: () => number; onError?: (m: string) => void } = {},
    // Log de diagnóstico LOCAL (P3): recebe TODO evento ANTES do gate de egress do Langfuse. Sempre-ligado
    // e redigido; nunca sujeito a cfg.enabled/amostragem. Opcional (ausente = sem log local).
    private readonly local?: { write: (e: ObsEvent) => void }
  ) {}

  private id = (): string => (this.deps.id ? this.deps.id() : randomUUID());
  private now = (): string => (this.deps.now ? this.deps.now() : new Date().toISOString());
  private rand = (): number => (this.deps.rand ? this.deps.rand() : Math.random());

  // Fronteira fail-open: a instrumentação NUNCA pode quebrar a geração — qualquer erro é engolido.
  record(e: ObsEvent): void {
    try {
      this.recordUnsafe(e);
    } catch (err) {
      this.deps.onError?.(`Observabilidade: record falhou (ignorado): ${(err as Error).message}`);
    }
  }

  private recordUnsafe(e: ObsEvent): void {
    // Diagnóstico LOCAL primeiro e SEMPRE (não é egress): registra o evento em disco/buffer independente
    // do opt-in do Langfuse. O writer local é fail-open (nunca lança), então não afeta o caminho remoto.
    this.local?.write(e);
    const cfg = this.getConfig();
    if (!cfg.enabled) return;

    let ctx: TraceCtx;
    let orphan = false;
    if (e.type === "generation.start") {
      ctx = { traceId: this.id(), sampled: this.rand() <= cfg.sampleRate };
      this.traces.set(e.taskId, ctx);
      this.last = ctx;
    } else if (e.type === "generation.end") {
      ctx = this.traces.get(e.taskId) ?? this.last ?? { traceId: this.id(), sampled: true };
      this.traces.delete(e.taskId);
    } else if (this.last) {
      ctx = this.last;
    } else {
      ctx = { traceId: this.id(), sampled: true }; // evento de workflow sem geração prévia
      this.last = ctx;
      orphan = true;
    }
    if (!ctx.sampled) return;

    const nowIso = this.now();
    const events = orphan ? [orphanTrace(this.id(), ctx.traceId, nowIso, cfg.environment)] : [];
    events.push(
      ...buildIngestion(e, {
        traceId: ctx.traceId,
        id: this.id,
        nowIso,
        capture: cfg.capture,
        environment: cfg.environment,
        pricing: cfg.pricing,
        currency: cfg.currency,
      })
    );
    this.sink.enqueue(events);
  }

  flush(): Promise<void> {
    return this.sink.flush();
  }
}
