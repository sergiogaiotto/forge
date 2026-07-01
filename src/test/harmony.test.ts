import assert from "node:assert/strict";
import { test } from "node:test";
import { stripHarmony } from "../util/harmony";

test("stripHarmony: canal final delimitado — mantém só o conteúdo após <|channel|>final<|message|>", () => {
  const leak = "Now final output is markdown string. Proceed.<|channel|>final<|message|># Título\nconteúdo real";
  assert.equal(stripHarmony(leak), "# Título\nconteúdo real");
});

test("stripHarmony: forma colapsada 'assistantfinal' (gateway removeu os <|...|>) — corta no marcador", () => {
  const leak = "analysisNow final output is markdown string. Proceed.assistantfinal[{\"path\":\"a.py\"}]";
  assert.equal(stripHarmony(leak), '[{"path":"a.py"}]');
});

test("stripHarmony: corta no canal final e remove tokens de controle residuais (<|end|> etc.)", () => {
  assert.equal(stripHarmony("<|channel|>final<|message|>olá<|end|>"), "olá");
});

test("stripHarmony: sem marcador de canal → texto preservado (só trim/tokens), sem destruir conteúdo", () => {
  assert.equal(stripHarmony("  conteúdo normal do usuário  "), "conteúdo normal do usuário");
  // NÃO corta em "assistant final" (com espaço) — é texto legítimo possível, não um marcador colapsado.
  assert.equal(stripHarmony("o assistant final review process"), "o assistant final review process");
});

test("stripHarmony: usa o ÚLTIMO marcador (o final real) quando há mais de um", () => {
  const leak = "<|channel|>analysis<|message|>penso...<|channel|>final<|message|>resposta";
  assert.equal(stripHarmony(leak), "resposta");
});

test("stripHarmony: vazio/entrada trivial", () => {
  assert.equal(stripHarmony(""), "");
  assert.equal(stripHarmony("   "), "");
});

// REGRESSÃO (project.md real): o gpt-oss vazou o preâmbulo do canal analysis SEM marcador — linhas
// ".", "Now final output is markdown string." e "Proceed." antes do conteúdo — e o texto foi SALVO
// assim no charter. O preâmbulo em linhas iniciais isoladas é removido; prosa real nunca é tocada.
test("stripHarmony: preâmbulo vazado SEM marcador (linhas de controle iniciais) é removido", () => {
  const leak = ".\n\nNow final output is markdown string.\n\nProceed.\n\n- RF-01: interface web responsiva";
  assert.equal(stripHarmony(leak), "- RF-01: interface web responsiva");
});

test("stripHarmony: frase de controle NO MEIO do texto é preservada (conservador)", () => {
  const text = "- item um\nProceed.\n- item dois";
  assert.equal(stripHarmony(text), text);
});

test("stripHarmony: conteúdo legítimo na 1ª linha → nada é removido, mesmo com 'Proceed' depois", () => {
  const text = "O sistema oferece gerenciamento de credenciais.\nProceed com o cadastro em duas etapas.";
  assert.equal(stripHarmony(text), text);
});

test("stripHarmony: teto de 8 linhas protege contra stripping exagerado de preâmbulo", () => {
  // 9 linhas "Proceed." — só as 8 primeiras podem ser descartadas; a 9ª sobrevive (guarda-corpo).
  const lines = Array.from({ length: 9 }, () => "Proceed.").join("\n");
  assert.equal(stripHarmony(lines), "Proceed.");
});

// REGRESSÃO (revisão adversarial): linhas em BRANCO não consomem o teto de 8 — o mesmo vazamento
// real, com mais espaçamento entre as linhas de controle, tem de continuar sendo limpo.
test("stripHarmony: preâmbulo com muitas linhas em branco intercaladas ainda é removido", () => {
  const leak = ".\n\n\n\n\nNow final output is markdown string.\n\n\nProceed.\n\n- RF-01: conteudo";
  assert.equal(stripHarmony(leak), "- RF-01: conteudo");
});

// REGRESSÃO (revisão adversarial): com o marcador do canal final presente, TUDO após ele é conteúdo
// final por definição — a heurística de preâmbulo NÃO roda (prosa legítima começando com "The final
// output …" ou "Proceed." seria destruída).
test("stripHarmony: após o marcador final, linha parecida com preâmbulo é PRESERVADA", () => {
  assert.equal(
    stripHarmony("<|channel|>final<|message|>The final output includes a CSV report.\nMore real content."),
    "The final output includes a CSV report.\nMore real content."
  );
  assert.equal(
    stripHarmony("analysis rascunho…assistantfinalProceed.\nCom o cadastro em duas etapas."),
    "Proceed.\nCom o cadastro em duas etapas."
  );
});
