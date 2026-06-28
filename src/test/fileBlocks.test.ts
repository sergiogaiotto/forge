import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFileBlocks, parsePartialFileBlocks, stripFileBlocksFromText } from "../util/fileBlocks";

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

// ---- parsePartialFileBlocks (streaming ao vivo) -----------------------------

test("partial parser marks a closed block as closed", () => {
  const text = ["```forge-file path=a.py", "x = 1", "```"].join("\n");
  const blocks = parsePartialFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "a.py");
  assert.equal(blocks[0].content, "x = 1");
  assert.equal(blocks[0].closed, true);
});

test("partial parser captures an open (still streaming) block", () => {
  const text = ["antes", "```forge-file path=a.py", "linha 1", "linha 2 incompl"].join("\n");
  const blocks = parsePartialFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "a.py");
  assert.equal(blocks[0].closed, false);
  assert.match(blocks[0].content, /linha 1\nlinha 2 incompl/);
});

test("partial parser handles a header line that is still arriving", () => {
  const text = "texto\n```forge-file path=sentiment_age";
  const blocks = parsePartialFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "sentiment_age");
  assert.equal(blocks[0].closed, false);
  assert.equal(blocks[0].content, "");
});

test("partial parser mixes a closed block followed by an open one", () => {
  const text = [
    "```forge-file path=a.py",
    "a = 1",
    "```",
    "entre",
    "```forge-file path=b.py",
    "b = 2",
  ].join("\n");
  const blocks = parsePartialFileBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].closed, true);
  assert.equal(blocks[1].path, "b.py");
  assert.equal(blocks[1].closed, false);
});

// ---- stripFileBlocksFromText (prosa exibida) --------------------------------

test("strip removes a closed block but keeps the surrounding prose", () => {
  const text = ["Olha o arquivo:", "```forge-file path=a.py", "x = 1", "```", "Pronto."].join("\n");
  const out = stripFileBlocksFromText(text);
  assert.match(out, /Olha o arquivo:/);
  assert.match(out, /Pronto\./);
  assert.ok(!out.includes("forge-file"));
  assert.ok(!out.includes("x = 1"));
});

test("strip removes an open block that is still streaming", () => {
  const text = ["Gerando…", "```forge-file path=a.py", "linha incompl"].join("\n");
  const out = stripFileBlocksFromText(text);
  assert.equal(out, "Gerando…");
});

test("strip is a no-op for prose without file blocks", () => {
  assert.equal(stripFileBlocksFromText("só texto"), "só texto");
});

// ---- consistência webview ↔ host (achados da revisão adversarial) ------------

test("closed block without a path is ignored by every parser (no silent loss)", () => {
  // O host (parseFileBlocks) exige path não-vazio; a webview deve concordar — senão o conteúdo
  // some da prosa e vira um cartão morto permanente.
  const text = ["Olha:", "```forge-file path=", "print('ola')", "```", "fim"].join("\n");
  assert.equal(parseFileBlocks(text).length, 0);
  assert.equal(parsePartialFileBlocks(text).filter((b) => b.closed).length, 0);
  const out = stripFileBlocksFromText(text);
  assert.match(out, /print\('ola'\)/); // conteúdo preservado na prosa
});

test("closed block with no path= at all is ignored by every parser", () => {
  const text = ["Olha:", "```forge-file", "print('ola')", "```", "fim"].join("\n");
  assert.equal(parseFileBlocks(text).length, 0);
  assert.equal(parsePartialFileBlocks(text).filter((b) => b.closed).length, 0);
  assert.match(stripFileBlocksFromText(text), /print\('ola'\)/);
});

test("fence that is a prefix of a larger token does not match (```forge-fileXYZ)", () => {
  const text = ["antes", "```forge-fileXYZ path=a.py", "x = 1", "```", "depois"].join("\n");
  assert.equal(parseFileBlocks(text).length, 0);
  assert.equal(parsePartialFileBlocks(text).length, 0);
  // Nada é removido — o texto cru permanece (consistente com o host não gerar proposta).
  const out = stripFileBlocksFromText(text);
  assert.match(out, /x = 1/);
  assert.match(out, /forge-fileXYZ/);
});

test("a valid block right after a false-prefix fence is still found", () => {
  const text = [
    "```forge-fileXYZ ignora isto",
    "```forge-file path=ok.py",
    "y = 2",
    "```",
  ].join("\n");
  const blocks = parsePartialFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "ok.py");
  assert.equal(blocks[0].closed, true);
});
