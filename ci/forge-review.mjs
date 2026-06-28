#!/usr/bin/env node
// FORGE Review — revisão de Pull/Merge Request por IA, rodando na CI.
// "CodeRabbit soberano": chama um endpoint OpenAI-compatible IN-NETWORK (gateway
// ou HubGPU) — o código NÃO sai da empresa — e publica os achados como
// comentários inline (GitHub) ou uma nota de revisão (GitLab).
//
// Sem dependências (node:fs + fetch global). Requer Node >= 18.
//
// Variáveis (env):
//   LLM_BASE_URL     base OpenAI-compatible (termina em /v1). Vazio = pula (no-op).
//   LLM_MODEL        ex.: openai/gpt-oss-120b
//   LLM_AUTH_HEADER  opcional, "Header: valor"
//   FORGE_MAX_DIFF   tamanho máx. do diff enviado (chars). default 24000
//   --selftest       roda os parsers com fixtures e sai (sem rede)
//
//   GitHub:  GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH
//   GitLab:  CI_API_V4_URL, CI_PROJECT_ID, CI_MERGE_REQUEST_IID, GITLAB_TOKEN
import * as fs from "node:fs";

// ---- helpers puros (exportados e testados) ----------------------------------

/** Linhas adicionadas (numeração do arquivo NOVO) presentes no patch. */
export function parseAddedLines(patch) {
  const added = new Set();
  if (!patch) return added;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) {
      newLine = parseInt(m[1], 10);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      added.add(newLine);
      newLine++;
    } else if (raw.startsWith("-")) {
      // linha removida — não avança a numeração do arquivo novo
    } else {
      newLine++; // contexto
    }
  }
  return added;
}

/** Extrai o primeiro objeto JSON balanceado de um texto (a resposta do modelo). */
export function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const SEVERITIES = { critical: "🔴", warning: "🟠", suggestion: "🟡" };

/** Valida/normaliza os achados retornados pelo modelo. */
export function normalizeFindings(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const f of raw) {
    if (!f || typeof f.file !== "string" || typeof f.body !== "string") continue;
    const severity = SEVERITIES[f.severity] ? f.severity : "suggestion";
    const line = Number.isInteger(f.line) ? f.line : typeof f.line === "string" ? parseInt(f.line, 10) : NaN;
    out.push({
      file: f.file.replace(/^\.?\//, ""),
      line: Number.isInteger(line) ? line : null,
      severity,
      title: typeof f.title === "string" ? f.title : "",
      body: f.body,
      suggestion: typeof f.suggestion === "string" ? f.suggestion : "",
    });
  }
  return out;
}

function findingComment(f) {
  let s = `${SEVERITIES[f.severity]} **${f.title || "Achado"}** — _FORGE Review_\n\n${f.body}`;
  if (f.suggestion) s += `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
  return s;
}

export function buildSummary(verdict, summary, findings, inlineCount) {
  const v =
    verdict === "request_changes" ? "🔴 mudanças necessárias" : verdict === "approve" ? "✅ aprovar" : "🟠 aprovar com ressalvas";
  const counts = ["critical", "warning", "suggestion"]
    .map((s) => `${SEVERITIES[s]} ${findings.filter((f) => f.severity === s).length}`)
    .join(" · ");
  let body = `## 🔥 FORGE Review (in-network)\n\n**Veredito:** ${v}\n\n${summary || ""}\n\n${counts} · ${inlineCount} comentário(s) inline`;
  const offline = findings.filter((f) => f.line === null);
  if (offline.length) {
    body += `\n\n<details><summary>Achados sem linha exata</summary>\n\n`;
    for (const f of offline) body += `- ${SEVERITIES[f.severity]} \`${f.file}\` — ${f.title}: ${f.body}\n`;
    body += `\n</details>`;
  }
  body += `\n\n<sub>Revisado pelo HubGPU em rede interna — o código não saiu da empresa.</sub>`;
  return body;
}

// ---- chamada ao modelo ------------------------------------------------------

const REVIEW_SYSTEM = `Você é o FORGE Review, um revisor de código sênior da Claro. Revise o diff sob múltiplas
lentes (correção, segurança, dados/LGPD, performance, estilo) e responda SOMENTE com um objeto JSON
válido, em português do Brasil, no formato:
{"verdict":"approve|comment|request_changes","summary":"resumo curto","findings":[
  {"file":"caminho/arquivo","line":123,"severity":"critical|warning|suggestion","title":"título curto","body":"explicação e correção","suggestion":"código sugerido (opcional)"}
]}
Use a numeração de linha do arquivo NOVO. Não invente problemas; se estiver bom, retorne findings vazio
e verdict "approve". Não escreva nada fora do JSON.`;

async function callLlm(diffText) {
  const baseUrl = (process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
  const headers = { "content-type": "application/json" };
  const auth = process.env.LLM_AUTH_HEADER;
  if (auth && auth.includes(":")) {
    const i = auth.indexOf(":");
    headers[auth.slice(0, i).trim()] = auth.slice(i + 1).trim();
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: process.env.LLM_MODEL || "openai/gpt-oss-120b",
      stream: false,
      messages: [
        { role: "system", content: REVIEW_SYSTEM },
        { role: "user", content: `Revise estas alterações:\n\n${diffText}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM retornou ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

// ---- GitHub -----------------------------------------------------------------

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `token ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "forge-review",
      ...(init.headers || {}),
    },
  });
  return res;
}

async function runGitHub() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  if (!pr) return log("Sem pull_request no evento — pulando.");
  const repo = process.env.GITHUB_REPOSITORY;
  const number = pr.number;

  const filesRes = await gh(`/repos/${repo}/pulls/${number}/files?per_page=100`);
  const files = await filesRes.json();
  const added = new Map();
  let diffText = "";
  const max = parseInt(process.env.FORGE_MAX_DIFF || "24000", 10);
  for (const f of files) {
    if (!f.patch) continue;
    added.set(f.filename, parseAddedLines(f.patch));
    if (diffText.length < max) diffText += `\n### ${f.filename}\n${f.patch}\n`;
  }
  if (!diffText.trim()) return log("Nada para revisar.");

  const content = await callLlm(diffText.slice(0, max));
  const parsed = extractJson(content) || {};
  const findings = normalizeFindings(parsed.findings);

  const comments = [];
  for (const f of findings) {
    if (f.line !== null && added.get(f.file)?.has(f.line)) {
      comments.push({ path: f.file, line: f.line, side: "RIGHT", body: findingComment(f) });
    } else {
      f.line = null; // cai para o resumo
    }
  }
  const summaryBody = buildSummary(parsed.verdict, parsed.summary, findings, comments.length);

  let res = await gh(`/repos/${repo}/pulls/${number}/reviews`, {
    method: "POST",
    body: JSON.stringify({ event: "COMMENT", body: summaryBody, comments }),
  });
  if (!res.ok && comments.length) {
    log(`Review com inline falhou (${res.status}); publicando só o resumo.`);
    res = await gh(`/repos/${repo}/pulls/${number}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event: "COMMENT", body: summaryBody }),
    });
  }
  if (!res.ok) throw new Error(`GitHub review falhou: ${res.status} ${(await res.text()).slice(0, 300)}`);
  log(`FORGE Review publicado em ${repo}#${number}: ${comments.length} inline, veredito ${parsed.verdict || "comment"}.`);
}

// ---- GitLab (nota de resumo) ------------------------------------------------

async function runGitLab() {
  const api = process.env.CI_API_V4_URL;
  const project = process.env.CI_PROJECT_ID;
  const iid = process.env.CI_MERGE_REQUEST_IID;
  const token = process.env.GITLAB_TOKEN;
  const changesRes = await fetch(`${api}/projects/${project}/merge_requests/${iid}/changes`, {
    headers: { "private-token": token },
  });
  const changes = await changesRes.json();
  let diffText = "";
  const max = parseInt(process.env.FORGE_MAX_DIFF || "24000", 10);
  for (const c of changes.changes || []) {
    if (c.diff && diffText.length < max) diffText += `\n### ${c.new_path}\n${c.diff}\n`;
  }
  if (!diffText.trim()) return log("Nada para revisar.");
  const content = await callLlm(diffText.slice(0, max));
  const parsed = extractJson(content) || {};
  const findings = normalizeFindings(parsed.findings);
  let body = buildSummary(parsed.verdict, parsed.summary, findings, 0);
  for (const f of findings) body += `\n- ${SEVERITIES[f.severity]} \`${f.file}:${f.line ?? "?"}\` — ${f.title}: ${f.body}`;
  const res = await fetch(`${api}/projects/${project}/merge_requests/${iid}/notes`, {
    method: "POST",
    headers: { "private-token": token, "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`GitLab note falhou: ${res.status}`);
  log(`FORGE Review publicado no MR !${iid}.`);
}

function log(msg) {
  process.stdout.write(`[forge-review] ${msg}\n`);
}

function selftest() {
  const patch = "@@ -1,3 +1,4 @@\n ctx\n-old\n+new1\n+new2\n ctx2";
  const added = parseAddedLines(patch);
  log(`selftest addedLines = ${[...added].join(",")} (esperado 2,3)`);
  const j = extractJson('lixo antes {"verdict":"comment","findings":[]} lixo depois');
  log(`selftest extractJson.verdict = ${j?.verdict} (esperado comment)`);
  const f = normalizeFindings([{ file: "a.py", line: "5", severity: "x", body: "b", title: "t" }]);
  log(`selftest normalize = ${JSON.stringify(f[0])}`);
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  if (!process.env.LLM_BASE_URL) return log("LLM_BASE_URL não configurado — FORGE Review desativado (no-op).");
  try {
    if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) await runGitHub();
    else if (process.env.CI_MERGE_REQUEST_IID) await runGitLab();
    else log("Não está num contexto de PR/MR — pulando.");
  } catch (err) {
    log(`erro: ${err.message}`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("ci/forge-review.mjs");
if (invokedDirectly) void main();
