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

test("pytestOutcome: timeout é 'error' (instalar nada resolve), mesmo com exit 1", () => {
  assert.equal(pytestOutcome(1, "coletando…\n[execução interrompida após o tempo limite]"), "error");
});

// Runner AUSENTE = ambiente incompleto acionável ("env-missing"), distinto de erro genérico —
// habilita o botão "Instalar pytest e rodar" no cartão (o pré-flight do host cura). SÓ pelos sinais
// inequívocos: token pytest do "No module named" + exit codes do shell (9009 cmd / 127 sh).
test("pytestOutcome: pytest ausente / comando não reconhecido → 'env-missing'", () => {
  assert.equal(pytestOutcome(1, "ModuleNotFoundError: No module named 'pytest'"), "env-missing");
  assert.equal(pytestOutcome(1, "No module named pytest"), "env-missing");
  // o print real do dev: cmd.exe pt-BR, exit 9009 (o exit code decide — Windows localizado)
  assert.equal(pytestOutcome(9009, "'pytest' não é reconhecido como um comando interno\nou externo…"), "env-missing");
  assert.equal(pytestOutcome(9009, ""), "env-missing");
  assert.equal(pytestOutcome(127, "sh: pytest: command not found"), "env-missing"); // POSIX
});

// REGRESSÃO (revisão adversarial): texto livre "command not found"/"não é reconhecido" NA SAÍDA de
// uma suíte que RODOU (exit 1) é falha real de teste (teste que invoca binário ausente) — não pode
// virar "env-missing" neutro, senão mascara o gate vermelho e o botão de cura vira loop inútil.
test("pytestOutcome: 'command not found' impresso por um TESTE que falhou continua 'failed'", () => {
  assert.equal(pytestOutcome(1, "FAILED test_cli.py — Captured stderr: sh: foo: command not found"), "failed");
  assert.equal(pytestOutcome(0, "test_cli.py::test_msg PASSED — prints 'is not recognized as an internal or external command'"), "passed");
});

test("pytestOutcome: 'No module named' de OUTRO pacote não é erro de ambiente (segue o exit code)", () => {
  assert.equal(pytestOutcome(1, "No module named 'pytest_asyncio'"), "failed");
  assert.equal(pytestOutcome(1, "No module named pytest_cov"), "failed");
});

test("testOutcomeLabel: rótulos legíveis por outcome", () => {
  assert.match(testOutcomeLabel("passed", 0), /verdes/);
  assert.match(testOutcomeLabel("failed", 1), /falharam/);
  assert.match(testOutcomeLabel("no-tests", 5), /nenhum teste/);
  assert.match(testOutcomeLabel("env-missing", 9009), /pytest ausente/);
  assert.match(testOutcomeLabel("error", 3), /erro do pytest/);
});
