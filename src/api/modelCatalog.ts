// Catálogo de metadados por modelo: janela de contexto e teto de saída padrão. É a fonte da verdade
// que destrava o uso real da janela (ex.: 128k do gpt-oss-120b) em vez do teto fixo DEFAULT_MAX_TOKENS.
//
// `maxOutputTokens` aqui é a RESERVA DE SAÍDA PADRÃO — generosa, mas segura (cabe entrada + saída na
// janela sem orçamento dinâmico). A alocação entrada/saída verdadeiramente dinâmica (usar "a janela
// toda") é responsabilidade do ContextBudget (fase seguinte); este catálogo é o piso sólido sobre o
// qual ela se apoia. Modelo desconhecido cai em defaults conservadores — nunca estoura por otimismo.
import { ProviderType, supportsReasoningEffort } from "../shared/protocol";

export interface ModelMeta {
  contextWindow: number; // janela total de tokens (entrada + saída)
  maxOutputTokens: number; // reserva de saída padrão (a fase de orçamento torna isto dinâmico)
  supportsReasoningEffort: boolean;
}

interface ModelCaps {
  contextWindow: number;
  maxOutputTokens: number;
}

// Casamento por padrão sobre o modelId (robusto a prefixos como "openai/" e sufixos de versão).
// Ordem importa: o primeiro padrão que casa vence. Os padrões exigem fronteira (início ou "/") para
// evitar falso-positivo de substring (ex.: "o1" dentro de "histo1ry").
// NOTA: contextWindow é a capacidade do MODELO, não garantia do SERVIDOR — o gateway HubGPU/vLLM pode
// servir com --max-model-len menor. A Fase de orçamento deve reconciliar com o limite real do servidor.
const PATTERNS: { re: RegExp; caps: ModelCaps }[] = [
  // gpt-oss (HubGPU/vLLM): janela de 128k. Saída generosa de 32k como reserva segura — o orçamento
  // dinâmico sobe além disso quando a entrada é pequena (decisão: usar a janela toda para a saída).
  { re: /gpt-oss/i, caps: { contextWindow: 131072, maxOutputTokens: 32768 } },
  // OpenAI modernos (gpt-4o, gpt-4.1, o-series): 128k de janela, 16k de saída. Ancorado em início ou "/".
  { re: /(^|\/)(gpt-4o|gpt-4\.1)|(^|\/)o[13](\b|-)/i, caps: { contextWindow: 128000, maxOutputTokens: 16384 } },
  // Anthropic Claude: 200k de janela. (Saída 16k = comportamento histórico; a Fase de orçamento eleva.)
  { re: /claude/i, caps: { contextWindow: 200000, maxOutputTokens: 16384 } },
  // Famílias OpenAI-compatíveis comuns com janela de ~128k. Saída conservadora (8k) por segurança.
  { re: /llama-?3|qwen-?2|mistral|mixtral|deepseek|phi-?[34]/i, caps: { contextWindow: 128000, maxOutputTokens: 8192 } },
];

// Defaults conservadores para modelo desconhecido: nunca estourar a janela por otimismo.
const DEFAULT_CAPS: ModelCaps = { contextWindow: 8192, maxOutputTokens: 4096 };

export function getModelMeta(type: ProviderType, modelId: string): ModelMeta {
  const caps = PATTERNS.find((p) => p.re.test(modelId))?.caps ?? DEFAULT_CAPS;
  return {
    contextWindow: caps.contextWindow,
    maxOutputTokens: caps.maxOutputTokens,
    supportsReasoningEffort: supportsReasoningEffort(type, modelId),
  };
}

// Resolve o teto de saída efetivo: um override de config válido (inteiro positivo, nunca acima da
// janela) vence; senão usa a reserva padrão do catálogo. Saneia entradas inválidas (0, negativo, NaN).
export function resolveMaxOutput(override: number, meta: ModelMeta): number {
  const o = Math.floor(override);
  if (Number.isFinite(o) && o > 0) return Math.min(o, meta.contextWindow);
  return meta.maxOutputTokens;
}

// Política de ORÇAMENTO da janela, COMPARTILHADA entre o teto de saída (clampOutputToServed) e o orçamento
// de entrada (deriveBudget) — os dois têm de CONCORDAR: o provider reserva `maxTokens` de saída e nós
// empacotamos `inputBudget` de entrada; saída + entrada + margem tem de caber na janela, senão HTTP 400.
// Antes eram dois floors FIXOS e divergentes (4096 no clamp, 1024 no deriveBudget); numa janela servida
// pequena (ex.: 32k do --max-model-len do vLLM) um preset de saída grande engolia quase tudo e a ENTRADA
// COLAPSAVA a 1024 — dropando skills/RAG e truncando o base prompt (o modelo gerava quase sem contexto).
export const CONTEXT_SAFETY = 0.1; // folga de 10% p/ erro da estimativa de tokens (BPE quebra pt-BR em +tokens)
const INPUT_FRACTION = 0.3; // fração MÍNIMA da janela reservada p/ ENTRADA (piso PROPORCIONAL, não colapsa)
const MIN_INPUT_ABS = 4096; // piso ABSOLUTO de entrada (janelas pequenas onde 30% ficaria abaixo disto)

// Margem de segurança (tokens) para uma janela. Puro.
export function safetyMargin(window: number): number {
  return Math.ceil(Math.max(0, window) * CONTEXT_SAFETY);
}

// Reserva MÍNIMA de ENTRADA para uma janela: proporcional (≥30%) com piso absoluto. Em janelas grandes
// (128k) a entrada NATURAL (janela − saída − margem) excede este piso, então ele NÃO reduz a saída; só
// morde em janelas pequenas (servidas com --max-model-len reduzido), garantindo que a entrada não seja
// starved a 1024. É a fonte ÚNICA usada pelo clamp de saída E pelo deriveBudget (mantém os dois coerentes).
// CAP defensivo: nunca reserva tanto que não sobre a margem + um mínimo de saída (1024) — sem isto, numa
// janela DEGENERADA (< ~5.7k, teórica) o piso de entrada + o floor de saída somariam mais que a janela → 400. Puro.
export function minInputReserve(window: number): number {
  const w = Math.max(0, window);
  const desired = Math.max(MIN_INPUT_ABS, Math.ceil(w * INPUT_FRACTION));
  const cap = Math.max(0, w - safetyMargin(w) - 1024); // deixa ≥ margem + 1024 de saída
  return Math.min(desired, cap);
}

// Rebaixa o teto de saída à janela realmente SERVIDA pelo gateway, reservando a ENTRADA proporcional
// (minInputReserve) + a margem de segurança — evita o footgun de um preset grande que (a) excederia o
// --max-model-len servido (HTTP 400 em toda geração) ou (b) colapsaria a entrada. `servedWindow` =
// forge.provider.maxContextWindow (0 = usar o nominal do catálogo). Nunca abaixo de 1024 (piso de saída). Puro.
export function clampOutputToServed(resolved: number, meta: ModelMeta, servedWindow: number): number {
  const window = Number.isFinite(servedWindow) && servedWindow > 0 ? Math.min(servedWindow, meta.contextWindow) : meta.contextWindow;
  const margin = safetyMargin(window);
  // Teto = janela − reserva de entrada − margem, com piso ÚTIL de 1024 MAS nunca acima de (janela − margem):
  // sem o cap superior, numa janela DEGENERADA (< ~1.1k, teórica) o piso de 1024 excederia a janela e a soma
  // saída+entrada+margem estouraria (HTTP 400). O `min` garante maxTokens ≤ janela−margem−minInput SEMPRE — a
  // invariante anti-400 que o deriveBudget assume. Nas janelas reais (≥ 2k) o piso não morde: inalterado.
  const ceiling = Math.min(window - margin, Math.max(1024, window - minInputReserve(window) - margin));
  return Math.min(resolved, ceiling);
}
