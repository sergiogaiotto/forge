import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafeHref, parseInline, parseMarkdownBlocks, type Block } from "../../webview-ui/src/markdown";

function kinds(b: Block[]): string[] {
  return b.map((x) => x.t);
}

test("parseInline: código, negrito, itálico e link seguro", () => {
  const n = parseInline("a `cod` **forte** *leve* [x](https://a.com)");
  assert.equal(n[0].t, "text");
  assert.ok(n.some((x) => x.t === "code" && x.v === "cod"));
  assert.ok(n.some((x) => x.t === "strong"));
  assert.ok(n.some((x) => x.t === "em"));
  const link = n.find((x) => x.t === "link");
  assert.ok(link && link.t === "link" && link.href === "https://a.com");
});

test("parseInline: link com esquema inseguro vira texto (não href)", () => {
  const n = parseInline("clique [aqui](javascript:alert(1))");
  assert.ok(!n.some((x) => x.t === "link"));
});

test("isSafeHref aceita http(s), mailto, âncora e relativo; rejeita o resto", () => {
  assert.ok(isSafeHref("https://x.com"));
  assert.ok(isSafeHref("mailto:a@b.com"));
  assert.ok(isSafeHref("#secao"));
  assert.ok(isSafeHref("/rel"));
  assert.ok(!isSafeHref("javascript:alert(1)"));
  assert.ok(!isSafeHref("data:text/html,x"));
});

test("código inline não formata o conteúdo interno", () => {
  const n = parseInline("`**não é negrito**`");
  assert.equal(n.length, 1);
  assert.equal(n[0].t, "code");
  assert.equal(n[0].t === "code" && n[0].v, "**não é negrito**");
});

test("cerca de código captura linguagem e conteúdo literal (vira box)", () => {
  const b = parseMarkdownBlocks("```python\nx = 1\nprint(x)\n```");
  assert.equal(b.length, 1);
  assert.equal(b[0].t, "code");
  assert.equal(b[0].t === "code" && b[0].lang, "python");
  assert.equal(b[0].t === "code" && b[0].v, "x = 1\nprint(x)");
});

test("cerca de 4 crases preserva cercas de 3 internas (não fecha cedo)", () => {
  const src = "````md\ntexto\n```bash\nls\n```\n````";
  const b = parseMarkdownBlocks(src);
  assert.equal(b.length, 1);
  assert.equal(b[0].t, "code");
  assert.ok(b[0].t === "code" && b[0].v.includes("```bash"));
});

test("tabela GFM é reconhecida com cabeçalho, alinhamento e linhas (o caso do print)", () => {
  const src = ["| Arquivo | Linha | Problema |", "|:---|:---:|---:|", "| a.py | 78 | bug |", "| b.py | 12 | erro |"].join("\n");
  const b = parseMarkdownBlocks(src);
  assert.equal(b.length, 1);
  const t = b[0];
  assert.equal(t.t, "table");
  if (t.t !== "table") return;
  assert.equal(t.head.length, 3);
  assert.deepEqual(t.align, ["left", "center", "right"]);
  assert.equal(t.rows.length, 2);
  // conteúdo da primeira célula da primeira linha
  assert.equal(t.rows[0][0][0].t === "text" && t.rows[0][0][0].v, "a.py");
});

test("linha com pipes SEM separador não vira tabela (fica parágrafo)", () => {
  const b = parseMarkdownBlocks("a | b | c\ntexto normal");
  assert.equal(b[0].t, "p");
});

test("headings, listas, citação e régua", () => {
  const src = ["# Título", "", "- um", "- dois", "", "1. a", "2. b", "", "> citação", "", "---"].join("\n");
  const b = parseMarkdownBlocks(src);
  assert.deepEqual(kinds(b), ["heading", "list", "list", "quote", "hr"]);
  assert.equal(b[0].t === "heading" && b[0].level, 1);
  assert.equal(b[1].t === "list" && b[1].ordered, false);
  assert.equal(b[1].t === "list" && b[1].items.length, 2);
  assert.equal(b[2].t === "list" && b[2].ordered, true);
  assert.equal(b[2].t === "list" && b[2].start, 1);
});

test("parágrafos são separados por linha em branco; linhas contíguas juntam", () => {
  const b = parseMarkdownBlocks("linha um\nlinha dois\n\noutro parágrafo");
  assert.equal(b.length, 2);
  assert.equal(b[0].t, "p");
  assert.equal(b[1].t, "p");
});

test("ênfase com _/* NÃO dispara dentro de identificadores (snake_case, a*b*c)", () => {
  for (const id of ["user_id_field", "a_b_c", "snake_case_name", "df.groupby(user_id).agg(max_value)"]) {
    const n = parseInline(`use ${id} aqui`);
    assert.ok(!n.some((x) => x.t === "em" || x.t === "strong"), `não deveria formatar: ${id}`);
  }
  assert.ok(!parseInline("calcule a*b*c").some((x) => x.t === "em"));
  assert.ok(!parseInline("2*3*4 = 24").some((x) => x.t === "em"));
});

test("ênfase legítima (cercada por fronteira de palavra) continua funcionando", () => {
  assert.ok(parseInline("isto é *importante* mesmo").some((x) => x.t === "em"));
  assert.ok(parseInline("isto é **crucial** ok").some((x) => x.t === "strong"));
  assert.ok(parseInline("use _itálico_ aqui").some((x) => x.t === "em"));
  assert.ok(parseInline("e __negrito__ também").some((x) => x.t === "strong"));
});

test("escape de marcador (\\*) vira literal e não formata", () => {
  const n = parseInline("preço \\*especial\\* hoje");
  assert.ok(!n.some((x) => x.t === "em"));
  assert.ok(
    n.map((x) => (x.t === "text" ? x.v : "")).join("").includes("*especial*")
  );
});

test("link protocol-relative (//host) NÃO vira link — anti open-redirect", () => {
  assert.ok(!parseInline("veja [aqui](//evil.com)").some((x) => x.t === "link"));
  assert.ok(isSafeHref("/caminho/local"));
  assert.ok(!isSafeHref("//evil.com"));
});

test("cerca de código não fechada (streaming) vira UMA box marcada como open", () => {
  const b = parseMarkdownBlocks("Veja:\n```python\nx = 1\nprint(x");
  const code = b.find((x) => x.t === "code");
  assert.ok(code && code.t === "code");
  assert.equal(code && code.t === "code" && code.open, true);
  assert.equal(code && code.t === "code" && code.v, "x = 1\nprint(x");
  const code2 = parseMarkdownBlocks("```js\na\n```")[0];
  assert.equal(code2.t === "code" && code2.open, false);
});

test("tabela só com cabeçalho vira parágrafo; com separador sem linhas vira tabela vazia", () => {
  assert.equal(parseMarkdownBlocks("| A | B |")[0].t, "p");
  const t = parseMarkdownBlocks("| A | B |\n|---|---|")[0];
  assert.equal(t.t, "table");
  assert.equal(t.t === "table" && t.rows.length, 0);
});

test("não quebra com entrada vazia", () => {
  assert.deepEqual(parseMarkdownBlocks(""), []);
  assert.deepEqual(parseInline(""), []);
});
