import assert from "node:assert/strict";
import { test } from "node:test";
import { lexicalScore, SkillSelector } from "../skills/SkillSelector";
import { SkillMeta } from "../skills/types";

function skill(name: string, description: string, enabled = true): SkillMeta {
  return { name, description, path: `/skills/${name}`, source: "managed", enabled, validators: [], templates: [] };
}

const skills: SkillMeta[] = [
  skill("pandas-defensive-pipelines", "Build pandas DataFrame cleaning pipelines with nulls and dtypes"),
  skill("sql-dialect-aware", "Write dialect-aware SQL queries with window functions"),
  skill("pytorch-training", "PyTorch training loops, DataLoaders and checkpoints"),
  skill("airflow-dags", "Author Airflow DAGs with idempotent tasks and scheduling"),
];

test("below threshold returns all enabled skills", () => {
  const sel = new SkillSelector({ retrievalThreshold: 15, topK: 2, activationThreshold: 1, maxActivations: 3 });
  const out = sel.selectForDiscovery(skills, "limpar dataframe pandas");
  assert.equal(out.length, 4);
});

test("disabled skills are excluded from discovery", () => {
  const withDisabled = [...skills, skill("disabled-one", "irrelevant thing", false)];
  const sel = new SkillSelector({ retrievalThreshold: 15, topK: 8, activationThreshold: 1, maxActivations: 3 });
  const out = sel.selectForDiscovery(withDisabled, "pandas");
  assert.ok(!out.find((s) => s.name === "disabled-one"));
});

test("above threshold selects top-K by relevance", () => {
  const sel = new SkillSelector({ retrievalThreshold: 2, topK: 1, activationThreshold: 1, maxActivations: 3 });
  const out = sel.selectForDiscovery(skills, "clean a pandas dataframe with nulls");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "pandas-defensive-pipelines");
});

test("activation picks the matching skill above threshold", () => {
  const sel = new SkillSelector({ retrievalThreshold: 15, topK: 8, activationThreshold: 1.0, maxActivations: 1 });
  const discovery = sel.selectForDiscovery(skills, "write a SQL query with window functions");
  const activated = sel.selectForActivation(discovery, "write a SQL query with window functions");
  assert.equal(activated[0]?.name, "sql-dialect-aware");
});

test("lexicalScore ranks the right skill highest", () => {
  const pandasScore = lexicalScore("clean pandas dataframe nulls", skills[0]);
  const sqlScore = lexicalScore("clean pandas dataframe nulls", skills[1]);
  assert.ok(pandasScore > sqlScore);
});
