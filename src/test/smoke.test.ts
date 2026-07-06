import assert from "node:assert/strict";
import { test } from "node:test";
import { ValidatorResult } from "../shared/protocol";
import { summarizeSmoke } from "../util/smoke";

const res = (status: ValidatorResult["status"], output = "", reason?: string): ValidatorResult => ({
  id: "smoke:pytest",
  label: "pytest (smoke)",
  status,
  gate: false,
  output,
  reason,
});

test("summarizeSmoke: testes passaram → info, ran, com a contagem", () => {
  const v = summarizeSmoke(res("ok", "===== 3 passed in 0.12s ====="));
  assert.equal(v.level, "info");
  assert.equal(v.ran, true);
  assert.match(v.message, /3 teste/);
  assert.match(v.message, /PASSARAM/);
});

test("summarizeSmoke: testes falharam → warn, ran, com a contagem", () => {
  const v = summarizeSmoke(res("failed", "===== 2 failed, 1 passed in 0.3s ====="));
  assert.equal(v.level, "warn");
  assert.equal(v.ran, true);
  assert.match(v.message, /2 teste/);
  assert.match(v.message, /FALHARAM/);
  assert.match(v.message, /não bloqueia/i); // deixa claro que é advisory
});

test("summarizeSmoke: pytest não instalado → advisory info, NÃO ran, NÃO 'falhou'", () => {
  const v = summarizeSmoke(res("failed", "/venv/bin/python: No module named pytest"));
  assert.equal(v.level, "info");
  assert.equal(v.ran, false);
  assert.match(v.message, /pytest não está instalado|Preparar ambiente/i);
});

test("summarizeSmoke: dependência de terceiros ausente → advisory info (ambiente, não defeito)", () => {
  const v = summarizeSmoke(res("failed", "E   ModuleNotFoundError: No module named 'fastapi'"));
  assert.equal(v.level, "info");
  assert.equal(v.ran, false);
  assert.match(v.message, /dependências não instaladas|Preparar ambiente/i);
});

test("summarizeSmoke: nenhum teste coletado → info neutro, NÃO ran", () => {
  const v = summarizeSmoke(res("failed", "no tests ran in 0.01s"));
  assert.equal(v.level, "info");
  assert.equal(v.ran, false);
  assert.match(v.message, /nenhum teste/i);
});

test("summarizeSmoke: pytest ausente (ENOENT → skipped) → info pulado, NÃO ran", () => {
  const v = summarizeSmoke(res("skipped", "", "ferramenta não disponível no PATH"));
  assert.equal(v.level, "info");
  assert.equal(v.ran, false);
  assert.match(v.message, /Python indispon[íi]vel|pulado/i);
});

test("summarizeSmoke: timeout (skipped) → info inconclusivo", () => {
  const v = summarizeSmoke(res("skipped", "", "tempo esgotado (inconclusivo)"));
  assert.equal(v.level, "info");
  assert.equal(v.ran, false);
  assert.match(v.message, /tempo esgotado|inconclusivo/i);
});

// 'pytest' aparece antes do ModuleNotFound genérico: 'No module named pytest' cai no ramo específico.
test("summarizeSmoke: 'No module named pytest' vai para o ramo do pytest, não o genérico", () => {
  const v = summarizeSmoke(res("failed", "ModuleNotFoundError: No module named 'pytest'"));
  assert.match(v.message, /pytest não está instalado/i);
});

// REGRESSÃO (revisão adversarial): status decide PRIMEIRO. Um teste que PASSOU mas cujo output menciona
// "ImportError" NÃO pode ser reclassificado como "dep ausente" — status ok é passou, ponto.
test("summarizeSmoke: suíte que PASSOU mas loga 'ImportError' → PASSARAM (não 'dep ausente')", () => {
  const v = summarizeSmoke(res("ok", "test_handles_importerror PASSED\ncaught ImportError ok\n1 passed in 0.1s"));
  assert.equal(v.level, "info");
  assert.equal(v.ran, true);
  assert.match(v.message, /PASSARAM/);
});

// REGRESSÃO: um teste que FALHOU de verdade cujo traceback menciona ImportError é FALHA (warn), não
// advisory de ambiente — o resumo "N failed" decide antes do ramo ModuleNotFound.
test("summarizeSmoke: teste que FALHOU com ImportError no traceback → FALHARAM (warn), não ambiente", () => {
  const v = summarizeSmoke(res("failed", "E   ImportError: cannot import name 'X'\n===== 1 failed in 0.2s ====="));
  assert.equal(v.level, "warn");
  assert.equal(v.ran, true);
  assert.match(v.message, /FALHARAM/);
});
