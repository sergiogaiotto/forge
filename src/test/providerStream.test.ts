import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";
import { AnthropicProvider } from "../api/providers/AnthropicProvider";
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

test("envia max_tokens no corpo da requisição (evita truncamento pelo default do gateway)", async () => {
  let body: any;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
    // sem maxTokens explícito → deve cair no DEFAULT_MAX_TOKENS
    const provider = new OpenAICompatibleProvider(
      { type: "openai-compatible", modelId: "m", baseUrl: `http://127.0.0.1:${port}`, apiKey: "not-needed", timeoutSeconds: 10 },
      egress
    );
    await collect(provider.createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000 }));
    assert.equal(typeof body.max_tokens, "number");
    assert.ok(body.max_tokens >= 8192, "max_tokens deve ser generoso para caber um arquivo completo");
    // respeita override explícito
    body = undefined;
    const provider2 = new OpenAICompatibleProvider(
      { type: "openai-compatible", modelId: "m", baseUrl: `http://127.0.0.1:${port}`, apiKey: "not-needed", timeoutSeconds: 10, maxTokens: 4096 },
      egress
    );
    await collect(provider2.createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000 }));
    assert.ok(body, "a segunda requisição deve ter chegado ao servidor");
    assert.equal(body.max_tokens, 4096);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("envia reasoning_effort no corpo quando configurado; omite quando ausente", async () => {
  let body: any;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
    const withEffort = new OpenAICompatibleProvider(
      { type: "openai-compatible", modelId: "openai/gpt-oss-120b", baseUrl: `http://127.0.0.1:${port}`, apiKey: "not-needed", timeoutSeconds: 30, reasoningEffort: "high" },
      egress
    );
    await collect(withEffort.createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000 }));
    assert.equal(body.reasoning_effort, "high");
    body = undefined;
    const noEffort = new OpenAICompatibleProvider(
      { type: "openai-compatible", modelId: "m", baseUrl: `http://127.0.0.1:${port}`, apiKey: "not-needed", timeoutSeconds: 30 },
      egress
    );
    await collect(noEffort.createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000 }));
    assert.ok(body && !("reasoning_effort" in body), "sem reasoningEffort configurado, não deve enviar o campo");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// temperature 0 é FALSY: o provider tem de checar `!== undefined`, não truthiness — regressão aqui
// devolveria a variância de amostragem às tarefas estruturadas (blueprint/charter) silenciosamente.
test("envia temperature no corpo quando configurada (inclusive 0); omite quando ausente", async () => {
  let body: any;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
    const zero = new OpenAICompatibleProvider(
      { type: "openai-compatible", modelId: "m", baseUrl: `http://127.0.0.1:${port}`, apiKey: "not-needed", timeoutSeconds: 10, temperature: 0 },
      egress
    );
    await collect(zero.createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000 }));
    assert.equal(body.temperature, 0);
    body = undefined;
    const absent = new OpenAICompatibleProvider(
      { type: "openai-compatible", modelId: "m", baseUrl: `http://127.0.0.1:${port}`, apiKey: "not-needed", timeoutSeconds: 10 },
      egress
    );
    await collect(absent.createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000 }));
    assert.ok(body && !("temperature" in body), "sem temperature configurada, não deve enviar o campo");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// JSON garantido pelo decoder: response_format só vai quando opts.jsonResponse; gateway antigo que
// rejeita com 400 mencionando response_format ganha UMA reemissão automática sem o campo.
test("envia response_format com jsonResponse e DEGRADA sozinho quando o gateway rejeita", async () => {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      if (body.response_format) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "response_format is not supported" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "[]" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
    const provider = new OpenAICompatibleProvider(
      { type: "openai-compatible", modelId: "openai/gpt-oss-120b", baseUrl: `http://127.0.0.1:${port}`, apiKey: "not-needed", timeoutSeconds: 10 },
      egress
    );
    const chunks = await collect(provider.createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000, jsonResponse: true }));
    assert.equal(bodies.length, 2, "deve reenviar UMA vez sem response_format");
    assert.deepEqual(bodies[0].response_format, { type: "json_object" });
    assert.ok(!("response_format" in bodies[1]));
    const text = chunks.filter((c) => c.kind === "text").map((c) => (c as any).text).join("");
    assert.equal(text, "[]"); // a degradação entrega a resposta normal
    // sem jsonResponse, o campo NUNCA vai
    bodies.length = 0;
    await collect(provider.createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000 }));
    assert.equal(bodies.length, 1);
    assert.ok(!("response_format" in bodies[0]));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("emite warning NÃO-fatal quando finish_reason é 'length' (truncamento)", async () => {
  const srv = await sseServer([
    JSON.stringify({ choices: [{ delta: { content: "início do arquivo…" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 16384 } }),
  ]);
  try {
    const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
    const provider = new OpenAICompatibleProvider(
      { type: "openai-compatible", modelId: "openai/gpt-oss-120b", baseUrl: srv.baseUrl, apiKey: "not-needed", timeoutSeconds: 30 },
      egress
    );
    const chunks = await collect(provider.createMessage("sys", [{ role: "user", content: "oi" }], { timeoutMs: 5000 }));
    const text = chunks.filter((c) => c.kind === "text").map((c) => (c as any).text).join("");
    const warning = chunks.find((c) => c.kind === "warning") as any;
    // o texto parcial é preservado e há um aviso (não um erro) sobre o truncamento
    assert.equal(text, "início do arquivo…");
    assert.ok(warning, "deveria emitir um chunk warning");
    assert.match(warning.message, /truncad/i);
    assert.ok(!chunks.some((c) => c.kind === "error"), "truncamento não deve virar erro fatal");
  } finally {
    await srv.close();
  }
});

// ---- Modo NÃO-STREAMING (opts.streaming: false) ---------------------------------------------------
// Servidor de resposta JSON única (não-SSE) com contador de chamadas e responder por-chamada — para
// os testes de retry-once e content-vazio. Captura o corpo da 1ª requisição em `bodies[0]`.
function jsonServer(responder: (call: number) => { status: number; json?: unknown; text?: string }): Promise<{ baseUrl: string; bodies: any[]; calls: () => number; close: () => Promise<void> }> {
  const bodies: any[] = [];
  let calls = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        calls++;
        try {
          bodies.push(JSON.parse(raw));
        } catch {
          bodies.push(null);
        }
        const r = responder(calls);
        res.writeHead(r.status, { "content-type": r.json !== undefined ? "application/json" : "text/plain" });
        res.end(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ""));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, bodies, calls: () => calls, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

function mkProvider(baseUrl: string, extra: Record<string, unknown> = {}) {
  const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
  return new OpenAICompatibleProvider(
    { type: "openai-compatible", modelId: "openai/gpt-oss-120b", baseUrl, apiKey: "not-needed", timeoutSeconds: 30, ...extra } as any,
    egress
  );
}

test("não-streaming: emite a MESMA sequência de chunks (usage/reasoning/text) de uma resposta JSON única", async () => {
  const srv = await jsonServer(() => ({
    status: 200,
    json: { choices: [{ message: { content: "Olá mundo", reasoning_content: "pensando…" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
  }));
  try {
    const chunks = await collect(mkProvider(srv.baseUrl).createMessage("sys", [{ role: "user", content: "oi" }], { timeoutMs: 5000, streaming: false }));
    assert.equal(srv.bodies[0].stream, false, "streaming:false deve enviar stream:false no corpo");
    assert.ok(!("stream_options" in srv.bodies[0]), "não-streaming não envia stream_options");
    const text = chunks.filter((c) => c.kind === "text").map((c) => (c as any).text).join("");
    const reasoning = chunks.filter((c) => c.kind === "reasoning").map((c) => (c as any).text).join("");
    const usage = chunks.find((c) => c.kind === "usage") as any;
    assert.equal(text, "Olá mundo");
    assert.equal(reasoning, "pensando…");
    assert.equal(usage.inputTokens, 7);
    assert.equal(usage.outputTokens, 3);
    assert.ok(!chunks.some((c) => c.kind === "error"));
  } finally {
    await srv.close();
  }
});

test("não-streaming: warning NÃO-fatal quando finish_reason é 'length' (lido direto do corpo)", async () => {
  const srv = await jsonServer(() => ({
    status: 200,
    json: { choices: [{ message: { content: "início do arquivo…" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 16384 } },
  }));
  try {
    const chunks = await collect(mkProvider(srv.baseUrl).createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000, streaming: false }));
    const text = chunks.filter((c) => c.kind === "text").map((c) => (c as any).text).join("");
    const warning = chunks.find((c) => c.kind === "warning") as any;
    assert.equal(text, "início do arquivo…");
    assert.ok(warning && /truncad/i.test(warning.message));
    assert.ok(!chunks.some((c) => c.kind === "error"), "truncamento não vira erro fatal");
  } finally {
    await srv.close();
  }
});

test("não-streaming: DEGRADA response_format sozinho em 400 (mesma via compartilhada do streaming)", async () => {
  const srv = await jsonServer((call) =>
    call === 1
      ? { status: 400, json: { error: { message: "response_format is not supported" } } }
      : { status: 200, json: { choices: [{ message: { content: "[]" }, finish_reason: "stop" }] } }
  );
  try {
    const chunks = await collect(mkProvider(srv.baseUrl).createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000, streaming: false, jsonResponse: true }));
    assert.equal(srv.calls(), 2, "deve reenviar UMA vez sem response_format");
    assert.deepEqual(srv.bodies[0].response_format, { type: "json_object" });
    assert.ok(!("response_format" in srv.bodies[1]));
    assert.equal(chunks.filter((c) => c.kind === "text").map((c) => (c as any).text).join(""), "[]");
  } finally {
    await srv.close();
  }
});

test("não-streaming: retry-once quando a resposta vem SEM choices (transitória do gateway)", async () => {
  const srv = await jsonServer((call) =>
    call === 1
      ? { status: 200, json: { object: "chat.completion" } } // sem choices → transitória
      : { status: 200, json: { choices: [{ message: { content: "recuperado" }, finish_reason: "stop" }] } }
  );
  try {
    const chunks = await collect(mkProvider(srv.baseUrl).createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000, streaming: false }));
    assert.equal(srv.calls(), 2, "deve refazer a chamada UMA vez");
    assert.equal(chunks.filter((c) => c.kind === "text").map((c) => (c as any).text).join(""), "recuperado");
    assert.ok(!chunks.some((c) => c.kind === "error"));
  } finally {
    await srv.close();
  }
});

// REGRESSÃO: content VAZIO com choices é resultado LEGÍTIMO (o raciocínio consumiu todo o max_tokens).
// NÃO pode disparar o retry-once (queimaria tokens repetindo) — o retry é só para resposta malformada.
test("não-streaming: content vazio COM choices NÃO retria e não vira erro", async () => {
  const srv = await jsonServer(() => ({
    status: 200,
    json: { choices: [{ message: { content: "", reasoning_content: "raciocínio que comeu o orçamento" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 110 } },
  }));
  try {
    const chunks = await collect(mkProvider(srv.baseUrl).createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000, streaming: false }));
    assert.equal(srv.calls(), 1, "content vazio legítimo NÃO deve refazer a chamada");
    assert.ok(!chunks.some((c) => c.kind === "text"), "sem content → nenhum chunk de texto");
    assert.ok(chunks.some((c) => c.kind === "reasoning"), "o raciocínio é emitido (para o resgate a jusante)");
    assert.ok(chunks.some((c) => c.kind === "warning"), "finish_reason=length → warning");
    assert.ok(!chunks.some((c) => c.kind === "error"), "content vazio não é erro");
  } finally {
    await srv.close();
  }
});

// REGRESSÃO (revisão adversarial): o retry-once do não-streaming deve passar pela MESMA degradação de
// response_format. Sequência: 1ª resposta 200 SEM choices (transitória) → retry cai num 400 que rejeita
// response_format → degrada (remove o campo) → sucede. Sem o fix, o retry reenviaria o campo e daria erro seco.
test("não-streaming: retry após 'sem choices' passa pela degradação de response_format", async () => {
  const srv = await jsonServer((call) =>
    call === 1
      ? { status: 200, json: { object: "chat.completion" } } // sem choices → transitória
      : call === 2
        ? { status: 400, json: { error: { message: "response_format is not supported" } } }
        : { status: 200, json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } }
  );
  try {
    const chunks = await collect(mkProvider(srv.baseUrl).createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000, streaming: false, jsonResponse: true }));
    assert.equal(srv.calls(), 3, "1ª sem choices → retry que degrada (400) → sucesso");
    assert.deepEqual(srv.bodies[0].response_format, { type: "json_object" });
    assert.ok(!("response_format" in srv.bodies[2]), "a chamada final NÃO envia response_format (degradou)");
    assert.equal(chunks.filter((c) => c.kind === "text").map((c) => (c as any).text).join(""), "ok");
    assert.ok(!chunks.some((c) => c.kind === "error"));
  } finally {
    await srv.close();
  }
});

// REGRESSÃO (revisão adversarial): tool_calls sem id no não-streaming recebem ids DISTINTOS por índice
// (como no streaming) — "call_0" fixo colidiria e um consumidor que dedup por id veria só uma.
test("não-streaming: tool_calls sem id recebem ids distintos por índice", async () => {
  const srv = await jsonServer(() => ({
    status: 200,
    json: { choices: [{ message: { tool_calls: [{ function: { name: "a", arguments: "{}" } }, { function: { name: "b", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
  }));
  try {
    const chunks = await collect(mkProvider(srv.baseUrl).createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000, streaming: false }));
    const calls = chunks.filter((c) => c.kind === "tool_call") as any[];
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].id, calls[1].id, "ids devem ser distintos");
    assert.deepEqual(calls.map((c) => c.name), ["a", "b"]);
  } finally {
    await srv.close();
  }
});

test("emite warning ao truncar mesmo após reasoning_content (caminho típico do gpt-oss)", async () => {
  const srv = await sseServer([
    JSON.stringify({ choices: [{ delta: { reasoning_content: "pensando muito…" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 16384 } }),
  ]);
  try {
    const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
    const provider = new OpenAICompatibleProvider(
      { type: "openai-compatible", modelId: "openai/gpt-oss-120b", baseUrl: srv.baseUrl, apiKey: "not-needed", timeoutSeconds: 30 },
      egress
    );
    const chunks = await collect(provider.createMessage("sys", [{ role: "user", content: "oi" }], { timeoutMs: 5000 }));
    const reasoning = chunks.filter((c) => c.kind === "reasoning").map((c) => (c as any).text).join("");
    const warnings = chunks.filter((c) => c.kind === "warning");
    assert.equal(reasoning, "pensando muito…"); // raciocínio parcial preservado
    assert.equal(warnings.length, 1, "exatamente um aviso (sem duplicação)");
    assert.ok(!chunks.some((c) => c.kind === "error"));
  } finally {
    await srv.close();
  }
});

test("encaminha os headers de trace (x-forge-login) ao endpoint", async () => {
  let received: http.IncomingHttpHeaders | undefined;
  const server = http.createServer((req, res) => {
    received = req.headers;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
    const provider = new OpenAICompatibleProvider(
      { type: "openai-compatible", modelId: "m", baseUrl: `http://127.0.0.1:${port}`, apiKey: "not-needed", timeoutSeconds: 10 },
      egress
    );
    await collect(
      provider.createMessage("s", [{ role: "user", content: "hi" }], {
        timeoutMs: 5000,
        extraHeaders: { "x-forge-login": "sergio.gaiotto", "x-forge-session": "sess-1", "x-forge-skills": "pandas-defensive-pipelines" },
      })
    );
    assert.equal(received?.["x-forge-login"], "sergio.gaiotto");
    assert.equal(received?.["x-forge-session"], "sess-1");
    assert.equal(received?.["x-forge-skills"], "pandas-defensive-pipelines");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("Anthropic envia max_tokens generoso e avisa em stop_reason 'max_tokens'", async () => {
  let body: any;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "parcial" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 16384 } })}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const egress = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, () => undefined);
    const provider = new AnthropicProvider(
      { type: "anthropic", modelId: "claude-sonnet-4-6", baseUrl: `http://127.0.0.1:${port}`, apiKey: "not-needed", timeoutSeconds: 10 },
      egress
    );
    const chunks = await collect(provider.createMessage("s", [{ role: "user", content: "hi" }], { timeoutMs: 5000 }));
    assert.ok(body.max_tokens >= 8192, "Anthropic deve usar o teto generoso, não 8192 hardcoded");
    const text = chunks.filter((c) => c.kind === "text").map((c) => (c as any).text).join("");
    assert.equal(text, "parcial");
    assert.ok(chunks.some((c) => c.kind === "warning"), "stop_reason max_tokens deve emitir warning");
    assert.ok(!chunks.some((c) => c.kind === "error"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
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
