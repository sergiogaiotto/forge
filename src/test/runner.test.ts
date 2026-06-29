import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommand, chooseRunMode, DEFAULT_RUN_COMMANDS, makeAnsiFilter, resolveRunCommand, stripAnsi } from "../core/Runner";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

test("resolve comando padrão por extensão", () => {
  const r = resolveRunCommand("src/churn.py", {});
  assert.ok("template" in r);
  if ("template" in r) assert.equal(r.template, "python {file}");
});

test("override do usuário tem precedência", () => {
  const r = resolveRunCommand("a.py", { ".py": "python3 {file}" });
  assert.ok("template" in r && r.template === "python3 {file}");
});

test("extensão não executável é pulada", () => {
  const r = resolveRunCommand("query.sql", {});
  assert.ok("skippedReason" in r);
});

test("notebook e node têm comandos padrão", () => {
  assert.ok(DEFAULT_RUN_COMMANDS[".ipynb"].includes("nbconvert"));
  assert.deepEqual(resolveRunCommand("app.js", {}), { template: "node {file}" });
});

test("buildCommand substitui {file} e cita caminho com espaço", () => {
  assert.equal(buildCommand("python {file}", "/tmp/a.py"), "python /tmp/a.py");
  assert.equal(buildCommand("python {file}", "C:/meu projeto/a.py"), 'python "C:/meu projeto/a.py"');
});

test("chooseRunMode: terminal quando há shell integration, senão painel", () => {
  assert.equal(chooseRunMode(true), "terminal");
  assert.equal(chooseRunMode(false), "panel");
});

test("stripAnsi remove cores CSI mas preserva o texto", () => {
  assert.equal(stripAnsi(`${ESC}[31mvermelho${ESC}[0m`), "vermelho");
  assert.equal(stripAnsi(`${ESC}[2J${ESC}[H ok`), " ok");
});

test("stripAnsi remove OSC (inclui OSC 633 da shell integration do VSCode)", () => {
  assert.equal(stripAnsi(`${ESC}]633;C${BEL}saída`), "saída");
  assert.equal(stripAnsi(`${ESC}]0;título${BEL}corpo`), "corpo");
});

test("stripAnsi mantém tab e quebras de linha", () => {
  assert.equal(stripAnsi("a\tb\nc\r\nd"), "a\tb\nc\r\nd");
});

test("makeAnsiFilter junta um escape CSI cortado na borda do chunk", () => {
  const f = makeAnsiFilter();
  assert.equal(f(`ola${ESC}[3`), "ola"); // escape incompleto no fim — segura
  assert.equal(f(`1mVERMELHO${ESC}[0m`), "VERMELHO"); // completa e remove
});

test("makeAnsiFilter segura um OSC cortado entre chunks", () => {
  const f = makeAnsiFilter();
  assert.equal(f(`${ESC}]633;C`), ""); // OSC sem terminador — segura tudo
  assert.equal(f(`${BEL}corpo`), "corpo");
});

test("makeAnsiFilter sem corte se comporta como stripAnsi", () => {
  const f = makeAnsiFilter();
  assert.equal(f(`${ESC}[32mverde${ESC}[0m`), "verde");
  assert.equal(f("texto puro\n"), "texto puro\n");
});

test("makeAnsiFilter: instâncias independentes não compartilham estado (um por stream)", () => {
  const out = makeAnsiFilter();
  const err = makeAnsiFilter();
  assert.equal(out(`progresso${ESC}[`), "progresso"); // out segura o ESC[ parcial
  assert.equal(err("ERRO: arquivo\n"), "ERRO: arquivo\n"); // err intacto, sem herdar o pending de out
  assert.equal(out("31mVERMELHO"), "VERMELHO"); // out completa seu próprio escape
});

test("makeAnsiFilter: OSC sem terminador não engole toda a saída (pending limitado)", () => {
  const f = makeAnsiFilter();
  const big = "x".repeat(500);
  const out = f(`${ESC}]8;;http://exemplo.com${big}`); // OSC aberto sem BEL/ST + muito texto
  assert.ok(out.includes(big.slice(-100))); // o texto longo passou (não ficou todo retido/sumido)
});
