import assert from "node:assert/strict";
import { test } from "node:test";
import { clampOutputToServed, getModelMeta, resolveMaxOutput } from "../api/modelCatalog";
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

// R6 (roadmap pós-#199): numa janela SERVIDA pequena (ex.: 32k do --max-model-len do vLLM) + preset de saída
// grande, o inputBudget COLAPSAVA a 1024 (dois floors FIXOS divergentes: 4096 no clamp de saída, 1024 no
// deriveBudget) → base prompt truncado, skills/RAG dropados (o modelo gerava quase sem contexto). Agora a
// reserva de entrada é PROPORCIONAL e a MESMA política alimenta os dois pontos, que concordam. Testa a CADEIA
// real (resolveMaxOutput → clampOutputToServed = maxTokens do provider → deriveBudget = entrada empacotada).
test("R6: janela servida 32k + preset grande não colapsa a entrada; a cadeia é consistente (anti-400)", () => {
  const meta = getModelMeta("openai-compatible", "openai/gpt-oss-120b"); // catálogo 131072/32768
  const served = 32768; // gateway serve 32k
  for (const preset of [0 /* =catálogo 32768 */, 32768, 65536, 131072]) {
    const maxTokens = clampOutputToServed(resolveMaxOutput(preset, meta), meta, served); // enviado ao provider
    const b = deriveBudget(meta, maxTokens, served); // entrada que empacotamos
    // (1) anti-400: saída (provider) + entrada (empacotada) + margem cabem na janela SERVIDA.
    assert.ok(maxTokens + b.inputBudget + b.safetyMargin <= served, `preset ${preset}: ${maxTokens}+${b.inputBudget}+${b.safetyMargin} > ${served}`);
    // (2) R6 corrigido: a entrada NÃO colapsa — recebe ~30% da janela (>> os 1024 antigos).
    assert.ok(b.inputBudget >= 9000, `preset ${preset}: inputBudget=${b.inputBudget} colapsou (esperava ~30% de 32k)`);
    assert.notEqual(b.inputBudget, 1024, "não pode mais colapsar ao piso antigo de 1024");
  }
  // 128k (janela principal) NÃO regride: o piso proporcional não morde, a saída fica no preset e a entrada é enorme.
  const big = deriveBudget(meta, clampOutputToServed(resolveMaxOutput(32768, meta), meta, 0), 0);
  assert.equal(big.outputReserve, 32768, "128k: saída fica no preset (piso não reduz)");
  assert.ok(big.inputBudget > 80000, `128k: entrada segue enorme (${big.inputBudget})`);
});

// Invariante UNIVERSAL (anti-400): a cadeia saída(provider) + entrada(empacotada) + margem cabe na janela
// para QUALQUER janela servida e preset — incluindo janelas DEGENERADAS (< ~5.7k, teóricas), onde o CAP do
// piso de entrada impede que piso-de-entrada + floor-de-saída somem mais que a janela.
test("R6 invariante universal: nunca estoura a janela (anti-400) em qualquer janela/preset", () => {
  const meta = getModelMeta("openai-compatible", "openai/gpt-oss-120b");
  const windows = [4096, 6000, 8192, 16384, 24000, 32768, 48000, 65536, 100000, 131072];
  const presets = [0, 8192, 16384, 32768, 65536, 131072, 999999999];
  for (const w of windows) {
    for (const p of presets) {
      const maxTokens = clampOutputToServed(resolveMaxOutput(p, meta), meta, w);
      const b = deriveBudget(meta, maxTokens, w);
      assert.ok(
        maxTokens + b.inputBudget + b.safetyMargin <= b.contextWindow,
        `janela ${w} preset ${p}: ${maxTokens}+${b.inputBudget}+${b.safetyMargin} > ${b.contextWindow}`
      );
      assert.ok(b.inputBudget >= 1024, `janela ${w} preset ${p}: entrada ${b.inputBudget} < 1024`);
      assert.ok(maxTokens >= 1024, `janela ${w} preset ${p}: saída ${maxTokens} < piso 1024`);
    }
  }
});

// Banda DEGENERADA (revisão adversarial): numa janela servida < ~1.2k (admin fixa maxContextWindow ~1024, ou
// gateway serve --max-model-len ~1024) o piso de saída 1024 INCONDICIONAL somava mais que a janela → 400. O cap
// superior no teto de saída (min com janela−margem) elimina a aritmética. A entrada pode ser 0 (janela inútil,
// inerente — nenhum orçamento cabe um system prompt em 1k tokens; NÃO é regressão: o design antigo estourava pior).
test("R6: janela DEGENERADA não estoura aritmeticamente (cap do teto de saída) — anti-400 no limite", () => {
  const meta = getModelMeta("openai-compatible", "openai/gpt-oss-120b");
  for (const w of [1, 256, 512, 1024, 1137, 1138, 2048]) {
    for (const p of [0, 512, 8192, 131072]) {
      const maxTokens = clampOutputToServed(resolveMaxOutput(p, meta), meta, w);
      const b = deriveBudget(meta, maxTokens, w);
      assert.ok(
        maxTokens + b.inputBudget + b.safetyMargin <= b.contextWindow,
        `janela ${w} preset ${p}: ${maxTokens}+${b.inputBudget}+${b.safetyMargin} > ${b.contextWindow}`
      );
      assert.ok(maxTokens >= 0 && b.inputBudget >= 0, "sem valores negativos");
    }
  }
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
