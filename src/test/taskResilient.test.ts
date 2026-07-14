import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatMessage } from "../api/types";
import { checkCompleteness, dedupeFileBlocksByPath, emittedContracts, partialFilePath, partialProposalKeys, resilientGenerate } from "../util/completeness";
import { parseFileBlocks } from "../util/fileBlocks";

const FENCE = "````"; // 4 crases (FORGE_FENCE)
const base: ChatMessage[] = [{ role: "user", content: "gere o arquivo" }];
const opts = {
  maxContinuations: 6,
  anchorChars: 8000,
  buildContinuation: (p?: string) => `continue ${p ?? ""}`,
  buildTailContinuation: () => "emita o restante dos arquivos",
};

// streamFn roteirizada por passagem (repete o último), captura as mensagens e devolve o flag truncated.
function scripted(scripts: { text: string; truncated?: boolean }[]) {
  let i = 0;
  const captured: ChatMessage[][] = [];
  const fn = async (messages: ChatMessage[]) => {
    captured.push(messages);
    const s = scripts[Math.min(i++, scripts.length - 1)];
    return { text: s.text, truncated: s.truncated };
  };
  return { fn, captured, calls: () => i };
}

// streamFn CIENTE DAS MENSAGENS: decide a resposta pela conversa recebida (não por índice). O mock por
// índice IGNORA as mensagens, então NÃO consegue distinguir uma continuação clean-room (que muda a
// conversa) de um no-op — é o único jeito de PROVAR que a continuação F-02 realmente destrava a cauda.
function messageAware(handler: (msgs: ChatMessage[]) => { text: string; truncated?: boolean }) {
  const captured: ChatMessage[][] = [];
  const fn = async (messages: ChatMessage[]) => {
    captured.push(messages);
    return handler(messages);
  };
  return { fn, captured };
}

test("resilientGenerate: cerca aberta na 1ª, fecha na 2ª → 1 continuação, completo", async () => {
  const s = scripted([
    { text: "Aqui vai:\n" + FENCE + "forge-file path=a.py\ndef f():\n    x = 1" },
    { text: "\n    return x\n" + FENCE + "\n" },
  ]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.attempts, 1);
  assert.equal(r.completeness.complete, true);
  assert.equal(r.truncated, false);
  assert.match(r.full, /return x/);
});

test("resilientGenerate: corte ENTRE arquivos (provider truncou, blocos fechados) CONTINUA e completa", async () => {
  const s = scripted([
    { text: FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n", truncated: true }, // fechado, mas cortado
    { text: FENCE + "forge-file path=b.py\ny = 2\n" + FENCE + "\n" }, // o resto
  ]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.attempts, 1, "continua mesmo sem cerca aberta, pelo sinal do provider");
  assert.equal(r.truncated, false);
  assert.match(r.full, /path=a\.py/);
  assert.match(r.full, /path=b\.py/); // o 2º arquivo entrou
});

test("resilientGenerate: corte persistente marca truncated=true (não entrega projeto incompleto como sucesso)", async () => {
  const s = scripted([{ text: FENCE + "forge-file path=a.py\n" + "z".repeat(40) + "\n" + FENCE + "\n", truncated: true }]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.truncated, true, "corte por limite sinalizado pelo provider → aviso honesto");
});

// F-02: no Modo Projeto a completude é medida pelos ARQUIVOS DO PLANO, não só pela cauda "parecer" fechada.
// O gpt-oss às vezes auto-encerra (finish_reason=stop, blocos fechados, sem sinal de corte) com arquivos
// faltando — o laço tem que continuar, NOMEANDO os que faltam.
test("resilientGenerate: expectedPaths — continua até TODOS os arquivos do plano saírem, sem sinal de corte (F-02)", async () => {
  const s = scripted([
    // 1ª: emite a.py e b.py FECHADOS e SEM truncated (auto-encerrou faltando c.py)
    { text: FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n" + FENCE + "forge-file path=b.py\ny = 2\n" + FENCE + "\n" },
    { text: FENCE + "forge-file path=c.py\nz = 3\n" + FENCE + "\n" }, // o arquivo que faltava
  ]);
  const r = await resilientGenerate(base, s.fn, {
    ...opts,
    expectedPaths: ["a.py", "b.py", "c.py"],
    buildTailContinuation: (missing?: string[]) => `faltam: ${(missing ?? []).join(", ")}`,
  });
  assert.equal(r.attempts, 1, "continua mesmo sem cerca aberta e sem truncated, pois falta arquivo do plano");
  assert.equal(r.truncated, false);
  assert.match(r.full, /path=c\.py/, "o arquivo faltante entrou na continuação");
  const contMsg = s.captured[1]?.at(-1)?.content ?? ""; // a instrução de continuação é a ÚLTIMA mensagem
  assert.match(contMsg, /c\.py/, "a continuação NOMEIA o arquivo faltante do plano");
  assert.ok(!/a\.py|b\.py/.test(contMsg), "não re-pede os que já saíram");
});

test("resilientGenerate: expectedPaths — arquivo do plano que nunca sai marca truncated=true (F-02)", async () => {
  const s = scripted([{ text: FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n" }]); // b.py nunca vem
  const r = await resilientGenerate(base, s.fn, { ...opts, expectedPaths: ["a.py", "b.py"] });
  assert.equal(r.truncated, true, "arquivo do plano ausente após stall/esgotar continuações → aviso honesto");
});

// Achado da revisão adversarial do F-02: a completude por-arquivo tem que usar o parser AUTORITATIVO
// (parseFileBlocks, que RECUPERA um bloco com cerca mal-contada), não closedBlockPaths (fechamento exato).
test("resilientGenerate: expectedPaths — arquivo FECHADO com nº de crases errado NÃO vira falso-faltante", async () => {
  const FENCE3 = "```"; // 3 crases: slip comum (abriu com 4, fecha com 3) — recoverOpen ainda o recupera
  const s = scripted([{ text: FENCE + "forge-file path=a.py\nx = 1\n" + FENCE3 + "\n" }]);
  const r = await resilientGenerate(base, s.fn, { ...opts, expectedPaths: ["a.py"] });
  assert.equal(r.attempts, 0, "o arquivo foi recuperado pelo parser → não dispara continuação espúria");
  assert.equal(r.truncated, false);
});

test("resilientGenerate: expectedPaths — casa o path do plano case-insensitively (README.md vs readme.md)", async () => {
  const s = scripted([{ text: FENCE + "forge-file path=readme.md\n# Doc\n" + FENCE + "\n" }]);
  const r = await resilientGenerate(base, s.fn, { ...opts, expectedPaths: ["README.md"] });
  assert.equal(r.attempts, 0, "caixa diferente não vira falso-faltante (não queima continuações)");
  assert.equal(r.truncated, false);
});

// ---- F-02 (resíduo): continuação CLEAN-ROOM + guarda de stall por PROGRESSO (não por crescimento) --------

const AB_CLOSED =
  FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n" + FENCE + "forge-file path=b.py\ny = 2\n" + FENCE + "\n";

test("resilientGenerate: clean-room — continuação dos faltantes SEM âncora, nomeia só o que falta e AVANÇA (F-02)", async () => {
  const tail =
    FENCE + "forge-file path=README.md\n# Doc\n" + FENCE + "\n" + FENCE + "forge-file path=tests/test_x.py\nassert True\n" + FENCE + "\n";
  // só emite a cauda quando a instrução NOMEIA os faltantes → prova que a continuação clean-room a destravou
  const m = messageAware((msgs) => (/README\.md/.test(msgs.at(-1)?.content ?? "") ? { text: tail } : { text: AB_CLOSED }));
  const r = await resilientGenerate(base, m.fn, {
    ...opts,
    expectedPaths: ["a.py", "b.py", "README.md", "tests/test_x.py"],
    buildMissingFilesContinuation: (missing) => `emita EXATAMENTE: ${missing.join(", ")}`,
  });
  assert.equal(r.truncated, false);
  assert.ok(r.attempts >= 1);
  assert.match(r.full, /path=README\.md/);
  assert.match(r.full, /path=tests\/test_x\.py/);
  const cont = m.captured[1];
  assert.ok(!cont.some((msg) => msg.role === "assistant"), "clean-room: NÃO reenvia âncora de assistant");
  const instr = cont.at(-1)?.content ?? "";
  assert.match(instr, /README\.md/);
  assert.match(instr, /tests\/test_x\.py/);
  assert.ok(!/\ba\.py\b|\bb\.py\b/.test(instr), "não re-pede os que já saíram");
});

test("resilientGenerate: clean-room emite arquivo que TRUNCA → próxima rodada REANCORA e fecha (F-02 handoff)", async () => {
  const readmeOpen = FENCE + "forge-file path=README.md\n# Projeto\nlinha cortada no me"; // cerca aberta
  const readmeClose = "io\nfim.\n" + FENCE + "\n";
  const m = messageAware((msgs) => {
    const last = msgs.at(-1)?.content ?? "";
    const hasAnchor = msgs.some((x) => x.role === "assistant");
    if (/README\.md/.test(last) && !hasAnchor) return { text: readmeOpen }; // rodada clean-room
    if (hasAnchor) return { text: readmeClose }; // rodada ancorada fecha o README
    return { text: AB_CLOSED };
  });
  const r = await resilientGenerate(base, m.fn, {
    ...opts,
    expectedPaths: ["a.py", "b.py", "README.md"],
    buildContinuation: (p?: string) => `continue ${p ?? ""}`,
    buildMissingFilesContinuation: (missing) => `emita: ${missing.join(", ")}`,
  });
  assert.equal(r.truncated, false);
  assert.equal(r.completeness.complete, true);
  assert.match(r.full, /# Projeto/);
  assert.match(r.full, /fim\./);
  assert.ok(!m.captured[1].some((x) => x.role === "assistant"), "rodada clean-room: sem âncora");
  assert.ok(m.captured[2].some((x) => x.role === "assistant"), "rodada de fechamento: reancorada");
  assert.match(m.captured[2].at(-1)?.content ?? "", /continue README\.md/);
});

test("resilientGenerate: cerca aberta + faltam arquivos MANTÉM a âncora e usa buildContinuation (gating clean-room)", async () => {
  const s = scripted([
    { text: FENCE + "forge-file path=a.py\ndef f():\n    x = 1" }, // cortado no meio de a.py (cerca aberta)
    { text: "\n    return x\n" + FENCE + "\n" + FENCE + "forge-file path=b.py\ny = 2\n" + FENCE + "\n" },
  ]);
  const r = await resilientGenerate(base, s.fn, {
    ...opts,
    expectedPaths: ["a.py", "b.py"],
    buildContinuation: (p?: string) => `continue ${p ?? ""}`,
    buildMissingFilesContinuation: (missing) => `NAO_USAR: ${missing.join(", ")}`,
  });
  const cont = s.captured[1];
  assert.ok(cont.some((msg) => msg.role === "assistant"), "cerca aberta preserva a âncora");
  const instr = cont.at(-1)?.content ?? "";
  assert.match(instr, /continue a\.py/, "usa buildContinuation, não a clean-room");
  assert.ok(!/NAO_USAR/.test(instr), "clean-room NÃO dispara com cerca aberta (mesmo faltando arquivo)");
});

test("resilientGenerate: chat (sem expectedPaths) truncado MANTÉM a âncora e NÃO entra em clean-room (F-02)", async () => {
  const s = scripted([
    { text: FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n", truncated: true },
    { text: FENCE + "forge-file path=b.py\ny = 2\n" + FENCE + "\n" },
  ]);
  const r = await resilientGenerate(base, s.fn, {
    ...opts,
    buildMissingFilesContinuation: (missing) => `NAO_USAR: ${missing.join(", ")}`, // presente, mas sem plano não dispara
  });
  const cont = s.captured[1];
  assert.ok(cont.some((msg) => msg.role === "assistant"), "chat: âncora preservada");
  assert.ok(!/NAO_USAR/.test(cont.at(-1)?.content ?? ""), "clean-room não dispara sem expectedPaths");
  assert.match(r.full, /path=b\.py/);
});

test("resilientGenerate: tolera UMA rodada morta e depois avança (F-02 stall tolerante)", async () => {
  const s = scripted([
    { text: AB_CLOSED },
    { text: "" }, // rodada morta (modelo não emitiu nada)
    { text: FENCE + "forge-file path=c.py\nz = 3\n" + FENCE + "\n" },
  ]);
  const r = await resilientGenerate(base, s.fn, {
    ...opts,
    expectedPaths: ["a.py", "b.py", "c.py"],
    buildMissingFilesContinuation: (missing) => `faltam: ${missing.join(", ")}`,
  });
  assert.equal(r.truncated, false);
  assert.equal(r.attempts, 2, "1 rodada morta tolerada; avança na seguinte (antes desistia no 1º stall)");
  assert.match(r.full, /path=c\.py/);
});

test("resilientGenerate: DUAS rodadas mortas seguidas → desiste, truncated e attempts limitado (F-02)", async () => {
  const s = scripted([{ text: AB_CLOSED }, { text: "" }, { text: "" }]);
  const r = await resilientGenerate(base, s.fn, {
    ...opts,
    expectedPaths: ["a.py", "b.py", "c.py"],
    buildMissingFilesContinuation: (missing) => `faltam: ${missing.join(", ")}`,
  });
  assert.equal(r.truncated, true);
  assert.equal(r.attempts, 2, "desiste em noProgress>=2 — bem abaixo de maxContinuations=6");
  assert.ok(!/path=c\.py/.test(r.full));
});

// A prova de que a guarda é por PROGRESSO (plano encolher) e não por CRESCIMENTO: o modelo re-emite um
// arquivo JÁ feito em vez do faltante. O texto CRESCE (sem overlap p/ deduplicar), mas o plano não encolhe —
// uma guarda por crescimento seria enganada e queimaria as 6 continuações; a guarda por progresso desiste cedo.
test("resilientGenerate: re-emitir arquivo já feito (cresce sem encolher o plano) é tratado como stall (F-02)", async () => {
  const reemitA = FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n"; // re-emissão do que já saiu
  const s = scripted([{ text: AB_CLOSED }, { text: reemitA }, { text: reemitA }]);
  const r = await resilientGenerate(base, s.fn, {
    ...opts,
    expectedPaths: ["a.py", "b.py", "c.py"],
    buildMissingFilesContinuation: (missing) => `faltam: ${missing.join(", ")}`,
  });
  assert.equal(r.truncated, true, "c.py nunca saiu → aviso honesto");
  assert.equal(r.attempts, 2, "progresso FALSO detectado (plano não encolheu); não queima as 6 continuações");
  // contrato do dedup que o Task.run aplica sobre r.full: o a.py re-emitido colapsa (2 paths, não 4 blocos)
  assert.equal(dedupeFileBlocksByPath(parseFileBlocks(r.full)).length, 2, "dedup colapsa o a.py duplicado");
});

// Regressão da revisão adversarial (off-by-one): FECHAR um arquivo do plano que estava cortado (aberto→
// fechado) não muda `missing` (recoverOpen já contava o aberto como emitido) — se essa rodada fosse lida
// como MORTA, queimaria uma folga do stall no exato regime do F-02, e a cauda ainda faltante perderia uma
// das duas tentativas clean-room. O crédito da transição aberto→fechado preserva a folga.
test("resilientGenerate: fechar arquivo cortado (aberto→fechado) conta como progresso — preserva a folga do stall (F-02)", async () => {
  const aClosed = FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n";
  const bOpen = FENCE + "forge-file path=b.py\ndef g():\n    y = "; // cerca aberta (cortado no meio)
  const bClose = "2\n    return y\n" + FENCE + "\n";
  const readme = FENCE + "forge-file path=README.md\n# Doc\n" + FENCE + "\n";
  let cleanRoom = 0;
  const m = messageAware((msgs) => {
    const hasAnchor = msgs.some((x) => x.role === "assistant");
    if (msgs.length === 1) return { text: aClosed + bOpen }; // round0: a.py fechado + b.py ABERTO
    if (hasAnchor) return { text: bClose }; // rodada ancorada: fecha b.py (missing NÃO muda — b já contava)
    return ++cleanRoom >= 2 ? { text: readme } : { text: "" }; // clean-room README: 1ª morta, 2ª emite
  });
  const r = await resilientGenerate(base, m.fn, {
    ...opts,
    expectedPaths: ["a.py", "b.py", "README.md"],
    buildContinuation: (p?: string) => `continue ${p ?? ""}`,
    buildMissingFilesContinuation: (missing) => `emita: ${missing.join(", ")}`,
  });
  assert.equal(r.truncated, false, "fechar b.py não é rodada morta → README ainda ganha 2 tentativas clean-room");
  assert.match(r.full, /path=README\.md/);
});

// Regressão da revisão adversarial (test-adequacy): projeto que precisa de VÁRIAS continuações, cada uma com
// progresso (o plano encolhe 1 arquivo por vez). Prova que noProgress RESETA a cada progresso — sem o reset,
// uma "simplificação" que só zera na rodada 0 estagnaria em 2 tentativas e dropar a cauda (o resíduo F-02).
test("resilientGenerate: projeto grande — 3+ continuações, cada uma emite 1 arquivo do plano (F-02 reset de progresso)", async () => {
  const plan = ["a.py", "b.py", "c.py", "d.py"];
  const block = (p: string) => FENCE + `forge-file path=${p}\nx = 1\n` + FENCE + "\n";
  const m = messageAware((msgs) => {
    if (msgs.length === 1) return { text: block("a.py") }; // round0: só a.py
    const last = msgs.at(-1)?.content ?? ""; // clean-room nomeia os faltantes — emite o 1º ainda não presente
    const next = plan.find((p) => last.includes(p));
    return { text: next ? block(next) : "" };
  });
  const r = await resilientGenerate(base, m.fn, {
    ...opts,
    expectedPaths: plan,
    buildMissingFilesContinuation: (missing) => `emita: ${missing.join(", ")}`,
  });
  assert.equal(r.truncated, false);
  assert.equal(r.attempts, 3, "3 continuações, todas com progresso → nunca estagna");
  for (const p of plan) assert.match(r.full, new RegExp(`path=${p.replace(".", "\\.")}`), `${p} presente`);
});

// ---- openFence "spin": o modelo trava fechando UM arquivo; abandona-o e salva o resto do plano ----------

const spinOpts = (extra: object) => ({
  ...opts,
  maxContinuations: 12,
  buildContinuation: (p?: string) => `continue ${p ?? ""}`,
  buildMissingFilesContinuation: (missing: string[]) => `emita: ${missing.join(", ")}`,
  ...extra,
});

test("resilientGenerate: openFence spin — abandona o travado após K, salva o resto e reporta abandonedPaths", async () => {
  const aClosed = FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n";
  const readmeOpen = FENCE + "forge-file path=README.md\n# Projeto\n" + "linha ".repeat(60); // corpo real, ABERTO
  const bc = FENCE + "forge-file path=b.py\ny = 2\n" + FENCE + "\n" + FENCE + "forge-file path=c.py\nz = 3\n" + FENCE + "\n";
  const m = messageAware((msgs) => {
    const hasAnchor = msgs.some((x) => x.role === "assistant");
    if (msgs.length === 1) return { text: aClosed + readmeOpen }; // round0: a.py fechado + README ABERTO
    if (hasAnchor) return { text: "Proceed.\n" }; // spin: fragmento minúsculo, nunca fecha o README
    return { text: bc }; // clean-room (sem âncora): emite os outros faltantes
  });
  const r = await resilientGenerate(base, m.fn, spinOpts({ expectedPaths: ["a.py", "README.md", "b.py", "c.py"] }));
  assert.equal(r.truncated, false);
  assert.deepEqual(r.abandonedPaths, ["README.md"]);
  assert.match(r.full, /path=b\.py/);
  assert.match(r.full, /path=c\.py/);
  const cleanRoom = m.captured.find((c) => c.length > 1 && !c.some((x) => x.role === "assistant"));
  assert.ok(cleanRoom, "houve uma continuação clean-room (sem âncora)");
  assert.ok(!/README/.test(cleanRoom!.at(-1)?.content ?? ""), "clean-room não re-pede o README abandonado (tem corpo)");
});

test("resilientGenerate: arquivo grande legítimo que FECHA antes de K NÃO é abandonado (o legítimo fecha; o spin não)", async () => {
  const aClosed = FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n";
  const bigOpen = FENCE + "forge-file path=big.py\nparte0 = 0\n"; // ABERTO
  let anchored = 0;
  const m = messageAware((msgs) => {
    const hasAnchor = msgs.some((x) => x.role === "assistant");
    if (msgs.length === 1) return { text: aClosed + bigOpen };
    if (hasAnchor) {
      anchored++; // cresce de verdade por rodada e FECHA na 4ª continuação (< STUCK_FILE_TOLERANCE=5)
      const chunk = `parte${anchored} = ${anchored}\n`.repeat(40);
      return anchored < 4 ? { text: chunk } : { text: chunk + FENCE + "\n" };
    }
    return { text: FENCE + "forge-file path=c.py\nz = 3\n" + FENCE + "\n" };
  });
  const r = await resilientGenerate(base, m.fn, spinOpts({ expectedPaths: ["a.py", "big.py", "c.py"] }));
  assert.equal(r.truncated, false);
  assert.ok(!r.abandonedPaths || r.abandonedPaths.length === 0, "fecha antes de K rodadas → streak reseta, não abandona");
  assert.match(r.full, /path=big\.py/);
});

test("resilientGenerate: spin que ESTAGNA (não cresce) antes de K abandona e salva — não desiste no stall", async () => {
  const aClosed = FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n";
  const readmeOpen = FENCE + "forge-file path=README.md\n# Projeto\n" + "linha ".repeat(60); // ABERTO, com corpo
  const m = messageAware((msgs) => {
    const hasAnchor = msgs.some((x) => x.role === "assistant");
    if (msgs.length === 1) return { text: aClosed + readmeOpen };
    if (hasAnchor) return { text: "" }; // spin VAZIO: 2 rodadas sem crescer → stall ANTES de K
    return { text: FENCE + "forge-file path=b.py\ny = 2\n" + FENCE + "\n" };
  });
  const r = await resilientGenerate(base, m.fn, spinOpts({ expectedPaths: ["a.py", "README.md", "b.py"] }));
  assert.equal(r.truncated, false, "o stall com arquivo travado + outros faltantes SALVA em vez de desistir");
  assert.deepEqual(r.abandonedPaths, ["README.md"]);
  assert.match(r.full, /path=b\.py/);
});

// Integridade (achado da revisão): um arquivo travado SEM corpo recuperável (só cabeçalho) NÃO é abandonado —
// continua em `missing` e é re-emitido do ZERO pela clean-room (completo). Marcá-lo parcial gravaria um
// arquivo completo como parcial. Sem este teste, um mutante "sempre abandona" (dropar o `bodied &&`) passaria.
test("resilientGenerate: arquivo travado SEM corpo (só cabeçalho) NÃO é abandonado — clean-room o re-emite completo", async () => {
  const aClosed = FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n";
  const readmeHeaderOnly = FENCE + "forge-file path=README.md\n"; // ABERTO, cabeçalho SEM corpo (recoverOpen → null)
  const readmeFull = FENCE + "forge-file path=README.md\n# Doc completo\nconteudo\n" + FENCE + "\n";
  const bClosed = FENCE + "forge-file path=b.py\ny = 2\n" + FENCE + "\n";
  const m = messageAware((msgs) => {
    const hasAnchor = msgs.some((x) => x.role === "assistant");
    if (msgs.length === 1) return { text: aClosed + readmeHeaderOnly };
    if (hasAnchor) return { text: "" }; // spin vazio → stall (o cabeçalho nunca ganha corpo)
    return { text: readmeFull + bClosed }; // clean-room re-emite o README COMPLETO + b.py
  });
  const r = await resilientGenerate(base, m.fn, spinOpts({ expectedPaths: ["a.py", "README.md", "b.py"] }));
  assert.ok(!r.abandonedPaths || r.abandonedPaths.length === 0, "sem corpo → fica em missing → re-emitido do zero, NÃO abandonado");
  assert.match(r.full, /# Doc completo/, "clean-room re-emitiu o README COMPLETO");
  assert.ok(!partialProposalKeys(r.truncated, r.completeness, r.full, r.abandonedPaths).has("readme.md"), "README completo NÃO é marcado parcial");
});

test("resilientGenerate: arquivo travado SEM \\n final — a injeção faz o próximo arquivo parsear após o salvamento", async () => {
  const aClosed = FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n";
  const readmeNoNL = FENCE + "forge-file path=README.md\n# Doc\nlinha sem quebra final"; // ABERTO, sem \n no fim
  const m = messageAware((msgs) => {
    const hasAnchor = msgs.some((x) => x.role === "assistant");
    if (msgs.length === 1) return { text: aClosed + readmeNoNL };
    if (hasAnchor) return { text: "Thus final." }; // spin SEM quebra de linha
    return { text: FENCE + "forge-file path=b.py\ny = 2\n" + FENCE + "\n" };
  });
  const r = await resilientGenerate(base, m.fn, spinOpts({ expectedPaths: ["a.py", "README.md", "b.py"] }));
  assert.equal(r.truncated, false);
  assert.deepEqual(r.abandonedPaths, ["README.md"]);
  assert.ok(parseFileBlocks(r.full).some((b) => b.path === "b.py"), "a injeção de \\n pôs a cerca do b.py em início de linha → parseado (sem ela seria engolido)");
});

test("resilientGenerate: chat (sem expectedPaths) com cerca aberta NUNCA abandona nem entra em clean-room", async () => {
  const s = scripted([
    { text: FENCE + "forge-file path=a.py\ndef f():" }, // aberto
    { text: "\n    x = 1" }, // spin, não fecha
    { text: "\n    y = 2" }, // spin, não fecha
  ]);
  const r = await resilientGenerate(base, s.fn, {
    ...opts,
    maxContinuations: 2,
    buildMissingFilesContinuation: (missing: string[]) => `NAO_USAR: ${missing.join(", ")}`,
  });
  assert.ok(!r.abandonedPaths || r.abandonedPaths.length === 0, "sem plano → missing sempre [] → nunca abandona");
  assert.equal(r.truncated, true);
  for (const c of s.captured.slice(1)) {
    assert.ok(c.some((x) => x.role === "assistant"), "âncora preservada (openFence normal)");
    assert.ok(!/NAO_USAR/.test(c.at(-1)?.content ?? ""), "clean-room nunca dispara sem expectedPaths");
  }
});

test("resilientGenerate: salvamento precisa de orçamento — cap baixo trunca, cap alto completa (spin)", async () => {
  const plan = ["f0.py", "f1.py", "f2.py", "f3.py", "f4.py", "f5.py", "f6.py"];
  const block = (p: string) => FENCE + `forge-file path=${p}\nx = 1\n` + FENCE + "\n";
  const f1Open = FENCE + "forge-file path=f1.py\n# corpo\n"; // f1 ABERTO (com corpo)
  const run = (cap: number) => {
    const m = messageAware((msgs) => {
      const hasAnchor = msgs.some((x) => x.role === "assistant");
      if (msgs.length === 1) return { text: block("f0.py") + f1Open }; // f0 fechado + f1 ABERTO (trava na #2)
      if (hasAnchor) return { text: "Proceed.\n" }; // spin em f1
      const last = msgs.at(-1)?.content ?? ""; // clean-room: emite o 1º faltante nomeado, um por rodada
      const next = plan.find((p) => last.includes(p));
      return { text: next ? block(next) : "" };
    });
    return resilientGenerate(base, m.fn, spinOpts({ maxContinuations: cap, expectedPaths: plan }));
  };
  const low = await run(6);
  assert.equal(low.truncated, true, "cap=6: o orçamento estoura antes de salvar o plano inteiro");
  const high = await run(12);
  assert.equal(high.truncated, false, "cap=12: salva o plano inteiro após abandonar o travado");
  for (const p of plan) assert.match(high.full, new RegExp(`path=${p.replace(".", "\\.")}`), `${p} presente`);
});

test("resilientGenerate: reenvia só a CAUDA (âncora), não o texto inteiro", async () => {
  const big = "x".repeat(20000);
  const s = scripted([{ text: FENCE + "forge-file path=c.py\n" + big }, { text: "\nfim\n" + FENCE + "\n" }]);
  await resilientGenerate(base, s.fn, { ...opts, anchorChars: 500 });
  const assistantMsg = s.captured[1].find((m) => m.role === "assistant");
  assert.ok(assistantMsg && assistantMsg.content.length <= 520);
});

test("resilientGenerate: erro numa passagem é propagado sem continuar", async () => {
  const fn = async () => ({ text: "", error: "boom", truncated: false });
  const r = await resilientGenerate(base, fn, opts);
  assert.equal(r.error, "boom");
  assert.equal(r.attempts, 0);
});

// ---- Saneamento harmony na geração (streaming): SÓ o preâmbulo (fora dos blocos); payload verbatim ----
test("resilientGenerate: vazamento harmony NO PREÂMBULO (antes do 1º bloco) é saneado na 1ª passagem", async () => {
  const s = scripted([
    { text: "We need to output the code.\n<|channel|>final<|message|>Segue:\n" + FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n" },
  ]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.ok(!/We need to output/i.test(r.full), "análise antes do marcador foi cortada");
  assert.ok(!/<\|channel\|>/.test(r.full), "token de controle do preâmbulo removido");
  assert.match(r.full, /path=a\.py/);
  assert.match(r.full, /x = 1/);
});

test("resilientGenerate: preâmbulo de análise SEM marcador (antes do 1º bloco) é dropado na 1ª passagem", async () => {
  const s = scripted([
    { text: "We need to produce the file.\nProceed.\n" + FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n" },
  ]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.ok(!/We need to produce|Proceed/i.test(r.full), "linhas de análise iniciais dropadas");
  assert.match(r.full, /path=a\.py/);
});

// REGRESSÃO (achado crítico da revisão adversarial): o CONTEÚDO de um arquivo pode conter literais harmony
// (o domínio do FORGE é parsear gpt-oss) — o saneamento NUNCA pode tocar dentro do bloco.
test("resilientGenerate: arquivo com literal harmony NÃO é corrompido na 1ª passagem [regressão]", async () => {
  const code = 'FINAL = "assistantfinal"\nTOK = "<|channel|>final<|message|>"\ndef strip(t):\n    return t\n';
  const s = scripted([{ text: "Segue:\n" + FENCE + "forge-file path=harmony_parser.py\n" + code + FENCE + "\n" }]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.match(r.full, /path=harmony_parser\.py/);
  assert.match(r.full, /"assistantfinal"/, "literal assistantfinal preservado no conteúdo do arquivo");
  assert.ok(r.full.includes("<|channel|>final<|message|>"), "token literal preservado no conteúdo do arquivo");
});

test("resilientGenerate: continuação que RETOMA código com literal harmony NÃO é corrompida [regressão]", async () => {
  const s = scripted([
    { text: "Segue:\n" + FENCE + 'forge-file path=p.py\nMARK = "assist', truncated: true }, // cortado no meio da string
    { text: 'antfinal"\ndef f():\n    return MARK\n' + FENCE + "\n" }, // continua "…assistantfinal"
  ]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.ok(/assistantfinal/.test(r.full), "a string costurada da continuação sobrevive (não é tratada como marcador)");
  assert.match(r.full, /def f\(\)/);
});

test("resilientGenerate: marcador vazado no PREÂMBULO de uma continuação-entre-arquivos é removido", async () => {
  const s = scripted([
    { text: FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n", truncated: true },
    { text: "assistantfinal\n" + FENCE + "forge-file path=b.py\ny = 2\n" + FENCE + "\n" },
  ]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.ok(!/assistantfinal/i.test(r.full), "marcador colapsado do preâmbulo da continuação removido");
  assert.match(r.full, /path=a\.py/);
  assert.match(r.full, /path=b\.py/);
});

test("resilientGenerate: fluxo normal (já completo, sem truncar) NÃO continua", async () => {
  const s = scripted([{ text: "ok, sem código.\n" }]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.attempts, 0);
  assert.equal(r.truncated, false);
  assert.equal(s.calls(), 1);
});

// ---- partialFilePath: qual arquivo (se algum) é PARCIAL (bug do README no "Aplicar tudo") ----

// Dois arquivos, ambos FECHADOS (corte ENTRE arquivos): nenhum é parcial.
const TWO_CLOSED = FENCE + "forge-file path=src/a.py\nx = 1\n" + FENCE + "\n" + FENCE + "forge-file path=README.md\n# Doc\n" + FENCE + "\n";
// a.py fechado + b.py cortado no meio SEM cerca de fechamento (cerca-aberta genuína).
const OPEN_LAST = FENCE + "forge-file path=src/a.py\nx = 1\n" + FENCE + "\n" + FENCE + "forge-file path=src/b.py\ndef f():\n    x = ";
// README cortado no meio, mas com uma cerca SOLTA de 3 crases no fim (a abertura tem 4): o
// BARE_FENCE_TAIL faz checkCompleteness dizer complete:true, mascarando o truncamento.
const MASKED_TRUNC = FENCE + "forge-file path=README.md\n# Titulo\nlinha cortada no me\n```\n";

test("partialFilePath: corte ENTRE arquivos (tudo fechado) NÃO marca parcial — o README completo é aplicável", () => {
  assert.equal(partialFilePath(true, { complete: true }, TWO_CLOSED), undefined);
});

test("partialFilePath: arquivo realmente cortado (cerca aberta) é o parcial", () => {
  assert.equal(partialFilePath(true, { complete: false, reason: "cerca-aberta", path: "src/b.py" }, OPEN_LAST), "src/b.py");
});

test("partialFilePath: path reportado FORA dos blocos → cai no ÚLTIMO bloco emitido", () => {
  assert.equal(partialFilePath(true, { complete: false, reason: "cerca-aberta", path: "z.py" }, OPEN_LAST), "src/b.py");
});

test("partialFilePath: sem truncamento → nada parcial; sem blocos → undefined", () => {
  assert.equal(partialFilePath(false, { complete: false, reason: "cerca-aberta", path: "x" }, OPEN_LAST), undefined);
  assert.equal(partialFilePath(true, { complete: false, reason: "cerca-aberta", path: undefined }, "sem blocos aqui"), undefined);
});

// REGRESSÃO (revisão adversarial PR B): truncamento no meio MASCARADO por cerca solta de contagem
// errada NÃO pode escapar — o "Aplicar tudo" gravaria um README cortado como completo.
test("partialFilePath: truncamento mascarado por BARE_FENCE_TAIL (último bloco não fechou de fato) → parcial", () => {
  const c = checkCompleteness(MASKED_TRUNC);
  assert.equal(c.complete, true, "BARE_FENCE_TAIL mascara o corte como 'completo'");
  // ...mas o último bloco não fechou de verdade → deve ser marcado parcial e PULADO pelo Aplicar tudo:
  assert.equal(partialFilePath(true, c, MASKED_TRUNC), "README.md");
});

test("cenário do README ponta-a-ponta: 1 arquivo FECHADO com corte do provider → truncado mas NÃO parcial", async () => {
  const s = scripted([{ text: FENCE + "forge-file path=README.md\n# Projeto\nrodar: `python -m app`\n" + FENCE + "\n", truncated: true }]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.truncated, true, "provider sinalizou finish_reason=length");
  assert.equal(r.completeness.complete, true, "mas o bloco do README fechou");
  assert.equal(partialFilePath(r.truncated, r.completeness, r.full), undefined);
});

// ---- R5: a continuação clean-room passa os CONTRATOS reais dos já-emitidos ----

test("R5 emittedContracts: extrai os blocos já emitidos (path+content) e EXCLUI o bloco ABERTO (travado)", () => {
  const full =
    FENCE + "forge-file path=a.py\nclass A:\n    def go(self) -> int: ...\n" + FENCE + "\n" +
    FENCE + "forge-file path=b.py\nclass B: ...\n" + FENCE + "\n" +
    FENCE + "forge-file path=c.py\nclass C_incompl"; // c.py cerca ABERTA (travado/abandonado)
  const c = emittedContracts(full, "c.py");
  const paths = c.map((b) => b.path.replace(/^\.\//, ""));
  assert.ok(paths.includes("a.py") && paths.includes("b.py"), "traz os já-emitidos completos");
  assert.ok(!paths.includes("c.py"), "exclui o bloco aberto (travado) — não é contrato confiável");
  assert.match(c.find((b) => /a\.py/.test(b.path))!.content, /class A/, "traz o CONTEÚDO real (a assinatura)");
});

test("R5: o laço clean-room ENTREGA ao builder os contratos reais dos já-emitidos (não regenera cego)", async () => {
  let seen: { path: string; content: string }[] = [];
  const s = scripted([
    { text: AB_CLOSED }, // a.py + b.py fechados; README.md do plano FALTA (sem cerca aberta) → clean-room
    { text: FENCE + "forge-file path=README.md\n# Doc\n" + FENCE + "\n" }, // a clean-room emite o faltante
  ]);
  const r = await resilientGenerate(base, s.fn, {
    ...opts,
    expectedPaths: ["a.py", "b.py", "README.md"],
    buildMissingFilesContinuation: (missing, emitted) => {
      seen = emitted;
      return `emita: ${missing.join(", ")}`;
    },
  });
  assert.equal(r.completeness.complete, true);
  const paths = seen.map((e) => e.path.replace(/^\.\//, ""));
  assert.ok(paths.includes("a.py") && paths.includes("b.py"), "o builder RECEBEU o contrato de a.py e b.py já emitidos");
  assert.ok(!paths.includes("README.md"), "o faltante que está sendo regenerado NÃO é seu próprio contrato");
  assert.ok(seen.every((e) => typeof e.content === "string" && e.content.length > 0), "os contratos trazem o conteúdo real");
});
