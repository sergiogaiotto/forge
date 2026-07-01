import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatMessage } from "../api/types";
import { resilientGenerate } from "../util/completeness";

const FENCE = "````"; // 4 crases (FORGE_FENCE)
const base: ChatMessage[] = [{ role: "user", content: "gere o arquivo" }];
const opts = { maxContinuations: 6, anchorChars: 8000, buildContinuation: (p?: string) => `continue ${p ?? ""}` };

// Cria uma streamFn roteirizada por passagem (repete o último script) e captura as mensagens recebidas.
function scripted(scripts: string[]) {
  let i = 0;
  const captured: ChatMessage[][] = [];
  const fn = async (messages: ChatMessage[]) => {
    captured.push(messages);
    return { text: scripts[Math.min(i++, scripts.length - 1)] };
  };
  return { fn, captured, calls: () => i };
}

test("resilientGenerate: 1ª passagem trunca (cerca aberta), 2ª completa → 1 continuação, completo", async () => {
  const s = scripted([
    "Aqui vai:\n" + FENCE + "forge-file path=a.py\ndef f():\n    x = 1", // aberto
    "\n    return x\n" + FENCE + "\n", // continua e fecha
  ]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.attempts, 1, "exatamente 1 continuação");
  assert.equal(r.completeness.complete, true);
  assert.match(r.full, /def f\(\):/);
  assert.match(r.full, /return x/);
});

test("resilientGenerate: nunca fecha → para por stall/teto, ainda incompleto (cerca-aberta)", async () => {
  const s = scripted([
    FENCE + "forge-file path=b.py\nprimeira linha de conteudo real",
    "\nsegunda linha que avanca mas nunca fecha",
  ]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.completeness.complete, false);
  assert.equal(r.completeness.reason, "cerca-aberta");
  assert.ok(r.attempts >= 1);
  assert.ok(r.attempts <= opts.maxContinuations, "respeita o teto");
});

test("resilientGenerate: continuação reenvia só a CAUDA (âncora), não o arquivo inteiro", async () => {
  const big = "x".repeat(20000);
  const s = scripted([FENCE + "forge-file path=c.py\n" + big, "\nfim\n" + FENCE + "\n"]);
  await resilientGenerate(base, s.fn, { ...opts, anchorChars: 500 });
  const assistantMsg = s.captured[1].find((m) => m.role === "assistant");
  assert.ok(assistantMsg, "a 2ª passagem recebe o assistant anterior como âncora");
  assert.ok(assistantMsg!.content.length <= 520, `âncora deve ser a cauda (~500), veio ${assistantMsg!.content.length}`);
});

test("resilientGenerate: erro numa passagem é propagado sem continuar", async () => {
  const fn = async () => ({ text: "", error: "boom" });
  const r = await resilientGenerate(base, fn, opts);
  assert.equal(r.error, "boom");
  assert.equal(r.attempts, 0);
});

test("resilientGenerate: fluxo normal (já completo) NÃO continua", async () => {
  const s = scripted(["ok, sem código.\n"]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.attempts, 0);
  assert.equal(r.completeness.complete, true);
  assert.equal(s.calls(), 1, "uma única passagem");
});
