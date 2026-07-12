import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRuffReport, RuffFinding, ruffAdvisories } from "../util/ruffParse";

// Fábrica de item do relatório do ruff (`--output-format json`) — inclui os campos REAIS que o ruff emite
// (cell/end_location/fix.edits[]/noqa_row/url), não só os 4 que consumimos, para o parser ser exercitado
// contra a forma de verdade (achado da revisão adversarial).
function issue(o: { file?: string; code?: string; row?: number; message?: string }) {
  return {
    cell: null,
    code: o.code ?? "F401",
    end_location: { column: 10, row: o.row ?? 1 },
    filename: o.file ?? "C:/tmp/app/run.py",
    fix: { applicability: "safe", edits: [{ content: "", end_location: { column: 1, row: (o.row ?? 1) + 1 }, location: { column: 1, row: o.row ?? 1 } }], message: "Remove unused import" },
    location: { column: 8, row: o.row ?? 1 },
    message: o.message ?? "`os` imported but unused",
    noqa_row: o.row ?? 1,
    url: "https://docs.astral.sh/ruff/rules/unused-import",
  };
}
const report = (items: ReturnType<typeof issue>[]): string => JSON.stringify(items);

// ---- parseRuffReport: null (sem relatório) vs [] (rodou limpo) vs achados ----

test("parseRuffReport: relatório REAL do ruff → achados com todos os 4 campos (path verbatim; Controller normaliza)", () => {
  // caminho ABSOLUTO com barra invertida do Windows, forma que o ruff emite ao vivo
  const f = parseRuffReport(report([issue({ file: "C:\\tmp\\app\\run.py", code: "F401", row: 1, message: "`os` imported but unused" })]));
  assert.ok(f);
  assert.equal(f!.length, 1);
  assert.deepEqual(f![0], { path: "C:\\tmp\\app\\run.py", line: 1, code: "F401", message: "`os` imported but unused" } as RuffFinding);
});

test("parseRuffReport: rodou e nada achou ([]) → [] (NÃO null)", () => {
  assert.deepEqual(parseRuffReport("[]"), []);
  assert.deepEqual(ruffAdvisories([]), []);
});

// REGRESSÃO (revisão adversarial, repro ao vivo com ruff 0.8.4): o ruff emite os erros de SINTAXE do parser
// SEMPRE (com `code: null`), mesmo sob `--select F401`. Esses NÃO são imports mortos — devem ser filtrados,
// senão vazariam como avisos fantasma com o prefixo malformado "ruff : SyntaxError…".
test("parseRuffReport: erros de SINTAXE (code:null) são filtrados — só F401 sobrevive", () => {
  const synErr = (file: string, row: number, msg: string) => ({ cell: null, code: null, filename: file, location: { row, column: 1 }, message: msg, noqa_row: row, url: null });
  const mixed = JSON.stringify([
    synErr("C:/tmp/broken.py", 2, "SyntaxError: Expected an identifier"),
    synErr("C:/tmp/broken.py", 3, "SyntaxError: unexpected EOF while parsing"),
    issue({ file: "C:/tmp/dead.py", code: "F401", row: 1, message: "`os` imported but unused" }),
  ]);
  const f = parseRuffReport(mixed);
  assert.ok(f);
  assert.equal(f!.length, 1, "só o F401 sobrevive; os SyntaxError (code:null) são filtrados");
  assert.equal(f![0].code, "F401");
  assert.ok(!ruffAdvisories(f!).some((a) => /SyntaxError|ruff : /.test(a)), "nenhum aviso fantasma de sintaxe / prefixo malformado");
  // relatório SÓ com erros de sintaxe → [] (rodou, 0 imports mortos), NÃO null (não rodou)
  assert.deepEqual(parseRuffReport(JSON.stringify([synErr("x.py", 1, "SyntaxError: bad")])), []);
});

test("parseRuffReport: sem relatório-array válido → null (fail-open, não confundir com 0 achados)", () => {
  assert.equal(parseRuffReport(""), null);
  assert.equal(parseRuffReport("   "), null);
  assert.equal(parseRuffReport("lixo não-json"), null);
  assert.equal(parseRuffReport('{"x":1}'), null); // objeto no topo, não array
  assert.equal(parseRuffReport('"nope"'), null); // string JSON, não array
});

// REGRESSÃO: relatório TRUNCADO → null, nunca [] (senão passaria por "varredura limpa" e os avisos sumiriam
// em silêncio). Trunca APÓS o `]` interno do fix.edits mas ANTES do `]` externo — exercita o recorte contra
// a forma ANINHADA real do ruff (achado da revisão).
test("parseRuffReport: relatório truncado (com fix.edits aninhado) → null (não é varredura limpa)", () => {
  const full = report([issue({ code: "F401" })]);
  assert.equal(parseRuffReport(full.slice(0, full.length - 15)), null);
});

test("parseRuffReport: tolerante a BOM/espaços em volta (conteúdo de arquivo)", () => {
  assert.equal(parseRuffReport("﻿" + "[]" + "\n")!.length, 0);
});

test("ruffAdvisories: linhas legíveis, ordenadas de forma estável", () => {
  const findings: RuffFinding[] = [
    { path: "src/z.py", line: 3, code: "F401", message: "`b` imported but unused" },
    { path: "src/a.py", line: 1, code: "F401", message: "`os` imported but unused" },
  ];
  assert.deepEqual(ruffAdvisories(findings), [
    "src/a.py:1 — ruff F401: `os` imported but unused",
    "src/z.py:3 — ruff F401: `b` imported but unused",
  ]);
});
