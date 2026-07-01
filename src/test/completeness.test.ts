import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCompleteness, sanitizeContinuation, stitchContinuation } from "../util/completeness";

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

test("sanitizeContinuation remove prosa conversacional no início (o bug do print)", () => {
  // exatamente os fragmentos do print: "Add newline after fence." e "Will do."
  const cont = "Add newline after fence.\n\nWill do.\n    assert repo.get(...) is None\n";
  const out = sanitizeContinuation(cont);
  assert.ok(!/Will do|Add newline/i.test(out), "prosa deve sair");
  assert.ok(out.startsWith("    assert repo.get"), "o código deve começar a continuação");
});

test("sanitizeContinuation cobre acks pt-BR/EN e para na 1ª linha de código", () => {
  assert.equal(sanitizeContinuation("Claro!\nvou continuar.\nx = 1\n"), "x = 1\n");
  assert.equal(sanitizeContinuation("Sure.\nHere's the rest of the code:\nreturn 42"), "return 42");
  assert.equal(sanitizeContinuation("Continuando…\n    pass\n"), "    pass\n");
});

test("sanitizeContinuation NÃO toca código legítimo (sem preâmbulo)", () => {
  const code = "    return x + 1\n}\n";
  assert.equal(sanitizeContinuation(code), code);
  // 'ok' como parte de código não é ack (linha inteira precisa casar)
  assert.equal(sanitizeContinuation("ok = compute()\n"), "ok = compute()\n");
  // comentário de código com 'continue' não é removido (tem estrutura de código antes)
  assert.equal(sanitizeContinuation("for i in x:\n    continue\n"), "for i in x:\n    continue\n");
});

// ---- regressões da revisão adversarial do PR-A ------------------------------

test("REGRESSÃO: sanitizeContinuation NÃO apaga keyword de controle de fluxo como 1ª linha", () => {
  // O caso que quebrava: continuação retomando dentro de um laço truncado.
  assert.equal(sanitizeContinuation("            continue\n        process(row)\n"), "            continue\n        process(row)\n");
  assert.equal(sanitizeContinuation("continue\n    total += 1\n"), "continue\n    total += 1\n");
  assert.equal(sanitizeContinuation("break\n"), "break\n");
  assert.equal(sanitizeContinuation("proceed()\n    x = 1\n"), "proceed()\n    x = 1\n");
  assert.equal(sanitizeContinuation("proceeding = state\n"), "proceeding = state\n");
  assert.equal(sanitizeContinuation("done\n"), "done\n"); // fim de laço em shell
});

test("REGRESSÃO: sanitizeContinuation NÃO come linhas em branco iniciais sem preâmbulo", () => {
  // sem nenhum preâmbulo, brancos iniciais são preservados (não fundir cercas no multi-arquivo)
  assert.equal(sanitizeContinuation("\n\ndef f():\n    pass\n"), "\n\ndef f():\n    pass\n");
  // com preâmbulo: remove a prosa; o branco que segue o preâmbulo é inofensivo e preservado
  assert.equal(sanitizeContinuation("Will do.\n\nx = 1\n"), "\nx = 1\n");
  // brancos entre DOIS preâmbulos são removidos junto
  assert.equal(sanitizeContinuation("Sure.\n\nWill do.\nx = 1\n"), "x = 1\n");
});
