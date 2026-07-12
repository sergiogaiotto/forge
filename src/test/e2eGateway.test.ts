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

// Upstream FAKE: responde /chat/completions com um SSE mínimo (conteúdo + usage + [DONE]), como o vLLM,
// e CAPTURA o corpo recebido para o teste asseverar que o payload do cliente atravessou o gateway.
interface FakeUpstream {
  url: string;
  close: () => Promise<void>;
  hits: () => number;
  lastBody: () => string;
}
function startFakeUpstream(): Promise<FakeUpstream> {
  let hits = 0;
  let lastBody = "";
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url && req.url.endsWith("/chat/completions")) {
      hits++;
      // acumula o corpo (o gateway repassa o payload do cliente) e responde streaming
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastBody = body;
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
        lastBody: () => lastBody,
        // closeAllConnections() derruba sockets keep-alive residuais — sem isto, um socket sobrevivente
        // (undici↔fake) faria server.close() aguardar para sempre no teardown (sem --test-timeout).
        close: () =>
          new Promise<void>((r) => {
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

// Espera o /health responder, mas ABORTA cedo se o processo do gateway morrer no boot (chave ausente,
// porta em uso) — senão seriam 8s de timeout escondendo a causa real, que fica no stderr capturado.
async function waitForHealth(base: string, gwExit: () => number | null, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = gwExit();
    if (code !== null) throw new Error(`gateway morreu no boot (exit ${code}) — veja o log do gateway acima`);
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

// Emite uma licença de TESTE assinada (admin-cli real). extra permite --scope etc.
function mint(keysDir: string, subject: string, ...extra: string[]): string {
  const iss = spawnSync(process.execPath, [ADMIN_CLI, "issue", "--keys-dir", keysDir, "--subject", subject, "--org", "claro", "--days", "1", "--json", ...extra], { encoding: "utf8" });
  assert.equal(iss.status, 0, `issue falhou: ${iss.stderr}`);
  return (JSON.parse(iss.stdout) as { license: string }).license;
}

// Sobe o gateway REAL com env customizado; devolve base + stop() que espera o exit real (sem sleep-palpite).
async function bootGateway(keysDir: string, upstreamUrl: string, extraEnv: Record<string, string>): Promise<{ base: string; stop: () => Promise<void>; log: () => string }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  let exitCode: number | null = null;
  const gw = spawn(process.execPath, [GATEWAY], {
    env: { ...process.env, PORT: String(port), KEYINFO: path.join(keysDir, "keyinfo.json"), REVOCATIONS: path.join(keysDir, "revocations.json"), UPSTREAM_BASEURL: upstreamUrl, LANGFUSE_ENABLED: "false", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gw.stdout?.on("data", (d) => (log += d.toString()));
  gw.stderr?.on("data", (d) => (log += d.toString()));
  gw.once("exit", (c) => (exitCode = c ?? 0));
  await waitForHealth(base, () => exitCode);
  return {
    base,
    log: () => log,
    stop: async () => {
      if (exitCode === null) {
        const exited = new Promise<void>((r) => gw.once("exit", () => r()));
        gw.kill();
        await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3000))]);
      }
    },
  };
}

test("E2E license↔gateway↔provider: activate → proxy (geração) → 401 sem token → revogação enforçada ao vivo", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-e2e-"));
  const keysDir = path.join(tmp, "keys");
  const node = process.execPath;
  const fake = await startFakeUpstream();
  let gw: ChildProcess | undefined;
  let gwLog = "";
  let gwExitCode: number | null = null;
  let failed = false;
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
    gw.once("exit", (code) => (gwExitCode = code ?? 0));
    await waitForHealth(base, () => gwExitCode);

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
    // metade cliente→upstream: o payload do cliente (model + mensagem) atravessou o gateway sem corromper
    assert.match(fake.lastBody(), /escreva um hello/, "o payload do cliente deveria chegar ao upstream pelo gateway");
    assert.match(fake.lastBody(), /gpt-oss-120b/, "o model do cliente deveria chegar ao upstream");

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
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    // Encerra o gateway e ESPERA o exit real (não um sleep-palpite): sem isto, sockets residuais
    // travariam o fake.close() do teardown.
    if (gw && gwExitCode === null) {
      const exited = new Promise<void>((r) => gw!.once("exit", () => r()));
      gw.kill();
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3000))]);
    }
    await fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    // Em falha (ou sob FORGE_E2E_DEBUG), despeja o log do gateway — a causa costuma estar no stderr dele.
    if (failed || process.env.FORGE_E2E_DEBUG) process.stderr.write(gwLog);
  }
});

// Trava o WIRING dos caminhos de rejeição novos (escopo/capacidade) ponta-a-ponta — não só os predicados
// puros: uma regressão no call-site (arg trocado, campo faltando) escaparia aos unit tests.
test("E2E escopo + capacidade: skills sem escopo → 403; codegen passa; teto 503 NÃO desloga a sessão viva", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-e2e-scope-"));
  const keysDir = path.join(tmp, "keys");
  const fake = await startFakeUpstream();
  let gw: { base: string; stop: () => Promise<void>; log: () => string } | undefined;
  let failed = false;
  try {
    const kg = spawnSync(process.execPath, [ADMIN_CLI, "keygen", "--keys-dir", keysDir, "--json"], { encoding: "utf8" });
    assert.equal(kg.status, 0, `keygen falhou: ${kg.stderr}`);
    const licCodegen = mint(keysDir, "codegen-only@claro.com", "--scope", "codegen"); // SEM "skills"
    const licOther = mint(keysDir, "outro@claro.com"); // escopo default (codegen,skills)
    // MAX_SESSIONS=1 força o teste do teto; RATE alto para o rate-limit não interferir aqui.
    gw = await bootGateway(keysDir, fake.url, { MAX_SESSIONS: "1", RATE_LIMIT_PER_MIN: "1000" });

    const act = await fetch(`${gw.base}/license/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: licCodegen }) });
    assert.equal(act.status, 200, "licença codegen ativa normalmente");
    const tokenA = ((await act.json()) as { token: string }).token;

    // codegen SEM skills → passa (200) e chama o upstream.
    const okGen = await fetch(`${gw.base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "oi" }] }) });
    assert.equal(okGen.status, 200, "codegen sem skills passa");
    assert.equal(fake.hits(), 1);

    // ativa skills SEM o escopo "skills" → 403 scope; upstream NÃO é chamado.
    const denyGen = await fetch(`${gw.base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}`, "x-forge-skills": "pandas-defensive-pipelines" }, body: JSON.stringify({ model: "m", messages: [] }) });
    assert.equal(denyGen.status, 403, "skills sem escopo → 403");
    assert.equal(((await denyGen.json()) as { error: string }).error, "scope");
    assert.equal(fake.hits(), 1, "escopo negado NÃO chama o upstream");

    // teto de sessões: A está viva, MAX_SESSIONS=1 → activate de OUTRA licença → 503 capacity.
    const actB = await fetch(`${gw.base}/license/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: licOther }) });
    assert.equal(actB.status, 503, "teto cheio de sessões VIVAS → 503");
    assert.equal(((await actB.json()) as { error: string }).error, "capacity");

    // e a sessão A (viva) sobrevive à ativação recusada de B — NÃO é mass-logout (o cerne do fix de DoS).
    const stillOk = await fetch(`${gw.base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "de novo" }] }) });
    assert.equal(stillOk.status, 200, "a sessão viva NÃO foi deslogada pelo 503");
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    await gw?.stop();
    await fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failed || process.env.FORGE_E2E_DEBUG) process.stderr.write(gw?.log() ?? "");
  }
});

test("E2E rate-limit da ativação: 2ª ativação do mesmo subject no mesmo minuto → 429", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-e2e-rl-"));
  const keysDir = path.join(tmp, "keys");
  let gw: { base: string; stop: () => Promise<void>; log: () => string } | undefined;
  let failed = false;
  try {
    const kg = spawnSync(process.execPath, [ADMIN_CLI, "keygen", "--keys-dir", keysDir, "--json"], { encoding: "utf8" });
    assert.equal(kg.status, 0, `keygen falhou: ${kg.stderr}`);
    const lic = mint(keysDir, "burst@claro.com");
    // RATE_LIMIT_PER_MIN=1: o bucket tem 1 token; a 2ª ativação imediata do mesmo subject é barrada.
    gw = await bootGateway(keysDir, "http://127.0.0.1:9", { RATE_LIMIT_PER_MIN: "1", MAX_SESSIONS: "1000" });
    const body = JSON.stringify({ key: lic });
    const a1 = await fetch(`${gw.base}/license/activate`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(a1.status, 200, "1ª ativação consome o token do bucket");
    const a2 = await fetch(`${gw.base}/license/activate`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(a2.status, 429, "2ª ativação imediata do mesmo subject → 429");
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    await gw?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failed || process.env.FORGE_E2E_DEBUG) process.stderr.write(gw?.log() ?? "");
  }
});
