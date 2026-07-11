import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkCompleteness,
  dedupeFileBlocksByPath,
  missingExpectedFiles,
  sanitizeContinuation,
  stitchContinuation,
} from "../util/completeness";

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

// ---- F-02: dedup de blocos por path (continuação clean-room pode re-emitir um arquivo já feito) --------

test("dedupeFileBlocksByPath: cópia truncada perde para a completa (ORDEM-INDEPENDENTE)", () => {
  const completa = { path: "a.py", content: "def f():\n    return 1\n" };
  const truncada = { path: "a.py", content: "def f():\n    ret" }; // mais curta
  const r1 = dedupeFileBlocksByPath([completa, truncada]);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].content, completa.content, "completa-primeiro: mantém a completa");
  const r2 = dedupeFileBlocksByPath([truncada, completa]);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].content, completa.content, "truncada-primeiro: mesmo resultado (maior-vence)");
});

test("dedupeFileBlocksByPath: paths distintos preservam a ordem da 1ª ocorrência", () => {
  const r = dedupeFileBlocksByPath([
    { path: "a.py", content: "1" },
    { path: "README.md", content: "doc" },
    { path: "b.py", content: "2" },
  ]);
  assert.deepEqual(r.map((b) => b.path), ["a.py", "README.md", "b.py"]);
});

test("dedupeFileBlocksByPath: ./ e caixa colapsam via normResilientPath (maior-conteúdo-vence)", () => {
  const r = dedupeFileBlocksByPath([
    { path: "./src/a.py", content: "curto" },
    { path: "src/a.py", content: "conteudo maior vence" },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].content, "conteudo maior vence");
});

// Regressão da revisão adversarial: uma re-emissão TRUNCADA porém MAIOR não pode expulsar a cópia COMPLETA
// mais curta. O bloco aberto é sempre o ÚLTIMO do texto e `openPath` (= completeness.path) o identifica →
// preferir FECHADO ao ABERTO, independentemente do tamanho.
test("dedupeFileBlocksByPath: cópia FECHADA vence a re-emissão ABERTA (truncada) mesmo sendo MENOR", () => {
  const completaCurta = { path: "a.py", content: "x=1\n" }; // completa (fechada), curta
  const truncadaLonga = { path: "a.py", content: "def verbose():\n    # muito mais longo porém cortado no fim\n    y = " }; // aberta, maior
  // a ABERTA é o último bloco → openPath='a.py' a marca; a fechada (1ª) deve vencer
  const r = dedupeFileBlocksByPath([completaCurta, truncadaLonga], "a.py");
  assert.equal(r.length, 1);
  assert.equal(r[0].content, completaCurta.content, "fechada vence mesmo sendo menor");
  // sem openPath (compat): cai no maior-conteúdo-vence puro (a longa vence)
  const r2 = dedupeFileBlocksByPath([completaCurta, truncadaLonga]);
  assert.equal(r2[0].content, truncadaLonga.content);
});

// ---- F-02: missingExpectedFiles usa o parser AUTORITATIVO (recupera cerca mal-contada — armadilha #158) --

test("missingExpectedFiles: cerca mal-contada é RECUPERADA (não vira falso-faltante #158)", () => {
  const F3 = "```"; // abriu com 4, fechou com 3 — recoverOpen recupera
  const a = F + "forge-file path=a.py\nx = 1\n" + F3 + "\n";
  assert.deepEqual(missingExpectedFiles(a, ["a.py"]), []);
});

test("missingExpectedFiles: normaliza caixa / ./ / barra; faltante real; expected vazio → []", () => {
  const doc =
    F + "forge-file path=readme.md\n# Doc\n" + F + "\n" + F + "forge-file path=src/x.py\ny = 1\n" + F + "\n";
  assert.deepEqual(missingExpectedFiles(doc, ["README.md", "./src/x.py"]), [], "caixa e ./ normalizados");
  assert.deepEqual(missingExpectedFiles(doc, ["README.md", "src/y.py"]), ["src/y.py"], "faltante real preservado");
  const a = F + "forge-file path=a.py\nx = 1\n" + F + "\n";
  assert.deepEqual(missingExpectedFiles(a, []), []);
  assert.deepEqual(missingExpectedFiles(a, undefined), []);
});
