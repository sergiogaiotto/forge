import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
  buildMypyInstall,
  buildPytestInstall,
  buildPytestProbe,
  buildVenvSetupCommand,
  chooseTestCommand,
  findVenvPython,
  isPytestCommand,
  resolvePythonRunCommand,
  resolveTestCommand,
  venvPythonCandidates,
} from "../util/pythonEnv";

test("isPytestCommand: pytest nu e python -m pytest; wrappers/npm ficam de fora", () => {
  assert.ok(isPytestCommand("pytest -q"));
  assert.ok(isPytestCommand("python -m pytest tests/"));
  assert.ok(isPytestCommand("python3 -m pytest"));
  assert.ok(!isPytestCommand("poetry run pytest"));
  assert.ok(!isPytestCommand("npm test"));
  assert.ok(!isPytestCommand("uv run pytest"));
});

test("chooseTestCommand: default + stack Node + script test real → npm test; senão pytest fica", () => {
  assert.equal(chooseTestCommand("pytest -q", "pytest -q", "vitest", true), "npm test");
  assert.equal(chooseTestCommand("pytest -q", "pytest -q", "jest", true), "npm test");
  // REGRESSÃO: vitest detectado mas SEM scripts.test → npm test falharia com "Missing script"
  assert.equal(chooseTestCommand("pytest -q", "pytest -q", "vitest", false), "pytest -q");
  assert.equal(chooseTestCommand("pytest -q", "pytest -q", "pytest", true), "pytest -q");
  assert.equal(chooseTestCommand("pytest -q", "pytest -q", undefined, true), "pytest -q");
  assert.equal(chooseTestCommand("pytest tests/ -x", "pytest -q", "vitest", true), "pytest tests/ -x"); // override
});

test("buildPytestProbe: proba o ambiente onde os testes VÃO RODAR (venv → módulo; sem venv → binário do PATH)", () => {
  assert.equal(buildPytestProbe("C:/p/.venv/Scripts/python.exe"), "C:/p/.venv/Scripts/python.exe -m pytest --version");
  // REGRESSÃO: sem venv o comando real é `pytest` do PATH (pipx/scoop) — probar `python -m pytest`
  // divergia e declarava falso "ausente" num setup que funcionava.
  assert.equal(buildPytestProbe(undefined), "pytest --version");
  // caminho com espaço → aspas
  assert.equal(buildPytestProbe("C:/meu proj/.venv/Scripts/python.exe"), '"C:/meu proj/.venv/Scripts/python.exe" -m pytest --version');
});

test("buildPytestInstall: instala no venv EXISTENTE (o caso sem venv passa antes pelo prepareEnv)", () => {
  assert.equal(buildPytestInstall("C:/p/.venv/Scripts/python.exe"), "C:/p/.venv/Scripts/python.exe -m pip install pytest");
  assert.equal(buildPytestInstall("C:/meu proj/.venv/Scripts/python.exe"), '"C:/meu proj/.venv/Scripts/python.exe" -m pip install pytest');
});

test("buildMypyInstall: instala mypy no venv do gate (aspas em caminho com espaço)", () => {
  assert.equal(buildMypyInstall("C:/p/.venv/Scripts/python.exe"), "C:/p/.venv/Scripts/python.exe -m pip install mypy");
  assert.equal(buildMypyInstall("C:/meu proj/.venv/Scripts/python.exe"), '"C:/meu proj/.venv/Scripts/python.exe" -m pip install mypy');
});

// REGRESSÃO (print do dev: ModuleNotFoundError com venv preparado): o "Executar" rodava o python do
// PATH. O rewrite troca `python`/`python3` NU pelo interpretador do venv; caminhos/execs próprios passam.
test("resolvePythonRunCommand: troca python nu pelo venv; respeita caminho absoluto e outros executáveis", () => {
  const venv = "C:/proj/.venv/Scripts/python.exe";
  assert.equal(resolvePythonRunCommand('python "C:/proj/app.py"', venv), `${venv} "C:/proj/app.py"`);
  assert.equal(resolvePythonRunCommand("python3 app.py", venv), `${venv} app.py`);
  // interpretador com caminho explícito → o admin escolheu; não mexe
  assert.equal(resolvePythonRunCommand("/usr/bin/python3 app.py", venv), "/usr/bin/python3 app.py");
  // outros executáveis (node, bash) → intactos
  assert.equal(resolvePythonRunCommand("node app.js", venv), "node app.js");
  // sem venv → intacto
  assert.equal(resolvePythonRunCommand("python app.py", undefined), "python app.py");
  // venv com espaço no caminho → aspas (RunService força spawn nesse caso)
  assert.equal(resolvePythonRunCommand("python app.py", "C:/meu proj/.venv/Scripts/python.exe"), '"C:/meu proj/.venv/Scripts/python.exe" app.py');
  // REGRESSÃO (revisão adversarial): interpretador VERSIONADO/suffixado não pode ser corrompido
  // (`python3.11` virava `<venv>.exe.11` com \b) — é escolha do admin, passa intacto.
  assert.equal(resolvePythonRunCommand("python3.11 app.py", venv), "python3.11 app.py");
  assert.equal(resolvePythonRunCommand("python3.12 app.py", venv), "python3.12 app.py");
  assert.equal(resolvePythonRunCommand("python-config app.py", venv), "python-config app.py");
  assert.equal(resolvePythonRunCommand("pythonw app.py", venv), "pythonw app.py");
});

test("venvPythonCandidates: caminhos por SO (.venv/venv/.env)", () => {
  const win = venvPythonCandidates("C:/proj", true);
  assert.ok(win[0].endsWith("python.exe"));
  assert.ok(win.some((p) => p.includes(".venv") && p.includes("Scripts")));
  const posix = venvPythonCandidates("/proj", false);
  assert.ok(posix.some((p) => p.includes(".venv") && p.includes("bin")));
});

test("findVenvPython: acha o primeiro venv existente", () => {
  const target = path.join("/proj", ".venv", "bin", "python");
  const existing = new Set([target]);
  const p = findVenvPython("/proj", false, (x) => existing.has(x));
  assert.equal(p, target);
});

test("findVenvPython: VIRTUAL_ENV tem prioridade sobre .venv da pasta", () => {
  const active = path.join("/other/env", "bin", "python");
  const existing = new Set([active, path.join("/proj", ".venv", "bin", "python")]);
  const p = findVenvPython("/proj", false, (x) => existing.has(x), "/other/env");
  assert.equal(p, active);
});

test("findVenvPython: sem venv retorna undefined", () => {
  assert.equal(findVenvPython("/proj", false, () => false), undefined);
});

test("resolveTestCommand: 'pytest -q' vira '<venv> -m pytest -q' quando há venv", () => {
  assert.equal(resolveTestCommand("pytest -q", "/proj/.venv/bin/python"), "/proj/.venv/bin/python -m pytest -q");
  // caminho com espaço é citado
  assert.equal(resolveTestCommand("pytest", 'C:/meus projetos/.venv/Scripts/python.exe'), '"C:/meus projetos/.venv/Scripts/python.exe" -m pytest');
});

test("resolveTestCommand: comando custom (não-pytest) é respeitado; sem venv devolve original", () => {
  assert.equal(resolveTestCommand("npm test", "/proj/.venv/bin/python"), "npm test");
  assert.equal(resolveTestCommand("pytest -q", undefined), "pytest -q");
});

test("resolveTestCommand: 'python -m pytest' (nome nu) também recebe o venv; caminho/wrapper respeitados", () => {
  assert.equal(resolveTestCommand("python -m pytest -q", "/proj/.venv/bin/python"), "/proj/.venv/bin/python -m pytest -q");
  assert.equal(resolveTestCommand("python3 -m pytest", "/v/bin/python"), "/v/bin/python -m pytest");
  // python com CAMINHO absoluto → o admin escolheu; respeitar
  assert.equal(resolveTestCommand("/usr/bin/python3 -m pytest", "/v/bin/python"), "/usr/bin/python3 -m pytest");
  // wrapper que já resolve o ambiente → respeitar
  assert.equal(resolveTestCommand("poetry run pytest", "/v/bin/python"), "poetry run pytest");
});

test("buildVenvSetupCommand: cria .venv e instala quando não há venv (encadeia com &&)", () => {
  const win = buildVenvSetupCommand({ isWindows: true, venvPython: undefined, install: "requirements" });
  assert.match(win, /python -m venv \.venv/);
  assert.match(win, /&&/);
  assert.match(win, /\.venv\\Scripts\\python -m pip install -r requirements\.txt/);
  const posix = buildVenvSetupCommand({ isWindows: false, venvPython: undefined, install: "editable" });
  assert.match(posix, /python3 -m venv \.venv/);
  assert.match(posix, /\.venv\/bin\/python -m pip install -e \./);
});

test("buildVenvSetupCommand: pyproject só-de-ferramentas (install='none') só cria o venv — NÃO usa -e .", () => {
  const cmd = buildVenvSetupCommand({ isWindows: false, venvPython: undefined, install: "none" });
  assert.match(cmd, /python3 -m venv \.venv && \.venv\/bin\/python -m pip install --upgrade pip$/);
  assert.ok(!cmd.includes("-e ."), "não deve tentar editable install");
  assert.ok(!cmd.includes("requirements"), "não deve instalar requirements inexistente");
});

test("buildVenvSetupCommand: com venv existente, só instala (sem recriar) e cita caminho com espaço", () => {
  const cmd = buildVenvSetupCommand({ isWindows: true, venvPython: "C:/meus projetos/.venv/Scripts/python.exe", install: "requirements" });
  assert.ok(!cmd.includes("venv .venv"), "não deve recriar o venv");
  assert.match(cmd, /^"C:\/meus projetos\/\.venv\/Scripts\/python\.exe" -m pip install --upgrade pip && "C:\/meus projetos\/\.venv\/Scripts\/python\.exe" -m pip install -r requirements\.txt$/);
});
