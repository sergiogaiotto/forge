// TESTE E2E (item 3 do hardening): sobe o GATEWAY REAL (gateway/server.mjs) + um upstream FAKE, gera um
// par de chaves e emite uma licença de TESTE pelo admin-cli REAL, e dirige o fluxo ponta-a-ponta
// license↔gateway↔provider — activate → proxy (geração) → revogação enforçada AO VIVO. É o único teste
// que exercita os processos reais integrados (o resto da suíte cobre os módulos puros em unidade).
//
// Nada de mocks do gateway: o server.mjs de referência roda como processo, com KEYINFO/REVOCATIONS/
// UPSTREAM apontados para artefatos temporários. Fecha o gap "nada sobe extension-host + gateway +
// provider ponta a ponta" (Gap #5 da gap analysis) na fatia que não depende do VSCode.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADMIN_CLI = path.join(REPO, "admin-cli", "forge-admin.mjs");
const GATEWAY = path.join(REPO, "gateway", "server.mjs");
const SUBJECT = "e2e@claro.com";

// Porta livre: escuta em 0, lê a porta atribuída e fecha. Há uma janela de corrida até o gateway
// reclamá-la, aceitável em teste local (sem serviços concorrentes).
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

// Upstream FAKE: responde /chat/completions com um SSE mínimo (conteúdo + usage + [DONE]), como o vLLM.
function startFakeUpstream(): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url && req.url.endsWith("/chat/completions")) {
      hits++;
      // drena o corpo (o gateway repassa o payload do cliente) e responde streaming
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"print(\\"forge e2e\\")"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":4}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        hits: () => hits,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function waitForHealth(base: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("gateway não respondeu /health a tempo");
}

test("E2E license↔gateway↔provider: activate → proxy (geração) → 401 sem token → revogação enforçada ao vivo", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-e2e-"));
  const keysDir = path.join(tmp, "keys");
  const node = process.execPath;
  const fake = await startFakeUpstream();
  let gw: ChildProcess | undefined;
  let gwLog = "";
  try {
    // 1) Par de chaves de TESTE (admin-cli real, keys-dir isolado — não toca o embeddedKey do cliente).
    const kg = spawnSync(node, [ADMIN_CLI, "keygen", "--keys-dir", keysDir, "--json"], { encoding: "utf8" });
    assert.equal(kg.status, 0, `keygen falhou: ${kg.stderr}`);
    assert.ok(fs.existsSync(path.join(keysDir, "keyinfo.json")), "keyinfo.json deveria existir");

    // 2) Licença de TESTE assinada por essa chave.
    const iss = spawnSync(node, [ADMIN_CLI, "issue", "--keys-dir", keysDir, "--subject", SUBJECT, "--org", "claro", "--days", "1", "--json"], { encoding: "utf8" });
    assert.equal(iss.status, 0, `issue falhou: ${iss.stderr}`);
    const license = (JSON.parse(iss.stdout) as { license: string }).license;
    assert.match(license, /^FORGE-/, "licença deveria ter o prefixo FORGE-");

    // 3) Sobe o gateway REAL apontando para as chaves de teste e o upstream fake (Langfuse off).
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    gw = spawn(node, [GATEWAY], {
      env: {
        ...process.env,
        PORT: String(port),
        KEYINFO: path.join(keysDir, "keyinfo.json"),
        REVOCATIONS: path.join(keysDir, "revocations.json"),
        UPSTREAM_BASEURL: fake.url,
        LANGFUSE_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    gw.stdout?.on("data", (d) => (gwLog += d.toString()));
    gw.stderr?.on("data", (d) => (gwLog += d.toString()));
    await waitForHealth(base);

    // 4) ATIVA a licença → token de sessão.
    const act = await fetch(`${base}/license/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: license }),
    });
    assert.equal(act.status, 200, "activate deveria aceitar a licença de teste");
    const session = (await act.json()) as { token: string; subject: string };
    assert.ok(session.token, "activate deveria devolver um token");
    assert.equal(session.subject, SUBJECT);

    // 5) PROXY: uma "geração" atravessa gateway → provider fake e volta o SSE (prova o fluxo completo).
    const gen = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}`, "x-forge-model": "gpt-oss-120b" },
      body: JSON.stringify({ model: "gpt-oss-120b", messages: [{ role: "user", content: "escreva um hello" }], stream: true }),
    });
    assert.equal(gen.status, 200, "proxy deveria retornar 200");
    const body = await gen.text();
    assert.match(body, /forge e2e/, "o corpo do provider fake deveria chegar ao cliente pelo gateway");
    assert.equal(fake.hits(), 1, "o gateway deveria ter chamado o upstream exatamente uma vez");

    // 6) NEGAÇÃO: proxy sem token → 401 (recusa autoritativa do gateway).
    const noTok = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    assert.equal(noTok.status, 401, "proxy sem sessão deveria ser 401");

    // 7) REVOGAÇÃO ENFORÇADA AO VIVO: revoga o subject e o PRÓXIMO proxy é barrado (403), com a sessão
    // ainda válida em memória — o cerne da Fase 1 (revogação que morde no proxy, sem reiniciar o gateway).
    const rev = spawnSync(node, [ADMIN_CLI, "revoke", "--keys-dir", keysDir, "--subject", SUBJECT, "--json"], { encoding: "utf8" });
    assert.equal(rev.status, 0, `revoke falhou: ${rev.stderr}`);
    const afterRevoke = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ model: "gpt-oss-120b", messages: [{ role: "user", content: "de novo" }] }),
    });
    assert.equal(afterRevoke.status, 403, "após revogar o subject, o proxy deveria negar com 403");
    assert.equal(fake.hits(), 1, "o upstream NÃO deveria ser chamado para um subject revogado");
  } finally {
    if (gw && gw.exitCode === null) {
      gw.kill();
      await new Promise((r) => setTimeout(r, 150));
    }
    await fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (process.env.FORGE_E2E_DEBUG) process.stderr.write(gwLog);
  }
});
