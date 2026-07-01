import assert from "node:assert/strict";
import { test } from "node:test";
import { pytestOutcome, testOutcomeLabel } from "../util/testOutcome";

test("pytestOutcome: mapeia os exit codes do pytest (0/1/5/erro)", () => {
  assert.equal(pytestOutcome(0, ""), "passed");
  assert.equal(pytestOutcome(1, ""), "failed");
  assert.equal(pytestOutcome(5, ""), "no-tests"); // nenhum teste coletado (não é falha)
  assert.equal(pytestOutcome(2, ""), "error");
  assert.equal(pytestOutcome(3, ""), "error");
  assert.equal(pytestOutcome(null, ""), "error");
});

test("pytestOutcome: timeout e pytest ausente são 'error' (não 'failed'), mesmo com exit 1", () => {
  assert.equal(pytestOutcome(1, "coletando…\n[execução interrompida após o tempo limite]"), "error");
  assert.equal(pytestOutcome(1, "ModuleNotFoundError: No module named 'pytest'"), "error");
  assert.equal(pytestOutcome(1, "No module named pytest"), "error");
});

test("pytestOutcome: 'No module named' de OUTRO pacote não é erro de ambiente (segue o exit code)", () => {
  assert.equal(pytestOutcome(1, "No module named 'pytest_asyncio'"), "failed");
  assert.equal(pytestOutcome(1, "No module named pytest_cov"), "failed");
});

test("testOutcomeLabel: rótulos legíveis por outcome", () => {
  assert.match(testOutcomeLabel("passed", 0), /verdes/);
  assert.match(testOutcomeLabel("failed", 1), /falharam/);
  assert.match(testOutcomeLabel("no-tests", 5), /nenhum teste/);
  assert.match(testOutcomeLabel("error", 3), /erro do pytest/);
});
