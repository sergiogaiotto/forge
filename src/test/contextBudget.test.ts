import assert from "node:assert/strict";
import { test } from "node:test";
import { getModelMeta } from "../api/modelCatalog";
import { deriveBudget } from "../core/ContextBudget";
import { ContextAssembler } from "../skills/ContextAssembler";
import { estimateTokens } from "../util/tokenEstimate";

test("gpt-oss 128k: entrada usa o resto da janela (muito mais que os 24k antigos)", () => {
  const meta = getModelMeta("openai-compatible", "openai/gpt-oss-120b"); // 131072 / 32768
  const b = deriveBudget(meta, meta.maxOutputTokens); // saída reservada = 32768
  assert.equal(b.contextWindow, 131072);
  assert.equal(b.outputReserve, 32768);
  // entrada = janela - saída - margem(8%); deve ser dezenas de milhares de tokens (>> 24000)
  assert.ok(b.inputBudget > 70000, `inputBudget=${b.inputBudget} deveria ser bem maior que os 24k antigos`);
  // soma nunca estoura a janela
  assert.ok(b.outputReserve + b.inputBudget + b.safetyMargin <= meta.contextWindow);
});

test("modelo pequeno (janela 8k): nunca produz orçamento negativo nem estoura", () => {
  const meta = getModelMeta("openai-compatible", "modelo-desconhecido"); // 8192 / 4096
  const b = deriveBudget(meta, meta.maxOutputTokens);
  assert.ok(b.inputBudget >= 1024);
  assert.ok(b.outputReserve + b.inputBudget + b.safetyMargin <= meta.contextWindow);
});

test("reserva de saída exagerada é limitada para garantir um piso de entrada", () => {
  const meta = getModelMeta("openai-compatible", "openai/gpt-oss-120b");
  const b = deriveBudget(meta, 999999999); // pede saída maior que a janela
  assert.ok(b.inputBudget >= 1024, "ainda sobra entrada mínima");
  assert.ok(b.outputReserve < meta.contextWindow);
});

test("reconciliação com o servidor: janela do gateway menor limita o orçamento (anti-400)", () => {
  const meta = getModelMeta("openai-compatible", "openai/gpt-oss-120b"); // catálogo diz 131072
  const b = deriveBudget(meta, meta.maxOutputTokens, 32768); // servidor real: 32k
  assert.equal(b.contextWindow, 32768, "usa a janela do servidor, não a do catálogo");
  assert.ok(b.outputReserve + b.inputBudget + b.safetyMargin <= 32768, "nunca estoura a janela real");
  // override 0 ou maior que o catálogo mantém o catálogo
  assert.equal(deriveBudget(meta, meta.maxOutputTokens, 0).contextWindow, 131072);
  assert.equal(deriveBudget(meta, meta.maxOutputTokens, 999999).contextWindow, 131072);
});

test("fio de integração: gpt-oss monta a entrada DENTRO do inputBudget mesmo com RAG e histórico enormes", () => {
  const meta = getModelMeta("openai-compatible", "openai/gpt-oss-120b");
  const budget = deriveBudget(meta, meta.maxOutputTokens);
  const out = new ContextAssembler().assemble({
    basePrompt: "BASE",
    discoverySkills: [],
    activatedSkills: [],
    retrievedContext: "linha de contexto do codebase\n".repeat(40000), // RAG gigante
    history: Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, content: `msg ${i} ${"palavra ".repeat(300)}` })),
    query: "pergunta final",
    inputBudgetTokens: budget.inputBudget,
  });
  const inputTokens = estimateTokens(out.systemPrompt) + out.messages.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);
  assert.ok(inputTokens <= budget.inputBudget, `entrada estimada ${inputTokens} deve caber em ${budget.inputBudget}`);
  // e usa MUITO mais que os 24k antigos (aproveita a janela)
  assert.ok(inputTokens > 24000, `deve aproveitar a janela: ${inputTokens} tokens`);
});
