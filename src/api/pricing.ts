// Custo estimado de geração por modelo (FinOps / visibilidade de SRE). Os preços são CONFIGURÁVEIS
// pelo admin — o FORGE NÃO fabrica números: sem tabela de preços, nenhum custo é exibido/emitido. Isso
// é deliberado — o HubGPU é self-hosted (custo interno é decisão da organização, não um preço público),
// e um custo inventado seria pior que custo nenhum. Quando o admin define `forge.observability.pricing`,
// o custo entra no trace do Langfuse (o SRE finalmente enxerga R$/US$ por geração). PURO/testável.

// Preço por 1 MILHÃO de tokens, na unidade que o admin escolher (R$/US$ — só um rótulo).
export interface ModelPrice {
  input: number;
  output: number;
}

// Chave = PADRÃO de modelId (substring, case-insensitive). A chave mais específica (mais longa) vence,
// para "claude-sonnet-4-6" poder ter preço diferente de "claude" genérico.
export type PricingTable = Record<string, ModelPrice>;

export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
}

// Casa o preço mais específico para o modelId. undefined se nada casar (nenhum custo será exibido).
export function matchPrice(modelId: string, table: PricingTable): ModelPrice | undefined {
  const m = (modelId ?? "").toLowerCase();
  if (!m) return undefined;
  let best: { len: number; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(table ?? {})) {
    const k = key.toLowerCase();
    if (!k) continue;
    if (m.includes(k) && (!best || k.length > best.len)) best = { len: k.length, price };
  }
  return best?.price;
}

// Custo estimado de uma geração. undefined quando não há usage ou não há preço para o modelo — nesses
// casos NADA de custo é emitido (nunca zero fabricado).
export function estimateCost(
  modelId: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  table: PricingTable,
  currency = "R$"
): CostEstimate | undefined {
  if (!usage) return undefined;
  const price = matchPrice(modelId, table);
  if (!price) return undefined;
  const inputCost = round6(((usage.inputTokens ?? 0) / 1_000_000) * price.input);
  const outputCost = round6(((usage.outputTokens ?? 0) / 1_000_000) * price.output);
  return { inputCost, outputCost, totalCost: round6(inputCost + outputCost), currency };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6; // 6 casas — custo por geração costuma ser fração de centavo
}

// FinOps (#12): decisão do teto de gasto da SESSÃO no cliente (deterrente). Pura/testável — o Controller
// guarda o estado (`sessionCost`, `budgetWarned`) e emite os avisos. block quando o gasto ATINGE o teto;
// warn ao cruzar ~80% (só uma vez — o chamador passa `warned`). budget<=0 = sem teto. Sem preços o custo
// é 0, então o teto (em moeda) simplesmente nunca dispara.
export function budgetGateDecision(spent: number, budget: number, warned: boolean): { block: boolean; warn: boolean } {
  if (!budget || budget <= 0) return { block: false, warn: false };
  if (spent >= budget) return { block: true, warn: false };
  return { block: false, warn: !warned && spent >= budget * 0.8 };
}

// Sanitiza a tabela vinda do settings (valores podem ser lixo). Descarta entradas inválidas.
export function sanitizePricing(raw: unknown): PricingTable {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: PricingTable = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || typeof val !== "object" || val === null) continue;
    const v = val as Record<string, unknown>;
    // Exige NÚMEROS REAIS — nada de coerção do Number() (""→0, true→1, [3]→3): coagir lixo a preço
    // subvaloriza o custo em silêncio (o oposto do "não fabricar preço"). Só número finito >= 0 vale.
    const { input, output } = v;
    if (typeof input === "number" && typeof output === "number" && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
      out[key] = { input, output };
    }
  }
  return out;
}
