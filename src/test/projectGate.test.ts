import assert from "node:assert/strict";
import { test } from "node:test";
import { ValidatorResult } from "../shared/protocol";
import {
  GateCheckResult,
  isTscSyntaxError,
  mypyUnavailable,
  normGatePath,
  parseCompileallErrors,
  parseMypyErrors,
  parseTscErrors,
  summarizeGate,
  syntheticInitDirs,
  tscErrorsToMap,
  tscUnavailable,
} from "../core/projectGate";

test("normGatePath: separadores pra frente, sem ./ inicial nem / final", () => {
  assert.equal(normGatePath("src\\domain\\models.py"), "src/domain/models.py");
  assert.equal(normGatePath("./adapters/api.py"), "adapters/api.py");
  assert.equal(normGatePath(".\\adapters\\api.py"), "adapters/api.py");
  assert.equal(normGatePath("src/"), "src");
  assert.equal(normGatePath(""), "");
  // REGRESSÃO (saída REAL do compileall no Windows): repr() DOBRA as barras invertidas — o colapso
  // de `//` é o que faz o arquivo com erro casar a proposta e ser bloqueado.
  assert.equal(normGatePath(".\\\\adapters\\\\syntax_bad.py"), "adapters/syntax_bad.py");
});

test("parseCompileallErrors: saída REAL do compileall -q no Windows (barras dobradas por repr) casa o arquivo", () => {
  // Copiado verbatim da execução real: `python -m compileall -q .` (Python 3.11, Windows).
  const real = [
    "*** Error compiling '.\\\\adapters\\\\syntax_bad.py'...",
    '  File ".\\adapters\\syntax_bad.py", line 1',
    "    def broken(:",
    "               ^",
    "SyntaxError: invalid syntax",
  ].join("\n");
  const map = parseCompileallErrors(real, "");
  assert.deepEqual([...map.keys()], ["adapters/syntax_bad.py"]);
  assert.match(map.get("adapters/syntax_bad.py")!.join("\n"), /SyntaxError: invalid syntax/);
});

test("syntheticInitDirs: todo ancestral de um .py vira pacote; raiz e não-.py não", () => {
  const dirs = syntheticInitDirs(["src/domain/models.py", "src/adapters/api.py", "main.py", "docs/README.md"]);
  assert.deepEqual(dirs, ["src", "src/adapters", "src/domain"]); // main.py é top-level; docs não tem .py
});

test("syntheticInitDirs: pula diretório que JÁ tem __init__.py entre as propostas", () => {
  const dirs = syntheticInitDirs(["pkg/__init__.py", "pkg/a.py", "pkg/sub/b.py"]);
  assert.deepEqual(dirs, ["pkg/sub"]); // pkg já é pacote (o modelo emitiu o __init__); só falta pkg/sub
});

test("syntheticInitDirs: sobe TODA a cadeia de ancestrais e deduplica", () => {
  assert.deepEqual(syntheticInitDirs(["a/b/c/d.py"]), ["a", "a/b", "a/b/c"]);
  assert.deepEqual(syntheticInitDirs(["top.py"]), []); // sem diretório → nenhum pacote
});

// REGRESSÃO (revisão adversarial, reproduzida com mypy 2.1.0): um __init__.py sintético num diretório
// de nome NÃO-identificador faz o mypy ABORTAR (exit 2) e mascarar o drift real. Nomes com hífen/ponto/
// dígito inicial NÃO podem virar pacote — o gate não deve semeá-los.
test("syntheticInitDirs: NÃO semeia diretório com nome inválido de pacote Python", () => {
  assert.deepEqual(syntheticInitDirs(["my-app/core.py"]), []); // 'my-app' tem hífen → inválido
  assert.deepEqual(syntheticInitDirs(["2fa/x.py"]), []); // começa com dígito → inválido
  assert.deepEqual(syntheticInitDirs(["order.service/x.py"]), []); // ponto → inválido
  // pacote válido ao lado de um inválido: só o válido é semeado (o drift dele fica verificável)
  assert.deepEqual(syntheticInitDirs(["my-app/main.py", "core/models.py", "core/service.py"]), ["core"]);
  // subpacote sob um ancestral inválido também é barrado (o caminho do módulo seria inválido)
  assert.deepEqual(syntheticInitDirs(["my-app/core/models.py"]), []);
});

test("parseCompileallErrors: ancora no arquivo e agrega o traceback do SyntaxError", () => {
  const out = [
    "*** Error compiling '.\\adapters\\api.py'...",
    '  File ".\\adapters\\api.py", line 5',
    "    def broken(:",
    "               ^",
    "SyntaxError: invalid syntax",
    "",
    "*** Error compiling '.\\domain\\models.py'...",
    "SyntaxError: unexpected EOF while parsing",
  ].join("\n");
  const map = parseCompileallErrors(out, "");
  assert.deepEqual([...map.keys()].sort(), ["adapters/api.py", "domain/models.py"]);
  assert.match(map.get("adapters/api.py")!.join("\n"), /SyntaxError: invalid syntax/);
  assert.match(map.get("domain/models.py")!.join("\n"), /unexpected EOF/);
});

test("parseMypyErrors: coleta só linhas 'error' (com/sem coluna), ignora 'note'", () => {
  const out = [
    'adapters\\api.py:5: error: Module "domain.models" has no attribute "OrderStatus"  [attr-defined]',
    'application/use_cases.py:12:9: error: "Order" has no attribute "order_id"  [attr-defined]',
    "adapters\\api.py:6: note: contexto irrelevante",
    "Found 2 errors in 2 files",
  ].join("\n");
  const map = parseMypyErrors(out, "");
  assert.deepEqual([...map.keys()].sort(), ["adapters/api.py", "application/use_cases.py"]);
  assert.match(map.get("adapters/api.py")!.join("\n"), /linha 5: Module "domain.models" has no attribute "OrderStatus"/);
  assert.match(map.get("application/use_cases.py")!.join("\n"), /linha 12:.*order_id/);
  assert.equal(map.get("adapters/api.py")!.length, 1); // a 'note' não entra
});

test("mypyUnavailable: 'No module named mypy' → indisponível (não é reprovação real)", () => {
  const base = { id: "gate:mypy", label: "mypy", gate: true } as const;
  assert.equal(mypyUnavailable({ ...base, status: "failed", output: "C:\\py\\python.exe: No module named mypy" }), true);
  assert.equal(mypyUnavailable({ ...base, status: "skipped", output: "" }), true);
  assert.equal(mypyUnavailable({ ...base, status: "failed", output: 'api.py:5: error: has no attribute "X"' }), false);
  assert.equal(mypyUnavailable({ ...base, status: "ok", output: "" }), false);
});

// Helpers para montar GateCheckResult nos testes de decisão.
const res = (label: string, status: ValidatorResult["status"], output = ""): ValidatorResult => ({ id: `gate:${label}`, label, status, gate: true, output });
const check = (r: ValidatorResult, errors: Array<[string, string[]]> = []): GateCheckResult => ({ result: r, errors: new Map(errors) });

test("summarizeGate: TODAS as checagens puladas → consultivo, nada bloqueado", () => {
  const s = summarizeGate([check(res("compileall", "skipped")), check(res("mypy", "skipped"))]);
  assert.equal(s.advisory, true);
  assert.equal(s.partial, false); // consultivo (nada rodou) ≠ parcial (compileall rodou, mypy não)
  assert.deepEqual(s.fileErrors, []);
  assert.deepEqual(s.projectErrors, []);
  assert.match(s.summary, /consultivo/i);
});

test("summarizeGate: compileall ok + mypy reprovou com erro por-arquivo → bloqueia esse arquivo", () => {
  const s = summarizeGate([
    check(res("compileall", "ok")),
    check(res("mypy", "failed"), [["adapters/api.py", ["linha 5: no attribute OrderStatus"]]]),
  ]);
  assert.equal(s.advisory, false);
  assert.deepEqual(s.fileErrors.map((f) => f.path), ["adapters/api.py"]);
  assert.deepEqual(s.projectErrors, []);
  assert.match(s.summary, /reprovou/i);
});

test("summarizeGate: reprovação de gate SEM arquivo atribuível → projectErrors (aviso, NÃO bloqueia)", () => {
  const s = summarizeGate([check(res("compileall", "failed", "erro sem path reconhecível"))]);
  assert.equal(s.advisory, false);
  assert.deepEqual(s.fileErrors, []); // nada atribuído → nada bloqueado
  assert.equal(s.projectErrors.length, 1);
  assert.match(s.projectErrors[0], /compileall/);
  assert.match(s.summary, /não consegui localizar|nada foi bloqueado/i);
});

test("summarizeGate: compileall ok + mypy ok → verde (compila e importa)", () => {
  const s = summarizeGate([check(res("compileall", "ok")), check(res("mypy", "ok"))]);
  assert.equal(s.advisory, false);
  assert.equal(s.partial, false); // mypy rodou → coerência verificada de fato
  assert.deepEqual(s.fileErrors, []);
  assert.match(s.summary, /verde/i);
  assert.match(s.summary, /mypy/i);
});

test("summarizeGate: compileall ok mas mypy PULADO → 'parcial' (drift não verificado), não verde falso", () => {
  const s = summarizeGate([check(res("compileall", "ok")), check(res("mypy", "skipped"))]);
  assert.equal(s.advisory, false); // uma checagem de gate rodou (compileall)
  assert.equal(s.partial, true); // mas o mypy NÃO rodou → coerência não verificada (a UI avisa, não celebra)
  assert.deepEqual(s.fileErrors, []);
  assert.match(s.summary, /parcial/i);
  assert.match(s.summary, /drift/i);
});

test("summarizeGate: só uma checagem skipped não conta como bloqueio nem como gate rodado", () => {
  const s = summarizeGate([check(res("mypy", "skipped"), [["x.py", ["ignorar"]]])]);
  assert.equal(s.advisory, true); // nenhuma checagem de gate executou
  assert.deepEqual(s.fileErrors, []); // erros de uma checagem SKIPPED não bloqueiam
});

// ---- P4: gate TypeScript (parseTscErrors / syntax / syntheticInitDirs) --------

test("parseTscErrors: formato pretty=false `path(l,c): error TSxxxx` — atribui e captura código/mensagem", () => {
  const out = [
    "src/domain/order.ts(10,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    "src/adapters/db.ts(1,7): error TS1005: ',' expected.",
  ].join("\n");
  const e = parseTscErrors(out);
  assert.equal(e.length, 2);
  assert.deepEqual(e[0], { path: "src/domain/order.ts", line: 10, code: "TS2345", message: "Argument of type 'string' is not assignable to parameter of type 'number'." });
  assert.equal(e[1].code, "TS1005");
});

test("parseTscErrors: formato pretty `path:l:c - error TSxxxx` também é parseado", () => {
  const e = parseTscErrors("src/x.ts:5:1 - error TS2304: Cannot find name 'foo'.");
  assert.equal(e.length, 1);
  assert.equal(e[0].line, 5);
  assert.equal(e[0].code, "TS2304");
});

test("parseTscErrors: FILTRA cannot-find-module de import BARE (dep externa), MANTÉM o relativo (drift interno)", () => {
  const out = [
    "src/app.ts(1,20): error TS2307: Cannot find module 'express' or its corresponding type declarations.",
    "src/app.ts(2,20): error TS2307: Cannot find module './does-not-exist'.",
    "src/app.ts(3,1): error TS7016: Could not find a declaration file for module 'lodash'.",
  ].join("\n");
  const e = parseTscErrors(out);
  // express/lodash (bare) filtrados; './does-not-exist' (relativo) mantido
  assert.equal(e.length, 1);
  assert.match(e[0].message, /does-not-exist/);
});

test("isTscSyntaxError: TS1xxx é sintaxe (bloqueia); TS2xxx+ é tipo (advisory)", () => {
  assert.equal(isTscSyntaxError("TS1005"), true);
  assert.equal(isTscSyntaxError("TS1109"), true);
  assert.equal(isTscSyntaxError("TS2345"), false);
  assert.equal(isTscSyntaxError("TS2307"), false);
  assert.equal(isTscSyntaxError("TS7016"), false);
});

test("tscErrorsToMap: agrupa por arquivo com código e linha", () => {
  const map = tscErrorsToMap([
    { path: "a.ts", line: 1, code: "TS1005", message: "',' expected." },
    { path: "a.ts", line: 9, code: "TS1109", message: "Expression expected." },
    { path: "b.ts", line: 2, code: "TS1128", message: "Declaration expected." },
  ]);
  assert.equal(map.get("a.ts")!.length, 2);
  assert.match(map.get("a.ts")![0], /TS1005/);
  assert.equal(map.get("b.ts")!.length, 1);
});

test("tscUnavailable: skipped ou 'is not recognized' → indisponível; failed com erros reais → disponível", () => {
  assert.equal(tscUnavailable(res("tsc", "skipped")), true);
  assert.equal(tscUnavailable({ ...res("tsc", "failed"), output: "'tsc' is not recognized as an internal or external command" }), true);
  assert.equal(tscUnavailable({ ...res("tsc", "failed"), output: "src/x.ts(1,1): error TS1005: ',' expected." }), false);
  // loader do Node não achou o pacote typescript (o próprio tsc não carregou) → indisponível
  assert.equal(tscUnavailable({ ...res("tsc", "failed"), output: "Error: Cannot find module 'typescript'\n    at Module._resolveFilename" }), true);
});

// REGRESSÃO (revisão): um projeto que importa o PACOTE `typescript` faz o compilador emitir seu PRÓPRIO
// `error TS2307: Cannot find module 'typescript'` — isso NÃO pode ser lido como "tsc indisponível" (senão o
// gate, inclusive o bloqueio de SINTAXE, seria desligado). Um relatório COM diagnósticos = tsc RODOU.
test("tscUnavailable: TS2307 do compilador para import 'typescript' NÃO desliga o gate (há diagnósticos)", () => {
  const out = [
    "src/plugin.ts(1,25): error TS2307: Cannot find module 'typescript' or its corresponding type declarations.",
    "src/broken.ts(3,1): error TS1308: 'await' expression is only allowed within an async function.",
  ].join("\n");
  assert.equal(tscUnavailable({ ...res("tsc", "failed"), output: out }), false); // rodou → o TS1308 (sintaxe) bloqueia
});

test("syntheticInitDirs: SÓ semeia __init__.py para Python; TypeScript não precisa (retorna [])", () => {
  const paths = ["src/domain/order.ts", "src/adapters/db.ts"];
  assert.deepEqual(syntheticInitDirs(paths, "typescript"), []);
  // Python: semeia os diretórios-pacote
  const py = syntheticInitDirs(["src/domain/order.py", "src/adapters/db.py"], "python");
  assert.ok(py.includes("src/domain") && py.includes("src/adapters") && py.includes("src"));
});
