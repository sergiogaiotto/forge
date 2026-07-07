import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as yaml from "js-yaml";
import { interpolateTemplate, planTemplateFiles, toIdentifierSlug } from "../skills/templates";

// normalizador de teste que espelha o normGatePath (barras pra frente, sem ./ inicial nem / final).
const norm = (p: string) => (p ?? "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();

test("interpolateTemplate: substitui {{chave}} (com espaços) do whitelist; desconhecida fica INTACTA", () => {
  const vars = { projectName: "meu_dw", language: "python" };
  assert.equal(interpolateTemplate("name: '{{projectName}}'", vars), "name: 'meu_dw'");
  assert.equal(interpolateTemplate("x {{ projectName }} y", vars), "x meu_dw y");
  assert.equal(interpolateTemplate("{{language}}/{{projectName}}", vars), "python/meu_dw");
  // chave ausente das vars → não some, não quebra
  assert.equal(interpolateTemplate("{{unknown}} e {{projectName}}", vars), "{{unknown}} e meu_dw");
  assert.equal(interpolateTemplate("sem placeholder", vars), "sem placeholder");
});

test("planTemplateFiles: interpola conteúdo E dest, normaliza o dest", () => {
  const plan = planTemplateFiles(
    [{ spec: { src: "t/p.yml.tmpl", dest: "./{{projectName}}.yml" }, raw: "name: {{projectName}}" }],
    { projectName: "dw" },
    new Set(),
    norm
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].dest, "dw.yml"); // ./  removido pela normalização
  assert.equal(plan[0].content, "name: dw");
  assert.equal(plan[0].status, "materialize");
});

test("planTemplateFiles: GAP-FILL — dest já proposto (LLM) vira collision, não materializa", () => {
  const plan = planTemplateFiles(
    [{ spec: { src: "t/g.tmpl", dest: "dbt_project.yml" }, raw: "x" }],
    {},
    new Set(["dbt_project.yml"]), // o LLM já propôs este arquivo
    norm
  );
  assert.equal(plan[0].status, "collision");
});

test("planTemplateFiles: dedup entre templates da MESMA passada (2º com mesmo dest → collision)", () => {
  const plan = planTemplateFiles(
    [
      { spec: { src: "a.tmpl", dest: "x.yml" }, raw: "a" },
      { spec: { src: "b.tmpl", dest: "./x.yml" }, raw: "b" }, // mesmo dest após normalização
    ],
    {},
    new Set(),
    norm
  );
  assert.equal(plan[0].status, "materialize");
  assert.equal(plan[1].status, "collision"); // o 1º já reivindicou x.yml
});

test("planTemplateFiles: colisão compara o dest NORMALIZADO (barras/ ./ )", () => {
  const plan = planTemplateFiles(
    [{ spec: { src: "a.tmpl", dest: "sub\\config.yml" }, raw: "a" }],
    {},
    new Set(["sub/config.yml"]), // proposto com barra pra frente
    norm
  );
  assert.equal(plan[0].status, "collision"); // sub\config.yml normaliza para sub/config.yml → colide
});

test("planTemplateFiles: colisão CASE-INSENSITIVE (Windows/macOS, caseFold=true default)", () => {
  // o LLM propôs dbt_project.yml (minúsculo); a skill declara DBT_PROJECT.YML → mesmo arquivo no FS → colide
  const plan = planTemplateFiles([{ spec: { src: "a.tmpl", dest: "DBT_PROJECT.YML" }, raw: "x" }], {}, new Set(["dbt_project.yml"]), norm);
  assert.equal(plan[0].status, "collision");
  // dedup na mesma passada também case-insensitive
  const dup = planTemplateFiles(
    [
      { spec: { src: "a.tmpl", dest: "Config.yml" }, raw: "a" },
      { spec: { src: "b.tmpl", dest: "config.yml" }, raw: "b" },
    ],
    {},
    new Set(),
    norm
  );
  assert.equal(dup[0].status, "materialize");
  assert.equal(dup[1].status, "collision");
});

test("planTemplateFiles: caseFold=false (Linux) — caixa divergente são arquivos DISTINTOS, não colide", () => {
  const plan = planTemplateFiles([{ spec: { src: "a.tmpl", dest: "DBT_PROJECT.YML" }, raw: "x" }], {}, new Set(["dbt_project.yml"]), norm, false);
  assert.equal(plan[0].status, "materialize"); // no Linux DBT_PROJECT.YML ≠ dbt_project.yml → materializa
  const dup = planTemplateFiles(
    [
      { spec: { src: "a.tmpl", dest: "README.md" }, raw: "a" },
      { spec: { src: "b.tmpl", dest: "readme.md" }, raw: "b" },
    ],
    {},
    new Set(),
    norm,
    false
  );
  assert.equal(dup[0].status, "materialize");
  assert.equal(dup[1].status, "materialize"); // distintos no Linux
});

// ---- toIdentifierSlug + validade do template dbt (fix do achado HIGH) ----

test("toIdentifierSlug: deriva identificador ^[a-z_]\\w*$ de nomes de pasta reais", () => {
  assert.equal(toIdentifierSlug("meu_dw"), "meu_dw");
  assert.equal(toIdentifierSlug("my-dw project"), "my_dw_project");
  assert.equal(toIdentifierSlug("Cliente 360 (Prod)"), "cliente_360_prod");
  assert.equal(toIdentifierSlug("analytics.core"), "analytics_core");
  assert.equal(toIdentifierSlug("app #1"), "app_1");
  assert.equal(toIdentifierSlug("quote's"), "quote_s");
  assert.equal(toIdentifierSlug("2fa"), "_2fa"); // não pode começar com dígito
  assert.equal(toIdentifierSlug("a__b"), "a_b"); // colapsa _
  assert.equal(toIdentifierSlug("---"), "forge_project"); // degenerou → fallback
  assert.equal(toIdentifierSlug(""), "forge_project");
  // todo resultado casa a regra de nome do dbt / identificador
  for (const n of ["my-dw project", "Cliente 360 (Prod)", "analytics.core", "app #1", "quote's", "2fa", "", "---"]) {
    assert.match(toIdentifierSlug(n), /^[A-Za-z_]\w*$/);
  }
});

test("template dbt_project.yml REAL com nome de pasta 'sujo' → YAML válido E nome dbt válido", () => {
  const tmpl = fs.readFileSync(path.join(__dirname, "..", "..", "skills", "dbt-modeling", "templates", "dbt_project.yml.tmpl"), "utf8");
  for (const projectName of ["my-dw project", "Cliente 360 (Prod)", "app #1", "quote's", "analytics.core"]) {
    const rendered = interpolateTemplate(tmpl, { projectName, projectSlug: toIdentifierSlug(projectName) });
    const doc = yaml.load(rendered) as Record<string, unknown>; // NÃO lança (era o bug)
    assert.match(String(doc.name), /^[A-Za-z_]\w*$/, `name inválido para "${projectName}": ${doc.name}`);
    assert.equal(doc.profile, doc.name);
    assert.ok((doc.models as Record<string, unknown>)[String(doc.name)], "a chave de models deve casar o name");
  }
});
