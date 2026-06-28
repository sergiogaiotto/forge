import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkill } from "../skills/frontmatter";

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
