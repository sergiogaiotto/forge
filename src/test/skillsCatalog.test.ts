import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { parseSkill } from "../skills/frontmatter";

const SKILLS_DIR = path.join(__dirname, "..", "..", "skills");

test("every bundled skill in skills/ parses and name matches its directory", () => {
  const dirs = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  assert.ok(dirs.length >= 10, `esperava ≥10 skills empacotadas, achei ${dirs.length}`);

  for (const dir of dirs) {
    const file = path.join(SKILLS_DIR, dir, "SKILL.md");
    assert.ok(fs.existsSync(file), `SKILL.md ausente em ${dir}`);
    const result = parseSkill(fs.readFileSync(file, "utf8"), dir);
    assert.ok(result.ok, `skill ${dir} inválida: ${result.errors.map((e) => e.field + ":" + e.message).join("; ")}`);
    assert.equal(result.parsed?.frontmatter.name, dir);
    assert.ok((result.parsed?.frontmatter.description.length ?? 0) > 0);
    // P2: todo template DECLARADO deve ter o arquivo `src` no disco (senão o loadAsset falharia em runtime).
    for (const t of result.parsed?.frontmatter.templates ?? []) {
      assert.ok(fs.existsSync(path.join(SKILLS_DIR, dir, t.src)), `template src ausente: ${dir}/${t.src}`);
    }
  }
});

test("dbt-modeling declara os templates de scaffold (dbt_project.yml + .gitignore)", () => {
  const r = parseSkill(fs.readFileSync(path.join(SKILLS_DIR, "dbt-modeling", "SKILL.md"), "utf8"), "dbt-modeling");
  assert.ok(r.ok);
  const dests = (r.parsed?.frontmatter.templates ?? []).map((t) => t.dest);
  assert.deepEqual(dests.sort(), [".gitignore", "dbt_project.yml"]);
});
