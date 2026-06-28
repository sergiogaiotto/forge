import assert from "node:assert/strict";
import { test } from "node:test";
import { validatorsFromStack } from "../skills/stackValidators";

test("deriva validadores advisory (gate:false) das ferramentas de lint/tipos Python", () => {
  const v = validatorsFromStack({ lintFormat: ["ruff", "black"], types: ["mypy"], libs: [] });
  assert.deepEqual(
    v.map((x) => x.id).sort(),
    ["stack:black", "stack:mypy", "stack:ruff"]
  );
  for (const x of v) {
    assert.equal(x.gate, false);
    assert.deepEqual(x.appliesTo, [".py"]);
  }
  assert.match(v.find((x) => x.id === "stack:ruff")!.command, /ruff check \{file\}/);
  assert.match(v.find((x) => x.id === "stack:black")!.command, /black --check \{file\}/);
});

test("eslint aplica a arquivos JS/TS", () => {
  const v = validatorsFromStack({ lintFormat: ["eslint"], types: [], libs: [] });
  assert.equal(v.length, 1);
  assert.equal(v[0].id, "stack:eslint");
  assert.ok(v[0].appliesTo!.includes(".ts") && v[0].appliesTo!.includes(".tsx"));
});

test("typescript (tsc) não vira validador arquivo-a-arquivo", () => {
  assert.deepEqual(validatorsFromStack({ lintFormat: [], types: ["typescript"], libs: [] }), []);
});

test("stack vazia => nenhum validador", () => {
  assert.deepEqual(validatorsFromStack({ lintFormat: [], types: [], libs: [] }), []);
});
