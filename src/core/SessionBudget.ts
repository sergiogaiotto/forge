import { budgetGateDecision } from "../api/pricing";

// Estado FinOps CLIENTE de uma sessão: tokens acumulados (input/output), custo estimado e o flag de
// aviso-único do teto de gasto. Extraído do Controller (god-object) para uma unidade PURA e testável — a
// acumulação, a decisão do gate (avisa 1× ~80%, bloqueia 100%) e a RESET do /limpar já tiveram bug
// histórico ("o /limpar não zerava o gasto" → o bloqueio de teto PERSISTIA numa nova sessão) e nenhum teste.
// O POST da notice fica no Controller (vscode); aqui só estado + decisão. Ver [[forge-finops-ceiling-12]].
export type BudgetDecision = "proceed" | "warn" | "block";

export interface UsageSnapshot {
  input: number;
  output: number;
  totalCost: number;
  currency: string;
}

export class SessionBudget {
  private input = 0;
  private output = 0;
  private totalCost = 0;
  private currency: string;
  private warned = false;

  constructor(defaultCurrency: string) {
    this.currency = defaultCurrency;
  }

  // Acumula os tokens de uma geração + o custo já estimado pelo chamador (estimateCost precisa do config de
  // preços). `cost` ausente (sem preço configurado) → só os tokens acumulam; o custo segue 0.
  track(inputTokens: number, outputTokens: number, cost?: { totalCost: number; currency: string }): void {
    this.input += inputTokens;
    this.output += outputTokens;
    if (cost) {
      this.totalCost += cost.totalCost;
      this.currency = cost.currency;
    }
  }

  // Decisão do gate de teto sobre o custo acumulado. Marca `warned` ao avisar (só 1× por sessão) — o chamador
  // POSTA a notice conforme o retorno. Puro na decisão (budgetGateDecision).
  gate(budget: number): BudgetDecision {
    const dec = budgetGateDecision(this.totalCost, budget, this.warned);
    if (dec.block) return "block";
    if (dec.warn) {
      this.warned = true;
      return "warn";
    }
    return "proceed";
  }

  // /limpar = nova sessão: zera tokens + custo + o aviso. A moeda volta ao default do config (o init truthy
  // mascararia o fallback do custo antes da 1ª geração precificada).
  reset(defaultCurrency: string): void {
    this.input = 0;
    this.output = 0;
    this.totalCost = 0;
    this.currency = defaultCurrency;
    this.warned = false;
  }

  get spent(): number {
    return this.totalCost;
  }

  // Percentual do teto já gasto (0 se o teto for 0/ausente) — para a mensagem de aviso.
  pct(budget: number): number {
    return budget > 0 ? Math.round((this.totalCost / budget) * 100) : 0;
  }

  snapshot(): UsageSnapshot {
    return { input: this.input, output: this.output, totalCost: this.totalCost, currency: this.currency };
  }
}
