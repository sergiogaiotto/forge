import assert from "node:assert/strict";
import { test } from "node:test";
import { canReuse, parseSnapshot, serializeSnapshot, snapshotFileName, SNAPSHOT_VERSION, vectorsCompatible } from "../rag/indexPersistence";
import { IndexedChunk } from "../rag/types";
import { cosine } from "../util/vector";

test("REGRESSÃO: cosine retorna 0 para vetores de dimensões diferentes (não trunca por Math.min)", () => {
  assert.equal(cosine([1, 0, 0], [1, 0]), 0, "dims diferentes = incomparável = 0");
  assert.ok(cosine([1, 0, 0], [1, 0, 0]) > 0.99); // mesma dim continua funcionando
});

const chunk = (id: string, vector?: number[]): IndexedChunk =>
  ({ id, relPath: "a.ts", language: "typescript", startLine: 1, endLine: 5, symbol: "foo", text: "código", vector }) as IndexedChunk;

function makeFiles(entries: [string, { mtimeMs: number; size: number }, IndexedChunk[]][]) {
  const m = new Map<string, { meta: { mtimeMs: number; size: number }; chunks: IndexedChunk[] }>();
  for (const [rel, meta, chunks] of entries) m.set(rel, { meta, chunks });
  return m;
}

test("serialize→parse roundtrip preserva chunks e reidrata vetores (base64 Float32)", () => {
  const vec = [0.5, -0.25, 1.0, 0.125];
  const json = serializeSnapshot({
    workspaceRoot: "C:/proj",
    embeddingModel: "Qwen3",
    embeddingDims: 0,
    mode: "embeddings",
    files: makeFiles([["a.ts", { mtimeMs: 100, size: 200 }, [chunk("a.ts#1", vec)]]]),
  });
  const snap = parseSnapshot(json)!;
  assert.equal(snap.version, SNAPSHOT_VERSION);
  assert.equal(snap.workspaceRoot, "C:/proj");
  const f = snap.files["a.ts"];
  assert.equal(f.mtimeMs, 100);
  assert.equal(f.size, 200);
  assert.equal(f.chunks[0].id, "a.ts#1");
  assert.equal(f.chunks[0].symbol, "foo");
  // Float32 tem precisão limitada — compara com tolerância
  f.chunks[0].vector!.forEach((x, i) => assert.ok(Math.abs(x - vec[i]) < 1e-6));
});

test("chunk sem vetor (modo lexical) roundtrip → vector undefined", () => {
  const json = serializeSnapshot({
    workspaceRoot: "r", embeddingModel: "", embeddingDims: 0, mode: "lexical",
    files: makeFiles([["a.ts", { mtimeMs: 1, size: 1 }, [chunk("a.ts#1")]]]),
  });
  const snap = parseSnapshot(json)!;
  assert.equal(snap.files["a.ts"].chunks[0].vector, undefined);
});

test("parseSnapshot: versão errada / JSON inválido → null (força rebuild)", () => {
  assert.equal(parseSnapshot("{ invalido"), null);
  assert.equal(parseSnapshot(JSON.stringify({ version: 999, files: {} })), null);
  assert.equal(parseSnapshot(JSON.stringify({ version: SNAPSHOT_VERSION })), null); // sem files
});

test("canReuse: reusa só quando mtime E size batem", () => {
  const p = { mtimeMs: 100, size: 200, chunks: [] };
  assert.equal(canReuse(p, { mtimeMs: 100, size: 200 }), true);
  assert.equal(canReuse(p, { mtimeMs: 101, size: 200 }), false); // editado (mtime mudou)
  assert.equal(canReuse(p, { mtimeMs: 100, size: 201 }), false); // tamanho mudou
  assert.equal(canReuse(undefined, { mtimeMs: 100, size: 200 }), false); // novo (não no snapshot)
  assert.equal(canReuse(p, undefined), false); // sumiu do disco
});

test("vectorsCompatible: reusa se modo=embeddings E modelo bate (dims real vem da checagem de homogeneidade)", () => {
  const snap = parseSnapshot(serializeSnapshot({
    workspaceRoot: "r", embeddingModel: "Qwen3", embeddingDims: 1024, mode: "embeddings",
    files: makeFiles([]),
  }))!;
  assert.equal(vectorsCompatible(snap, "Qwen3"), true);
  assert.equal(vectorsCompatible(snap, "OutroModelo"), false); // trocou o modelo → re-embeda
  assert.equal(vectorsCompatible(snap, ""), false); // modelo vazio nunca reusa
  const lex = parseSnapshot(serializeSnapshot({ workspaceRoot: "r", embeddingModel: "", embeddingDims: 0, mode: "lexical", files: makeFiles([]) }))!;
  assert.equal(vectorsCompatible(lex, ""), false); // lexical não tem vetores para reusar
});

test("snapshotFileName: estável por workspace, diferente entre workspaces", () => {
  assert.equal(snapshotFileName("C:/a"), snapshotFileName("C:/a"));
  assert.notEqual(snapshotFileName("C:/a"), snapshotFileName("C:/b"));
  assert.match(snapshotFileName("C:/a"), /^rag-index-[0-9a-f]{16}\.json$/);
});
