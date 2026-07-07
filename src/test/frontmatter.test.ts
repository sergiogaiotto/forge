import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafeRelPath, parseSkill } from "../skills/frontmatter";

const valid = `---
name: pandas-defensive-pipelines
description: >-
  Build pandas pipelines. Use whenever the user works with DataFrames.
license: Apache-2.0
validators:
  - id: ruff
    label: ruff
    command: "ruff check {file}"
    gate: true
    appliesTo: [".py"]
---
# Body
Step 1.`;

test("valid skill parses with validators", () => {
  const r = parseSkill(valid, "pandas-defensive-pipelines");
  assert.equal(r.ok, true);
  assert.equal(r.parsed?.frontmatter.name, "pandas-defensive-pipelines");
  assert.equal(r.parsed?.frontmatter.validators?.length, 1);
  assert.equal(r.parsed?.frontmatter.validators?.[0].gate, true);
  assert.match(r.parsed?.body ?? "", /# Body/);
});

test("name must equal directory name", () => {
  const r = parseSkill(valid, "wrong-dir");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "name"));
});

test("missing description is rejected", () => {
  const r = parseSkill(`---\nname: foo\n---\nbody`, "foo");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "description"));
});

test("angle brackets in frontmatter are rejected", () => {
  const bad = `---\nname: foo\ndescription: "has <script> tag"\n---\nbody`;
  const r = parseSkill(bad, "foo");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "frontmatter"));
});

test("invalid name characters are rejected", () => {
  const r = parseSkill(`---\nname: Foo_Bar\ndescription: ok desc\n---\nx`, "Foo_Bar");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "name"));
});

test("missing frontmatter is rejected", () => {
  const r = parseSkill(`# just markdown`, "foo");
  assert.equal(r.ok, false);
});

// ---- P2: templates no frontmatter ----

test("templates válidos parseiam (src/dest relativos seguros)", () => {
  const src = `---
name: foo
description: ok desc
templates:
  - src: templates/dbt_project.yml.tmpl
    dest: dbt_project.yml
  - src: templates/gitignore.tmpl
    dest: .gitignore
---
body`;
  const r = parseSkill(src, "foo");
  assert.equal(r.ok, true);
  assert.equal(r.parsed?.frontmatter.templates?.length, 2);
  assert.deepEqual(r.parsed?.frontmatter.templates?.[0], { src: "templates/dbt_project.yml.tmpl", dest: "dbt_project.yml" });
});

test("template com dest ABSOLUTO ou traversal é rejeitado", () => {
  const abs = parseSkill(`---\nname: foo\ndescription: ok desc\ntemplates:\n  - src: t/x.tmpl\n    dest: /etc/passwd\n---\nb`, "foo");
  assert.equal(abs.ok, false);
  assert.ok(abs.errors.some((e) => e.field.startsWith("templates")));
  const trav = parseSkill(`---\nname: foo\ndescription: ok desc\ntemplates:\n  - src: ../../secret.tmpl\n    dest: x.yml\n---\nb`, "foo");
  assert.equal(trav.ok, false);
  assert.ok(trav.errors.some((e) => e.field.startsWith("templates")));
});

test("template sem src/dest é rejeitado; ausência de templates → []", () => {
  const bad = parseSkill(`---\nname: foo\ndescription: ok desc\ntemplates:\n  - src: t/x.tmpl\n---\nb`, "foo");
  assert.equal(bad.ok, false);
  const none = parseSkill(`---\nname: foo\ndescription: ok desc\n---\nb`, "foo");
  assert.equal(none.ok, true);
  assert.deepEqual(none.parsed?.frontmatter.templates, []);
});

test("isSafeRelPath: relativo aceito; absoluto/drive/traversal/vazio rejeitados", () => {
  assert.equal(isSafeRelPath("templates/x.tmpl"), true);
  assert.equal(isSafeRelPath("a/b/c.yml"), true);
  assert.equal(isSafeRelPath("/etc/passwd"), false);
  assert.equal(isSafeRelPath("C:\\Windows\\x"), false);
  assert.equal(isSafeRelPath("../x"), false);
  assert.equal(isSafeRelPath("a/../../x"), false);
  assert.equal(isSafeRelPath("  "), false);
  assert.equal(isSafeRelPath(""), false);
});
