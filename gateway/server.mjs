#!/usr/bin/env node
// Gateway de referência do FORGE (server-side). Responsabilidades (SPEC §5.1.7):
//   1. Validação autoritativa de licença + tokens de sessão (RF-013/015/017).
//   2. Proxy de inferência ao provedor in-network (HubGPU).
//   3. Emissão de traces ao Langfuse com mascaramento/amostragem — único lugar
//      onde a secretKey do Langfuse existe (ADR-6, RNF-010).
//
// Endurecido para PoC robusta: validação de config, sessões com TTL e teto,
// exportação de traces em LOTE com buffer limitado (fail-open, RNF-013), rate
// limiting, request-id, shutdown gracioso e TLS opcional. Sem dependências
// (node:http/https + fetch global). Requer Node >= 18.
import * as http from "node:http";
import * as https from "node:https";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRevocationChecker } from "./revocations.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(__dirname, ".env"));

const STARTED_AT = Date.now();
const VERSION = "1.0.0";

const CFG = {
  port: parseInt(process.env.PORT || "8787", 10),
  upstreamBaseUrl: process.env.UPSTREAM_BASEURL || "https://hub-gpus.claro.com.br/gpt120/v1",
  upstreamAuthHeader: process.env.UPSTREAM_AUTH_HEADER || "",
  upstreamTimeoutMs: parseInt(process.env.UPSTREAM_TIMEOUT_MS || "300000", 10),
  keyinfoPath: process.env.KEYINFO || path.join(__dirname, "..", "admin-cli", "keys", "keyinfo.json"),
  revocationsPath: process.env.REVOCATIONS || path.join(__dirname, "..", "admin-cli", "keys", "revocations.json"),
  sessionTtlSec: parseInt(process.env.SESSION_TTL_SEC || "3600", 10),
  maxSessions: parseInt(process.env.MAX_SESSIONS || "10000", 10),
  rateLimitPerMin: parseInt(process.env.RATE_LIMIT_PER_MIN || "120", 10),
  tls: { key: process.env.HTTPS_KEY || "", cert: process.env.HTTPS_CERT || "" },
  langfuse: {
    enabled: (process.env.LANGFUSE_ENABLED || "false") === "true",
    baseUrl: process.env.LANGFUSE_BASEURL || "https://langfuse.interno.claro.com.br",
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || "",
    secretKey: process.env.LANGFUSE_SECRET_KEY || "", // SERVER-SIDE ONLY
    environment: process.env.LANGFUSE_ENV || "production",
    sampleRate: parseFloat(process.env.LANGFUSE_SAMPLE_RATE || "1.0"),
    capture: process.env.LANGFUSE_CAPTURE || "masked", // full | masked | metadata-only
    flushIntervalMs: parseInt(process.env.LANGFUSE_FLUSH_MS || "3000", 10),
    queueMax: parseInt(process.env.LANGFUSE_QUEUE_MAX || "1000", 10),
    batchMax: parseInt(process.env.LANGFUSE_BATCH_MAX || "50", 10),
  },
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const sessions = new Map(); // token -> { subject, org, expiresAt }
// Revogação enforçada em activate/renew/proxy (cache por assinatura mtime+size). Um subject revogado
// perde o acesso no próximo request, sem esperar o gateway reiniciar. Um JSON ilegível ANTES de
// qualquer lista boa (cold-start) é logado em ERROR — a revogação ainda não está garantida; depois de
// uma lista boa, um erro é só WARN (mantém a última lista conhecida).
let revocation;
revocation = createRevocationChecker(CFG.revocationsPath, {
  onError: (e) =>
    revocation && revocation.isReady()
      ? logLine("warn", "revocations.json ilegível — mantendo última lista boa", { error: e.message })
      : logLine("error", "revocations.json ILEGÍVEL no cold-start — revogação NÃO garantida até corrigir o arquivo", { error: e.message }),
});
const rateBuckets = new Map(); // key -> { tokens, updatedAt }
const traceQueue = [];
let droppedTraces = 0;
let shuttingDown = false;

const MASK_PATTERNS = [
  /sk-[a-zA-Z0-9]{16,}/g,
  /pk-lf-[a-zA-Z0-9-]{8,}/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b\d{11,16}\b/g,
];

// ---- infra ------------------------------------------------------------------
function loadDotEnv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
function logLine(level, msg, fields = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
}
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "="), "base64");
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(obj));
}
async function readBody(req, limitBytes = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error("payload muito grande");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---- config validation ------------------------------------------------------
function validateConfig() {
  const problems = [];
  if (!fs.existsSync(CFG.keyinfoPath)) problems.push(`keyinfo ausente em ${CFG.keyinfoPath} — rode 'npm run keygen'`);
  if (CFG.langfuse.enabled) {
    if (!CFG.langfuse.publicKey || !CFG.langfuse.secretKey) problems.push("LANGFUSE_ENABLED=true mas publicKey/secretKey ausentes");
    if (!(CFG.langfuse.sampleRate >= 0 && CFG.langfuse.sampleRate <= 1)) problems.push("LANGFUSE_SAMPLE_RATE deve estar entre 0 e 1");
  }
  if ((CFG.tls.key && !CFG.tls.cert) || (!CFG.tls.key && CFG.tls.cert)) problems.push("HTTPS_KEY e HTTPS_CERT devem ser fornecidos juntos");
  return problems;
}

// ---- licença ----------------------------------------------------------------
function publicKey() {
  const { publicKeyB64 } = JSON.parse(fs.readFileSync(CFG.keyinfoPath, "utf8"));
  const raw = Buffer.from(publicKeyB64, "base64");
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}
function verifyLicense(key) {
  const raw = key.startsWith("FORGE-") ? key.slice(6) : key;
  const dot = raw.indexOf(".");
  if (dot < 1) return { ok: false, reason: "format" };
  const payloadB64 = raw.slice(0, dot);
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(payloadB64, "utf8"), publicKey(), b64urlDecode(raw.slice(dot + 1)));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature" };
  const payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  if (payload.expiry <= Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };
  if (revocation.isRevoked(payload.subject)) return { ok: false, reason: "revoked" };
  return { ok: true, payload };
}

// ---- rate limiting (token bucket por chave) ---------------------------------
function rateLimited(key) {
  const cap = CFG.rateLimitPerMin;
  const refillPerMs = cap / 60000;
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b) {
    b = { tokens: cap, updatedAt: now };
    rateBuckets.set(key, b);
  }
  b.tokens = Math.min(cap, b.tokens + (now - b.updatedAt) * refillPerMs);
  b.updatedAt = now;
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}

// ---- observabilidade (fila em lote, fail-open, RNF-012/013) ------------------
function mask(value) {
  if (CFG.langfuse.capture === "metadata-only") return undefined;
  if (CFG.langfuse.capture === "full") return value;
  let s = typeof value === "string" ? value : JSON.stringify(value);
  for (const re of MASK_PATTERNS) s = s.replace(re, "‹redacted›");
  return s;
}
function enqueueTrace(ctx, record) {
  const lf = CFG.langfuse;
  if (!lf.enabled || !lf.secretKey) return;
  if (Math.random() > lf.sampleRate) return; // amostragem (RF-066)
  const traceId = crypto.randomUUID();
  const genId = crypto.randomUUID();
  const ts = new Date().toISOString();
  const events = [
    { id: crypto.randomUUID(), type: "trace-create", timestamp: ts, body: { id: traceId, name: "forge.generation", userId: ctx.email || ctx.login || ctx.subjectHash, environment: lf.environment, metadata: ctx } },
    {
      id: crypto.randomUUID(),
      type: "generation-create",
      timestamp: ts,
      body: {
        id: genId, traceId, name: "generation", model: ctx.modelId,
        input: mask(record.input), output: mask(record.output), usage: record.usage,
        startTime: new Date(record.startTime).toISOString(),
        completionStartTime: record.completionStartTime ? new Date(record.completionStartTime).toISOString() : undefined,
        endTime: new Date(record.endTime).toISOString(), metadata: ctx,
      },
    },
  ];
  for (const e of events) {
    if (traceQueue.length >= lf.queueMax) {
      traceQueue.shift(); // descarte controlado — buffer com teto
      droppedTraces++;
    }
    traceQueue.push(e);
  }
}
async function flushTraces() {
  const lf = CFG.langfuse;
  if (!lf.enabled || !lf.secretKey || traceQueue.length === 0) return;
  const batch = traceQueue.splice(0, lf.batchMax);
  try {
    const auth = "Basic " + Buffer.from(`${lf.publicKey}:${lf.secretKey}`).toString("base64");
    const res = await fetch(`${lf.baseUrl.replace(/\/+$/, "")}/api/public/ingestion`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ batch }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) logLine("warn", "langfuse ingestion não-OK (fail-open)", { status: res.status });
  } catch (err) {
    // fail-open: re-enfileira no máximo uma vez se ainda há espaço.
    if (traceQueue.length + batch.length <= lf.queueMax) traceQueue.unshift(...batch);
    else droppedTraces += batch.length;
    logLine("warn", "falha ao enviar traces (fail-open)", { error: err.message });
  }
}

// ---- rotas ------------------------------------------------------------------
async function handleActivate(req, res, reqId) {
  const { key } = JSON.parse((await readBody(req)) || "{}");
  if (!key) return send(res, 400, { error: "missing key" });
  const v = verifyLicense(key);
  if (!v.ok) {
    logLine("info", "licença recusada", { reqId, reason: v.reason });
    return send(res, 403, { error: "license rejected", reason: v.reason });
  }
  if (sessions.size >= CFG.maxSessions) sweepSessions(true);
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Math.min(v.payload.expiry, Math.floor(Date.now() / 1000) + CFG.sessionTtlSec);
  sessions.set(token, { subject: v.payload.subject, org: v.payload.org, expiresAt });
  logLine("info", "licença ativada", { reqId, subject: v.payload.subject, org: v.payload.org });
  send(res, 200, { token, expiresAt, subject: v.payload.subject, org: v.payload.org });
}

async function handleRenew(req, res, reqId) {
  const { token } = JSON.parse((await readBody(req)) || "{}");
  const s = sessions.get(token);
  if (!s) return send(res, 403, { error: "unknown token" });
  // Revogação enforçada na renovação: um subject revogado NÃO estende a sessão (o gap era exatamente
  // renovar indefinidamente uma sessão em memória). Mata a sessão para não vazar em requests seguintes.
  if (revocation.isRevoked(s.subject)) {
    sessions.delete(token);
    logLine("info", "renovação recusada — subject revogado", { reqId, subject: s.subject });
    return send(res, 403, { error: "revoked" });
  }
  s.expiresAt = Math.floor(Date.now() / 1000) + CFG.sessionTtlSec;
  send(res, 200, { token, expiresAt: s.expiresAt, subject: s.subject, org: s.org });
}

// Relay governado de observabilidade: o cliente (GatewayRelaySink) envia eventos de WORKFLOW já no
// formato de ingestão do Langfuse; o gateway valida a sessão (+ revogação) e os encaminha com a
// secretKey SERVER-SIDE — fechando o gap de a secret viver no cliente. Fail-open: sem Langfuse
// habilitado, aceita e descarta (o cliente não precisa saber). Respeita amostragem/teto da fila.
async function handleObsIngest(req, res, reqId) {
  const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) {
    return send(res, 401, { error: "invalid session" });
  }
  if (revocation.isRevoked(session.subject)) {
    sessions.delete(token);
    return send(res, 403, { error: "revoked" });
  }
  if (rateLimited("obs:" + token)) return send(res, 429, { error: "rate limited" });
  const lf = CFG.langfuse;
  const body = JSON.parse((await readBody(req, 4_000_000)) || "{}");
  const batch = Array.isArray(body.batch) ? body.batch : [];
  // Sem Langfuse habilitado/sample-out, aceita silenciosamente (o cliente é fail-open e não deve travar).
  if (!lf.enabled || !lf.secretKey) return send(res, 202, { accepted: 0 });
  let accepted = 0;
  for (const e of batch) {
    if (!e || typeof e !== "object") continue;
    if (Math.random() > lf.sampleRate) continue; // amostragem governada pelo Admin (server-side)
    if (traceQueue.length >= lf.queueMax) {
      traceQueue.shift();
      droppedTraces++;
    }
    traceQueue.push(e);
    accepted++;
  }
  logLine("info", "obs relay recebido", { reqId, org: session.org, eventos: batch.length, aceitos: accepted });
  send(res, 202, { accepted });
}

async function handleProxy(req, res, reqId) {
  const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) {
    return send(res, 401, { error: "invalid session" }); // RF-013 recusa autoritativa
  }
  // Revogação enforçada no proxy: mesmo com sessão válida e não-expirada, um subject revogado é
  // barrado no PRÓXIMO request de inferência (sem esperar restart do gateway). Mata a sessão.
  if (revocation.isRevoked(session.subject)) {
    sessions.delete(token);
    logLine("info", "proxy recusado — subject revogado", { reqId, subject: session.subject });
    return send(res, 403, { error: "revoked" });
  }
  if (rateLimited(token)) return send(res, 429, { error: "rate limited" });

  const bodyText = await readBody(req);
  const ctx = {
    sessionId: req.headers["x-forge-session"] || "",
    email: req.headers["x-forge-email"] || session.subject || "", // RF-063: identidade principal (userId)
    login: req.headers["x-forge-login"] || "", // metadado secundário (login do SO)
    org: session.org,
    subjectHash: crypto.createHash("sha256").update(session.subject).digest("hex").slice(0, 16),
    provider: req.headers["x-forge-provider"] || "openai-compatible",
    modelId: req.headers["x-forge-model"] || "",
    activatedSkills: (req.headers["x-forge-skills"] || "").split(",").filter(Boolean),
  };

  const startTime = Date.now();
  let completionStartTime = 0;
  let output = "";
  let upstream;
  try {
    upstream = await fetch(`${CFG.upstreamBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(CFG.upstreamAuthHeader ? parseHeader(CFG.upstreamAuthHeader) : {}) },
      body: bodyText,
      signal: AbortSignal.timeout(CFG.upstreamTimeoutMs),
    });
  } catch (err) {
    logLine("error", "upstream inacessível", { reqId, error: err.message });
    return send(res, 502, { error: "upstream unavailable", detail: err.message });
  }
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "text/event-stream" });
  const reader = upstream.body?.getReader();
  const decoder = new TextDecoder();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!completionStartTime) completionStartTime = Date.now();
      output += decoder.decode(value, { stream: true });
      res.write(value);
    }
  }
  res.end();
  enqueueTrace(ctx, { input: bodyText, output, usage: extractUsage(output), startTime, completionStartTime, endTime: Date.now() });
  logLine("info", "geração proxiada", { reqId, org: ctx.org, model: ctx.modelId, ms: Date.now() - startTime });
}

function parseHeader(h) {
  const i = h.indexOf(":");
  return i > 0 ? { [h.slice(0, i).trim()]: h.slice(i + 1).trim() } : {};
}
function extractUsage(sse) {
  const m = /"completion_tokens"\s*:\s*(\d+)[\s\S]*?"prompt_tokens"\s*:\s*(\d+)/.exec(sse) || /"prompt_tokens"\s*:\s*(\d+)[\s\S]*?"completion_tokens"\s*:\s*(\d+)/.exec(sse);
  return m ? { inputTokens: parseInt(m[2] || m[1], 10), outputTokens: parseInt(m[1] || m[2], 10) } : { inputTokens: 0, outputTokens: 0 };
}

function sweepSessions(force = false) {
  const now = Math.floor(Date.now() / 1000);
  for (const [token, s] of sessions) if (force || s.expiresAt <= now) sessions.delete(token);
}

// ---- servidor ---------------------------------------------------------------
async function router(req, res) {
  const reqId = crypto.randomUUID().slice(0, 8);
  if (shuttingDown) return send(res, 503, { error: "shutting down" });
  try {
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, {
        ok: true, version: VERSION, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        sessions: sessions.size, traceQueue: traceQueue.length, droppedTraces, langfuse: CFG.langfuse.enabled,
      });
    }
    if (req.method === "POST" && req.url === "/license/activate") return handleActivate(req, res, reqId);
    if (req.method === "POST" && req.url === "/license/renew") return handleRenew(req, res, reqId);
    if (req.method === "POST" && req.url === "/obs/ingest") return handleObsIngest(req, res, reqId);
    if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) return handleProxy(req, res, reqId);
    send(res, 404, { error: "not found" });
  } catch (err) {
    logLine("error", "erro de requisição", { reqId, error: err.message });
    if (!res.headersSent) send(res, 500, { error: err.message });
  }
}

const problems = validateConfig();
for (const p of problems) logLine("warn", "config", { problem: p });
if (problems.some((p) => p.includes("keyinfo ausente"))) {
  logLine("error", "config inválida — encerrando", {});
  process.exit(1);
}

const server = CFG.tls.key && CFG.tls.cert
  ? https.createServer({ key: fs.readFileSync(CFG.tls.key), cert: fs.readFileSync(CFG.tls.cert) }, router)
  : http.createServer(router);

const sweepTimer = setInterval(() => sweepSessions(false), 60000);
const flushTimer = setInterval(() => void flushTraces(), CFG.langfuse.flushIntervalMs);

server.listen(CFG.port, () => {
  logLine("info", "gateway no ar", {
    url: `${CFG.tls.key ? "https" : "http"}://localhost:${CFG.port}`,
    upstream: CFG.upstreamBaseUrl,
    langfuse: CFG.langfuse.enabled ? `${CFG.langfuse.baseUrl} (${CFG.langfuse.capture}, sample ${CFG.langfuse.sampleRate})` : "off",
    secretKeyPresente: !!CFG.langfuse.secretKey,
  });
});

// Shutdown gracioso: para de aceitar, drena a fila de traces e encerra.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logLine("info", "encerrando", { signal });
  clearInterval(sweepTimer);
  clearInterval(flushTimer);
  server.close();
  for (let i = 0; i < 5 && traceQueue.length > 0; i++) await flushTraces();
  logLine("info", "encerrado", { tracesPendentes: traceQueue.length, descartados: droppedTraces });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
