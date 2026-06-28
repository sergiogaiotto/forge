import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFileBlocks } from "../util/fileBlocks";

test("extracts a single file block", () => {
  const text = [
    "Aqui está a função limpar:",
    "```forge-file path=churn_pipeline.py",
    "def limpar(df):",
    "    return df.drop_duplicates()",
    "```",
    "Pronto.",
  ].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "churn_pipeline.py");
  assert.match(blocks[0].content, /def limpar/);
  assert.ok(!blocks[0].content.endsWith("\n"));
});

test("extracts multiple blocks and strips quotes around the path", () => {
  const text = [
    '```forge-file path="a/b.py"',
    "x = 1",
    "```",
    "texto",
    "```forge-file path=c.sql",
    "select 1;",
    "```",
  ].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].path, "a/b.py");
  assert.equal(blocks[1].path, "c.sql");
  assert.equal(blocks[1].content, "select 1;");
});

test("returns nothing when there is no file block", () => {
  assert.equal(parseFileBlocks("apenas uma explicação, sem código").length, 0);
});
