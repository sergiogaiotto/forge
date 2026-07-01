import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { findVenvPython, resolveTestCommand, venvPythonCandidates } from "../util/pythonEnv";

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
