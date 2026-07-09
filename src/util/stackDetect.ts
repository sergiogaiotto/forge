// Auto-detecção da stack do projeto a partir de arquivos-âncora na raiz do workspace
// (pyproject.toml, package.json, lockfiles, configs de lint/tipos/teste). "Inferir, não
// interrogar": o resultado é injetado no prompt como "Stack do projeto (detectada)" e pré-preenche
// o esqueleto do .forge/project.md. PURO/testável — detecção por presença de arquivo + substring
// no conteúdo cru (sem parser de TOML; suficiente para um hint, e sem novas dependências).

export interface DetectedStack {
  language?: string;
  packaging?: string;
  lintFormat: string[];
  types: string[];
  tests?: string;
  libs: string[];
}

// Arquivos lidos da raiz do workspace para a detecção (lista limitada — leitura barata).
export const STACK_PROBE_FILES = [
  "pyproject.toml",
  "requirements.txt",
  "setup.cfg",
  "tox.ini",
  "ruff.toml",
  ".ruff.toml",
  ".flake8",
  "mypy.ini",
  "pyrightconfig.json",
  "pytest.ini",
  "Pipfile",
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  ".pre-commit-config.yaml",
  "package.json",
  "tsconfig.json",
  "dbt_project.yml",
];

// Bibliotecas de dados/IA reconhecidas (hint de domínio para o modelo).
const KNOWN_PY_LIBS = [
  "pandas", "polars", "pyspark", "numpy", "scikit-learn", "sklearn", "scipy", "torch",
  "tensorflow", "keras", "xgboost", "lightgbm", "fastapi", "flask", "django", "sqlalchemy",
  "pydantic", "airflow", "dbt", "duckdb", "mlflow", "transformers", "langchain", "great-expectations",
];
const KNOWN_NODE_LIBS = ["react", "vue", "next", "express", "@nestjs/core", "prisma", "svelte"];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Casa o token como PALAVRA (fronteira nas duas pontas) — evita "dbt" dentro de "rapidbtree".
// Nomes com hífen (scikit-learn) ainda casam, pois "-" é fronteira de palavra.
function hasWord(haystack: string, token: string): boolean {
  return new RegExp(`\\b${escapeRe(token)}\\b`).test(haystack);
}

// Remove comentários e linhas de metadados ([project] name/authors/url/description/keywords/…),
// onde nomes de libs aparecem como PROSA — deixando essencialmente a porção de dependências/config.
function stripNoise(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith("#")) return false;
      return !/^(name|description|summary|authors?|maintainers?|keywords|homepage|documentation|repository|download[-_]url|urls?|readme|license|classifiers|version|requires-python)\b/.test(t);
    })
    .join("\n");
}

export function detectStack(files: Record<string, string | undefined>): DetectedStack {
  const has = (name: string) => typeof files[name] === "string";
  const text = (name: string) => files[name] ?? "";
  const stack: DetectedStack = { lintFormat: [], types: [], libs: [] };

  const isPython =
    has("pyproject.toml") || has("requirements.txt") || has("setup.cfg") || has("Pipfile") || has("pytest.ini");
  const isNode = has("package.json");
  if (isPython) stack.language = "Python";
  else if (isNode) stack.language = "Node/JavaScript";

  // Gerenciador de pacotes
  if (has("uv.lock")) stack.packaging = "uv";
  else if (has("poetry.lock") || /\[tool\.poetry\]/i.test(text("pyproject.toml"))) stack.packaging = "poetry";
  else if (has("pdm.lock")) stack.packaging = "pdm";
  else if (has("Pipfile")) stack.packaging = "pipenv";
  else if (has("requirements.txt")) stack.packaging = "pip";
  else if (isNode) stack.packaging = "npm";

  const pyConfigs = (
    text("pyproject.toml") + text("setup.cfg") + text("tox.ini") + text(".pre-commit-config.yaml")
  ).toLowerCase();
  const pkg = text("package.json").toLowerCase();

  // Lint / format
  if (has("ruff.toml") || has(".ruff.toml") || /\bruff\b/.test(pyConfigs)) stack.lintFormat.push("ruff");
  // black é palavra comum ("black-box"); exige a tabela [tool.black] ou black no texto já filtrado.
  if (/\[tool\.black\]/.test(pyConfigs) || hasWord(stripNoise(pyConfigs), "black")) stack.lintFormat.push("black");
  if (has(".flake8") || /\bflake8\b/.test(pyConfigs)) stack.lintFormat.push("flake8");
  if (/\bisort\b/.test(pyConfigs)) stack.lintFormat.push("isort");
  if (isNode && pkg.includes("eslint")) stack.lintFormat.push("eslint");
  if (isNode && pkg.includes("prettier")) stack.lintFormat.push("prettier");

  // Tipos
  if (has("mypy.ini") || /\bmypy\b/.test(pyConfigs)) stack.types.push("mypy");
  if (has("pyrightconfig.json") || /\bpyright\b/.test(pyConfigs)) stack.types.push("pyright");
  if (isNode && has("tsconfig.json")) stack.types.push("typescript");

  // Testes
  if (has("pytest.ini") || /\[tool\.pytest|\bpytest\b/.test(pyConfigs)) stack.tests = "pytest";
  else if (isNode && pkg.includes("vitest")) stack.tests = "vitest";
  else if (isNode && pkg.includes("jest")) stack.tests = "jest";

  // Bibliotecas
  const deps = stripNoise(
    (text("pyproject.toml") + "\n" + text("requirements.txt") + "\n" + text("setup.cfg") + "\n" + text("Pipfile")).toLowerCase()
  );
  for (const lib of KNOWN_PY_LIBS) {
    if (hasWord(deps, lib)) {
      const norm = lib === "sklearn" ? "scikit-learn" : lib;
      if (!stack.libs.includes(norm)) stack.libs.push(norm);
    }
  }
  for (const lib of KNOWN_NODE_LIBS) {
    if (pkg.includes(`"${lib}"`)) stack.libs.push(lib);
  }

  // Projeto dbt: o dbt_project.yml é a âncora (repos dbt puros nem sempre têm requirements.txt).
  if (has("dbt_project.yml")) {
    if (!stack.libs.includes("dbt")) stack.libs.unshift("dbt");
    if (!stack.language) stack.language = "SQL (projeto dbt)";
  }

  return stack;
}

// Renderiza o bloco markdown da stack para o prompt / esqueleto do perfil. "" quando nada detectado.
export function renderStackBlock(s: DetectedStack): string {
  const lines: string[] = [];
  if (s.language) lines.push(`- Linguagem: ${s.language}`);
  if (s.packaging) lines.push(`- Pacotes: ${s.packaging}`);
  if (s.lintFormat.length) lines.push(`- Lint/format: ${s.lintFormat.join(", ")}`);
  if (s.types.length) lines.push(`- Tipos: ${s.types.join(", ")}`);
  if (s.tests) lines.push(`- Testes: ${s.tests}`);
  if (s.libs.length) lines.push(`- Libs: ${s.libs.slice(0, 12).join(", ")}`);
  if (lines.length === 0) return "";
  return ["## Stack do projeto (detectada automaticamente)", ...lines].join("\n");
}
