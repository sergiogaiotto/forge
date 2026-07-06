import assert from "node:assert/strict";
import { test } from "node:test";
import { mapImportsToPackages, mergeRequirements, parsePinnedRequirements, parseRequirementNames, reconcileRequirements, renderRequirements, scanPythonImports } from "../util/pythonDeps";

test("parsePinnedRequirements: preserva o pin, ignora comentários/opções/in-line e capa o total", () => {
  const req = [
    "# deps do projeto",
    "fastapi==0.110.0",
    "jinja2>=3.1.3  # engine de templates",
    "",
    "-r dev-requirements.txt",
    "--index-url https://pypi.org/simple",
    "pydantic",
  ].join("\n");
  assert.deepEqual(parsePinnedRequirements(req), ["fastapi==0.110.0", "jinja2>=3.1.3", "pydantic"]);
  // cap: um requirements gigante não incha o prompt
  const many = Array.from({ length: 100 }, (_, i) => `pkg${i}==1.0.0`).join("\n");
  assert.equal(parsePinnedRequirements(many, 40).length, 40);
  assert.deepEqual(parsePinnedRequirements(""), []);
});

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

// ---- reconcileRequirements (P4): manifesto gerado × imports reais --------------

test("reconcileRequirements: pacote importado mas ausente do requirements é acrescentado", () => {
  const py = [{ path: "src/app.py", content: "import fastapi\nfrom pydantic import BaseModel\nimport os" }];
  const r = reconcileRequirements(py, ["src/app.py", "requirements.txt"], "fastapi\n");
  assert.deepEqual(r.added, ["pydantic"]); // fastapi já listado, os é stdlib
  assert.match(r.content, /pydantic/);
});

test("reconcileRequirements: idempotente — tudo já declarado → nada a adicionar, conteúdo intacto", () => {
  const py = [{ path: "app.py", content: "import fastapi\nimport pydantic" }];
  const r = reconcileRequirements(py, ["app.py", "requirements.txt"], "fastapi\npydantic\n");
  assert.deepEqual(r.added, []);
  assert.equal(r.content, "fastapi\npydantic\n");
});

test("reconcileRequirements: módulo LOCAL (layout src/) NÃO vira pacote pip", () => {
  const py = [
    { path: "src/app.py", content: "from adapters.db import Session\nfrom domain import Order\nimport fastapi" },
    { path: "src/adapters/db.py", content: "class Session: ..." },
    { path: "src/domain.py", content: "class Order: ..." },
  ];
  const paths = ["src/app.py", "src/adapters/db.py", "src/domain.py", "requirements.txt"];
  const r = reconcileRequirements(py, paths, "");
  assert.deepEqual(r.added, ["fastapi"]); // adapters (diretório) e domain (módulo) são locais
});

test("reconcileRequirements: nome PyPI divergente é mapeado (sklearn→scikit-learn, cv2→opencv-python)", () => {
  const py = [{ path: "m.py", content: "import sklearn\nimport cv2\nimport yaml" }];
  const r = reconcileRequirements(py, ["m.py", "requirements.txt"], "");
  assert.deepEqual(r.added.sort(), ["PyYAML", "opencv-python", "scikit-learn"]);
});

test("reconcileRequirements: import em docstring/stdlib não é acrescentado (herda o conservadorismo)", () => {
  const py = [{ path: "m.py", content: '"""\nimport requests  # exemplo na doc\n"""\nimport os\nimport json' }];
  const r = reconcileRequirements(py, ["m.py", "requirements.txt"], "");
  assert.deepEqual(r.added, []);
});

test("reconcileRequirements: preserva pins/comentários e acrescenta só o ausente no fim", () => {
  const py = [{ path: "m.py", content: "import fastapi\nimport uvicorn" }];
  const r = reconcileRequirements(py, ["m.py", "requirements.txt"], "# deps\nfastapi==0.110.0\n");
  assert.deepEqual(r.added, ["uvicorn"]);
  assert.match(r.content, /fastapi==0\.110\.0/); // pin preservado
  assert.match(r.content, /uvicorn/);
});

test("reconcileRequirements: caminho de arquivo APLICADO (rodada anterior) conta como módulo local", () => {
  // O import é de um módulo gerado numa rodada anterior (só o path chega em projectPaths, sem content).
  const py = [{ path: "app.py", content: "from services.orders import place\nimport httpx" }];
  const paths = ["app.py", "services/orders.py", "requirements.txt"]; // services/orders.py foi aplicado antes
  const r = reconcileRequirements(py, paths, "");
  assert.deepEqual(r.added, ["httpx"]); // services é local (diretório), não vira pip
});

// REGRESSÃO (achado adversarial): import/from DENTRO de uma string de UMA linha (mensagem/exemplo/ajuda) NÃO
// pode virar dependência — antes o P4 injetava tensorflow/torch no requirements de um projeto legítimo.
test("reconcileRequirements: import/from em STRING de uma linha NÃO é acrescentado (não corrompe o manifesto)", () => {
  const py = [
    {
      path: "app.py",
      content:
        'import fastapi\n' +
        'ERROR_HINT = "invalid plugin; from tensorflow import keras is not permitted"\n' +
        'MSG = "blah; import torch  # ok"',
    },
  ];
  const r = reconcileRequirements(py, ["app.py", "requirements.txt"], "fastapi\n");
  assert.deepEqual(r.added, []); // tensorflow/torch estão em strings — não são imports reais
});

test("scanPythonImports: import/from em string de UMA linha é ignorado (escape-aware)", () => {
  assert.deepEqual(scanPythonImports(['x = "a; from tensorflow import k"\nimport os']), ["os"]);
  assert.deepEqual(scanPythonImports(['MSG = "b; import torch  # c"\nimport sys']), ["sys"]);
  // Aspa ESCAPADA não fecha a string cedo — o `; import evil` segue dentro do literal e é descartado.
  assert.deepEqual(scanPythonImports(['y = "a\\"; import evil\\""\nimport json']), ["json"]);
  // Aspas simples e o `;` dentro de string dupla convivem.
  assert.deepEqual(scanPythonImports(["t = 'x; import requests'\nimport re"]), ["re"]);
});

// REGRESSÃO (2a revisão): aspa ÍMPAR num COMENTÁRIO (# don't) não pode abrir string-fantasma que engula os
// imports seguintes — senão o requirements ficaria incompleto (o oposto do propósito do P4).
test("scanPythonImports: comentário com aspa desbalanceada não engole os imports seguintes", () => {
  assert.deepEqual(scanPythonImports(["# don't forget\nimport requests"]), ["requests"]);
  assert.deepEqual(scanPythonImports(["import os\n# the project's entrypoint\nfrom fastapi import FastAPI\nimport uvicorn"]), ["os", "fastapi", "uvicorn"]);
  assert.deepEqual(scanPythonImports(['# use " to quote here\nimport json']), ["json"]);
  assert.deepEqual(scanPythonImports(["import pandas  # dataframes"]), ["pandas"]); // comentário in-line
});

test("reconcileRequirements: comentário com apóstrofe não faz o scan perder imports reais", () => {
  const py = [{ path: "app.py", content: "# app.py — the project's entrypoint\nimport fastapi\nimport uvicorn" }];
  const r = reconcileRequirements(py, ["app.py", "requirements.txt"], "");
  assert.deepEqual(r.added.sort(), ["fastapi", "uvicorn"]);
});

// REGRESSÃO (3a revisão): continuação de linha explícita com barra (\) — um único statement lógico em
// Python — não pode fazer os módulos continuados sumirem (sub-detecção → requirements incompleto).
test("scanPythonImports: continuação de linha com barra (\\) junta o statement — nenhum módulo some", () => {
  assert.deepEqual(scanPythonImports(["import boto3, \\\n    celery"]), ["boto3", "celery"]);
  assert.deepEqual(scanPythonImports(["import \\\n    requests"]), ["requests"]);
  assert.deepEqual(scanPythonImports(["import numpy, pandas, \\\n    matplotlib\nimport os"]), ["numpy", "pandas", "matplotlib", "os"]);
  // CRLF (Windows) na continuação também é tratado
  assert.deepEqual(scanPythonImports(["import boto3, \\\r\n    celery"]), ["boto3", "celery"]);
});

test("reconcileRequirements: import com continuação de linha (\\) é detectado por completo", () => {
  const py = [{ path: "m.py", content: "import fastapi, \\\n    uvicorn" }];
  const r = reconcileRequirements(py, ["m.py", "requirements.txt"], "");
  assert.deepEqual(r.added.sort(), ["fastapi", "uvicorn"]);
});
