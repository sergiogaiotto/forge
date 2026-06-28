import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";
import { OpenAICompatibleProvider } from "../api/providers/OpenAICompatibleProvider";
import { StreamChunk } from "../api/types";
import { EgressEnforcer } from "../net/EgressEnforcer";

function sseServer(frames: string[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const f of frames) res.write(`data: ${f}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

test("streams text, reasoning and usage from an OpenAI-compatible endpoint", async () => {
  const srv = await sseServer([
    JSON.stringify({ choices: [{ delta: { reasoning_content: "pensando…" } }] }),
    JSON.stringify({ choices: [{ delta: { content: "Olá" } }] }),
    JSON.stringify({ choices: [{ delta: { content: " mundo" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
  ]);
  try {
    const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
    const provider = new OpenAICompatibleProvider(
      { type: "openai-compatible", modelId: "openai/gpt-oss-120b", baseUrl: srv.baseUrl, apiKey: "not-needed", timeoutSeconds: 30 },
      egress
    );
    const chunks = await collect(provider.createMessage("sys", [{ role: "user", content: "oi" }], { timeoutMs: 5000 }));
    const text = chunks.filter((c) => c.kind === "text").map((c) => (c as any).text).join("");
    const reasoning = chunks.filter((c) => c.kind === "reasoning").map((c) => (c as any).text).join("");
    const usage = chunks.find((c) => c.kind === "usage") as any;
    assert.equal(text, "Olá mundo");
    assert.equal(reasoning, "pensando…");
    assert.equal(usage.inputTokens, 7);
    assert.equal(usage.outputTokens, 3);
  } finally {
    await srv.close();
  }
});

test("egress enforcer blocks the request to an external host", async () => {
  const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
  const provider = new OpenAICompatibleProvider(
    { type: "openai-compatible", modelId: "m", baseUrl: "https://api.openai.com/v1", apiKey: "x", timeoutSeconds: 5 },
    egress
  );
  await assert.rejects(async () => {
    for await (const _ of provider.createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 2000 })) {
      // nunca deve emitir — o egress (assertAllowed) lança antes
    }
  });
});
