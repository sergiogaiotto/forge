import assert from "node:assert/strict";
import { test } from "node:test";
import { ValidatorResult } from "../shared/protocol";
import {
  GateCheckResult,
  mypyUnavailable,
  normGatePath,
  parseCompileallErrors,
  parseMypyErrors,
  summarizeGate,
  syntheticInitDirs,
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
