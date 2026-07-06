import assert from "node:assert/strict";
import { test } from "node:test";
import { BanditFinding, isBlockingFinding, parseBanditReport, splitSecurityFindings } from "../util/banditParse";

// Fábrica de item de relatório do bandit (formato `-f json`).
function issue(o: { file?: string; sev?: string; conf?: string; id: string; name?: string; line?: number; text?: string }) {
  return { filename: o.file ?? "./app/x.py", issue_severity: o.sev ?? "HIGH", issue_confidence: o.conf ?? "HIGH", test_id: o.id, test_name: o.name ?? o.id, line_number: o.line ?? 1, issue_text: o.text ?? "achado" };
}
function report(items: ReturnType<typeof issue>[]): string {
  return JSON.stringify({ errors: [], generated_at: "2026-01-01T00:00:00Z", metrics: {}, results: items });
}
function mk(o: Partial<BanditFinding> & { testId: string }): BanditFinding {
  return { path: "app/x.py", line: 1, testName: "t", severity: "HIGH", confidence: "HIGH", message: "m", ...o } as BanditFinding;
}

// ---- parseBanditReport: null (sem relatório) vs [] (rodou limpo) vs achados ----

test("parseBanditReport: relatório válido → achados com todos os campos", () => {
  const f = parseBanditReport(report([issue({ file: "./app/run.py", id: "B602", name: "subprocess_popen_with_shell_equals_true", line: 7, text: "subprocess call with shell=True" })]));
  assert.ok(f);
  assert.equal(f!.length, 1);
  assert.deepEqual(f![0], { path: "./app/run.py", line: 7, testId: "B602", testName: "subprocess_popen_with_shell_equals_true", severity: "HIGH", confidence: "HIGH", message: "subprocess call with shell=True" });
});

test("parseBanditReport: rodou e nada achou (results:[]) → [] (NÃO null)", () => {
  assert.deepEqual(parseBanditReport(report([])), []);
});

test("parseBanditReport: sem relatório válido → null (fail-open, não confundir com 0 achados)", () => {
  assert.equal(parseBanditReport(""), null);
  assert.equal(parseBanditReport("   "), null);
  assert.equal(parseBanditReport("lixo não-json"), null);
  assert.equal(parseBanditReport(JSON.stringify({ errors: [] })), null); // sem chave results
  assert.equal(parseBanditReport('{"results": "não é lista"}'), null);
});

// REGRESSÃO (achado #7): relatório TRUNCADO (JSON não fecha) → null, nunca [] (senão passaria por
// "varredura limpa" e os bloqueios sumiriam em silêncio).
test("parseBanditReport: relatório truncado no meio → null (não é varredura limpa)", () => {
  const full = report([issue({ id: "B602" })]);
  assert.equal(parseBanditReport(full.slice(0, full.length - 15)), null);
});

test("parseBanditReport: tolerante a BOM/espaços em volta (conteúdo de arquivo)", () => {
  assert.equal(parseBanditReport("﻿" + report([]) + "\n")!.length, 0);
});

// ---- isBlockingFinding: allowlist de execução de código, não HIGH+HIGH cru -----

test("isBlockingFinding: só execução de código/shell HIGH+HIGH bloqueia (B602/B307/B102/B605...)", () => {
  for (const id of ["B102", "B307", "B602", "B604", "B605", "B609"]) {
    assert.equal(isBlockingFinding(mk({ testId: id })), true, `${id} deveria bloquear`);
  }
});

// REGRESSÃO (achados #1/#2): B324 (md5/sha1) e B701 (autoescape default do Jinja2) são HIGH+HIGH mas NÃO
// bloqueiam — mordem código legítimo (etag/cache; template Flask). Provado ao vivo com bandit 1.9.4.
test("isBlockingFinding: B324 (md5) e B701 (jinja autoescape) HIGH+HIGH NÃO bloqueiam (advisory)", () => {
  assert.equal(isBlockingFinding(mk({ testId: "B324" })), false);
  assert.equal(isBlockingFinding(mk({ testId: "B701" })), false);
  assert.equal(isBlockingFinding(mk({ testId: "B303" })), false);
  assert.equal(isBlockingFinding(mk({ testId: "B105" })), false); // fora da allowlist
});

test("isBlockingFinding: mesmo na allowlist, exige HIGH+HIGH (MEDIUM não bloqueia)", () => {
  assert.equal(isBlockingFinding(mk({ testId: "B602", confidence: "MEDIUM" })), false);
  assert.equal(isBlockingFinding(mk({ testId: "B602", severity: "MEDIUM" })), false);
});

// ---- splitSecurityFindings ----------------------------------------------------

test("splitSecurityFindings conservative: só o B602 bloqueia; B324/B701 viram advisory", () => {
  const findings = parseBanditReport(report([
    issue({ file: "app/run.py", id: "B602", name: "subprocess_popen_with_shell_equals_true", line: 9 }),
    issue({ file: "app/cache.py", id: "B324", name: "hashlib", line: 3, text: "md5 para etag" }),
    issue({ file: "app/tmpl.py", id: "B701", name: "jinja2_autoescape_false", line: 2 }),
  ]))!.map((f) => ({ ...f, path: f.path.replace(/^\.\//, "") }));
  const { blocking, advisories } = splitSecurityFindings(findings, "conservative");
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].path, "app/run.py");
  assert.match(blocking[0].errors[0], /B602.*shell/i);
  assert.equal(advisories.length, 2); // B324 e B701
  assert.ok(advisories.some((a) => a.includes("B324")) && advisories.some((a) => a.includes("B701")));
});

// REGRESSÃO (achados #1/#2): um projeto legítimo cujo ÚNICO "achado" é md5 (etag) + jinja default NÃO pode
// bloquear NADA.
test("splitSecurityFindings conservative: projeto só com B324+B701 → ZERO bloqueio", () => {
  const findings = parseBanditReport(report([issue({ id: "B324" }), issue({ id: "B701" })]))!.map((f) => ({ ...f, path: f.path.replace(/^\.\//, "") }));
  const { blocking, advisories } = splitSecurityFindings(findings, "conservative");
  assert.equal(blocking.length, 0);
  assert.equal(advisories.length, 2);
});

test("splitSecurityFindings advisory: NADA bloqueia, mesmo shell=True", () => {
  const findings = parseBanditReport(report([issue({ id: "B602" })]))!.map((f) => ({ ...f, path: f.path.replace(/^\.\//, "") }));
  const { blocking, advisories } = splitSecurityFindings(findings, "advisory");
  assert.equal(blocking.length, 0);
  assert.equal(advisories.length, 1);
});

test("splitSecurityFindings: múltiplos bloqueios no MESMO arquivo agrupam", () => {
  const findings = [mk({ testId: "B602", path: "app/a.py", line: 1 }), mk({ testId: "B605", path: "app/a.py", line: 8 }), mk({ testId: "B307", path: "app/b.py", line: 3 })];
  const { blocking } = splitSecurityFindings(findings, "conservative");
  assert.equal(blocking.length, 2);
  assert.equal(blocking.find((b) => b.path === "app/a.py")!.errors.length, 2);
});

test("splitSecurityFindings: sem achados → vazio", () => {
  assert.deepEqual(splitSecurityFindings([], "conservative"), { blocking: [], advisories: [] });
});
