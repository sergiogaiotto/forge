import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextAssembler } from "../skills/ContextAssembler";
import { estimateTokens } from "../util/tokenEstimate";
import { SkillMeta } from "../skills/types";

function skill(name: string, description: string): SkillMeta {
  return { name, description, path: `/skills/${name}`, source: "managed", enabled: true, validators: [], templates: [] };
}

test("assembles system prompt in the specified order (RF-040)", () => {
  const a = new ContextAssembler();
  const out = a.assemble({
    basePrompt: "BASE_PROMPT",
    discoverySkills: [skill("pandas-defensive-pipelines", "DESC_PANDAS")],
    activatedSkills: [{ meta: skill("pandas-defensive-pipelines", "DESC_PANDAS"), body: "ACTIVATED_BODY" }],
    retrievedContext: "RETRIEVED_CTX",
    history: [{ role: "user", content: "prev question" }],
    query: "QUERY_TEXT",
  });

  const sp = out.systemPrompt;
  const iBase = sp.indexOf("BASE_PROMPT");
  const iDisc = sp.indexOf("DESC_PANDAS");
  const iBody = sp.indexOf("ACTIVATED_BODY");
  const iCtx = sp.indexOf("RETRIEVED_CTX");
  // ordem por prioridade: base → discovery → corpo da skill ativada → contexto RAG (elástico, por último)
  assert.ok(iBase >= 0 && iDisc > iBase && iBody > iDisc && iCtx > iBody, "order must be base → discovery → activated body → retrieved");

  // messages = history + query, query last.
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].content, "prev question");
  assert.equal(out.messages[1].content, "QUERY_TEXT");
  assert.deepEqual(out.activatedSkillNames, ["pandas-defensive-pipelines"]);
});

test("orçamento de entrada: corta o RAG (elástico) antes de tocar base/perfil (pinned)", () => {
  const a = new ContextAssembler();
  const bigRag = "RAGLINE ".repeat(5000); // ~10k tokens de contexto recuperado
  const out = a.assemble({
    basePrompt: "BASE_PINNED",
    projectProfile: "PERFIL_PINNED",
    discoverySkills: [],
    activatedSkills: [],
    retrievedContext: bigRag,
    history: [],
    query: "Q",
    inputBudgetTokens: 200, // orçamento apertado
  });
  // pinned sobrevivem; o RAG é truncado/omitido para caber
  assert.match(out.systemPrompt, /BASE_PINNED/);
  assert.match(out.systemPrompt, /PERFIL_PINNED/);
  assert.ok(out.systemPrompt.length < bigRag.length, "o RAG deve ter sido cortado pelo orçamento");
});

test("orçamento de entrada: histórico antigo é descartado, mantendo o mais recente", () => {
  const a = new ContextAssembler();
  const history = Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, content: `MSG_${i} ${"palavra ".repeat(50)}` }));
  const out = a.assemble({
    basePrompt: "BASE",
    discoverySkills: [],
    activatedSkills: [],
    retrievedContext: "",
    history,
    query: "Q",
    inputBudgetTokens: 600,
  });
  // só as mensagens mais recentes cabem; a query é sempre a última
  assert.ok(out.messages.length < history.length + 1, "histórico deve ser podado");
  assert.equal(out.messages[out.messages.length - 1].content, "Q");
  assert.match(out.messages[out.messages.length - 2].content, /MSG_49/); // a mais recente sobrevive
});

test("orçamento de entrada: RAG token-DENSO (código) NÃO estoura o teto — corta por medição, não chars/4 (footgun HTTP-400)", () => {
  const a = new ContextAssembler();
  // Código denso em símbolos: estimateTokens usa pieces*0.95, então a densidade é ~1 char/token (4× o que
  // "chars/4" assumia). O bug: truncateToTokens cortava por chars*4 → devolvia ~4× o teto em tokens →
  // input+output+margem passava da janela servida → HTTP 400 (o footgun que o #203 fechou).
  const denseCode = "a=b(c,d);".repeat(2000); // ~18k chars ≈ ~18k tokens estimados
  const budget = 400;
  const out = a.assemble({
    basePrompt: "BASE",
    discoverySkills: [],
    activatedSkills: [],
    retrievedContext: denseCode,
    history: [],
    query: "Q",
    inputBudgetTokens: budget,
  });
  const spTokens = estimateTokens(out.systemPrompt);
  assert.ok(spTokens <= budget, `systemPrompt (${spTokens} tok) deve caber no orçamento (${budget}) — o bug antigo daria ~4×`);
  assert.match(out.systemPrompt, /BASE/); // o pinned sobrevive
  assert.match(out.systemPrompt, /truncado por orçamento/); // o RAG foi truncado, não omitido
});

test("truncateToTokens (via assemble): prosa segue ~igual (sem regressão) — densidade ~4 chars/token", () => {
  const a = new ContextAssembler();
  const prose = "palavra ".repeat(4000); // prosa: densidade ~chars/4
  const budget = 300;
  const out = a.assemble({ basePrompt: "BASE", discoverySkills: [], activatedSkills: [], retrievedContext: prose, history: [], query: "Q", inputBudgetTokens: budget });
  const spTokens = estimateTokens(out.systemPrompt);
  assert.ok(spTokens <= budget, `prosa também respeita o teto (${spTokens} <= ${budget})`);
  // e a prosa não é cortada agressivamente demais: aproveita perto do orçamento disponível
  assert.ok(spTokens > budget * 0.5, `prosa aproveita o orçamento (${spTokens} > ${budget * 0.5})`);
});

test("omits empty sections", () => {
  const a = new ContextAssembler();
  const out = a.assemble({
    basePrompt: "BASE",
    discoverySkills: [],
    activatedSkills: [],
    retrievedContext: "",
    history: [],
    query: "Q",
  });
  assert.equal(out.systemPrompt.trim(), "BASE");
  assert.equal(out.messages.length, 1);
});
