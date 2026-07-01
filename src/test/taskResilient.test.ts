import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatMessage } from "../api/types";
import { checkCompleteness, partialFilePath, resilientGenerate } from "../util/completeness";

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

// ---- partialFilePath: qual arquivo (se algum) é PARCIAL (bug do README no "Aplicar tudo") ----

// Dois arquivos, ambos FECHADOS (corte ENTRE arquivos): nenhum é parcial.
const TWO_CLOSED = FENCE + "forge-file path=src/a.py\nx = 1\n" + FENCE + "\n" + FENCE + "forge-file path=README.md\n# Doc\n" + FENCE + "\n";
// a.py fechado + b.py cortado no meio SEM cerca de fechamento (cerca-aberta genuína).
const OPEN_LAST = FENCE + "forge-file path=src/a.py\nx = 1\n" + FENCE + "\n" + FENCE + "forge-file path=src/b.py\ndef f():\n    x = ";
// README cortado no meio, mas com uma cerca SOLTA de 3 crases no fim (a abertura tem 4): o
// BARE_FENCE_TAIL faz checkCompleteness dizer complete:true, mascarando o truncamento.
const MASKED_TRUNC = FENCE + "forge-file path=README.md\n# Titulo\nlinha cortada no me\n```\n";

test("partialFilePath: corte ENTRE arquivos (tudo fechado) NÃO marca parcial — o README completo é aplicável", () => {
  assert.equal(partialFilePath(true, { complete: true }, TWO_CLOSED), undefined);
});

test("partialFilePath: arquivo realmente cortado (cerca aberta) é o parcial", () => {
  assert.equal(partialFilePath(true, { complete: false, reason: "cerca-aberta", path: "src/b.py" }, OPEN_LAST), "src/b.py");
});

test("partialFilePath: path reportado FORA dos blocos → cai no ÚLTIMO bloco emitido", () => {
  assert.equal(partialFilePath(true, { complete: false, reason: "cerca-aberta", path: "z.py" }, OPEN_LAST), "src/b.py");
});

test("partialFilePath: sem truncamento → nada parcial; sem blocos → undefined", () => {
  assert.equal(partialFilePath(false, { complete: false, reason: "cerca-aberta", path: "x" }, OPEN_LAST), undefined);
  assert.equal(partialFilePath(true, { complete: false, reason: "cerca-aberta", path: undefined }, "sem blocos aqui"), undefined);
});

// REGRESSÃO (revisão adversarial PR B): truncamento no meio MASCARADO por cerca solta de contagem
// errada NÃO pode escapar — o "Aplicar tudo" gravaria um README cortado como completo.
test("partialFilePath: truncamento mascarado por BARE_FENCE_TAIL (último bloco não fechou de fato) → parcial", () => {
  const c = checkCompleteness(MASKED_TRUNC);
  assert.equal(c.complete, true, "BARE_FENCE_TAIL mascara o corte como 'completo'");
  // ...mas o último bloco não fechou de verdade → deve ser marcado parcial e PULADO pelo Aplicar tudo:
  assert.equal(partialFilePath(true, c, MASKED_TRUNC), "README.md");
});

test("cenário do README ponta-a-ponta: 1 arquivo FECHADO com corte do provider → truncado mas NÃO parcial", async () => {
  const s = scripted([{ text: FENCE + "forge-file path=README.md\n# Projeto\nrodar: `python -m app`\n" + FENCE + "\n", truncated: true }]);
  const r = await resilientGenerate(base, s.fn, opts);
  assert.equal(r.truncated, true, "provider sinalizou finish_reason=length");
  assert.equal(r.completeness.complete, true, "mas o bloco do README fechou");
  assert.equal(partialFilePath(r.truncated, r.completeness, r.full), undefined);
});
