import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRole, parseRole, resolveRole, roleGuidance, setRole, stripFrontmatter } from "../util/roleDefaults";

test("normalizeRole reconhece variações e desambigua ML vs dados", () => {
  assert.equal(normalizeRole("engenheiro de dados"), "engenheiro-de-dados");
  assert.equal(normalizeRole("data engineer"), "engenheiro-de-dados");
  assert.equal(normalizeRole("engenheiro de ml"), "engenheiro-de-ml");
  assert.equal(normalizeRole("cientista de dados"), "cientista-de-dados");
  assert.equal(normalizeRole("software engineer"), "engenheiro-de-software");
  assert.equal(normalizeRole("xpto"), undefined);
  assert.equal(normalizeRole(""), undefined);
});

test("normalizeRole reconhece Engenheiro de IA e não confunde com ML/dados", () => {
  assert.equal(normalizeRole("engenheiro de ia"), "engenheiro-de-ia");
  assert.equal(normalizeRole("engenheiro-de-ia"), "engenheiro-de-ia");
  assert.equal(normalizeRole("ai engineer"), "engenheiro-de-ia");
  assert.equal(normalizeRole("inteligência artificial"), "engenheiro-de-ia");
  assert.equal(normalizeRole("GenAI"), "engenheiro-de-ia");
  // não deve capturar ML nem dados
  assert.equal(normalizeRole("engenheiro de ml"), "engenheiro-de-ml");
  assert.equal(normalizeRole("engenheiro de dados"), "engenheiro-de-dados");
});

test("REGRESSÃO: menção solta de llm/genai não sequestra cargo explícito (revisão PR-A)", () => {
  assert.equal(normalizeRole("engenheiro de dados usando llm"), "engenheiro-de-dados");
  assert.equal(normalizeRole("engenheiro de ml com genai"), "engenheiro-de-ml");
  assert.equal(normalizeRole("engenheiro de software com llm"), "engenheiro-de-software");
  // sem cargo explícito, a menção de tecnologia classifica como Eng. de IA
  assert.equal(normalizeRole("llm ops"), "engenheiro-de-ia");
});

test("roleGuidance de Engenheiro de IA foca em LLM/RAG/evals/guardrails", () => {
  const g = roleGuidance("engenheiro-de-ia");
  assert.match(g, /## Papel e padrões/);
  assert.match(g, /LLM|GenAI/);
  assert.match(g, /RAG/);
  assert.match(g, /eval/i);
});

test("parseRole lê o papel do frontmatter (e ignora ausência)", () => {
  const text = ["---", "papel: engenheiro-de-dados", "---", "", "## Regras do projeto"].join("\n");
  assert.equal(parseRole(text), "engenheiro-de-dados");
  assert.equal(parseRole("# Sem frontmatter\n## Regras"), undefined);
});

test("roleGuidance expande o papel e é vazio para indefinido", () => {
  const g = roleGuidance("engenheiro-de-dados");
  assert.match(g, /## Papel e padrões/);
  assert.match(g, /idempotentes/);
  assert.equal(roleGuidance(undefined), "");
});

test("setRole cria frontmatter quando ausente, preservando o corpo", () => {
  const out = setRole("# Perfil\n\n## Regras do projeto\n- x", "cientista-de-dados");
  assert.match(out, /^---\npapel: cientista-de-dados\n---/);
  assert.match(out, /## Regras do projeto/);
  assert.equal(parseRole(out), "cientista-de-dados");
});

test("setRole atualiza o papel existente sem duplicar", () => {
  const base = setRole("# Perfil", "cientista-de-dados");
  const updated = setRole(base, "engenheiro-de-ml");
  assert.equal(parseRole(updated), "engenheiro-de-ml");
  assert.equal((updated.match(/papel:/g) ?? []).length, 1);
});

test("stripFrontmatter remove o bloco inicial e mantém o corpo", () => {
  const text = ["---", "papel: x", "---", "", "corpo aqui"].join("\n");
  assert.equal(stripFrontmatter(text), "corpo aqui");
  assert.equal(stripFrontmatter("sem fm"), "sem fm");
});

// ---- regressões da revisão adversarial --------------------------------------

test("setRole não corrompe frontmatter com tokens $&, $`, $', $$ do dev", () => {
  const nota = "nota: valor com $& e $` e $' e $$";
  const base = ["---", nota, "---", "", "corpo"].join("\n");
  const out = setRole(base, "engenheiro-de-ml");
  assert.ok(out.includes(nota), "o campo do dev deve sobreviver literalmente");
  assert.equal(parseRole(out), "engenheiro-de-ml");
  assert.ok(out.includes("corpo"));
});

test("setRole em frontmatter vazio (só linhas em branco) preserva as cercas", () => {
  const out = setRole("---\n\n---\nbody", "engenheiro-de-dados");
  assert.match(out, /^---\npapel: engenheiro-de-dados\n---/);
  assert.equal(parseRole(out), "engenheiro-de-dados");
  assert.equal(stripFrontmatter(out), "body");
});

test("setRole preserva CRLF ao anexar papel (sem quebras mistas)", () => {
  const out = setRole("---\r\nstack: python\r\n---\r\nCorpo\r\n", "engenheiro-de-ml");
  assert.ok(!/[^\r]\n/.test(out), "não deve haver LF solto entre conteúdo CRLF");
  assert.equal(parseRole(out), "engenheiro-de-ml");
});

test("parseRole ignora 'papel:' no corpo (só frontmatter)", () => {
  const text = ["---", "stack: python", "---", "", "## Notas", "papel: cientista de dados decide as métricas"].join("\n");
  assert.equal(parseRole(text), undefined);
});

test("resolveRole: o papel do workspace (último) vence o do usuário", () => {
  const user = ["---", "papel: cientista-de-dados", "---", "", "global"].join("\n");
  const ws = ["---", "papel: engenheiro-de-software", "---", "", "projeto"].join("\n");
  assert.equal(resolveRole([user, ws]), "engenheiro-de-software");
  assert.equal(resolveRole([user]), "cientista-de-dados");
  assert.equal(resolveRole([]), undefined);
});

test("resolveRole: 3 camadas admin → usuário → workspace (workspace vence; admin é fallback)", () => {
  const admin = ["---", "papel: engenheiro-de-dados", "---", "", "padrões da org"].join("\n");
  const userSemPapel = ["---", "stack: nota", "---", "", "global"].join("\n");
  const ws = ["---", "papel: engenheiro-de-ml", "---", "", "projeto"].join("\n");
  assert.equal(resolveRole([admin, userSemPapel, ws]), "engenheiro-de-ml");
  assert.equal(resolveRole([admin, userSemPapel]), "engenheiro-de-dados"); // admin como fallback
});
