import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextAssembler } from "../skills/ContextAssembler";
import { appendRule, normalizeRule, renderProfileBlock } from "../util/projectProfile";

test("appendRule cria a seção e o bullet a partir do vazio", () => {
  const out = appendRule("", "nunca use emojis");
  assert.match(out, /## Regras do projeto/);
  assert.match(out, /- nunca use emojis/);
});

test("appendRule é idempotente (case-insensitive)", () => {
  const base = appendRule("", "nunca use emojis");
  const again = appendRule(base, "Nunca Use Emojis");
  assert.equal(again, base);
});

test("appendRule insere sob a seção existente, preservando as demais regras", () => {
  const existing = "## Regras do projeto\n- regra antiga\n";
  const out = appendRule(existing, "regra nova");
  assert.match(out, /- regra nova/);
  assert.match(out, /- regra antiga/);
});

test("appendRule anexa a seção quando ela não existe, sem apagar o conteúdo", () => {
  const existing = "# Perfil\n\nalgum texto";
  const out = appendRule(existing, "regra X");
  assert.match(out, /algum texto/);
  assert.match(out, /## Regras do projeto\n- regra X/);
});

test("normalizeRule tira o bullet, colapsa espaços e limita o tamanho", () => {
  assert.equal(normalizeRule("-   sempre   usar  utf-8 "), "sempre usar utf-8");
  assert.equal(normalizeRule("x".repeat(500)).length, 300);
});

test("renderProfileBlock é vazio para texto vazio e trima", () => {
  assert.equal(renderProfileBlock(""), "");
  assert.equal(renderProfileBlock("  abc  "), "abc");
});

test("ContextAssembler injeta o perfil logo após o base e antes das skills", () => {
  const a = new ContextAssembler();
  const out = a.assemble({
    basePrompt: "BASE",
    projectProfile: "## Regras do projeto\n- nunca use emojis",
    discoverySkills: [{ name: "s1", description: "desc" } as any],
    activatedSkills: [],
    retrievedContext: "",
    history: [],
    query: "oi",
  });
  assert.match(out.systemPrompt, /# Perfil do projeto/);
  assert.match(out.systemPrompt, /nunca use emojis/);
  assert.ok(out.systemPrompt.indexOf("# Perfil do projeto") < out.systemPrompt.indexOf("Skills disponíveis"));
});

test("ContextAssembler omite o perfil quando vazio", () => {
  const a = new ContextAssembler();
  const out = a.assemble({
    basePrompt: "BASE",
    projectProfile: "",
    discoverySkills: [],
    activatedSkills: [],
    retrievedContext: "",
    history: [],
    query: "oi",
  });
  assert.ok(!out.systemPrompt.includes("# Perfil do projeto"));
});
