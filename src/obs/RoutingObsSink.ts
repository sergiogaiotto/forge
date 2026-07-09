import { IngestionEvent, ObsMode, ObsSink } from "./types";

// Roteia os eventos de ingestão para o sink certo conforme o `mode` corrente (direct | gateway | off).
// Cada sink concreto mantém a PRÓPRIA fila; o roteador só decide QUEM recebe o enqueue. O flush drena
// AMBOS — assim um resíduo deixado numa troca de modo (ex.: direct→gateway no meio da sessão) ainda é
// enviado, sem perda. PURO/testável.
export class RoutingObsSink implements ObsSink {
  constructor(
    private readonly getMode: () => ObsMode,
    private readonly direct: ObsSink,
    private readonly gateway: ObsSink
  ) {}

  enqueue(events: IngestionEvent[]): void {
    const mode = this.getMode();
    if (mode === "direct") this.direct.enqueue(events);
    else if (mode === "gateway") this.gateway.enqueue(events);
    // "off": descarta (o Observability já barra por cfg.enabled antes daqui; defesa em profundidade).
  }

  async flush(): Promise<void> {
    // "off" = nada sai do cliente: NÃO drena — retém o resíduo bufferizado antes da troca de modo
    // (simétrico ao LangfuseDirectSink, cujo flush já respeita cfg.enabled). Achado da revisão: sem
    // isto, virar o modo para off ainda mandava o resíduo do gateway na próxima batida do timer.
    if (this.getMode() === "off") return;
    // Nos modos ativos, drena os DOIS (cada um é no-op com fila vazia) — não perde resíduo de uma
    // troca direct↔gateway no meio da sessão.
    await this.direct.flush();
    await this.gateway.flush();
  }
}
