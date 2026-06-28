import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCellBlocks, parseNotebookCells } from "../util/cellBlocks";

test("parseCellBlocks: add com after e replace com index", () => {
  const text = [
    "Vou inserir e substituir células:",
    "```forge-cell path=nb.ipynb op=add after=2",
    "import pandas as pd",
    "```",
    "texto",
    "```forge-cell path=nb.ipynb op=replace index=3",
    "df = limpar(df)",
    "```",
  ].join("\n");
  const blocks = parseCellBlocks(text);
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    { ...blocks[0] },
    { path: "nb.ipynb", op: "add", after: 2, code: "import pandas as pd" }
  );
  assert.equal(blocks[1].op, "replace");
  assert.equal(blocks[1].index, 3);
  assert.equal(blocks[1].code, "df = limpar(df)");
});

test("parseCellBlocks: op default é add; replace sem index é ignorado", () => {
  const text =
    "```forge-cell path=a.ipynb\nx=1\n```\n```forge-cell path=a.ipynb op=replace\ny=2\n```";
  const blocks = parseCellBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].op, "add");
});

test("parseCellBlocks: cerca de 4 crases preserva cerca interna de 3 no código da célula", () => {
  const text = [
    "Vou inserir uma célula com docstring contendo um exemplo:",
    "````forge-cell path=nb.ipynb op=add after=1",
    "# Demonstração",
    "doc = '''",
    "```sql",
    "select 1",
    "```",
    "'''",
    "print(doc)",
    "````",
  ].join("\n");
  const blocks = parseCellBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].op, "add");
  assert.equal(blocks[0].after, 1);
  assert.match(blocks[0].code, /```sql/);
  assert.match(blocks[0].code, /select 1/);
  assert.match(blocks[0].code, /print\(doc\)/);
  assert.ok(!blocks[0].code.includes("forge-cell"));
});

test("parseNotebookCells lê células na ordem absoluta", () => {
  const ipynb = JSON.stringify({
    cells: [
      { cell_type: "markdown", source: ["# Título"] },
      { cell_type: "code", source: ["import pandas as pd\n", "df = pd.DataFrame()"] },
    ],
  });
  const cells = parseNotebookCells(ipynb);
  assert.equal(cells.length, 2);
  assert.equal(cells[0].kind, "markdown");
  assert.equal(cells[1].kind, "code");
  assert.match(cells[1].source, /import pandas/);
});

test("parseNotebookCells tolera JSON inválido", () => {
  assert.deepEqual(parseNotebookCells("não é json"), []);
});
