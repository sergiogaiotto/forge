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
