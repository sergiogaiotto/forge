import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error — módulo .mjs puro do gateway (sem tipos), importado só para teste.
import { charge, estimateActualTokens, estimateRequestTokens, overBudget, parseLedger, pruneOldDays, serializeLedger, settle, spentToday, utcDay } from "../../gateway/spend.mjs";

const DAY = "2026-07-12";
const OTHER = "2026-07-11";

test("utcDay devolve YYYY-MM-DD em UTC", () => {
  assert.equal(utcDay(Date.parse("2026-07-12T23:59:00Z")), "2026-07-12");
  assert.equal(utcDay(Date.parse("2026-07-12T00:00:00Z")), "2026-07-12");
});

test("charge acumula no dia; spentToday reflete", () => {
  const l = new Map();
  assert.equal(charge(l, "dev", DAY, 100), 100);
  assert.equal(charge(l, "dev", DAY, 50), 150);
  assert.equal(spentToday(l, "dev", DAY), 150);
  assert.equal(spentToday(l, "outro", DAY), 0, "subject sem gasto = 0");
});

test("ROLLOVER: gasto de outro dia não conta hoje; charge zera a base no dia novo", () => {
  const l = new Map([["dev", { day: OTHER, tokens: 999999 }]]);
  assert.equal(spentToday(l, "dev", DAY), 0, "gasto de ontem não conta hoje");
  assert.equal(overBudget(l, "dev", DAY, 100), false, "rollover: hoje começa do zero");
  assert.equal(charge(l, "dev", DAY, 10), 10, "charge no dia novo começa da base 0");
});

test("overBudget: budget 0/ausente = ILIMITADO (grandfather)", () => {
  const l = new Map([["dev", { day: DAY, tokens: 10 ** 9 }]]);
  assert.equal(overBudget(l, "dev", DAY, 0), false, "budget 0 = ilimitado");
  assert.equal(overBudget(l, "dev", DAY, undefined), false, "budget ausente = ilimitado");
});

test("overBudget dispara ao ATINGIR o teto (>=)", () => {
  const l = new Map();
  charge(l, "dev", DAY, 999);
  assert.equal(overBudget(l, "dev", DAY, 1000), false, "abaixo do teto passa");
  charge(l, "dev", DAY, 1);
  assert.equal(overBudget(l, "dev", DAY, 1000), true, "no teto exato → barra");
});

test("charge ignora valores não-positivos/NaN (não corrompe o total)", () => {
  const l = new Map();
  charge(l, "dev", DAY, 100);
  assert.equal(charge(l, "dev", DAY, -50), 100, "negativo não credita");
  assert.equal(charge(l, "dev", DAY, NaN), 100, "NaN não credita");
});

test("pruneOldDays remove só entradas de outros dias", () => {
  const l = new Map([["a", { day: DAY, tokens: 5 }], ["b", { day: OTHER, tokens: 5 }]]);
  assert.equal(pruneOldDays(l, DAY), 1);
  assert.deepEqual([...l.keys()], ["a"]);
});

test("serialize→parse preserva o gasto do dia corrente (durabilidade)", () => {
  const l = new Map([["a", { day: DAY, tokens: 300 }], ["b", { day: OTHER, tokens: 9 }]]);
  const round = parseLedger(serializeLedger(l, DAY));
  assert.equal(spentToday(round, "a", DAY), 300, "gasto do dia sobrevive ao round-trip");
  assert.equal(round.has("b"), false, "entradas de outros dias não são serializadas");
});

test("parseLedger fail-safe: JSON corrompido → ledger vazio", () => {
  assert.equal(parseLedger("{lixo").size, 0);
  assert.equal(parseLedger("").size, 0);
  assert.equal(parseLedger('{"day":"x","entries":{"a":-5}}').size, 0, "tokens negativos rejeitados");
});

test("REGRESSÃO (durabilidade): subject '__proto__' sobrevive ao round-trip (Object.create(null))", () => {
  const l = new Map([["__proto__", { day: DAY, tokens: 777 }]]);
  const round = parseLedger(serializeLedger(l, DAY));
  assert.equal(spentToday(round, "__proto__", DAY), 777, "o subject __proto__ não é dropado no serialize");
});

test("estimateRequestTokens: input (len/4) + max_tokens do corpo; sem max_tokens usa o default", () => {
  const body = JSON.stringify({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "oi" }] });
  assert.equal(estimateRequestTokens(body, 4096), Math.ceil(body.length / 4) + 100, "usa o max_tokens do corpo");
  const noMax = JSON.stringify({ model: "m", messages: [] });
  assert.equal(estimateRequestTokens(noMax, 4096), Math.ceil(noMax.length / 4) + 4096, "cai no default de saída");
  assert.equal(estimateRequestTokens("", 4096), 4096, "corpo vazio = só o default");
});

test("REGRESSÃO (corrida): reserva + settle deixa o total no custo REAL (troca a reserva pelo actual)", () => {
  const l = new Map();
  charge(l, "dev", DAY, 4116); // reserva no admit
  assert.equal(spentToday(l, "dev", DAY), 4116, "a reserva bloqueia concorrentes durante o voo");
  settle(l, "dev", DAY, 4116, 11); // reconcilia ao real (11)
  assert.equal(spentToday(l, "dev", DAY), 11, "após o stream, o total é o custo REAL, não a reserva");
});

test("settle: actual > reserve sobe corretamente; piso 0; rollover no meio cobra o actual", () => {
  const l = new Map([["dev", { day: DAY, tokens: 100 }]]);
  settle(l, "dev", DAY, 50, 80); // 100 - 50 + 80
  assert.equal(spentToday(l, "dev", DAY), 130);
  const l2 = new Map([["dev", { day: DAY, tokens: 10 }]]);
  settle(l2, "dev", DAY, 999, 5); // 10 - 999 + 5 → piso 0
  assert.equal(spentToday(l2, "dev", DAY), 0);
  const l3 = new Map([["dev", { day: OTHER, tokens: 5 }]]); // dia virou durante o stream
  settle(l3, "dev", DAY, 4116, 11);
  assert.equal(spentToday(l3, "dev", DAY), 11, "reserva perdida no rollover → cobra o actual no dia atual");
});

test("estimateActualTokens: input do corpo + output do texto (~len/4 cada)", () => {
  assert.equal(estimateActualTokens("x".repeat(400), "y".repeat(200)), 150, "100 (input) + 50 (output)");
  assert.equal(estimateActualTokens("", ""), 0);
  assert.equal(estimateActualTokens(undefined, undefined), 0, "não lança em não-string");
});

// REGRESSÃO (bypass do teto FinOps — achado do survey): quando o upstream NÃO ecoa usage (reported=0) MAS
// houve geração, o gateway cobra a ESTIMATIVA em vez de estornar a reserva a zero. Sem isto, spentToday nunca
// crescia e o teto de tokens/dia era 100% burlável por um cliente que só omite include_usage.
test("REGRESSÃO (bypass): usage ausente + houve output → cobra a estimativa, NÃO estorna a ZERO", () => {
  const body = "x".repeat(4000); // input ~1000 tokens
  const output = "y".repeat(8000); // geração real ~2000 tokens
  const reserve = estimateRequestTokens(body, 4096);
  // O BUG: settle com actual=0 (usage ausente) estornava a reserva → 0 cobrado, o teto nunca mordia.
  const bug = new Map();
  charge(bug, "dev", DAY, reserve);
  settle(bug, "dev", DAY, reserve, 0);
  assert.equal(spentToday(bug, "dev", DAY), 0, "o BUG: usage ausente → estorno total, 0 cobrado");
  // O FIX (o que o server.mjs faz agora): reported=0 + output != "" → cobra estimateActualTokens.
  const fix = new Map();
  charge(fix, "dev", DAY, reserve);
  settle(fix, "dev", DAY, reserve, estimateActualTokens(body, output));
  assert.equal(spentToday(fix, "dev", DAY), 3000, "o FIX: cobra a estimativa (1000 input + 2000 output)");
  assert.ok(spentToday(fix, "dev", DAY) > 0, "spentToday CRESCE → o teto deixa de ser burlável");
});
