import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlueprint, pickBlueprintFromChannels, topoSort } from "../util/blueprint";

// pickBlueprintFromChannels: escolha do plano entre content/raciocínio (revisão adversarial pinou
// o vetor: eco do schema no CoT BRUTO fabricava plano de 1 arquivo e PULAVA a 2ª tentativa).
const PLAN3 = '[{"path":"src/a.py","purpose":"porta","deps":[]},{"path":"src/b.py","purpose":"impl","deps":["src/a.py"]},{"path":"README.md","purpose":"docs","deps":[]}]';

test("pickBlueprintFromChannels: eco do schema no raciocínio BRUTO (sem marcador) NÃO fabrica plano", () => {
  const echo = 'We need JSON like [{"path":"caminho/relativo/arquivo.ext","purpose":"uma frase","deps":["outro/arquivo.ext"]}] then answer.';
  const r = pickBlueprintFromChannels({ text: "", reasoning: echo, truncated: false });
  assert.deepEqual(r.files, []); // inválido → chamador escala para a 2ª tentativa (conversão)
  assert.equal(r.fromReasoning, false);
});

test("pickBlueprintFromChannels: raciocínio COM marcador de canal final → resgata o plano real", () => {
  const reasoning = `rascunho... penso em [{"path":"x"}] etc.<|channel|>final<|message|>${PLAN3}`;
  const r = pickBlueprintFromChannels({ text: "", reasoning, truncated: false });
  assert.deepEqual(r.files.map((f) => f.path), ["src/a.py", "src/b.py", "README.md"]);
  assert.equal(r.fromReasoning, true);
});

test("pickBlueprintFromChannels: plano de 1 arquivo (mesmo no content) é INVÁLIDO — projeto completo tem >=2", () => {
  const r = pickBlueprintFromChannels({ text: '[{"path":"main.py","purpose":"tudo"}]', reasoning: "", truncated: false });
  assert.deepEqual(r.files, []);
});

test("pickBlueprintFromChannels: content com plano completo vence sem olhar o raciocínio", () => {
  const r = pickBlueprintFromChannels({ text: PLAN3, reasoning: "qualquer coisa", truncated: false });
  assert.equal(r.files.length, 3);
  assert.equal(r.fromReasoning, false);
});

test("pickBlueprintFromChannels: truncado com só 1 objeto completo salvageável → inválido (conversão)", () => {
  const cut = '[{"path":"src/a.py","purpose":"porta","deps":[]},{"path":"src/b.py","purp';
  const r = pickBlueprintFromChannels({ text: cut, reasoning: "", truncated: true });
  assert.deepEqual(r.files, []); // 1 < MIN → a 2ª tentativa converte a resposta truncada
  const cut2 = PLAN3.slice(0, PLAN3.length - 20); // corta no fim: 2 completos sobram
  const r2 = pickBlueprintFromChannels({ text: cut2, reasoning: "", truncated: true });
  assert.equal(r2.files.length, 2); // >= MIN → plano parcial utilizável (com aviso no modal)
});

test("parseBlueprint extrai o array JSON mesmo cercado por prosa/```json", () => {
  const text = 'Aqui está o plano:\n```json\n[{"path":"src/a.py","purpose":"porta","deps":[]},{"path":"src/b.py","purpose":"impl","deps":["src/a.py"]}]\n```\npronto!';
  const files = parseBlueprint(text);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "src/a.py");
  assert.deepEqual(files[1].deps, ["src/a.py"]);
});

test("parseBlueprint normaliza (tira ./ inicial, dedup, ignora sem path) e tolera lixo", () => {
  const files = parseBlueprint('[{"path":"./x.py","purpose":"p"},{"path":"x.py","purpose":"dup"},{"purpose":"sem path"},{"path":"y.ts","purpose":"q","deps":"naoarray"}]');
  assert.deepEqual(files.map((f) => f.path), ["x.py", "y.ts"]); // ./x.py normaliza p/ x.py e o dup é ignorado
  assert.deepEqual(files[1].deps, []); // deps não-array vira []
  assert.deepEqual(parseBlueprint("sem json aqui"), []);
  assert.deepEqual(parseBlueprint("[quebrado"), []);
});

test("parseBlueprint DESCARTA caminhos que escapariam o workspace (segurança)", () => {
  // `..` INTERIOR e caminho absoluto/drive são descartados; o `../` inicial é re-baseado p/ dentro.
  const files = parseBlueprint('[{"path":"src/ok.py","purpose":"ok"},{"path":"foo/../../../etc/x","purpose":"traversal"},{"path":"C:/Windows/evil","purpose":"absoluto"}]');
  assert.deepEqual(files.map((f) => f.path), ["src/ok.py"]); // só o contido sobrevive
});

// REGRESSÃO (raiz do "modal fecha sem nada"): o gpt-oss pode vazar raciocínio no output; o parse
// endurecido extrai o array top-level válido em vez de quebrar e retornar [].
test("parseBlueprint: raciocínio/controle vazado ANTES do array (gpt-oss) ainda produz o plano", () => {
  const leak = 'Now final output is markdown string. Proceed.assistantfinal[{"path":"src/a.py","purpose":"porta","deps":[]}]';
  assert.deepEqual(parseBlueprint(leak).map((f) => f.path), ["src/a.py"]);
});

test("parseBlueprint: ignora array de EXEMPLO na prosa e pega o array de blueprint (objetos com path)", () => {
  const text = 'considere as extensões ["a","b"] e então:\n[{"path":"x.py","purpose":"p"}]';
  assert.deepEqual(parseBlueprint(text).map((f) => f.path), ["x.py"]);
});

test("parseBlueprint: ] solto DEPOIS do array (prosa) não quebra o parse — extração balanceada", () => {
  // O parser antigo (lastIndexOf ']') pegaria o ] solto e falharia; a extração balanceada resolve.
  const text = '[{"path":"x.py","purpose":"p"}] e mais texto com ] solto no fim';
  assert.deepEqual(parseBlueprint(text).map((f) => f.path), ["x.py"]);
});

test("parseBlueprint: marcadores harmony delimitados (analysis/final) removidos antes do parse", () => {
  const text = '<|channel|>analysis<|message|>penso em [1,2]<|channel|>final<|message|>[{"path":"x.py","purpose":"p"}]';
  assert.deepEqual(parseBlueprint(text).map((f) => f.path), ["x.py"]);
});

// REGRESSÃO (revisão do PR 2): escolher o blueprint REAL, não um array de exemplo/schema-echo antes.
test("parseBlueprint: escolhe o blueprint real (mais arquivos), não um array de EXEMPLO antes dele", () => {
  const text = 'Vou seguir o formato [{"path":"exemplo/foo.py","purpose":"x"}].\nPlano:\n[{"path":"src/main.py","purpose":"m"},{"path":"src/util.py","purpose":"u"}]';
  assert.deepEqual(parseBlueprint(text).map((f) => f.path), ["src/main.py", "src/util.py"]);
});

test("parseBlueprint: no empate de tamanho, prefere o array MAIS TARDIO (a resposta final)", () => {
  const text = '[{"path":"exemplo/foo.py","purpose":"x"}] ... depois ... [{"path":"src/main.py","purpose":"m"}]';
  assert.deepEqual(parseBlueprint(text).map((f) => f.path), ["src/main.py"]);
});

test("parseBlueprint: prosa volumosa com colchetes balanceados não atrapalha nem trava (orçamento)", () => {
  const noise = "considere [item] e depois [outro], ".repeat(400); // ~14KB de prosa com [] balanceados
  const text = noise + '\n[{"path":"src/main.py","purpose":"m"},{"path":"a.py","purpose":"a"}]';
  assert.deepEqual(parseBlueprint(text).map((f) => f.path), ["src/main.py", "a.py"]);
});

// REGRESSÃO (modal "resposta sem blueprint válido" no HubGPU): com esforço alto, o raciocínio do
// gpt-oss consumia o max_tokens e a resposta parava NO MEIO do array (finish_reason=length). O reparo
// de truncamento recupera os objetos completos em vez de devolver [] — mas SÓ com o truncamento
// confirmado pelo chamador (salvageTruncated: true, derivado do finish_reason do stream).
const TRUNC = { salvageTruncated: true };

test("parseBlueprint: array TRUNCADO no meio de um objeto → recupera os arquivos completos", () => {
  const text =
    '[{"path":"src/a.py","purpose":"porta","deps":[]},{"path":"src/b.py","purpose":"impl","deps":["src/a.py"]},{"path":"src/c.py","purp';
  assert.deepEqual(parseBlueprint(text, TRUNC).map((f) => f.path), ["src/a.py", "src/b.py"]);
});

test("parseBlueprint: array TRUNCADO no meio de uma STRING (com escape) → recupera os completos", () => {
  const text = 'Plano:\n[{"path":"x.py","purpose":"p","deps":[]},{"path":"y.py","purpose":"diz \\"algo';
  assert.deepEqual(parseBlueprint(text, TRUNC).map((f) => f.path), ["x.py"]);
});

test("parseBlueprint: TRUNCADO dentro do deps (array aninhado aberto) → recupera os anteriores", () => {
  const text = '[{"path":"a.py","purpose":"a","deps":[]},{"path":"b.py","purpose":"b","deps":["a.py",';
  assert.deepEqual(parseBlueprint(text, TRUNC).map((f) => f.path), ["a.py"]);
});

test("parseBlueprint: reparo é ÚLTIMO recurso — não compete com um array completo válido", () => {
  const text = '[{"path":"real.py","purpose":"ok"}] e raciocínio vazado com [ aberto e {"path":"fake.py"';
  assert.deepEqual(parseBlueprint(text, TRUNC).map((f) => f.path), ["real.py"]);
});

test("parseBlueprint: preâmbulo harmony vazado + array truncado → strip e reparo combinados", () => {
  const text =
    'Now final output is markdown string.\nProceed.\n[{"path":"src/main.py","purpose":"entry","deps":[]},{"path":"src/util.py","pur';
  assert.deepEqual(parseBlueprint(text, TRUNC).map((f) => f.path), ["src/main.py"]);
});

test("parseBlueprint: truncado sem NENHUM objeto completo → [] (sem plano falso)", () => {
  assert.deepEqual(parseBlueprint('[{"path":"src/a.py","purpose":"corta', TRUNC), []);
});

// REGRESSÃO (revisão adversarial): SEM truncamento confirmado o reparo NÃO roda — um eco do schema do
// system prompt no raciocínio vazado ('[' nunca fechado) numa resposta NORMAL (prosa, sem array) tem
// de continuar dando [] → erro claro, não um plano falso de 1 arquivo placeholder.
test("parseBlueprint: eco de schema não fechado SEM truncamento → [] (reparo desabilitado)", () => {
  const text =
    'We need JSON like [{"path": "caminho/relativo/arquivo.ext", "purpose": "uma frase"} etc.\nDesculpe, preciso de mais detalhes sobre o projeto para planejar.';
  assert.deepEqual(parseBlueprint(text), []);
  assert.deepEqual(parseBlueprint(text, { salvageTruncated: false }), []);
});

// REGRESSÃO (revisão adversarial): o truncamento por limite de tokens corta sempre o FIM do texto,
// logo o array da resposta final é o ÚLTIMO '[' não fechado. Um rascunho vazado ANTERIOR do canal
// analysis (mais objetos completos) não pode vencer o array final real por "score".
test("parseBlueprint: rascunho vazado ANTES não vence o array final truncado (mais tardio vence)", () => {
  const text =
    'I think the files could be [{"path":"draft/a.py","purpose":"x"},{"path":"draft/b.py","purpose":"y"},{"path":"draft/c.py","purpose":"z"}, maybe more...\n' +
    'Final answer:\n[{"path":"src/real.py","purpose":"real entry","deps":[]},{"path":"src/real2.py","purp';
  assert.deepEqual(parseBlueprint(text, TRUNC).map((f) => f.path), ["src/real.py"]);
});

test("topoSort põe dependências antes dos dependentes e tolera ciclos", () => {
  const files = [
    { path: "wiring.py", purpose: "", deps: ["domain.py", "adapter.py"] },
    { path: "adapter.py", purpose: "", deps: ["port.py"] },
    { path: "domain.py", purpose: "", deps: ["port.py"] },
    { path: "port.py", purpose: "", deps: [] },
  ];
  const order = topoSort(files).map((f) => f.path);
  assert.ok(order.indexOf("port.py") < order.indexOf("adapter.py"));
  assert.ok(order.indexOf("port.py") < order.indexOf("domain.py"));
  assert.ok(order.indexOf("adapter.py") < order.indexOf("wiring.py"));
  assert.ok(order.indexOf("domain.py") < order.indexOf("wiring.py"));
  // ciclo não trava (a↔b) e todos aparecem uma vez
  const cyc = topoSort([
    { path: "a", purpose: "", deps: ["b"] },
    { path: "b", purpose: "", deps: ["a"] },
  ]);
  assert.equal(cyc.length, 2);
});
