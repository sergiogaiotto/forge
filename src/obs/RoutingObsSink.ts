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
    // Drena os dois independentemente do modo atual (cada um é no-op quando a fila está vazia).
    await this.direct.flush();
    await this.gateway.flush();
  }
}
