import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCompleteness, stitchContinuation } from "../util/completeness";

const F = "````"; // FORGE_FENCE (4 crases)

test("bloco fechado sem elipse = completo", () => {
  const t = `Explicação.\n${F}forge-file path=a.py\nx = 1\nprint(x)\n${F}\n`;
  assert.equal(checkCompleteness(t).complete, true);
});

test("cerca de fechamento ausente = incompleto (cerca-aberta), com o path", () => {
  const t = `${F}forge-file path=src/a.py\nx = 1\nprint(x`; // sem fechamento
  const r = checkCompleteness(t);
  assert.equal(r.complete, false);
  assert.equal(r.reason, "cerca-aberta");
  assert.equal(r.path, "src/a.py");
});

test("elipse dentro do bloco = incompleto (elipse)", () => {
  const t = `${F}forge-file path=a.py\ndef f():\n    # ... (restante do código)\n    pass\n${F}\n`;
  const r = checkCompleteness(t);
  assert.equal(r.complete, false);
  assert.equal(r.reason, "elipse");
});

test("prosa sem bloco = completo (não dispara continuação à toa)", () => {
  assert.equal(checkCompleteness("Só uma explicação, sem código.").complete, true);
});

test("cerca de fechamento com contagem errada (cerca solta no fim) = completo, não trunca", () => {
  // abriu com 4 crases, fechou com 3 — recoverOpen recupera; não vale re-pedir continuação
  const t = `${F}forge-file path=a.py\nx = 1\n\`\`\`\n`;
  assert.equal(checkCompleteness(t).complete, true);
});

test("NÃO marca elipse por falso-positivo (reticências/`resto` legítimos sem 'código')", () => {
  const t1 = `${F}forge-file path=a.py\nprint("carregando...")\nresto = fila[1:]  # o resto da fila\n${F}\n`;
  assert.equal(checkCompleteness(t1).complete, true);
  const t2 = `${F}forge-file path=a.py\n# rest of the arguments are optional\nx = 1\n${F}\n`;
  assert.equal(checkCompleteness(t2).complete, true);
});

test("stitchContinuation remove a sobreposição (continuação repete o fim)", () => {
  const prev = "linha1\nlinha2\ndef foo():\n    return";
  const cont = "def foo():\n    return 42\n";
  const out = stitchContinuation(prev, cont);
  assert.equal(out.split("def foo():").length - 1, 1, "não deve duplicar 'def foo():'");
  assert.ok(out.endsWith("return 42\n"));
});

test("stitchContinuation sem overlap concatena direto; trata vazios", () => {
  assert.equal(stitchContinuation("abc", "def"), "abcdef");
  assert.equal(stitchContinuation("", "x"), "x");
  assert.equal(stitchContinuation("x", ""), "x");
});
