import assert from "node:assert/strict";
import { test } from "node:test";
import { appendRule, collectRules, FR_SECTION, getSection, parseRules, PURPOSE_SECTION, setSection } from "../util/projectProfile";
import { roleLabel } from "../util/roleDefaults";

test("getSection/setSection: cria seção ausente preservando frontmatter e outras seções", () => {
  const base = ["---", "papel: engenheiro-de-ia", "---", "", "## Regras do projeto", "- sem emojis"].join("\n");
  const out = setSection(base, PURPOSE_SECTION, "App de gestão de senhas in-network.");
  assert.match(out, /papel: engenheiro-de-ia/); // frontmatter intacto
  assert.match(out, /## Regras do projeto/); // seção existente intacta
  assert.match(out, /## Propósito\n\nApp de gestão de senhas in-network\./);
  assert.equal(getSection(out, PURPOSE_SECTION), "App de gestão de senhas in-network.");
  assert.deepEqual(parseRules(out), ["sem emojis"]); // regras continuam parseáveis
});

test("setSection: substitui o corpo de uma seção existente sem tocar nas demais", () => {
  const base = [PURPOSE_SECTION, "", "velho", "", FR_SECTION, "", "- RF1", "- RF2"].join("\n");
  const out = setSection(base, PURPOSE_SECTION, "novo propósito");
  assert.equal(getSection(out, PURPOSE_SECTION), "novo propósito");
  assert.equal(getSection(out, FR_SECTION), "- RF1\n- RF2"); // FR preservado
  assert.equal((out.match(/## Propósito/g) ?? []).length, 1); // não duplicou
});

test("setSection: corpo vazio remove a seção", () => {
  const base = [PURPOSE_SECTION, "", "algo", "", FR_SECTION, "", "- RF1"].join("\n");
  const out = setSection(base, PURPOSE_SECTION, "   ");
  assert.equal(getSection(out, PURPOSE_SECTION), "");
  assert.ok(!out.includes("## Propósito"));
  assert.equal(getSection(out, FR_SECTION), "- RF1"); // FR intacto
});

test("getSection: ausente retorna vazio; termina no próximo cabeçalho", () => {
  assert.equal(getSection("# x\n\n## A\ncorpo", "## Inexistente"), "");
  assert.equal(getSection("## A\n\nlinha1\nlinha2\n\n## B\noutra", "## A"), "linha1\nlinha2");
});

// ---- regressões da revisão adversarial do PR-B ------------------------------

test("REGRESSÃO: setSection rebaixa '## ' no corpo para '###' (sem partir a seção / perder conteúdo)", () => {
  // o modelo às vezes emite um heading nível-2 no meio do texto — não pode virar fronteira de seção
  const out = setSection("", PURPOSE_SECTION, "Faz X.\n## Subseção falsa\ndetalhe importante");
  // o conteúdo inteiro sobrevive no readback (nada some)
  assert.equal(getSection(out, PURPOSE_SECTION), "Faz X.\n### Subseção falsa\ndetalhe importante");
  // não criou uma seção fantasma nível-2
  assert.equal((out.match(/^## /gm) ?? []).length, 1); // só o "## Propósito"
  // round-trip estável: re-salvar o que foi lido não muda mais nada
  const again = setSection(out, PURPOSE_SECTION, getSection(out, PURPOSE_SECTION));
  assert.equal(getSection(again, PURPOSE_SECTION), getSection(out, PURPOSE_SECTION));
});

test("REGRESSÃO: charter criado do zero respeita a ordem Propósito → Regras (não semeia Regras antes)", () => {
  // simula o loop do saveCharter num project.md inexistente
  let doc = "";
  doc = setSection(doc, PURPOSE_SECTION, "app");
  doc = setSection(doc, "## Regras do projeto", "- r1");
  const iPurpose = doc.indexOf(PURPOSE_SECTION);
  const iRules = doc.indexOf("## Regras do projeto");
  assert.ok(iPurpose >= 0 && iRules >= 0);
  assert.ok(iPurpose < iRules, "Propósito deve vir antes de Regras");
});

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
