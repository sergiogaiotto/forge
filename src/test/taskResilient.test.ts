import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatMessage } from "../api/types";
import { resilientGenerate } from "../util/completeness";

const FENCE = "````"; // 4 crases (FORGE_FENCE)
const base: ChatMessage[] = [{ role: "user", content: "gere o arquivo" }];
const opts = {
  maxContinuations: 6,
  anchorChars: 8000,
  buildContinuation: (p?: string) => `continue ${p ?? ""}`,
  buildTailContinuation: () => "emita o restante dos arquivos",
};

// streamFn roteirizada por passagem (repete o último), captura as mensagens e devolve o flag truncated.
function scripted(scripts: { text: string; truncated?: boolean }[]) {
  let i = 0;
  const captured: ChatMessage[][] = [];
  const fn = async (messages: ChatMessage[]) => {
    captured.push(messages);
    const s = scripts[Math.min(i++, scripts.length - 1)];
    return { text: s.text, truncated: s.truncated };
  };
  return { fn, captured, calls: () => i };
}

test("resilientGenerate: cerca aberta na 1ª, fecha na 2ª → 1 continuação, completo", async () => {
  const s = scripted([
    { text: "Aqui vai:\n" + FENCE + "forge-file path=a.py\ndef f():\n    x = 1" },
    { text: "\n    return x\n" + FENCE + "\n" },
  ]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.attempts, 1);
  assert.equal(r.completeness.complete, true);
  assert.equal(r.truncated, false);
  assert.match(r.full, /return x/);
});

test("resilientGenerate: corte ENTRE arquivos (provider truncou, blocos fechados) CONTINUA e completa", async () => {
  const s = scripted([
    { text: FENCE + "forge-file path=a.py\nx = 1\n" + FENCE + "\n", truncated: true }, // fechado, mas cortado
    { text: FENCE + "forge-file path=b.py\ny = 2\n" + FENCE + "\n" }, // o resto
  ]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.attempts, 1, "continua mesmo sem cerca aberta, pelo sinal do provider");
  assert.equal(r.truncated, false);
  assert.match(r.full, /path=a\.py/);
  assert.match(r.full, /path=b\.py/); // o 2º arquivo entrou
});

test("resilientGenerate: corte persistente marca truncated=true (não entrega projeto incompleto como sucesso)", async () => {
  const s = scripted([{ text: FENCE + "forge-file path=a.py\n" + "z".repeat(40) + "\n" + FENCE + "\n", truncated: true }]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.truncated, true, "corte por limite sinalizado pelo provider → aviso honesto");
});

test("resilientGenerate: reenvia só a CAUDA (âncora), não o texto inteiro", async () => {
  const big = "x".repeat(20000);
  const s = scripted([{ text: FENCE + "forge-file path=c.py\n" + big }, { text: "\nfim\n" + FENCE + "\n" }]);
  await resilientGenerate(base, s.fn, { ...opts, anchorChars: 500 });
  const assistantMsg = s.captured[1].find((m) => m.role === "assistant");
  assert.ok(assistantMsg && assistantMsg.content.length <= 520);
});

test("resilientGenerate: erro numa passagem é propagado sem continuar", async () => {
  const fn = async () => ({ text: "", error: "boom", truncated: false });
  const r = await resilientGenerate(base, fn, opts);
  assert.equal(r.error, "boom");
  assert.equal(r.attempts, 0);
});

test("resilientGenerate: fluxo normal (já completo, sem truncar) NÃO continua", async () => {
  const s = scripted([{ text: "ok, sem código.\n" }]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.attempts, 0);
  assert.equal(r.truncated, false);
  assert.equal(s.calls(), 1);
});
