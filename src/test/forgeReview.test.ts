import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error — script .mjs sem tipos; importado em runtime pelo tsx
import { buildSummary, extractJson, normalizeFindings, parseAddedLines } from "../../ci/forge-review.mjs";

test("parseAddedLines pega as linhas adicionadas (numeração do arquivo novo)", () => {
  const patch = "@@ -1,3 +1,4 @@\n ctx\n-old\n+new1\n+new2\n ctx2";
  const added = parseAddedLines(patch);
  assert.deepEqual([...added].sort((a: number, b: number) => a - b), [2, 3]);
});

test("extractJson ignora ruído antes/depois", () => {
  const j = extractJson('pensando... {"verdict":"comment","findings":[]} fim');
  assert.equal(j.verdict, "comment");
  assert.deepEqual(j.findings, []);
});

test("normalizeFindings coage linha e severidade e limpa o caminho", () => {
  const f = normalizeFindings([
    { file: "./src/a.py", line: "5", severity: "x", title: "t", body: "b" },
    { file: "ok.py", line: 9, severity: "critical", title: "c", body: "d", suggestion: "x=1" },
    { nope: true },
  ]);
  assert.equal(f.length, 2);
  assert.equal(f[0].file, "src/a.py");
  assert.equal(f[0].line, 5);
  assert.equal(f[0].severity, "suggestion");
  assert.equal(f[1].severity, "critical");
  assert.equal(f[1].suggestion, "x=1");
});

test("buildSummary inclui veredito e contagens", () => {
  const s = buildSummary("request_changes", "resumo", [{ severity: "critical", file: "a", line: 1, title: "t", body: "b" }], 1);
  assert.match(s, /FORGE Review/);
  assert.match(s, /mudanças necessárias/);
  assert.match(s, /rede interna/);
});
