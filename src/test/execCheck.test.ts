import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCheck, runFileCheck } from "../util/execCheck";

const SPEC = { id: "gate:mypy", label: "mypy", gate: true };

// REGRESSÃO (revisão do gate TS): o execFile pode LANÇAR de forma SÍNCRONA (`spawn EINVAL` ao tentar um .cmd
// inexistente no Windows — CVE-2024-27980). O runFileCheck NUNCA pode rejeitar (derrubaria o gate inteiro):
// deve resolver para "skipped". Em POSIX o mesmo nome dá ENOENT limpo → também skipped.
test("runFileCheck: comando inexistente (.cmd) resolve para skipped, nunca REJEITA a Promise", async () => {
  const r = await runFileCheck({ id: "probe", label: "x", gate: false }, "forge-nonexistent-tool-xyz.cmd", ["--version"], { timeoutMs: 5000 });
  assert.equal(r.status, "skipped"); // se o await lançasse, o teste falharia (Promise rejeitada)
});

test("classifyCheck: ENOENT (ferramenta ausente) → skipped, nunca reprova", () => {
  const r = classifyCheck(SPEC, Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), "", "");
  assert.equal(r.status, "skipped");
  assert.equal(r.gate, true); // preserva o gate (skipped ≠ failed no gatePassed)
  assert.equal(r.output, "");
  assert.match(r.reason ?? "", /PATH/);
});

test("classifyCheck: processo morto por timeout (killed) → skipped, inconclusivo não bloqueia", () => {
  const r = classifyCheck(SPEC, Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" }), "saída parcial", "");
  assert.equal(r.status, "skipped");
  assert.match(r.reason ?? "", /tempo esgotado/i);
});

test("classifyCheck: signal sem killed também é inconclusivo → skipped", () => {
  const r = classifyCheck(SPEC, Object.assign(new Error("killed"), { signal: "SIGKILL" }), "", "");
  assert.equal(r.status, "skipped");
});

test("classifyCheck: saída != 0 (a ferramenta rodou e reprovou) → failed com a saída", () => {
  const r = classifyCheck(SPEC, Object.assign(new Error("exit 1"), { code: 1 }), "erro X\n", "aviso Y  ");
  assert.equal(r.status, "failed");
  assert.equal(r.output, "erro X\naviso Y"); // stdout+stderr concatenados e SÓ as pontas trimadas
});

test("classifyCheck: sem erro → ok", () => {
  const r = classifyCheck({ id: "gate:compileall", label: "compileall", gate: true }, null, "", "");
  assert.equal(r.status, "ok");
  assert.equal(r.gate, true);
});

test("classifyCheck: a saída é capada em 4000 chars", () => {
  const big = "x".repeat(9000);
  const r = classifyCheck(SPEC, Object.assign(new Error("fail"), { code: 2 }), big, "");
  assert.equal(r.status, "failed");
  assert.equal(r.output.length, 4000);
});
