import { safeFetch } from "../net/safeFetch";
import { IngestionEvent, ObsSink } from "./types";

// `warn` injetável (default console) para manter o sink testável em Node puro, sem arrastar o logger
// acoplado ao vscode — mesmo padrão do EgressEnforcer.
type WarnFn = (message: string) => void;

const QUEUE_MAX = 1000;
const BATCH_MAX = 50;

// Sink GOVERNADO: em vez de mandar os eventos DIRETO ao Langfuse com a secretKey do dev, envia o lote
// ao GATEWAY (que detém a secretKey server-side) via POST /obs/ingest, autenticado pelo token de sessão.
// Fecha o gap da observabilidade governada: os eventos de WORKFLOW do cliente (aplicar/gate/run/revisão
// — que NUNCA passam pelo proxy de geração) chegam ao Langfuse sem a secret existir no cliente, com o
// Admin governando amostragem/captura no servidor. Em LOTE, fail-open, egress-checked. PURO em cima de
// `fetch`/`getToken` injetáveis (testável sem rede).
export class GatewayRelaySink implements ObsSink {
  private queue: IngestionEvent[] = [];
  private blockedWarned = false;

  constructor(
    private readonly getGatewayUrl: () => string,
    private readonly getToken: () => string | undefined,
    private readonly egress: { assertAllowed: (url: string) => void },
    private readonly deps: { fetch?: typeof fetch; warn?: WarnFn } = {}
  ) {}

  private warn(m: string): void {
    (this.deps.warn ?? ((x: string) => console.warn(x)))(m);
  }

  enqueue(events: IngestionEvent[]): void {
    for (const e of events) {
      if (this.queue.length >= QUEUE_MAX) this.queue.shift();
      this.queue.push(e);
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const gatewayUrl = (this.getGatewayUrl() || "").replace(/\/+$/, "");
    const token = this.getToken();
    // Sem gateway configurado ou sem sessão válida, não há para onde relayar — segura a fila (será
    // drenada quando a sessão existir), mas com teto (o enqueue já descarta o mais antigo em QUEUE_MAX).
    if (!gatewayUrl || !token) return;

    const url = `${gatewayUrl}/obs/ingest`;
    try {
      this.egress.assertAllowed(url); // o host do gateway já costuma estar na allowlist (é o provedor)
    } catch {
      if (!this.blockedWarned) {
        this.blockedWarned = true;
        this.warn(`Observabilidade (relay): egress para o gateway bloqueado. Adicione o host de ${url} em forge.egress.allowedHosts.`);
      }
      this.queue.length = 0;
      return;
    }

    const batch = this.queue.splice(0, BATCH_MAX);
    try {
      const res = await safeFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ batch }),
        signal: AbortSignal.timeout(10000),
        fetchImpl: this.deps.fetch,
      });
      // 401/403 = sessão inválida/revogada: NÃO re-enfileira (evita loop batendo num gateway que recusa).
      if (res.status === 401 || res.status === 403) {
        this.warn(`Observabilidade (relay): gateway recusou a sessão (${res.status}) — descartando lote.`);
        return;
      }
      if (!res.ok) this.warn(`Observabilidade (relay): ingestão via gateway não-OK (fail-open): ${res.status}`);
    } catch (err) {
      // fail-open: re-enfileira no máximo uma vez se ainda há espaço.
      if (this.queue.length + batch.length <= QUEUE_MAX) this.queue.unshift(...batch);
      this.warn(`Observabilidade (relay): falha ao enviar eventos (fail-open): ${(err as Error).message}`);
    }
  }
}
