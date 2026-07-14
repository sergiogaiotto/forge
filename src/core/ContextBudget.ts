// Orçamento dinâmico de contexto: divide a janela do modelo entre SAÍDA (reservada para o código
// gerado) e ENTRADA (system prompt + histórico + query), em TOKENS. Substitui o tokenBudget fixo de
// 24000 (em chars) que subutilizava a janela de 128k do gpt-oss em ~6x e cortava no meio de uma skill.
import { ModelMeta, minInputReserve, safetyMargin } from "../api/modelCatalog";

export interface ContextBudgetPlan {
  contextWindow: number;
  outputReserve: number; // tokens reservados para a SAÍDA (vira cfg.maxTokens)
  inputBudget: number; // tokens disponíveis para a ENTRADA (system + history + query)
  safetyMargin: number;
}

// A margem de folga (safetyMargin) e a reserva mínima de entrada (minInputReserve) vêm da política ÚNICA em
// modelCatalog — a MESMA que o clampOutputToServed usa ao rebaixar o teto de saída, para os dois concordarem
// (senão a soma saída+entrada+margem estouraria a janela → HTTP 400, ou a entrada colapsaria).

// `windowOverride` (> 0) reconcilia a janela do MODELO (catálogo) com o limite REAL do SERVIDOR: o
// gateway HubGPU/vLLM pode servir com --max-model-len menor que a capacidade do modelo. Sem isso, o
// orçamento confiaria nos 128k do catálogo e estouraria (400) se o servidor servir, p.ex., 32k.
export function deriveBudget(meta: ModelMeta, outputReserve: number, windowOverride = 0): ContextBudgetPlan {
  const window = windowOverride > 0 ? Math.min(meta.contextWindow, windowOverride) : meta.contextWindow;
  const margin = safetyMargin(window);
  const minInput = minInputReserve(window); // piso PROPORCIONAL (≥30%) — não colapsa a 1024 em janela pequena
  // A saída reservada nunca pode engolir a janela inteira — garante o piso de entrada.
  const reserve = Math.min(Math.max(0, outputReserve), Math.max(0, window - margin - minInput));
  // Clamp a window-margin garante que a soma (saída + entrada + margem) nunca exceda a janela, mesmo
  // em janelas minúsculas teóricas onde o piso minInput excederia o espaço disponível.
  const inputBudget = Math.min(window - margin, Math.max(minInput, window - reserve - margin));
  return { contextWindow: window, outputReserve: reserve, inputBudget, safetyMargin: margin };
}
