import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFewShotTurn } from "../util/fewShot";
import { FORGE_FENCE } from "../shared/protocol";

// Monta um texto gerado com N blocos forge-file (cerca de 4 crases + `path=`).
function block(path: string, body: string): string {
  return `${FORGE_FENCE}forge-file path=${path}\n${body}\n${FORGE_FENCE}`;
}

test("buildFewShotTurn: preserva os cabeçalhos forge-file (path=) dos blocos gerados", () => {
  const gen = `prosa antes\n${block("src/app.py", "import os\nprint(1)")}\nmeio\n${block("README.md", "# App")}\ndepois`;
  const turn = buildFewShotTurn(gen);
  assert.ok(turn);
  assert.match(turn!, /forge-file path=src\/app\.py/);
  assert.match(turn!, /forge-file path=README\.md/);
  assert.match(turn!, /import os/);
  // prosa fora dos blocos NÃO entra (só o protocolo é reforçado)
  assert.doesNotMatch(turn!, /prosa antes/);
});

test("buildFewShotTurn: sem blocos forge-file → null (não reforça formato errado)", () => {
  assert.equal(buildFewShotTurn("só prosa e uma cerca comum:\n```python\nprint(1)\n```"), null);
  assert.equal(buildFewShotTurn(""), null);
});

test("buildFewShotTurn: trunca o CORPO de um bloco longo, marcando as linhas omitidas", () => {
  const body = Array.from({ length: 100 }, (_, i) => `linha ${i}`).join("\n");
  const turn = buildFewShotTurn(block("big.py", body), { maxBodyLines: 10 });
  assert.ok(turn);
  assert.match(turn!, /linha 0/);
  assert.match(turn!, /linha 9/);
  assert.doesNotMatch(turn!, /linha 50/); // corpo truncado
  assert.match(turn!, /90 linha\(s\) omitida\(s\)/);
});

test("buildFewShotTurn: respeita o teto TOTAL cortando por BLOCO (nunca no meio) e sempre inclui ≥1", () => {
  const big = block("a.py", "x".repeat(5000));
  const small = block("b.py", "y");
  const turn = buildFewShotTurn(`${big}\n${small}`, { maxTotalChars: 500, maxBodyLines: 100 });
  assert.ok(turn);
  // o primeiro bloco entra inteiro (fecha a cerca); o segundo é omitido por tamanho, com aviso
  assert.match(turn!, /forge-file path=a\.py/);
  assert.doesNotMatch(turn!, /forge-file path=b\.py/);
  assert.match(turn!, /1 bloco\(s\) omitido\(s\)/);
  // a cerca do bloco incluído NÃO fica cortada no meio
  assert.ok(turn!.trim().includes(FORGE_FENCE));
});

// REGRESSÃO (revisão): uma LINHA ÚNICA gigante (data URI base64 / JSON minificado) no 1º bloco — que é
// sempre incluído — não pode furar o teto de caracteres e inflar o contexto.
test("buildFewShotTurn: linha única gigante no 1º bloco respeita o teto de caracteres (não incha o contexto)", () => {
  const hugeLine = "data:image/png;base64," + "A".repeat(80000); // ~80KB numa linha só, dentro das 30 linhas
  const turn = buildFewShotTurn(block("index.html", hugeLine));
  assert.ok(turn);
  assert.match(turn!, /forge-file path=index\.html/); // cabeçalho preservado
  assert.match(turn!, /corpo truncado/);
  assert.ok(turn!.length < 4500, `esperava turno limitado (~teto 4000), veio ${turn!.length}`);
});

// REGRESSÃO (2ª revisão): o path/cabeçalho não passa pelo teto do CORPO — um path patológico (parseFileBlocks
// aceita token corrido) não pode furar o teto do piece inteiro.
test("buildFewShotTurn: path/cabeçalho patológico é limitado pelo teto do piece (não incha o contexto)", () => {
  const gen = `${FORGE_FENCE}forge-file path=${"p".repeat(80000)}.py\nprint(1)\n${FORGE_FENCE}`;
  const turn = buildFewShotTurn(gen);
  assert.ok(turn);
  assert.ok(turn!.length <= 4100, `esperava piece limitado ao teto (~4000), veio ${turn!.length}`);
});

test("buildFewShotTurn: múltiplos blocos curtos cabem todos", () => {
  const turn = buildFewShotTurn(`${block("a.py", "1")}${block("b.py", "2")}${block("c.py", "3")}`);
  assert.ok(turn);
  for (const p of ["a.py", "b.py", "c.py"]) assert.match(turn!, new RegExp(`path=${p}`));
  assert.doesNotMatch(turn!, /omitido/);
});
