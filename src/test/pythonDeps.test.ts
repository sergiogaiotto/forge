import assert from "node:assert/strict";
import { test } from "node:test";
import { mapImportsToPackages, mergeRequirements, parseRequirementNames, renderRequirements, scanPythonImports } from "../util/pythonDeps";

test("scanPythonImports: cobre import simples, múltiplo, com as, from x.y e ignora relativos", () => {
  const src = [
    "import numpy as np",
    "import os, sys",
    "from scipy import integrate",
    "from sklearn.linear_model import LinearRegression",
    "from . import util",
    "from .local_mod import thing",
    "  import json  # comentário",
    "import numpy  # duplicado — dedupe",
  ].join("\n");
  assert.deepEqual(scanPythonImports([src]), ["numpy", "os", "sys", "scipy", "sklearn", "json"]);
});

test("scanPythonImports: não casa import dentro de string/prosa (linha não começa com import/from)", () => {
  const src = 'print("import fake")\nx = "from fake import y"';
  assert.deepEqual(scanPythonImports([src]), []);
});

test("mapImportsToPackages: filtra stdlib e módulos locais; mapeia nomes PyPI divergentes", () => {
  const imports = ["numpy", "os", "sys", "json", "sklearn", "cv2", "PIL", "yaml", "meu_modulo", "src"];
  const local = new Set(["meu_modulo", "src"]);
  assert.deepEqual(mapImportsToPackages(imports, local), ["numpy", "scikit-learn", "opencv-python", "Pillow", "PyYAML"]);
});

test("mapImportsToPackages: fallback nome-igual para pacote desconhecido; dedupe case-insensitive", () => {
  assert.deepEqual(mapImportsToPackages(["requests", "Requests"], new Set()), ["requests"]);
  assert.deepEqual(mapImportsToPackages(["fastapi"], new Set()), ["fastapi"]);
});

test("parseRequirementNames: normaliza pins, extras, caixa e separadores; ignora comentários/opções", () => {
  const req = [
    "# comentário",
    "-r outros.txt",
    "--index-url https://interno",
    "NumPy==1.26.4",
    "python_dotenv",
    "uvicorn[standard]>=0.29",
    "",
  ].join("\n");
  const names = parseRequirementNames(req);
  assert.ok(names.has("numpy"));
  assert.ok(names.has("python-dotenv"));
  assert.ok(names.has("uvicorn"));
  assert.equal(names.size, 3);
});

test("mergeRequirements: adiciona só os ausentes, preserva conteúdo/pins, idempotente", () => {
  const existing = "# deps\nnumpy==1.26.4\nuvicorn[standard]>=0.29\n";
  const r1 = mergeRequirements(existing, ["numpy", "scipy", "uvicorn", "python-dotenv"]);
  assert.deepEqual(r1.added, ["scipy", "python-dotenv"]);
  assert.ok(r1.content.startsWith(existing)); // nada existente foi tocado
  assert.ok(r1.content.includes("scipy\npython-dotenv\n"));
  const r2 = mergeRequirements(r1.content, ["scipy", "python-dotenv"]);
  assert.deepEqual(r2.added, []); // idempotente
  assert.equal(r2.content, r1.content);
});

test("mergeRequirements: arquivo sem newline final ganha quebra antes do acréscimo", () => {
  const r = mergeRequirements("numpy", ["scipy"]);
  assert.equal(r.content, "numpy\nscipy\n");
});

test("renderRequirements: cabeçalho explica a origem + um pacote por linha", () => {
  const out = renderRequirements(["numpy", "scipy"]);
  assert.match(out, /^# Gerado pelo FORGE/);
  assert.ok(out.endsWith("numpy\nscipy\n"));
});

// ---- REGRESSÕES da revisão adversarial (todas confirmadas com repro na revisão) ----

test("scanPythonImports: 'import x' dentro de DOCSTRING não vira dependência", () => {
  const src = '"""\nExemplo de uso:\n\nimport requests\n    import flask\n"""\nimport numpy\n';
  assert.deepEqual(scanPythonImports([src]), ["numpy"]);
  // docstring abre e fecha na MESMA linha + código depois na linha seguinte
  const inline = '"""doc de uma linha"""\nimport scipy';
  assert.deepEqual(scanPythonImports([inline]), ["scipy"]);
  // aspas simples triplas também
  const sq = "'''\nimport fake\n'''\nimport pandas";
  assert.deepEqual(scanPythonImports([sq]), ["pandas"]);
});

test("scanPythonImports: statements separados por ';' são todos vistos", () => {
  assert.deepEqual(scanPythonImports(["import os; import requests"]), ["os", "requests"]);
});

test("scanPythonImports: namespace google.* preservado em 2 segmentos", () => {
  const src = "from google.cloud import storage\nfrom google.protobuf import message\nimport google.generativeai as genai";
  assert.deepEqual(scanPythonImports([src]), ["google.cloud", "google.protobuf", "google.generativeai"]);
});

test("mapImportsToPackages: google.* — protobuf/generativeai mapeados; cloud e topo nus DESCARTADOS", () => {
  const out = mapImportsToPackages(["google.cloud", "google.protobuf", "google.generativeai", "google"], new Set());
  assert.deepEqual(out, ["protobuf", "google-generativeai"]); // nunca instalar pacote errado por palpite
});

test("mapImportsToPackages: stdlib removida em 3.12+ (distutils/lib2to3…) não vira pip install", () => {
  assert.deepEqual(mapImportsToPackages(["distutils", "lib2to3", "asyncore", "smtpd"], new Set()), []);
});

test("mapImportsToPackages: módulo local em layout src/ (segmento de diretório) é filtrado", () => {
  // 'adapters' EXISTE no PyPI (lib de ML) — o filtro local evita instalar a lib errada silenciosamente.
  const local = new Set(["main", "src", "adapters", "handler"]);
  assert.deepEqual(mapImportsToPackages(["adapters", "requests"], local), ["requests"]);
});

test("parseRequirementNames: URL/vcs — nome vem do #egg=; sem egg a linha é ignorada", () => {
  const req = [
    "git+https://github.com/psf/requests.git@main#egg=requests",
    "https://files.pythonhosted.org/packages/x/y/pkg-1.0.whl",
  ].join("\n");
  const names = parseRequirementNames(req);
  assert.ok(names.has("requests"));
  assert.ok(!names.has("https")); // esquema de URL nunca é nome de pacote
  assert.equal(names.size, 1);
  // idempotência do merge com a linha vcs presente
  assert.deepEqual(mergeRequirements(req, ["requests"]).added, []);
});
