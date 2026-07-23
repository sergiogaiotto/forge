import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { parseSkill } from "../skills/frontmatter";
import { DEFAULT_SELECTOR_CONFIG, lexicalScore, SkillSelector } from "../skills/SkillSelector";
import { SkillMeta } from "../skills/types";

const SKILLS_ROOT = path.join(__dirname, "..", "..", "skills");

function loadSkill(name: string): { meta: SkillMeta; body: string } {
  const skillDir = path.join(SKILLS_ROOT, name);
  const parsed = parseSkill(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"), name);
  assert.ok(parsed.ok && parsed.parsed, `${name} deve ter frontmatter valido`);
  return {
    meta: {
      name: parsed.parsed.frontmatter.name,
      description: parsed.parsed.frontmatter.description,
      path: skillDir,
      source: "managed",
      enabled: true,
      validators: [],
      templates: [],
    },
    body: parsed.parsed.body,
  };
}

test("spark-connect-notebooks: mantem a trilha moderna sem APIs classicas", () => {
  const { meta, body } = loadSkill("spark-connect-notebooks");
  assert.match(meta.description, /Spark Connect/);
  assert.match(body, /SPARK_REMOTE/);
  assert.match(body, /pyspark-client/);
  assert.match(body, /Never use unbounded `collect\(\)` or `toPandas\(\)`/);
  assert.match(body, /Do not emit `SparkContext`, `\.rdd`/);
  assert.match(body, /Route explicit RDD.*to `spark-classic-rdd`/s);
  assert.ok(fs.existsSync(path.join(meta.path, "references", "connect-review.md")));
});

test("spark-classic-rdd: combina Spark SQL e RDD com fronteira explicita", () => {
  const { meta, body } = loadSkill("spark-classic-rdd");
  assert.match(meta.description, /Spark SQL, DataFrames, SparkContext, and RDD/);
  assert.match(body, /Prove that RDD is warranted/);
  assert.match(body, /spark\.createDataFrame\(parsed_rdd, schema=schema\)/);
  assert.match(body, /rdd\.toDebugString\(\)/);
  assert.match(body, /reduceByKey/);
  assert.match(body, /retries and speculative execution can repeat side effects/);
  assert.ok(fs.existsSync(path.join(meta.path, "references", "classic-sql-rdd-review.md")));
});

test("seletor separa Spark Connect da solicitacao classica com RDD", () => {
  const connect = loadSkill("spark-connect-notebooks").meta;
  const classic = loadSkill("spark-classic-rdd").meta;
  const selector = new SkillSelector(DEFAULT_SELECTOR_CONFIG);

  const connectQuery = "crie notebook remoto com Spark Connect, Spark SQL e DataFrames";
  assert.ok(lexicalScore(connectQuery, connect) >= DEFAULT_SELECTOR_CONFIG.activationThreshold);
  assert.equal(selector.selectForActivation([connect, classic], connectQuery)[0]?.name, connect.name);

  const classicQuery = "otimize um job PySpark classico com SparkContext, pair RDD e custom partitioner";
  assert.ok(lexicalScore(classicQuery, classic) >= DEFAULT_SELECTOR_CONFIG.activationThreshold);
  assert.equal(selector.selectForActivation([connect, classic], classicQuery)[0]?.name, classic.name);
});

test("spark-pipelines roteia APIs incompatíveis antes de gerar codigo", () => {
  const body = loadSkill("spark-pipelines").body;
  assert.match(body, /Choose the runtime lane first/);
  assert.match(body, /Use `spark-connect-notebooks`/);
  assert.match(body, /Use `spark-classic-rdd`/);
  assert.match(body, /Never emit `\.rdd`, `SparkContext`, `_jdf` or `_jsc` for a Spark Connect session/);
});
