import { clampOutputToServed, getModelMeta, resolveMaxOutput } from "../api/modelCatalog";
import { ProviderRuntimeConfig } from "../api/types";

const OUTPUT_INPUT_RESERVE = 4096; // reserva de INPUT ao clampar o output contra a janela servida

// Resolve os parâmetros de RUNTIME do provider a partir de (type, baseUrl, modelId): a janela de contexto
// EFETIVA e o TETO de output, contra a janela SERVIDA pelo gateway. Extraído do Controller (god-object):
// encapsula o CACHE da janela servida (por type::baseUrl::modelId — gateways diferentes servem janelas
// diferentes; o vLLM/HubGPU expõe --max-model-len em /v1/models), a PRECEDÊNCIA (config do admin VENCE;
// senão a auto-detectada; senão 0 = catálogo) e a MATEMÁTICA do teto (reusa getModelMeta/resolveMaxOutput/
// clampOutputToServed, puros). O I/O do PROBE (rede/egress) fica no Controller e alimenta o cache via
// recordServed(). Config injetado por acessores → PURO/testável (sem vscode).
export interface ProviderRuntimeResolverDeps {
  maxContextWindow: () => number; // forge.provider.maxContextWindow (admin) — 0 = auto-detectar
  maxOutput: () => number; // forge.provider.maxOutput (admin) — teto de output da config
}

export class ProviderRuntimeResolver {
  private readonly served = new Map<string, number>(); // (type::baseUrl::modelId) → janela servida (0 = falha/ausente)

  constructor(private readonly deps: ProviderRuntimeResolverDeps) {}

  // Chave de cache por (type::baseUrl::modelId): gateways diferentes servem janelas diferentes.
  private key(type: string, baseUrl: string | undefined, modelId: string): string {
    return `${type}::${baseUrl ?? ""}::${modelId}`;
  }

  // Já probamos esta combinação? true MESMO para uma falha cacheada como 0 — o probe roda uma vez só.
  hasProbed(type: string, baseUrl: string | undefined, modelId: string): boolean {
    return this.served.has(this.key(type, baseUrl, modelId));
  }

  // Registra a janela servida detectada pelo probe (0 = falha/ausente → o catálogo é usado; não re-proba).
  recordServed(type: string, baseUrl: string | undefined, modelId: string, window: number): void {
    this.served.set(this.key(type, baseUrl, modelId), window);
  }

  // Janela de contexto EFETIVA p/ o orçamento: a config do admin (>0) VENCE; senão a auto-detectada (cache);
  // senão 0 = usar o nominal do catálogo (drop-in seguro quando não há detecção).
  effectiveContextWindow(type: string, baseUrl: string | undefined, modelId: string): number {
    const configured = this.deps.maxContextWindow();
    if (configured > 0) return configured;
    return this.served.get(this.key(type, baseUrl, modelId)) ?? 0;
  }

  // Teto de output EFETIVO: sessão > config do admin > catálogo, com CLAMP contra a janela servida menos a
  // reserva de input (evita o footgun de um valor que o gateway recusaria com HTTP 400). `sessionMaxOutput`
  // 0 = sem escolha por-sessão (a config do admin vence).
  resolveOutputTokens(type: ProviderRuntimeConfig["type"], baseUrl: string | undefined, modelId: string, sessionMaxOutput: number): number {
    const meta = getModelMeta(type, modelId);
    const requested = sessionMaxOutput > 0 ? sessionMaxOutput : this.deps.maxOutput();
    return clampOutputToServed(resolveMaxOutput(requested, meta), meta, this.effectiveContextWindow(type, baseUrl, modelId), OUTPUT_INPUT_RESERVE);
  }
}
