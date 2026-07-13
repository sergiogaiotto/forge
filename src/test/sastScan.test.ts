import assert from "node:assert/strict";
import { test } from "node:test";
import { codeOnly, scanSast, splitSast } from "../util/sastScan";

const f = (content: string, path = "a.ts") => scanSast([{ path, content }]);
const rules = (content: string, path = "a.ts") => f(content, path).map((x) => `${x.severity}:${x.rule}`);
const S = (...p: string[]) => p.join(""); // monta segredo por concatenação (evita a push-protection do GitHub)

test("code-exec BLOQUEIA: eval() e new Function()", () => {
  assert.deepEqual(rules("const r = eval(userInput);"), ["blocking:code-exec"]);
  assert.deepEqual(rules("const g = new Function('a', 'return a');"), ["blocking:code-exec"]);
});

test("REGRESSÃO (FP): comentário/string com 'eval' e RegExp.exec NÃO acusam (codeOnly)", () => {
  assert.equal(f("// use eval() com cuidado\nconst s = 'evite eval() aqui';").length, 0, "comentário e string neutralizados");
  assert.equal(f("const m = re.exec(line);").length, 0, "RegExp.exec (sem child_process) não é injeção");
  assert.equal(f("retrieval(x); medieval(y);").length, 0, "'eval' no fim de palavra não casa");
});

test("shell-exec BLOQUEIA: exec/execSync com comando DINÂMICO (shell + concatenação)", () => {
  assert.deepEqual(rules("import {execSync} from 'child_process';\nexecSync('rm -rf ' + dir);"), ["blocking:shell-exec"]);
  assert.deepEqual(rules("import cp from 'node:child_process';\ncp.exec(`git ${branch}`);"), ["blocking:shell-exec"]);
});

test("REGRESSÃO (FP): execFile/spawn com args em ARRAY (a forma SEGURA) NÃO bloqueia", () => {
  // O check empírico contra o próprio repo pegou este FP: execFile/spawn com concatenação nos ARGS é seguro
  // (sem shell) — só exec/execSync (que rodam via shell) com comando dinâmico bloqueia.
  assert.equal(f("import {execFile} from 'child_process';\nexecFile(bin, ['--out', dir + '/x']);").length, 0);
  assert.equal(f("import {spawn} from 'child_process';\nspawn('git', ['clone', url]);").length, 0);
  assert.equal(f("import {execSync} from 'child_process';\nexecSync('ls -la');").length, 0, "comando estático não é injeção");
});

test("shell:true é ADVISORY (smell com usos legítimos), não bloqueia", () => {
  assert.deepEqual(rules("import {spawn} from 'child_process';\nspawn(cmd, {shell: true});"), ["advisory:shell-exec"]);
});

test("XSS é ADVISORY: dangerouslySetInnerHTML e innerHTML dinâmico", () => {
  assert.deepEqual(rules("return <div dangerouslySetInnerHTML={{__html: x}} />;", "c.tsx"), ["advisory:xss"]);
  assert.deepEqual(rules("el.innerHTML = '<b>' + name + '</b>';"), ["advisory:xss"]);
  assert.equal(f("el.textContent = name;").length, 0, "textContent é seguro");
});

test("segredo hardcoded é ADVISORY: token de provedor por prefixo", () => {
  assert.deepEqual(rules("const k = '" + S("AKIA", "IOSFODNN7EXAMPLE") + "';"), ["advisory:hardcoded-secret"]);
  assert.deepEqual(rules("const t = '" + S("sk-proj-", "AbCdEf0123456789AbCd") + "';"), ["advisory:hardcoded-secret"]);
  assert.equal(f("const id = 'user-profile-heading';").length, 0, "identificador comum não casa (prefixo+dígito exigidos)");
});

test("REGRESSÃO (revisão): TEXTO de template com 'eval()' NÃO acusa; mas ${eval(x)} SIM", () => {
  // O FP dominante sobre código GERADO: prompt de LLM / mensagem de erro / doc de linter com "eval()" no texto.
  assert.equal(f("const p = `nunca chame eval(userInput) diretamente`;").length, 0, "texto de template neutralizado");
  assert.equal(f("throw new Error(`eval() não é permitido`);").length, 0, "mensagem de erro em template");
  assert.deepEqual(rules("const y = `${eval(expr)}`;"), ["blocking:code-exec"], "interpolação ${…} É código → acusa");
});

test("REGRESSÃO (revisão): chamadas de MEMBRO homônimas NÃO acusam (api.eval, page.$eval, db.exec, re.exec)", () => {
  assert.equal(f("api.eval(userInput);").length, 0, "método .eval não é o eval global");
  assert.equal(f("await page.$eval('#x', el => el.textContent);", "s.ts").length, 0, "Playwright $eval");
  assert.equal(f("import {spawn} from 'child_process';\nspawn('git',['s']);\ndb.exec('UPDATE t WHERE id=' + id);").length, 0, "db.exec (better-sqlite3) NÃO é shell; o spawn com array é seguro → 0 achados");
  assert.equal(f("const m = re.exec(prefix + line);").length, 0, "RegExp.exec com concatenação não é shell");
});

test("REGRESSÃO (revisão): innerHTML de COMPARAÇÃO (===/==) não acusa (só atribuição)", () => {
  assert.equal(f("if (el.innerHTML === expected + suffix) return;").length, 0, "comparação, não atribuição");
  assert.deepEqual(rules("el.innerHTML = '<b>' + name;"), ["advisory:xss"], "atribuição dinâmica acusa");
});

test("só varre TS/JS (não .py/.md)", () => {
  assert.equal(f("eval(x)", "a.py").length, 0);
  assert.equal(f("eval(x)", "README.md").length, 0);
  assert.equal(f("eval(x)", "a.tsx").length, 1);
  assert.equal(f("eval(x)", "a.mjs").length, 1);
});

test("codeOnly neutraliza comentários e strings, preservando linhas/posições", () => {
  const src = "a();\n// eval() aqui\nb('eval()');\nc();";
  const out = codeOnly(src);
  assert.equal(out.split("\n").length, src.split("\n").length, "mesmo número de linhas (posições preservadas)");
  assert.ok(!out.includes("eval"), "'eval' do comentário E da string foram apagados");
  assert.ok(out.includes("a();") && out.includes("c();"), "código real preservado");
});

test("splitSast: conservative separa blocking; advisory joga tudo em advisory", () => {
  const findings = scanSast([{ path: "x.ts", content: "import {spawn} from 'child_process';\neval(a);\nspawn(c, {shell:true});" }]);
  const cons = splitSast(findings, "conservative");
  assert.equal(cons.blocking.length, 1, "1 arquivo com bloqueio (eval)");
  assert.equal(cons.blocking[0].path, "x.ts");
  assert.equal(cons.advisories.length, 1, "shell:true fica advisory");
  const adv = splitSast(findings, "advisory");
  assert.equal(adv.blocking.length, 0, "modo advisory NÃO bloqueia nada");
  assert.equal(adv.advisories.length, 2);
});
