import assert from "node:assert/strict";
import { test } from "node:test";
import { appendRule, collectRules, parseRules } from "../util/projectProfile";
import { roleLabel } from "../util/roleDefaults";

test("parseRules extrai os bullets da seção de regras", () => {
  const text = [
    "# Perfil",
    "",
    "## Regras do projeto",
    "- nunca use emojis",
    "- I/O em utf-8",
    "",
    "## Outra seção",
    "- isto não conta",
  ].join("\n");
  assert.deepEqual(parseRules(text), ["nunca use emojis", "I/O em utf-8"]);
});

test("parseRules é vazio quando não há seção de regras", () => {
  assert.deepEqual(parseRules("# Perfil\n\nsem regras"), []);
  assert.deepEqual(parseRules(""), []);
});

test("parseRules casa com o que appendRule grava", () => {
  let doc = appendRule("", "primeira regra");
  doc = appendRule(doc, "segunda regra");
  assert.deepEqual(parseRules(doc).sort(), ["primeira regra", "segunda regra"]);
});

test("collectRules agrega regras de VÁRIOS documentos e deduplica (case-insensitive)", () => {
  const userDoc = ["## Regras do projeto", "- regra comum", "- só do usuário"].join("\n");
  const wsDoc = ["# Perfil", "", "## Regras do projeto", "- regra do workspace", "- Regra Comum"].join("\n");
  // sem perder as regras do workspace (que parseRules sozinho descartaria no blob mesclado)
  assert.deepEqual(collectRules([userDoc, wsDoc]), ["regra comum", "só do usuário", "regra do workspace"]);
});

test("roleLabel devolve o rótulo legível", () => {
  assert.equal(roleLabel("engenheiro-de-dados"), "Engenheiro de dados");
  assert.equal(roleLabel("engenheiro-de-ml"), "Engenheiro de ML");
});
