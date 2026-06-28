import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";
import { Bm25Index } from "../rag/Bm25Index";
import { chunkFile, languageForPath } from "../rag/chunker";
import { EmbeddingClient } from "../rag/EmbeddingClient";
import { EgressEnforcer } from "../net/EgressEnforcer";
import { cosine, tokenizeCode } from "../util/vector";

const PY = `import pandas as pd


def limpar(df):
    df = df.drop_duplicates()
    df["plano"] = df["plano"].astype("category")
    return df.fillna({"uso_mb": 0})


def treinar(modelo, dados):
    for epoch in range(10):
        modelo.fit(dados)
    return modelo
`;

test("chunker divide por fronteiras e preenche metadados", () => {
  const chunks = chunkFile("churn_pipeline.py", PY);
  assert.ok(chunks.length >= 2, `esperava >= 2 trechos, achei ${chunks.length}`);
  for (const c of chunks) {
    assert.equal(c.language, "python");
    assert.ok(c.startLine >= 1 && c.endLine >= c.startLine);
    assert.ok(c.text.length > 0);
  }
  assert.ok(chunks.some((c) => /limpar/.test(c.symbol ?? "") || /limpar/.test(c.text)));
});

test("languageForPath mapeia extensões", () => {
  assert.equal(languageForPath("a/b.py"), "python");
  assert.equal(languageForPath("x.sql"), "sql");
  assert.equal(languageForPath("y.ipynb"), "python");
  assert.equal(languageForPath("z.unknown"), "plaintext");
});

test("BM25 recupera o trecho mais relevante", () => {
  const chunks = chunkFile("churn_pipeline.py", PY);
  const idx = new Bm25Index(chunks);
  // BM25 é lexical: a query precisa compartilhar termos com o código.
  const hits = idx.query("drop_duplicates fillna astype category", 3);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].chunk.text, /drop_duplicates|fillna/);
});

test("cosine: idênticos = 1, ortogonais = 0", () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test("tokenizeCode separa camelCase e snake_case", () => {
  const t = tokenizeCode("readParquet drop_duplicates");
  assert.ok(t.includes("read"));
  assert.ok(t.includes("parquet"));
  assert.ok(t.includes("drop"));
  assert.ok(t.includes("duplicates"));
});

function embeddingsServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { input } = JSON.parse(body) as { input: string[] };
        // vetor determinístico de dimensão 4 baseado no texto
        const data = input.map((s, i) => ({
          index: i,
          embedding: [s.length, s.includes("pandas") ? 1 : 0, s.includes("sql") ? 1 : 0, 1],
        }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test("EmbeddingClient retorna vetores na ordem e respeita egress", async () => {
  const srv = await embeddingsServer();
  try {
    const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
    const client = new EmbeddingClient(srv.baseUrl, "test-model", egress);
    assert.equal(client.available(), true);
    const vecs = await client.embed(["pandas dataframe", "sql query"]);
    assert.equal(vecs.length, 2);
    assert.equal(vecs[0][1], 1); // marca "pandas"
    assert.equal(vecs[1][2], 1); // marca "sql"

    const blocked = new EmbeddingClient("https://api.openai.com/v1", "m", egress);
    await assert.rejects(() => blocked.embed(["x"]));
  } finally {
    await srv.close();
  }
});

test("EmbeddingClient envia 'dimensions' quando configurado (MRL)", async () => {
  let received: any = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = JSON.parse(body);
      const data = (received.input as string[]).map((_s, i) => ({ index: i, embedding: [1, 2, 3, 4] }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
    const client = new EmbeddingClient(`http://127.0.0.1:${port}/v1`, "Qwen/Qwen3-Embedding-0.6B", egress, 256);
    await client.embed(["abc"]);
    assert.equal(received.dimensions, 256);
    assert.equal(received.model, "Qwen/Qwen3-Embedding-0.6B");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
