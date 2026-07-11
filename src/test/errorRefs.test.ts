import assert from "node:assert/strict";
import { test } from "node:test";
import { extractReferencedPaths } from "../util/errorRefs";

// Frame de traceback Python: o path vem entre aspas (pode conter ':' do drive Windows e barras invertidas).
test("extractReferencedPaths: frame de traceback Python (path entre aspas, drive Windows)", () => {
  const tb =
    'Traceback (most recent call last):\n' +
    '  File "C:\\_PERSONAL\\prj_code\\teste\\src\\domain\\entities\\appointment.py", line 20, in <module>\n' +
    "    @dataclass\n" +
    "TypeError: non-default argument 'technician_id' follows default argument";
  const paths = extractReferencedPaths(tb);
  assert.ok(
    paths.includes("C:\\_PERSONAL\\prj_code\\teste\\src\\domain\\entities\\appointment.py"),
    "extrai o arquivo citado no frame"
  );
});

// Compilador / mypy / pytest: PATH:linha (relativo ou absoluto).
test("extractReferencedPaths: linha PATH:linha de compilador/mypy (relativo e absoluto)", () => {
  const err =
    "src/adapters/http/fastapi_router.py:54: error: Argument 1 ...\n" +
    "src/domain/entities/book.py:12: note: ...\n" +
    "C:\\ws\\src\\main.py:3: error: ...";
  const paths = extractReferencedPaths(err);
  assert.ok(paths.includes("src/adapters/http/fastapi_router.py"));
  assert.ok(paths.includes("src/domain/entities/book.py"));
  assert.ok(paths.includes("C:\\ws\\src\\main.py"));
});

// O util EXTRAI todos os frames (inclusive stdlib); a contenção no workspace é do safeWorkspacePath (host).
test("extractReferencedPaths: extrai todos os frames — o host descarta stdlib via safeWorkspacePath", () => {
  const tb =
    '  File "C:\\Users\\x\\AppData\\Local\\Programs\\Python\\Python311\\Lib\\dataclasses.py", line 585, in _init_fn\n' +
    '  File "src/app.py", line 3, in <module>';
  const paths = extractReferencedPaths(tb);
  assert.ok(paths.some((p) => p.endsWith("dataclasses.py")), "extrai o frame stdlib (o host filtra depois)");
  assert.ok(paths.includes("src/app.py"));
});

// Texto sem erro/path → nada (auto-leitura não dispara num brief normal de geração).
test("extractReferencedPaths: brief normal / vazio → sem candidatos", () => {
  assert.deepEqual(extractReferencedPaths("crie uma app simples de lista de tarefas"), []);
  assert.deepEqual(extractReferencedPaths(""), []);
});

// Anti-ReDoS (achado da revisão): uma linha gigante sem delimitador (base64/data-URI/minificado) NÃO pode
// disparar backtracking quadrático que trava o extension host — é pulada (> MAX_LINE), e retorna rápido.
test("extractReferencedPaths: linha gigante sem delimitador é pulada (anti-ReDoS) e retorna rápido", () => {
  const huge = "a".repeat(200_000) + ".py:1"; // uma linha só, muito acima de MAX_LINE
  const t0 = Date.now();
  const paths = extractReferencedPaths(huge + '\nFile "src/real.py", line 3');
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `deve retornar rápido (foi ${ms}ms) — sem blowup quadrático`);
  assert.ok(!paths.some((p) => p.length > 2000), "não extrai o token gigante");
  assert.ok(paths.includes("src/real.py"), "ainda extrai caminhos de linhas normais");
});
