import { EgressEnforcer } from "../net/EgressEnforcer";
import { safeFetch } from "../net/safeFetch";
import { combineSignals } from "../util/http";

// Cliente de embeddings via endpoint OpenAI-compatible in-network (ex.: HubGPU
// servindo Qwen3-Embedding). O `baseUrl` é só a base (ex.:
// "https://hub-gpus.claro.com.br/embed06b/v1") — o sufixo "/embeddings" é
// adicionado por este client, espelhando o contrato do hub interno da Claro.
// Sujeito ao egress deny-by-default. Quando a URL é vazia, `available()` é false
// e o índice cai para BM25 lexical (RF-079).
//
// `dimensions` (opcional) controla a densidade do vetor. Qwen3-Embedding suporta
// MRL/Matryoshka: 0 = padrão do modelo (1024 no 0.6B); valores menores (512/256)
// reduzem memória ao custo de precisão. Mudar a densidade exige reindex.
export class EmbeddingClient {
  private readonly batchSize = 64;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly egress: EgressEnforcer,
    private readonly dimensions = 0,
    private readonly timeoutMs = 30_000
  ) {}

  available(): boolean {
    return this.baseUrl.trim().length > 0;
  }

  private endpoint(): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/embeddings`;
  }

  /** Gera embeddings para os textos, preservando a ordem. Lança em caso de falha. */
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const url = this.endpoint();
    this.egress.assertAllowed(url);

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const body: Record<string, unknown> = { model: this.model, input: batch };
      if (this.dimensions > 0) body.dimensions = this.dimensions; // densidade do vetor (MRL)
      const res = await safeFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: combineSignals(signal, this.timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Embeddings retornou ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      for (const d of sorted) out.push(d.embedding);
    }
    return out;
  }
}
