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
import { processRelayBatch } from "./obsRelay.mjs";
import { redact } from "./redaction.cjs";
import { extractUsage } from "./usage.mjs";
import { pruneExpired, admitSession, authorizeScope, renewedExpiry } from "./sessions.mjs";
import { buildProxyTraceEvents } from "./proxyTrace.mjs";
import { utcDay, overBudget, charge, settle, estimateRequestTokens, pruneOldDays, serializeLedger, parseLedger } from "./spend.mjs";

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
  spendLedgerPath: process.env.SPEND_LEDGER || path.join(__dirname, "spend-ledger.json"),
  spendFlushMs: parseInt(process.env.SPEND_FLUSH_MS || "30000", 10),
  reserveMaxOutput: parseInt(process.env.RESERVE_MAX_OUTPUT || "4096", 10), // saída estimada p/ a reserva anti-corrida
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
// Ledger de gasto (tokens/dia por subject) — teto AUTORITATIVO do FinOps (#12). DURÁVEL: carregado no boot
// e escrito periodicamente (o 1º write-path do gateway) para que o teto do dia sobreviva a restart — senão
// reiniciar zeraria o gasto e o teto seria burlável.
let spendLedger = new Map();
let spendPersistOk = true; // última persistência do ledger deu certo? Exposto no /health p/ alarmar durabilidade off.
try {
  if (fs.existsSync(CFG.spendLedgerPath)) spendLedger = parseLedger(fs.readFileSync(CFG.spendLedgerPath, "utf8"));
} catch (e) {
  logLine("warn", "spend-ledger ilegível no boot — começando vazio (o teto do dia pode subestimar)", { error: e.message });
}
const traceQueue = [];
let droppedTraces = 0;
let shuttingDown = false;

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
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return redact(s); // fonte ÚNICA compartilhada com o cliente (gateway/redaction.mjs) — antes MASK_PATTERNS divergia. (#8)
}
function enqueueTrace(ctx, record) {
  const lf = CFG.langfuse;
  if (!lf.enabled || !lf.secretKey) return;
  if (Math.random() > lf.sampleRate) return; // amostragem (RF-066)
  // Builder PURO/testável: identidade ATESTADA pela sessão (não o header spoofável), metadata sem PII crua,
  // usage no shape server-side (ver gateway/proxyTrace.mjs). Ids/tempo injetados.
  const events = buildProxyTraceEvents(ctx, record, {
    capture: lf.capture,
    environment: lf.environment,
    mask,
    newId: () => crypto.randomUUID(),
    nowIso: new Date().toISOString(),
  });
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
  // Rate-limit da ATIVAÇÃO por subject (licença): sem isto um portador válido pode marretar /activate e
  // inflar a tabela de sessões. Chave por subject limita cada licença, independente de IP.
  if (rateLimited("activate:" + v.payload.subject)) return send(res, 429, { error: "rate limited" });
  // Escopo AUTORITATIVO no servidor (ADR-3/RNF-002): a licença precisa de "codegen" para o proxy de
  // geração. Escopo vazio/ausente = licença legada → grandfather (não trava). "skills" é gateado por
  // requisição no proxy (depende do x-forge-skills). A licença carrega o escopo ASSINADO (não spoofável).
  const scope = Array.isArray(v.payload.scope) ? v.payload.scope : [];
  const scopeChk = authorizeScope(scope, false);
  if (!scopeChk.ok) {
    logLine("info", "ativação recusada — escopo insuficiente", { reqId, subject: v.payload.subject, missing: scopeChk.missing });
    return send(res, 403, { error: "license rejected", reason: "scope", missing: scopeChk.missing });
  }
  // Teto de sessões SEM mass-logout: expira as vencidas; se ainda cheio de sessões VIVAS, RECUSA a
  // ativação (503) em vez de deslogar terceiros (o antigo sweepSessions(true) varria todo mundo — DoS).
  if (!admitSession(sessions, CFG.maxSessions, Math.floor(Date.now() / 1000))) {
    logLine("warn", "capacidade de sessões esgotada — ativação recusada", { reqId });
    return send(res, 503, { error: "capacity" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Math.min(v.payload.expiry, Math.floor(Date.now() / 1000) + CFG.sessionTtlSec);
  // licenseExpiry fica na sessão para o /renew NÃO estender a sessão além da expiração assinada da licença.
  // budget (tokens/dia) é o teto autoritativo do FinOps — carimbado da licença ASSINADA (não spoofável).
  sessions.set(token, { subject: v.payload.subject, org: v.payload.org, scope, licenseExpiry: v.payload.expiry, budget: v.payload.budget || 0, expiresAt });
  logLine("info", "licença ativada", { reqId, subject: v.payload.subject, org: v.payload.org });
  send(res, 200, { token, expiresAt, subject: v.payload.subject, org: v.payload.org });
}

async function handleRenew(req, res, reqId) {
  const { token } = JSON.parse((await readBody(req)) || "{}");
  const s = sessions.get(token);
  if (!s) return send(res, 403, { error: "unknown token" });
  // Rate-limit da RENOVAÇÃO por subject: sem isto, um portador válido renova em loop para PINAR a tabela
  // de sessões (mantê-la cheia além do TTL) — o teto de capacidade viraria um 503 permanente para todos.
  if (rateLimited("renew:" + s.subject)) return send(res, 429, { error: "rate limited" });
  // Revogação enforçada na renovação: um subject revogado NÃO estende a sessão (o gap era exatamente
  // renovar indefinidamente uma sessão em memória). Mata a sessão para não vazar em requests seguintes.
  if (revocation.isRevoked(s.subject)) {
    sessions.delete(token);
    logLine("info", "renovação recusada — subject revogado", { reqId, subject: s.subject });
    return send(res, 403, { error: "revoked" });
  }
  // A renovação NÃO estende a sessão além da EXPIRAÇÃO da licença: sem o teto, uma licença VENCIDA seguiria
  // viva indefinidamente via renew (a revogação mordia, a expiração não).
  const renewed = renewedExpiry(s.licenseExpiry, Math.floor(Date.now() / 1000), CFG.sessionTtlSec);
  if (renewed === null) {
    sessions.delete(token);
    logLine("info", "renovação recusada — licença expirada", { reqId, subject: s.subject });
    return send(res, 403, { error: "expired" });
  }
  s.expiresAt = renewed;
  send(res, 200, { token, expiresAt: s.expiresAt, subject: s.subject, org: s.org });
}

// Relay governado de observabilidade: o cliente (GatewayRelaySink) envia eventos de WORKFLOW já no
// formato de ingestão do Langfuse; o gateway valida a sessão (+ revogação), e — via processRelayBatch —
// CARIMBA a identidade da sessão, aplica a captura/amostragem do ADMIN (não confia no cliente) e
// encaminha com a secretKey SERVER-SIDE. Fecha o gap de a secret viver no cliente E o de a governança
// de captura/identidade/amostragem depender do cliente. Fail-open: sem Langfuse, aceita e descarta.
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
  if (!lf.enabled || !lf.secretKey) return send(res, 202, { accepted: 0 });

  const { events, total, dropped } = processRelayBatch(body.batch, {
    capture: lf.capture,
    mask,
    environment: lf.environment,
    session,
    sampleRate: lf.sampleRate,
  });
  for (const e of events) {
    if (traceQueue.length >= lf.queueMax) {
      traceQueue.shift();
      droppedTraces++;
    }
    traceQueue.push(e);
  }
  logLine("info", "obs relay recebido", { reqId, org: session.org, eventos: total, aceitos: events.length, capados: dropped });
  send(res, 202, { accepted: events.length });
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
  const skills = (req.headers["x-forge-skills"] || "").split(",").filter(Boolean);
  // Escopo "skills" no proxy é BEST-EFFORT, não autoritativo: o gateway só proxia o corpo opaco e não
  // observa o uso real de skills — o sinal é o header x-forge-skills, que um cliente PATCHED pode omitir.
  // Barra o cliente honesto (defesa em profundidade). O controle load-bearing é "codegen", exigido na
  // ativação contra o payload ASSINADO (não spoofável). Escopo vazio/ausente na sessão = legado → grandfather.
  const scopeChk = authorizeScope(session.scope, skills.length > 0);
  if (!scopeChk.ok) {
    logLine("info", "proxy recusado — escopo insuficiente", { reqId, missing: scopeChk.missing });
    return send(res, 403, { error: "scope", missing: scopeChk.missing });
  }
  // Teto AUTORITATIVO de tokens/dia (FinOps #12): se o subject JÁ estourou o orçamento ASSINADO na licença,
  // barra ANTES de chamar o upstream (402). budget 0/ausente = ilimitado (grandfather).
  const day = utcDay(Date.now());
  if (overBudget(spendLedger, session.subject, day, session.budget)) {
    logLine("info", "proxy recusado — orçamento de tokens/dia excedido", { reqId, subject: session.subject, budget: session.budget });
    return send(res, 402, { error: "budget exceeded", scope: "daily-tokens", budget: session.budget });
  }
  // RESERVA SÍNCRONA (mesmo tick do overBudget, SEM await entre eles) — fecha a corrida check-then-charge:
  // requisições CONCORRENTES do mesmo subject veem a reserva e são barradas, limitando o estouro a ~uma
  // requisição em voo em vez do burst inteiro. Reconciliada ao custo REAL no finally.
  const reserve = session.budget > 0 ? estimateRequestTokens(bodyText, CFG.reserveMaxOutput) : 0;
  if (reserve > 0) charge(spendLedger, session.subject, day, reserve);

  const ctx = {
    // IDENTIDADE ATESTADA pela sessão (não o header x-forge-email, do cliente e spoofável): o userId do
    // trace deriva de session.subject via attestedUserId (hash em masked; e-mail cru só em 'full'). RF-063
    // é honrado em 'full' (opt-in do Admin), e a captura padrão 'masked' é LGPD-safe (pseudônimo estável).
    subject: session.subject,
    org: session.org,
    sessionId: req.headers["x-forge-session"] || "",
    provider: req.headers["x-forge-provider"] || "openai-compatible",
    model: req.headers["x-forge-model"] || "",
    skills,
  };

  const startTime = Date.now();
  let completionStartTime = 0;
  let output = "";
  try {
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
      return send(res, 502, { error: "upstream unavailable", detail: err.message }); // o finally reconcilia a reserva
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
    logLine("info", "geração proxiada", { reqId, org: ctx.org, model: ctx.model, ms: Date.now() - startTime });
  } finally {
    // Reconcilia a reserva ao gasto REAL — SEMPRE roda (sucesso, 502 ou erro de stream), garantindo que a
    // reserva nunca fique presa inflando o teto. O extractUsage foi corrigido (não inverte input↔output).
    if (session.budget > 0) {
      const u = extractUsage(output);
      settle(spendLedger, session.subject, day, reserve, (u.inputTokens || 0) + (u.outputTokens || 0));
    }
  }
}

function parseHeader(h) {
  const i = h.indexOf(":");
  return i > 0 ? { [h.slice(0, i).trim()]: h.slice(i + 1).trim() } : {};
}

// Persiste o ledger de gasto em disco (durável): poda dias antigos e grava só o dia corrente. Fail-open —
// uma falha de escrita não derruba o gateway (mas o teto do dia pode subestimar após um restart; o /health
// expõe spendPersistOk p/ alarmar). Escrita ATÔMICA (tmp + rename): um crash no meio nunca deixa o arquivo
// truncado — senão o parseLedger no boot cairia em vazio e ZERARIA o teto do dia (fail-open no lugar errado).
function persistSpendLedger() {
  try {
    const day = utcDay(Date.now());
    pruneOldDays(spendLedger, day);
    const tmp = CFG.spendLedgerPath + ".tmp";
    fs.writeFileSync(tmp, serializeLedger(spendLedger, day));
    fs.renameSync(tmp, CFG.spendLedgerPath);
    spendPersistOk = true;
  } catch (err) {
    spendPersistOk = false;
    logLine("warn", "falha ao persistir o spend-ledger (fail-open — durabilidade OFF até corrigir)", { error: err.message });
  }
}

// ---- servidor ---------------------------------------------------------------
async function router(req, res) {
  const reqId = crypto.randomUUID().slice(0, 8);
  if (shuttingDown) return send(res, 503, { error: "shutting down" });
  try {
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, {
        ok: true, version: VERSION, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        sessions: sessions.size, traceQueue: traceQueue.length, droppedTraces, langfuse: CFG.langfuse.enabled, spendSubjects: spendLedger.size, spendPersistOk,
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

const sweepTimer = setInterval(() => pruneExpired(sessions, Math.floor(Date.now() / 1000)), 60000);
const flushTimer = setInterval(() => void flushTraces(), CFG.langfuse.flushIntervalMs);
const spendTimer = setInterval(persistSpendLedger, CFG.spendFlushMs);

// Falha ao abrir o socket (porta em uso, permissão) é reportada e encerra limpo — sem isto, um
// EADDRINUSE vira exceção NÃO-tratada com stack trace crua (e o operador não sabe que é a porta).
server.on("error", (err) => {
  logLine("error", "falha ao abrir o socket do gateway — encerrando", { port: CFG.port, code: err.code, error: err.message });
  process.exit(1);
});

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
  clearInterval(spendTimer);
  persistSpendLedger(); // best-effort em saída graciosa (POSIX); a DURABILIDADE é garantida pelo timer de
  // flush, não por este handler — no Windows um kill pode não rodá-lo (a durabilidade não depende disto).
  server.close();
  for (let i = 0; i < 5 && traceQueue.length > 0; i++) await flushTraces();
  logLine("info", "encerrado", { tracesPendentes: traceQueue.length, descartados: droppedTraces });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
