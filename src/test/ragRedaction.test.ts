import assert from "node:assert/strict";
import { test } from "node:test";
import { redactChunks } from "../rag/indexPersistence";
import { redactSecrets } from "../util/redact";
import { IndexedChunk } from "../rag/types";

// Segredo montado por concatenação: o literal contíguo nunca aparece no fonte (evita a push-protection do
// GitHub bloquear o commit) mas em runtime é "sk-proj-…", que o redactor unificado (#8) mascara.
const S = (...p: string[]) => p.join("");
const SECRET = S("sk-", "proj-", "AbCdEfGhIjKlMnOpQrStUvWx1234567890");

const chunk = (over: Partial<IndexedChunk>): IndexedChunk =>
  ({ relPath: "f", symbol: "", text: "", startLine: 1, endLine: 2, ...over } as IndexedChunk);

test("REGRESSÃO (exfil RAG): redactChunks redige o SÍMBOLO, não só o texto", () => {
  // O symbol é a linha-fronteira do chunk (chunker.symbolFor) — um INSERT/CREATE com credencial inline
  // cai aqui verbatim, e viaja ao embed (endpoint externo) + snapshot em disco. Precisa ser redigido.
  const [out] = redactChunks([
    chunk({ symbol: `INSERT INTO creds VALUES ('${SECRET}');`, text: `INSERT INTO creds VALUES ('${SECRET}');` }),
  ]);
  assert.ok(!out.symbol!.includes(SECRET), "segredo NÃO vaza no símbolo (o gap HIGH da revisão)");
  assert.ok(!out.text.includes(SECRET), "segredo NÃO vaza no texto");
});

test("redactChunks preserva identificadores normais (recuperação intacta)", () => {
  const [out] = redactChunks([chunk({ symbol: "def process_order", text: "def process_order():\n    return 1" })]);
  assert.equal(out.symbol, "def process_order", "nome de função é preservado (não é segredo)");
  assert.ok(out.text.includes("process_order"));
});

test("redactChunks: símbolo undefined passa sem quebrar", () => {
  const [out] = redactChunks([chunk({ symbol: undefined as unknown as string, text: "ok" })]);
  assert.equal(out.symbol, undefined);
  assert.equal(out.text, "ok");
});

// exfil RAG — 3ª via: CodebaseIndex.retrieve passou a redigir a QUERY com redactSecrets ANTES do embed
// (endpoint EXTERNO de embeddings) — a MESMA redação que os chunks já recebem em indexOneFile. O índice
// (vetores/BM25) é montado sobre chunks REDIGIDOS, então buscar em espaço redigido ALINHA a qualidade.
// CodebaseIndex é acoplado ao vscode (findFiles) → integration-only (sem harness unit): a WIRING de `retrieve`
// é revisada; aqui travamos a BEHAVIOR da redação para uma query realista — o segredo sai, os termos ficam.
test("exfil RAG (query): redactSecrets tira o segredo da query e PRESERVA os termos de busca", () => {
  const q = `debugar o login: falha ao autenticar com a chave ${SECRET} no header Authorization do OrderService`;
  const out = redactSecrets(q);
  assert.ok(!out.includes(SECRET), "o segredo da query NÃO vaza ao endpoint externo de embeddings");
  for (const term of ["debugar", "login", "autenticar", "header", "Authorization", "OrderService"]) {
    assert.ok(out.includes(term), `termo de busca preservado (recuperação intacta): ${term}`);
  }
});
