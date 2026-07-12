import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRuffReport, RuffFinding, ruffAdvisories, splitRuffFindings } from "../util/ruffParse";

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

// #9: o gate amplia de só-F401 para a família de referência-fantasma (F811/F821/F822/F823) + f-string (F5xx).
// Os novos códigos passam; um código Pyflakes FORA do set (ex.: F841 variável local não usada — ruidoso) é filtrado.
test("parseRuffReport (#9): F821/F811/F822/F823/F5xx passam; F841 (fora do set) é filtrado", () => {
  const items = [
    issue({ file: "a.py", code: "F821", row: 5, message: "Undefined name `OrderStatus`" }),
    issue({ file: "a.py", code: "F811", row: 2, message: "Redefinition of unused `foo`" }),
    issue({ file: "a.py", code: "F822", row: 1, message: "Undefined name `Bar` in `__all__`" }),
    issue({ file: "a.py", code: "F823", row: 7, message: "Local variable `x` referenced before assignment" }),
    issue({ file: "a.py", code: "F502", row: 3, message: "`%` format expected mapping but got sequence" }),
    issue({ file: "a.py", code: "F841", row: 9, message: "Local variable `tmp` assigned but never used" }),
  ];
  const f = parseRuffReport(report(items));
  assert.ok(f);
  assert.deepEqual(f!.map((x) => x.code).sort(), ["F502", "F811", "F821", "F822", "F823"], "F841 fora do set → filtrado; os gateados passam");
  assert.ok(ruffAdvisories(f!).some((a) => /ruff F821: Undefined name `OrderStatus`/.test(a)), "o F821 (símbolo-fantasma) aparece legível");
});

// #9 follow-up: split BLOQUEANTE (F821/F822/F823 nome-indefinido) vs ADVISORY (F401/F811/f-string). Os
// bloqueantes agrupam por arquivo (como o splitSecurityFindings do bandit → entram em fileErrors, fecham o Aplicar).
test("splitRuffFindings: F821/F822/F823 bloqueiam (agrupados por arquivo); F401/F811/F5xx viram advisory", () => {
  const findings: RuffFinding[] = [
    { path: "src/svc.py", line: 5, code: "F821", message: "Undefined name `OrderStatus`" },
    { path: "src/svc.py", line: 8, code: "F821", message: "Undefined name `Foo`" },
    { path: "src/mod.py", line: 1, code: "F822", message: "Undefined name `Bar` in `__all__`" },
    { path: "src/late.py", line: 4, code: "F823", message: "Local variable `x` referenced before assignment" },
    { path: "src/a.py", line: 2, code: "F401", message: "`os` imported but unused" },
    { path: "src/a.py", line: 3, code: "F811", message: "Redefinition of unused `x`" },
    { path: "src/b.py", line: 4, code: "F502", message: "`%`-format expected mapping" },
  ];
  const { blocking, advisories } = splitRuffFindings(findings);
  assert.equal(blocking.length, 3, "svc.py + mod.py + late.py (agrupados por arquivo)");
  const svc = blocking.find((b) => b.path === "src/svc.py")!;
  assert.equal(svc.errors.length, 2, "2 F821 no mesmo arquivo agrupam");
  assert.ok(svc.errors[0].includes("F821") && svc.errors[0].includes("OrderStatus"));
  assert.ok(blocking.some((b) => b.path === "src/mod.py" && b.errors[0].includes("F822")));
  assert.deepEqual(advisories.length, 3, "F401 + F811 + F502");
  assert.ok(advisories.every((a) => /F401|F811|F502/.test(a)));
  assert.ok(!advisories.some((a) => /F82[123]/.test(a)), "nenhum bloqueante vaza para o canal advisory");
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
