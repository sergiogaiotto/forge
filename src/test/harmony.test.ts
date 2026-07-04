import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFinalChannel, stitchHarmonyParts, stripHarmony } from "../util/harmony";

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

// Costura de geração CONTINUADA (corte por max_tokens + rodadas "siga de onde parou") — o saneamento
// harmony roda POR PARTE: stripHarmony no concatenado pegaria só o que vem após o ÚLTIMO marcador e
// DESCARTARIA as rodadas anteriores quando cada rodada vaza seu próprio "assistantfinal".
test("stitchHarmonyParts: cada rodada com seu marcador final — todas as rodadas sobrevivem", () => {
  const parts = [
    "analysis penso…assistantfinalO sistema controla o uso de medicamentos, permitindo cadas",
    "analysis retomo…assistantfinaltrar doses e horários por paciente.",
  ];
  assert.equal(stitchHarmonyParts(parts), "O sistema controla o uso de medicamentos, permitindo cadastrar doses e horários por paciente.");
});

test("stitchHarmonyParts: partes SEM marcador entram cruas — preserva o ponto exato do corte", () => {
  // corte no meio da palavra: a junção não pode inserir nem remover nada entre as partes.
  assert.equal(stitchHarmonyParts(["- RF-01: cadastrar medica", "mentos com dose e horário"]), "- RF-01: cadastrar medicamentos com dose e horário");
  // corte após quebra de linha: o \n interior sobrevive (trim só nas bordas EXTERNAS).
  assert.equal(stitchHarmonyParts(["- item um\n", "- item dois"]), "- item um\n- item dois");
});

test("stitchHarmonyParts: parte única equivale a stripHarmony (preâmbulo/tokens removidos)", () => {
  assert.equal(stitchHarmonyParts(["Proceed.\n\n- RF-01: ok<|end|>"]), "- RF-01: ok");
  assert.equal(stitchHarmonyParts([]), "");
});

// O modelo às vezes REPETE na continuação apesar da instrução — do rabo anterior até a seção inteira.
// Sobreposição EXATA >= 20 chars é cortada; sem sobreposição exata, nada é tocado (conservador).
test("stitchHarmonyParts: continuação que re-escreve o rabo da rodada anterior não duplica", () => {
  const p1 = "O sistema registra doses e horários de cada medicamento";
  const p2 = " e horários de cada medicamento, alertando o paciente nos horários corretos.";
  assert.equal(stitchHarmonyParts([p1, p2]), "O sistema registra doses e horários de cada medicamento, alertando o paciente nos horários corretos.");
});

test("stitchHarmonyParts: continuação que RECOMEÇA a seção do zero mantém só a cauda nova", () => {
  const p1 = "- RF-01: cadastrar medicamentos com dose\n- RF-02: listar medica";
  const p2 = "- RF-01: cadastrar medicamentos com dose\n- RF-02: listar medicamentos ativos\n- RF-03: remover medicamentos";
  assert.equal(stitchHarmonyParts([p1, p2]), "- RF-01: cadastrar medicamentos com dose\n- RF-02: listar medicamentos ativos\n- RF-03: remover medicamentos");
});

test("stitchHarmonyParts: sobreposição curta (< 20 chars) NÃO é cortada — pode ser coincidência", () => {
  // "- p95" no fim e no começo é coincidência plausível de bullets parecidos, não repetição.
  assert.equal(stitchHarmonyParts(["- RNF-01: p95\n", "- p95 do endpoint X < 200ms"]), "- RNF-01: p95\n- p95 do endpoint X < 200ms");
});

// REGRESSÃO (revisão adversarial): preâmbulo do canal analysis SEM marcador numa rodada >= 1 ficaria
// no MEIO do texto juntado — onde o dropHarmonyPreamble do fim não alcança. Limpa por parte, gated
// na presença REAL de preâmbulo (senão a parte entra crua, preservando o ponto exato do corte).
test("stitchHarmonyParts: preâmbulo sem marcador no INÍCIO de uma continuação é removido", () => {
  const parts = ["O sistema permite cadas", "Now final output is markdown string.\nProceed.\ntrar medicamentos e doses."];
  assert.equal(stitchHarmonyParts(parts), "O sistema permite cadastrar medicamentos e doses.");
});

test("stitchHarmonyParts: continuação limpa começando com quebra de linha NÃO perde a quebra", () => {
  // sem preâmbulo, a parte entra crua — o \n inicial da continuação é o separador do bullet.
  assert.equal(stitchHarmonyParts(["- item um", "\n- item dois"]), "- item um\n- item dois");
});

// REGRESSÃO (revisão adversarial): com marcador na 1ª parte, TUDO após ele é canal final por
// definição — o preâmbulo heurístico NÃO roda (mesma regra do stripHarmony de parte única).
test("stitchHarmonyParts: conteúdo legítimo após o marcador final não é tratado como preâmbulo", () => {
  assert.equal(
    stitchHarmonyParts(["analysis rascunho…assistantfinalProceed.\nCom o cadastro em duas etapas."]),
    "Proceed.\nCom o cadastro em duas etapas."
  );
});

// REGRESSÃO (revisão adversarial): a extração do canal final na costura NÃO pode trimar — o trim
// destruiria o whitespace do ponto exato do corte e colaria bullets/palavras na emenda.
test("stitchHarmonyParts: rodada com marcador terminando em quebra de linha preserva a quebra na emenda", () => {
  assert.equal(stitchHarmonyParts(["assistantfinal- item um\n", "- item dois"]), "- item um\n- item dois");
});

test("stitchHarmonyParts: costura de partes longas termina rápido (busca de sobreposição linear)", () => {
  // ~120k chars por parte SEM sobreposição: a busca O(n²) antiga levaria minutos; a linear, ms.
  const a = "A".repeat(120_000) + "corte aqui";
  const b = "retomada " + "B".repeat(120_000);
  const t0 = Date.now();
  const out = stitchHarmonyParts([a, b]);
  assert.ok(Date.now() - t0 < 2_000, "costura de partes de 120k chars deve ser sub-segundo");
  assert.equal(out.length, a.length + b.length);
});

// Resgate conservador do canal de raciocínio (gateway roteia a resposta p/ reasoning_content):
// SÓ devolve conteúdo se o marcador do canal final existir; raciocínio bruto → null (nunca é resposta).
test("extractFinalChannel: com marcador devolve o conteúdo final; sem marcador devolve null", () => {
  assert.equal(extractFinalChannel("penso A, penso B<|channel|>final<|message|># Seção\ntexto"), "# Seção\ntexto");
  assert.equal(extractFinalChannel("analysis rascunho…assistantfinal- RF-01: ok<|end|>"), "- RF-01: ok");
  assert.equal(extractFinalChannel("apenas raciocínio bruto, sem canal final"), null);
  assert.equal(extractFinalChannel(""), null);
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
