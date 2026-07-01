import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
// Núcleo compartilhado entre o CLI de repositório (forge-admin.mjs) e o .exe standalone.
import { parseArgs, resolveKeysDir, runCli, VERSION } from "../../admin-cli/core.mjs";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forge-keygen-"));
}

/** io coletável para inspecionar a saída do runCli sem poluir o console de teste. */
function collectIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (m: string) => out.push(m), err: (m: string) => err.push(m) }, out, err };
}

/** Verifica uma licença FORGE-... contra a chave pública raw (base64) de keyinfo.json. */
function verifyLicense(license: string, publicKeyB64: string): { ok: boolean; payload: any } {
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyB64, "base64")]);
  const pub = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  const m = license.match(/^FORGE-([^.]+)\.(.+)$/);
  assert.ok(m, "formato de licença inválido");
  const sig = Buffer.from(m![2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const ok = crypto.verify(null, Buffer.from(m![1], "utf8"), pub, sig);
  const payload = JSON.parse(Buffer.from(m![1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  return { ok, payload };
}

function ctx(dir: string, io: any, defaultEmbeddedTarget: string | null = null) {
  return { bin: "forge-keygen.exe", defaultKeysDir: dir, defaultEmbeddedTarget, io };
}

test("parseArgs: --chave valor, --flag booleana, -h e -v", () => {
  const a = parseArgs(["--subject", "dev@claro.com", "--force", "-v"]);
  assert.equal(a.subject, "dev@claro.com");
  assert.equal(a.force, "true");
  assert.equal(a.version, "true");
  const b = parseArgs(["-h"]);
  assert.equal(b.help, "true");
});

test("resolveKeysDir: --keys-dir sem valor cai no default (não vira a pasta literal 'true')", () => {
  const def = path.join(os.tmpdir(), "DEFAULT");
  // --keys-dir como último token → parseArgs devolve "true"; deve cair no default, não em ./true
  assert.equal(resolveKeysDir(parseArgs(["issue", "--subject", "x", "--keys-dir"]), def), def);
  // --keys-dir com valor → resolvido absoluto
  const custom = path.join(os.tmpdir(), "custom-keys");
  assert.equal(resolveKeysDir(parseArgs(["--keys-dir", custom]), def), path.resolve(custom));
});

test("runCli version/help/comando desconhecido têm códigos de saída corretos", () => {
  const v = collectIo();
  assert.equal(runCli(["--version"], ctx("/x", v.io)), 0);
  assert.equal(v.out.join(""), VERSION);

  const h = collectIo();
  assert.equal(runCli([], ctx("/x", h.io)), 0); // sem comando → ajuda, exit 0
  assert.match(h.out.join("\n"), /USO:/);

  const u = collectIo();
  assert.equal(runCli(["naoexiste"], ctx("/x", u.io)), 2); // desconhecido → exit 2
  assert.match(u.err.join("\n"), /desconhecido/);
});

test("keygen gera par válido e issue produz licença com assinatura verificável", () => {
  const dir = tmpDir();
  try {
    const k = collectIo();
    assert.equal(runCli(["keygen", "--key-id", "ed25519-test", "--keys-dir", dir], ctx(dir, k.io)), 0);
    assert.ok(fs.existsSync(path.join(dir, "private.pem")));
    assert.ok(fs.existsSync(path.join(dir, "keyinfo.json")));
    assert.ok(fs.existsSync(path.join(dir, "embeddedKey.ts")));

    const info = JSON.parse(fs.readFileSync(path.join(dir, "keyinfo.json"), "utf8"));
    assert.equal(info.keyId, "ed25519-test");

    const i = collectIo();
    assert.equal(runCli(["issue", "--subject", "dev@claro.com", "--days", "30", "--keys-dir", dir, "--json"], ctx(dir, i.io)), 0);
    const parsed = JSON.parse(i.out.join("\n"));
    const { ok, payload } = verifyLicense(parsed.license, info.publicKeyB64);
    assert.ok(ok, "assinatura Ed25519 deve verificar contra a chave pública gerada");
    assert.equal(payload.subject, "dev@claro.com");
    assert.equal(payload.key_id, "ed25519-test");
    assert.equal(payload.expiry - payload.issued_at, 30 * 86400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keygen recusa sobrescrever chave existente sem --force (exit 3) e aceita com --force", () => {
  const dir = tmpDir();
  try {
    assert.equal(runCli(["keygen", "--keys-dir", dir], ctx(dir, collectIo().io)), 0);
    const before = fs.readFileSync(path.join(dir, "private.pem"), "utf8");

    const guard = collectIo();
    assert.equal(runCli(["keygen", "--keys-dir", dir], ctx(dir, guard.io)), 3);
    assert.equal(fs.readFileSync(path.join(dir, "private.pem"), "utf8"), before, "chave não pode mudar sem --force");
    assert.match(guard.err.join("\n"), /IRREVERS/i);

    assert.equal(runCli(["keygen", "--keys-dir", dir, "--force"], ctx(dir, collectIo().io)), 0);
    assert.notEqual(fs.readFileSync(path.join(dir, "private.pem"), "utf8"), before, "com --force a chave deve ser rotacionada");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--keys-dir NÃO clobbera o embeddedKey.ts do repo (só o local padrão atualiza o cliente)", () => {
  const keysDir = tmpDir();
  const repoLike = tmpDir();
  const repoEmbedded = path.join(repoLike, "embeddedKey.ts");
  try {
    // defaultEmbeddedTarget existe (dir presente), mas passamos --keys-dir explícito.
    const c = ctx(keysDir, collectIo().io, repoEmbedded);
    runCli(["keygen", "--keys-dir", keysDir], c);
    assert.ok(!fs.existsSync(repoEmbedded), "com --keys-dir, o embedded do repo não deve ser tocado");
    assert.ok(fs.existsSync(path.join(keysDir, "embeddedKey.ts")), "embedded deve ir para o keys-dir informado");
  } finally {
    fs.rmSync(keysDir, { recursive: true, force: true });
    fs.rmSync(repoLike, { recursive: true, force: true });
  }
});

test("keygen no LOCAL PADRÃO atualiza o embeddedKey.ts do cliente (paridade com npm run keygen)", () => {
  const keysDir = tmpDir();
  const repoLike = tmpDir();
  const repoEmbedded = path.join(repoLike, "embeddedKey.ts");
  try {
    // sem --keys-dir: defaultKeysDir == keysDir, então grava no defaultEmbeddedTarget do "repo".
    runCli(["keygen"], ctx(keysDir, collectIo().io, repoEmbedded));
    assert.ok(fs.existsSync(repoEmbedded), "no local padrão, o embedded do cliente deve ser escrito");
    const body = fs.readFileSync(repoEmbedded, "utf8");
    assert.match(body, /EMBEDDED_PUBLIC_KEY_B64/);
    assert.match(body, /EMBEDDED_KEY_ID/);
  } finally {
    fs.rmSync(keysDir, { recursive: true, force: true });
    fs.rmSync(repoLike, { recursive: true, force: true });
  }
});

test("issue valida --days e --expires-at", () => {
  const dir = tmpDir();
  try {
    runCli(["keygen", "--keys-dir", dir], ctx(dir, collectIo().io));
    // --days inválido → exit 2 (inclui inteiro não-estrito: '10abc' não pode virar 10)
    assert.equal(runCli(["issue", "--days", "0", "--keys-dir", dir], ctx(dir, collectIo().io)), 2);
    assert.equal(runCli(["issue", "--days", "abc", "--keys-dir", dir], ctx(dir, collectIo().io)), 2);
    assert.equal(runCli(["issue", "--days", "10abc", "--keys-dir", dir], ctx(dir, collectIo().io)), 2);
    assert.equal(runCli(["issue", "--days", "5.9", "--keys-dir", dir], ctx(dir, collectIo().io)), 2);
    // --expires-at define expiry pela data
    const i = collectIo();
    assert.equal(runCli(["issue", "--expires-at", "2030-01-01", "--keys-dir", dir, "--json"], ctx(dir, i.io)), 0);
    const p = JSON.parse(i.out.join("\n"));
    assert.equal(p.expiry_iso, "2030-01-01");
    // --expires-at inválido → exit 2
    assert.equal(runCli(["issue", "--expires-at", "31-12-2030", "--keys-dir", dir], ctx(dir, collectIo().io)), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("issue sem chaves falha (exit 1); revoke exige --subject (exit 2) e grava a lista", () => {
  const dir = tmpDir();
  try {
    assert.equal(runCli(["issue", "--keys-dir", path.join(dir, "vazio")], ctx(dir, collectIo().io)), 1);
    assert.equal(runCli(["revoke", "--keys-dir", dir], ctx(dir, collectIo().io)), 2);
    assert.equal(runCli(["revoke", "--subject", "x@claro.com", "--reason", "teste", "--keys-dir", dir], ctx(dir, collectIo().io)), 0);
    const list = JSON.parse(fs.readFileSync(path.join(dir, "revocations.json"), "utf8"));
    assert.equal(list[0].subject, "x@claro.com");
    assert.equal(list[0].reason, "teste");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
