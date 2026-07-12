import { safeFetch } from "../net/safeFetch";
import { log } from "../util/logger";
import { IngestionEvent, ObsConfig, ObsSink } from "./types";

const QUEUE_MAX = 1000;
const BATCH_MAX = 50;

// Sink DIRETO: o cliente emite os eventos direto pro Langfuse (chaves do dev). Modo pessoal/PoC —
// a secretKey vive no cliente. Para garantia/governança do Admin, use o gateway-relay (secret
// server-side). Em LOTE, fail-open, respeitando a allowlist de egress.
export class LangfuseDirectSink implements ObsSink {
  private queue: IngestionEvent[] = [];
  private blockedWarned = false;

  constructor(
    private readonly getConfig: () => ObsConfig,
    private readonly getSecret: () => Promise<string | undefined>,
    private readonly egress: { assertAllowed: (url: string) => void }
  ) {}

  enqueue(events: IngestionEvent[]): void {
    for (const e of events) {
      if (this.queue.length >= QUEUE_MAX) this.queue.shift();
      this.queue.push(e);
    }
  }

  async flush(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.enabled || this.queue.length === 0) return;
    const secret = await this.getSecret();
    if (!cfg.publicKey || !secret) return;

    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/api/public/ingestion`;
    try {
      this.egress.assertAllowed(url); // governança: o host do Langfuse precisa estar na allowlist
    } catch {
      if (!this.blockedWarned) {
        this.blockedWarned = true;
        log.warn(`Observabilidade: egress para o Langfuse bloqueado. Adicione o host de ${url} em forge.egress.allowedHosts.`);
      }
      this.queue.length = 0; // não acumula indefinidamente quando bloqueado
      return;
    }

    const batch = this.queue.splice(0, BATCH_MAX);
    try {
      const auth = "Basic " + Buffer.from(`${cfg.publicKey}:${secret}`).toString("base64");
      const res = await safeFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ batch }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) log.warn(`Observabilidade: ingestão Langfuse não-OK (fail-open): ${res.status}`);
    } catch (err) {
      // fail-open: re-enfileira no máximo uma vez se ainda há espaço.
      if (this.queue.length + batch.length <= QUEUE_MAX) this.queue.unshift(...batch);
      log.warn(`Observabilidade: falha ao enviar eventos (fail-open): ${(err as Error).message}`);
    }
  }
}
