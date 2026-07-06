import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDefinitionOfDone, evaluateDodGate, DodRequirement } from "../util/dodCheck";

// Atalho: requisitos ausentes (ordenados) de um conjunto de arquivos, para asserts compactos.
function missing(files: { path: string; content?: string }[]): DodRequirement[] {
  return checkDefinitionOfDone(files, "python")
    .map((f) => f.requirement)
    .sort();
}

const MANIFEST = { path: "requirements.txt", content: "fastapi\n" };
const TESTFILE = { path: "tests/test_order.py", content: "def test_ok():\n    assert True\n" };
const README = { path: "README.md", content: "# App\n\n## Como rodar\n\n```\npip install -r requirements.txt\n```\n" };
const SRC = { path: "src/main.py", content: "print('x')" };

// ---- Função pura: presença dos três requisitos --------------------------------

test("projeto pronto (manifesto + teste + README executável) → nenhum achado", () => {
  assert.deepEqual(checkDefinitionOfDone([MANIFEST, TESTFILE, README, SRC], "python"), []);
});

test("faltando os três requisitos → 3 achados", () => {
  assert.deepEqual(missing([SRC]), ["manifest", "readme-run", "tests"]);
});

test("manifesto: requirements.txt / pyproject.toml / requirements/base.txt / Pipfile / environment.yml satisfazem", () => {
  for (const m of [
    "requirements.txt",
    "requirements-dev.txt",
    "requirements/base.txt",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "Pipfile",
    "environment.yml",
    "environment.yaml",
    "backend/requirements.txt",
  ]) {
    assert.ok(!missing([{ path: m, content: "x" }, TESTFILE, README]).includes("manifest"), `${m} deveria satisfazer o manifesto`);
  }
});

test("manifesto: um .txt qualquer NÃO é manifesto (evita casar notas.txt)", () => {
  assert.ok(missing([{ path: "notas.txt", content: "x" }, TESTFILE, README]).includes("manifest"));
});

test("teste: test_*.py, *_test.py e .py sob tests/ satisfazem", () => {
  for (const t of ["test_order.py", "app/test_service.py", "order_test.py", "tests/anything.py", "src/tests/conftest.py"]) {
    assert.ok(!missing([MANIFEST, { path: t, content: "def test_x(): assert True" }, README]).includes("tests"), `${t} deveria satisfazer o requisito de teste`);
  }
});

test("teste: tests/__init__.py sozinho NÃO conta como teste", () => {
  assert.ok(missing([MANIFEST, { path: "tests/__init__.py", content: "" }, README]).includes("tests"));
});

test("teste: nome sem convenção pytest NÃO conta, mesmo com def test_ dentro (pytest não coletaria)", () => {
  assert.ok(missing([MANIFEST, { path: "src/checks.py", content: "def test_x(): assert True" }, README]).includes("tests"));
});

// ---- README Markdown: seção de execução ---------------------------------------

test("README.md: heading pt-BR e en (Como rodar / Usage / Getting Started / Instalação) satisfazem", () => {
  for (const body of ["## Como rodar\ntexto", "## Usage\ntexto", "## Getting Started\ntexto", "## Instalação\ntexto", "### Setup\ntexto", "# Running the app\ntexto"]) {
    assert.ok(!missing([MANIFEST, TESTFILE, { path: "README.md", content: body }]).includes("readme-run"), `heading "${body.split("\n")[0]}" deveria satisfazer`);
  }
});

test("README.md: bloco de código cercado (``` ou ~~~) satisfaz mesmo sem heading canônico", () => {
  for (const body of ["# App\n\n```\npip install .\n```\n", "# App\n\n~~~sh\npython main.py\n~~~\n"]) {
    assert.ok(!missing([MANIFEST, TESTFILE, { path: "README.md", content: body }]).includes("readme-run"), "bloco cercado deveria satisfazer");
  }
});

test("README.md: só prosa, sem seção de execução nem bloco → achado readme-run", () => {
  assert.ok(missing([MANIFEST, TESTFILE, { path: "README.md", content: "# App\n\nUm projeto legal que faz coisas.\n" }]).includes("readme-run"));
});

test("README: sem nenhum README → achado readme-run", () => {
  assert.ok(missing([MANIFEST, TESTFILE, SRC]).includes("readme-run"));
});

// REGRESSÃO (achado adversarial #1/#4): README .rst/.txt REAL (não-Markdown) NÃO pode bloquear — o matcher
// Markdown não entende sublinhado RST nem prosa. Conta pela PRESENÇA. Antes, um projeto PyPI clássico com
// README.rst era bloqueado.
test("README.rst com conteúdo RST real (sublinhado + bloco ::) é aceito por PRESENÇA (não bloqueia)", () => {
  const rst = { path: "README.rst", content: "My App\n======\n\nInstallation\n------------\n\nInstall and run::\n\n    pip install .\n    app\n" };
  assert.ok(!missing([MANIFEST, TESTFILE, rst]).includes("readme-run"));
});

test("README.txt em prosa pura é aceito por PRESENÇA (não bloqueia)", () => {
  const txt = { path: "README.txt", content: "Este projeto instala com pip e roda com python main.py.\n" };
  assert.ok(!missing([MANIFEST, TESTFILE, txt]).includes("readme-run"));
});

test("README sem extensão é aceito por PRESENÇA (formato desconhecido → não bloqueia)", () => {
  assert.ok(!missing([MANIFEST, TESTFILE, { path: "README", content: "qualquer coisa" }]).includes("readme-run"));
});

test("README presente sem conteúdo (aplicado/truncado → content undefined) NÃO bloqueia", () => {
  assert.ok(!missing([MANIFEST, TESTFILE, { path: "README.md" }]).includes("readme-run"));
});

test("dois READMEs, um .md sem seção e um .rst → presença-apenas do .rst impede o bloqueio (conservador)", () => {
  const files = [MANIFEST, TESTFILE, { path: "README.md", content: "# App\nsó prosa" }, { path: "docs/README.rst", content: "App\n===" }];
  assert.ok(!missing(files).includes("readme-run"));
});

// REGRESSÃO (achado adversarial #7 — ReDoS): um heading Markdown seguido de um run gigante de espaços, sem
// palavra-chave, NÃO pode congelar. O matcher é linha-a-linha e linear; aqui só exigimos que complete e dê o
// veredito certo (readme-run, pois não há seção de execução).
test("README.md com heading de padding gigante não trava (anti-ReDoS) e é avaliado corretamente", () => {
  const padded = { path: "README.md", content: "# " + " ".repeat(60000) + "\n\nUm projeto.\n" };
  assert.ok(missing([MANIFEST, TESTFILE, padded]).includes("readme-run"));
});

// ---- Normalização e linguagem -------------------------------------------------

test("caminhos Windows (barras invertidas) são normalizados", () => {
  const files = [
    { path: "backend\\requirements.txt", content: "x" },
    { path: "backend\\tests\\test_x.py", content: "def test(): ..." },
    { path: "backend\\README.md", content: "## Como rodar\n```\napp\n```" },
  ];
  assert.deepEqual(checkDefinitionOfDone(files, "python"), []);
});

test("linguagem não-Python NÃO bloqueia (DoD é Python-only por ora)", () => {
  for (const lang of ["typescript", "java", "go"] as const) {
    assert.deepEqual(checkDefinitionOfDone([{ path: "src/main.ts", content: "x" }], lang), []);
  }
});

test("cada achado traz uma mensagem pt-BR acionável", () => {
  const findings = checkDefinitionOfDone([SRC], "python");
  assert.equal(findings.length, 3);
  for (const f of findings) assert.ok(f.message.length > 20 && /[a-zçãõáéí]/i.test(f.message));
});

// ---- evaluateDodGate: a DECISÃO de bloqueio (fiação testável) ------------------

test("evaluateDodGate: desabilitado → nunca bloqueia (errors vazio)", () => {
  const r = evaluateDodGate({ complete: true, enabled: false, language: "python", proposals: [SRC] });
  assert.deepEqual(r, { blocks: false, errors: [] });
});

test("evaluateDodGate: geração incompleta (complete=false) → nunca bloqueia", () => {
  const r = evaluateDodGate({ complete: false, enabled: true, language: "python", proposals: [SRC] });
  assert.deepEqual(r, { blocks: false, errors: [] });
});

test("evaluateDodGate: projeto fresco sem manifesto/teste/README → bloqueia com 3 mensagens", () => {
  const r = evaluateDodGate({ complete: true, enabled: true, language: "python", proposals: [SRC] });
  assert.equal(r.blocks, true);
  assert.equal(r.errors.length, 3);
});

test("evaluateDodGate: projeto completo (manifesto+teste+README) → não bloqueia", () => {
  const r = evaluateDodGate({ complete: true, enabled: true, language: "python", proposals: [SRC, MANIFEST, TESTFILE, README] });
  assert.deepEqual(r, { blocks: false, errors: [] });
});

// REGRESSÃO (achado #2/#5/#6): o arquivo que satisfaz um requisito veio TRUNCADO (partial=true). Ele conta
// por PRESENÇA — não pode ser tratado como ausente e bloquear o projeto inteiro.
test("evaluateDodGate: manifesto/README truncados (partial) contam por presença — não bloqueiam", () => {
  const r = evaluateDodGate({
    complete: true,
    enabled: true,
    language: "python",
    proposals: [
      SRC,
      TESTFILE,
      { path: "requirements.txt", content: "fast", partial: true },
      { path: "README.md", content: "# App\n(cortado no me", partial: true },
    ],
  });
  assert.deepEqual(r, { blocks: false, errors: [] });
});

// REGRESSÃO (achado #3): geração MULTI-RODADA. Na rodada que completa, o modelo emite só o teste que faltava;
// manifesto e README foram APLICADOS na rodada anterior (existem no disco, entram por appliedPaths). Não pode
// bloquear.
test("evaluateDodGate: multi-rodada — manifesto/README já aplicados (appliedPaths) satisfazem o DoD", () => {
  const r = evaluateDodGate({
    complete: true,
    enabled: true,
    language: "python",
    proposals: [{ path: "tests/test_x.py", content: "def test(): assert True" }],
    appliedPaths: ["requirements.txt", "README.md", "src/app.py"],
  });
  assert.deepEqual(r, { blocks: false, errors: [] });
});

test("evaluateDodGate: multi-rodada ainda pega ausência REAL (nada de manifesto em lugar nenhum)", () => {
  const r = evaluateDodGate({
    complete: true,
    enabled: true,
    language: "python",
    proposals: [{ path: "tests/test_x.py", content: "def test(): assert True" }],
    appliedPaths: ["README.md", "src/app.py"],
  });
  assert.equal(r.blocks, true);
  assert.equal(r.errors.length, 1); // só o manifesto falta
});
