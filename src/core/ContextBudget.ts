// Orçamento dinâmico de contexto: divide a janela do modelo entre SAÍDA (reservada para o código
// gerado) e ENTRADA (system prompt + histórico + query), em TOKENS. Substitui o tokenBudget fixo de
// 24000 (em chars) que subutilizava a janela de 128k do gpt-oss em ~6x e cortava no meio de uma skill.
import { ModelMeta } from "../api/modelCatalog";

export interface ContextBudgetPlan {
  contextWindow: number;
  outputReserve: number; // tokens reservados para a SAÍDA (vira cfg.maxTokens)
  inputBudget: number; // tokens disponíveis para a ENTRADA (system + history + query)
  safetyMargin: number;
}

// 10% de folga sobre a janela: a estimativa de tokens é heurística e o tokenizer real (BPE) quebra
// acentos/pt-BR em mais tokens do que a estimativa por densidade — subestimar custaria um HTTP 400 do
// gateway por estourar a janela. Superestimar só deixa um pouco de espaço ocioso.
const SAFETY = 0.1;
const MIN_INPUT = 1024;

// `windowOverride` (> 0) reconcilia a janela do MODELO (catálogo) com o limite REAL do SERVIDOR: o
// gateway HubGPU/vLLM pode servir com --max-model-len menor que a capacidade do modelo. Sem isso, o
// orçamento confiaria nos 128k do catálogo e estouraria (400) se o servidor servir, p.ex., 32k.
export function deriveBudget(meta: ModelMeta, outputReserve: number, windowOverride = 0): ContextBudgetPlan {
  const window = windowOverride > 0 ? Math.min(meta.contextWindow, windowOverride) : meta.contextWindow;
  const margin = Math.ceil(window * SAFETY);
  // A saída reservada nunca pode engolir a janela inteira — garante um piso de entrada.
  const reserve = Math.min(Math.max(0, outputReserve), Math.max(0, window - margin - MIN_INPUT));
  // Clamp a window-margin garante que a soma (saída + entrada + margem) nunca exceda a janela, mesmo
  // em janelas minúsculas teóricas onde o piso MIN_INPUT excederia o espaço disponível.
  const inputBudget = Math.min(window - margin, Math.max(MIN_INPUT, window - reserve - margin));
  return { contextWindow: window, outputReserve: reserve, inputBudget, safetyMargin: margin };
}
