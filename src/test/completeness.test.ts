import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkCompleteness,
  dedupeFileBlocksByPath,
  MAX_CONTINUATIONS,
  missingExpectedFiles,
  partialProposalKeys,
  pickMaxContinuations,
  PROJECT_MAX_CONTINUATIONS,
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

// ---- openFence spin: partialProposalKeys marca o arquivo ABANDONADO como parcial (contrato de integridade) --
// Achado CRÍTICO da revisão: no salvamento o abandonado fica no MEIO do texto, o scanner o lê como "fechado"
// e truncated=false → sem este campo o arquivo cortado seria aplicado como COMPLETO pelo "Aplicar tudo".
test("partialProposalKeys: o ABANDONADO (salvage, truncated=false) é parcial; os fechados NÃO", () => {
  // salvamento: a.py fechado + README ABANDONADO (aberto, com corpo) + b.py fechado + c.py fechado
  const full =
    F + "forge-file path=a.py\nx = 1\n" + F + "\n" +
    F + "forge-file path=README.md\n# Doc parcial cortado\n" +
    F + "forge-file path=b.py\ny = 2\n" + F + "\n" +
    F + "forge-file path=c.py\nz = 3\n" + F + "\n";
  const keys = partialProposalKeys(false, { complete: true }, full, ["README.md"]);
  assert.ok(keys.has("readme.md"), "o abandonado é parcial mesmo com truncated=false (scanner o lê fechado)");
  assert.ok(!keys.has("b.py"), "b.py fechado NÃO é parcial");
  assert.ok(!keys.has("c.py"), "c.py fechado NÃO é parcial");
  // sem abandonedPaths e sem truncamento → nada parcial (compat com o comportamento antigo do partialFilePath)
  assert.equal(partialProposalKeys(false, { complete: true }, full, undefined).size, 0);
  // o último bloco REALMENTE aberto continua parcial (via partialFilePath), unido aos abandonados
  const openTail = F + "forge-file path=a.py\nx = 1\n" + F + "\n" + F + "forge-file path=b.py\ndef f():\n    x = ";
  const keys2 = partialProposalKeys(true, { complete: false, reason: "cerca-aberta", path: "b.py" }, openTail, ["z.py"]);
  assert.ok(keys2.has("b.py") && keys2.has("z.py"), "une o cortado-no-fim (partialFilePath) com o abandonado");
});

// Modo Projeto usa o teto MAIOR de continuação (financia a clean-room de salvamento no openFence spin);
// chat/TDD (sem plano) usam o padrão. Puro/testável — o Task puxa vscode e não é importável em teste.
test("pickMaxContinuations: Modo Projeto (com plano) usa o teto maior; sem plano usa o padrão", () => {
  assert.equal(pickMaxContinuations(undefined), MAX_CONTINUATIONS, "sem expectedPaths → teto padrão");
  assert.equal(pickMaxContinuations([]), MAX_CONTINUATIONS, "plano vazio → teto padrão");
  assert.equal(pickMaxContinuations(["a.py"]), PROJECT_MAX_CONTINUATIONS, "com plano → teto de projeto");
  assert.ok(PROJECT_MAX_CONTINUATIONS > MAX_CONTINUATIONS, "o teto de projeto é MAIOR (financia o salvamento)");
});

// ---- emenda de cercas (F-STITCH: achado ao vivo no rig MDM) -----------------------------------

test("stitchContinuation: parte anterior termina em ```` SEM \n + continuação começando com cerca de abertura → insere \n (não funde as cercas)", async () => {
  const { parseFileBlocks } = await import("../util/fileBlocks");
  const prev = `${F}forge-file path=a.html\n<p>a</p>\n${F}`; // fecha SEM newline final (modelo pode parar aqui)
  const cont = `${F}forge-file path=b.py\nx = 1\n${F}\n`; // clean-room: começa direto com cerca de abertura
  const out = stitchContinuation(prev, cont);
  assert.ok(!out.includes("````````"), "as cercas não podem se fundir numa linha de 8 backticks");
  const blocks = parseFileBlocks(out);
  assert.deepEqual(blocks.map((b) => b.path).sort(), ["a.html", "b.py"], "os DOIS blocos sobrevivem ao parse");
  assert.ok(!blocks.some((b) => b.content.includes("forge-file")), "nenhum bloco engole o outro");
});

test("stitchContinuation: retomada MID-LINE de arquivo cortado segue COLADA (sem \n espúrio)", () => {
  const prev = `${F}forge-file path=a.py\nvalor = calc`; // cortado no meio do identificador
  const cont = "ular_total()\n";
  assert.equal(stitchContinuation(prev, cont), `${F}forge-file path=a.py\nvalor = calcular_total()\n`);
});

test("stitchContinuation: overlap continua vencendo (dedupe intacto com o guard novo)", () => {
  const prev = "abcdefghijklmnopqrstuvwxyz";
  const cont = "nopqrstuvwxyz0123456789";
  assert.equal(stitchContinuation(prev, cont), "abcdefghijklmnopqrstuvwxyz0123456789");
});

test("resilientGenerate: clean-room que emenda em ```` sem \n entrega TODOS os arquivos do plano (regressão do engolimento)", async () => {
  const { resilientGenerate } = await import("../util/completeness");
  const { parseFileBlocks } = await import("../util/fileBlocks");
  const expected = ["a.py", "b.html", "c.py", "d.py"];
  const parts = [
    // parte 1: a.py e b.html completos, mas o texto termina EXATAMENTE no ```` (sem \n) e o
    // provider para LIMPO deixando c.py e d.py faltando → dispara o clean-room.
    { text: `${F}forge-file path=a.py\nx = 1\n${F}\n\n${F}forge-file path=b.html\n<p>b</p>\n${F}`, truncated: false },
    // parte 2 (clean-room): os faltantes, começando DIRETO com a cerca de abertura.
    { text: `${F}forge-file path=c.py\ny = 2\n${F}\n\n${F}forge-file path=d.py\nz = 3\n${F}\n`, truncated: false },
  ];
  let call = 0;
  const gen = await resilientGenerate(
    [{ role: "user", content: "gere o plano" }],
    async () => parts[Math.min(call++, parts.length - 1)],
    {
      maxContinuations: 6,
      anchorChars: 8000,
      buildContinuation: (p) => `continue ${p}`,
      buildTailContinuation: () => "continue a cauda",
      buildMissingFilesContinuation: (missing) => `faltam: ${missing.join(", ")}`,
      expectedPaths: expected,
    }
  );
  assert.equal(gen.truncated, false, "não pode 'desistir' — os faltantes chegaram na 1ª continuação");
  const paths = parseFileBlocks(gen.full).map((b) => b.path).sort();
  assert.deepEqual(paths, ["a.py", "b.html", "c.py", "d.py"], "TODOS os blocos parseiam individualmente");
  const bHtml = parseFileBlocks(gen.full).find((b) => b.path === "b.html");
  assert.ok(bHtml && !bHtml.content.includes("forge-file"), "b.html não engole c.py/d.py dentro do conteúdo");
});
