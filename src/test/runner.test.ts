import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RUN_COMMANDS, resolveRunCommand } from "../core/Runner";

test("resolve comando padrão por extensão", () => {
  const r = resolveRunCommand("src/churn.py", {});
  assert.ok("template" in r);
  if ("template" in r) assert.equal(r.template, "python {file}");
});

test("override do usuário tem precedência", () => {
  const r = resolveRunCommand("a.py", { ".py": "python3 {file}" });
  assert.ok("template" in r && r.template === "python3 {file}");
});

test("extensão não executável é pulada", () => {
  const r = resolveRunCommand("query.sql", {});
  assert.ok("skippedReason" in r);
});

test("notebook e node têm comandos padrão", () => {
  assert.ok(DEFAULT_RUN_COMMANDS[".ipynb"].includes("nbconvert"));
  assert.deepEqual(resolveRunCommand("app.js", {}), { template: "node {file}" });
});
