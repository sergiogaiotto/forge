import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlueprint, topoSort } from "../util/blueprint";

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
