import assert from "node:assert/strict";
import { test } from "node:test";
import { codeOnly, scanSast, splitSast } from "../util/sastScan";

const f = (content: string, path = "a.ts") => scanSast([{ path, content }]);
const rules = (content: string, path = "a.ts") => f(content, path).map((x) => `${x.severity}:${x.rule}`);
const S = (...p: string[]) => p.join(""); // monta segredo por concatenação (evita a push-protection do GitHub)

test("code-exec: eval() global BLOQUEIA; new Function() é ADVISORY", () => {
  assert.deepEqual(rules("const r = eval(userInput);"), ["blocking:code-exec"]);
  // new Function tem base-rate legítimo alto em código gerado (template/E2E/codegen); a medição ao vivo
  // (259 arquivos) achou 100% das ocorrências legítimas → advisory (surfaça sem travar o Aplicar).
  assert.deepEqual(rules("const g = new Function('a', 'return a');"), ["advisory:code-exec"]);
  assert.deepEqual(rules("const fn = new Function(`return (${body});`);"), ["advisory:code-exec"], "new Function com template dinâmico ainda é advisory");
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

test("REGRESSÃO (corpus gerado): método/função DEFINIDO com nome `eval` NÃO acusa (interpretador/AST)", () => {
  // FP dominante do corpus GERADO: todo interpretador / AST / engine de expressão define um método eval().
  // O lookbehind barra `.eval` mas não uma definição em posição de membro — o filtro isEvalDefinition resolve.
  assert.equal(f("class Literal {\n  eval(env: Environment): RuntimeValue { return this.value; }\n}").length, 0, "método com tipo de retorno");
  assert.equal(f("interface Expr {\n  eval(env: Environment): RuntimeValue;\n}").length, 0, "assinatura de interface");
  assert.equal(f("class N {\n  eval() {\n    return 1;\n  }\n}").length, 0, "método sem params nem tipo");
  assert.equal(f("function eval(x) {\n  return x;\n}").length, 0, "declaração de função homônima");
  assert.equal(f("const o = {\n  eval(env) {\n    return env;\n  }\n};").length, 0, "método shorthand em objeto");
  assert.equal(f("class M {\n  eval(\n    source: string,\n    facts: FactBag,\n  ): RuntimeValue {\n    return run(source);\n  }\n}").length, 0, "definição multi-linha com tipo de retorno");
  assert.equal(f("class G {\n  get eval() { return this._e; }\n}").length, 0, "getter chamado eval");
  assert.equal(f("class A {\n  async eval(x: string): Promise<void> {}\n}").length, 0, "método async com tipo de retorno");
  assert.equal(f("type T = { eval(x: number): void };").length, 0, "membro de tipo/interface inline");
  assert.equal(f("abstract class B {\n  abstract eval(x: string): number;\n}").length, 0, "método abstrato (assinatura)");
});

test("REGRESSÃO (corpus gerado): CHAMADA de eval AINDA acusa após o filtro de definição", () => {
  // O filtro de definição não pode abrir buraco: eval de verdade (statement, atribuição, condição, interpolação)
  // continua bloqueando. Só definição (seguida de `{`/`:` após os params) é poupada.
  assert.deepEqual(rules("eval(userInput);"), ["blocking:code-exec"], "statement");
  assert.deepEqual(rules("const r = eval(expr);"), ["blocking:code-exec"], "atribuição");
  assert.deepEqual(rules("if (eval(cond)) return;"), ["blocking:code-exec"], "condição — ) após ) não é definição");
  assert.deepEqual(rules("return eval(x) ? a : b;"), ["blocking:code-exec"], "consequente antes do ? ainda acusa");
  assert.deepEqual(rules("const y = `${eval(expr)}`;"), ["blocking:code-exec"], "interpolação");
  // O `:` NÃO deve virar escape: ternário e `case` são posição de EXPRESSÃO (chamada), não tipo-de-retorno.
  assert.deepEqual(rules("const r = trusted ? eval(expr) : safeParse(expr);"), ["blocking:code-exec"], "eval no consequente de ternário (seguido de `:`) ainda acusa");
  assert.deepEqual(rules("switch (op) {\n  case eval(userInput):\n    return;\n}"), ["blocking:code-exec"], "eval em `case` (seguido de `:`) ainda acusa");
});

test("REGRESSÃO (revisão adversarial): assinatura de `eval` maior que o bound do matchParen NÃO vira FP bloqueante", () => {
  // Se a lista de params estoura o bound do matchParen (assinatura gigante e tipada — comum em codegen de
  // interpretador), o filtro erra para o lado SEGURO (definição/não-bloqueia), nunca para bloquear.
  const bigParams = Array.from({ length: 120 }, (_, i) => `arg${i}: SomeVeryLongTypeName${i}`).join(", ");
  assert.equal(f(`class M {\n  eval(${bigParams}): RuntimeValue {\n    return 1;\n  }\n}`).length, 0, "definição com assinatura > bound não bloqueia (fail-safe)");
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
