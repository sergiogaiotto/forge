import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionBudget } from "../core/SessionBudget";

const cost = (totalCost: number, currency = "R$") => ({ totalCost, currency });

test("track: acumula tokens; custo acumula quando há preço, e é ignorado sem preço", () => {
  const b = new SessionBudget("R$");
  b.track(100, 50, cost(0.02));
  b.track(200, 80, undefined); // sem preço configurado → só tokens
  const s = b.snapshot();
  assert.equal(s.input, 300);
  assert.equal(s.output, 130);
  assert.equal(Number(s.totalCost.toFixed(4)), 0.02, "custo só do 1º track (o 2º sem preço não soma)");
  assert.equal(b.spent, s.totalCost);
});

test("track: a moeda vem do custo acumulado (não do init)", () => {
  const b = new SessionBudget("R$");
  b.track(1, 1, cost(0.5, "USD"));
  assert.equal(b.snapshot().currency, "USD");
});

test("gate: proceed abaixo de 80%; warn UMA vez a ~80%; proceed depois (warned); block a 100%", () => {
  const b = new SessionBudget("R$");
  const budget = 10;
  assert.equal(b.gate(budget), "proceed", "gasto 0 → proceed");
  b.track(0, 0, cost(8)); // 80%
  assert.equal(b.gate(budget), "warn", "cruzou 80% → warn (1ª vez)");
  assert.equal(b.gate(budget), "proceed", "já avisou → não re-avisa (proceed)");
  b.track(0, 0, cost(2)); // 100%
  assert.equal(b.gate(budget), "block", "atingiu o teto → block");
});

test("gate: budget<=0 (sem teto) → sempre proceed, mesmo com gasto alto", () => {
  const b = new SessionBudget("R$");
  b.track(0, 0, cost(999));
  assert.equal(b.gate(0), "proceed");
  assert.equal(b.gate(-1), "proceed");
});

// REGRESSÃO do bug histórico (#12): "/limpar não zerava o gasto" → o bloqueio de teto PERSISTIA numa nova
// sessão, contradizendo a própria mensagem ("use /limpar para uma nova sessão"). reset() zera tudo.
test("reset: zera tokens + custo + o aviso — o bloqueio NÃO persiste após /limpar (regressão FinOps)", () => {
  const b = new SessionBudget("R$");
  b.track(500, 300, cost(15));
  assert.equal(b.gate(10), "block", "estourou o teto");
  b.reset("US$");
  const s = b.snapshot();
  assert.deepEqual([s.input, s.output, s.totalCost], [0, 0, 0], "tudo zerado");
  assert.equal(s.currency, "US$", "moeda volta ao default do config");
  assert.equal(b.gate(10), "proceed", "nova sessão → NÃO bloqueia (o bug era persistir o block)");
  // e o aviso volta a poder disparar após a reset
  b.track(0, 0, cost(8));
  assert.equal(b.gate(10), "warn", "warned foi resetado → avisa de novo na nova sessão");
});

test("pct: percentual do teto gasto; 0 quando o teto é 0", () => {
  const b = new SessionBudget("R$");
  b.track(0, 0, cost(2.5));
  assert.equal(b.pct(10), 25);
  assert.equal(b.pct(0), 0, "sem teto → 0 (sem divisão por zero)");
});
