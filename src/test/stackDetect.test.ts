import assert from "node:assert/strict";
import { test } from "node:test";
import { detectStack, renderStackBlock } from "../util/stackDetect";

test("detecta Python/uv/ruff/mypy/pytest e libs a partir do pyproject", () => {
  const files = {
    "pyproject.toml": [
      "[project]",
      "dependencies = ['polars', 'pyspark', 'scikit-learn']",
      "[tool.ruff]",
      "[tool.mypy]",
      "[tool.pytest.ini_options]",
    ].join("\n"),
    "uv.lock": "# lock",
  } as Record<string, string | undefined>;
  const s = detectStack(files);
  assert.equal(s.language, "Python");
  assert.equal(s.packaging, "uv");
  assert.ok(s.lintFormat.includes("ruff"));
  assert.ok(s.types.includes("mypy"));
  assert.equal(s.tests, "pytest");
  assert.ok(s.libs.includes("polars") && s.libs.includes("pyspark") && s.libs.includes("scikit-learn"));
});

test("requirements.txt => pip e detecta pandas", () => {
  const s = detectStack({ "requirements.txt": "pandas==2.2\nnumpy\n" });
  assert.equal(s.language, "Python");
  assert.equal(s.packaging, "pip");
  assert.ok(s.libs.includes("pandas") && s.libs.includes("numpy"));
});

test("sklearn é normalizado para scikit-learn sem duplicar", () => {
  const s = detectStack({ "requirements.txt": "scikit-learn\nsklearn\n" });
  assert.deepEqual(
    s.libs.filter((l) => l === "scikit-learn"),
    ["scikit-learn"]
  );
});

test("package.json => Node, eslint, typescript, jest e libs", () => {
  const files = {
    "package.json": JSON.stringify({
      devDependencies: { eslint: "^9", jest: "^29", prettier: "^3" },
      dependencies: { react: "^18", express: "^4" },
    }),
    "tsconfig.json": "{}",
  } as Record<string, string | undefined>;
  const s = detectStack(files);
  assert.equal(s.language, "Node/JavaScript");
  assert.equal(s.packaging, "npm");
  assert.ok(s.lintFormat.includes("eslint") && s.lintFormat.includes("prettier"));
  assert.ok(s.types.includes("typescript"));
  assert.equal(s.tests, "jest");
  assert.ok(s.libs.includes("react") && s.libs.includes("express"));
});

test("não confunde metadados/prosa com libs (Keras Fan, my-flasky-app, airflow-incubator, scipy-like, # adbtools)", () => {
  const files = {
    "pyproject.toml": [
      "[project]",
      'name = "my-flasky-app"',
      'authors = ["Keras Fan"]',
      'description = "A scipy-like API for data"',
      'homepage = "https://github.com/airflow-incubator/x"',
      "# usa django-style settings e rapidbtree e adbtools",
      'dependencies = ["polars"]',
    ].join("\n"),
  } as Record<string, string | undefined>;
  const s = detectStack(files);
  for (const phantom of ["keras", "flask", "airflow", "scipy", "django", "dbt"]) {
    assert.ok(!s.libs.includes(phantom), `não deveria detectar ${phantom}`);
  }
  assert.ok(s.libs.includes("polars")); // a dependência real ainda é detectada
});

test("black: detectado por [tool.black], não por 'black-box' na descrição", () => {
  const prose = detectStack({ "pyproject.toml": 'description = "we do black-box testing"' });
  assert.ok(!prose.lintFormat.includes("black"));
  const real = detectStack({ "pyproject.toml": "[tool.black]\nline-length = 100" });
  assert.ok(real.lintFormat.includes("black"));
});

test("renderStackBlock é vazio sem detecção e formata quando há dados", () => {
  assert.equal(renderStackBlock(detectStack({})), "");
  const block = renderStackBlock(detectStack({ "requirements.txt": "pandas" }));
  assert.match(block, /## Stack do projeto/);
  assert.match(block, /Linguagem: Python/);
  assert.match(block, /Libs: pandas/);
});

test("dbt_project.yml ancora projeto dbt: lib dbt em primeiro e linguagem SQL quando não há outra", () => {
  const stack = detectStack({ "dbt_project.yml": "name: shop\nprofile: shop" });
  assert.ok(stack.libs.includes("dbt"));
  assert.equal(stack.language, "SQL (projeto dbt)");
  // com Python presente, a linguagem detectada permanece e o dbt não duplica
  const misto = detectStack({ "dbt_project.yml": "name: x", "requirements.txt": "dbt-core==1.8\npandas" });
  assert.equal(misto.language, "Python");
  assert.equal(misto.libs.filter((l) => l === "dbt").length, 1);
});
