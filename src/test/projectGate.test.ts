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

test("summarizeGate: reprovação de gate SEM arquivo atribuível → projectErrors (bloqueio amplo)", () => {
  const s = summarizeGate([check(res("compileall", "failed", "erro sem path reconhecível"))]);
  assert.equal(s.advisory, false);
  assert.deepEqual(s.fileErrors, []);
  assert.equal(s.projectErrors.length, 1);
  assert.match(s.projectErrors[0], /compileall/);
});

test("summarizeGate: compileall ok + mypy ok → verde (compila e importa)", () => {
  const s = summarizeGate([check(res("compileall", "ok")), check(res("mypy", "ok"))]);
  assert.equal(s.advisory, false);
  assert.deepEqual(s.fileErrors, []);
  assert.match(s.summary, /verde/i);
  assert.match(s.summary, /mypy/i);
});

test("summarizeGate: compileall ok mas mypy PULADO → 'parcial' (drift não verificado), não verde falso", () => {
  const s = summarizeGate([check(res("compileall", "ok")), check(res("mypy", "skipped"))]);
  assert.equal(s.advisory, false); // uma checagem de gate rodou (compileall)
  assert.deepEqual(s.fileErrors, []);
  assert.match(s.summary, /parcial/i);
  assert.match(s.summary, /drift/i);
});

test("summarizeGate: só uma checagem skipped não conta como bloqueio nem como gate rodado", () => {
  const s = summarizeGate([check(res("mypy", "skipped"), [["x.py", ["ignorar"]]])]);
  assert.equal(s.advisory, true); // nenhuma checagem de gate executou
  assert.deepEqual(s.fileErrors, []); // erros de uma checagem SKIPPED não bloqueiam
});
