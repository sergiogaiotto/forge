#!/usr/bin/env node
// FORGE admin CLI — Ed25519 key management and license issuance (RF-016/017).
// The PRIVATE key never leaves this machine; only the PUBLIC key is embedded in
// the client (ADR-2). Run `keygen` once, then `issue` to mint licenses.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(__dirname, "keys");
const EMBEDDED_TS = path.join(__dirname, "..", "src", "license", "embeddedKey.ts");
const REVOCATION = path.join(KEYS_DIR, "revocations.json");

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

function rawPublicKeyB64(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

function keygen(args) {
  const keyId = args["key-id"] || `ed25519-${new Date().getFullYear()}-01`;
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const pubB64 = rawPublicKeyB64(publicKey);

  fs.writeFileSync(path.join(KEYS_DIR, "private.pem"), privPem, { mode: 0o600 });
  fs.writeFileSync(path.join(KEYS_DIR, "keyinfo.json"), JSON.stringify({ keyId, publicKeyB64: pubB64 }, null, 2));

  const ts = `// GERADO AUTOMATICAMENTE por \`npm run keygen\` (admin-cli/forge-admin.mjs).
// Contém APENAS a chave PÚBLICA Ed25519 — seguro distribuir no cliente.
// A chave privada nunca sai da máquina do admin (ADR-2).
export const EMBEDDED_PUBLIC_KEY_B64 = ${JSON.stringify(pubB64)};
export const EMBEDDED_KEY_ID = ${JSON.stringify(keyId)};
`;
  fs.writeFileSync(EMBEDDED_TS, ts);

  console.log("✓ Par de chaves Ed25519 gerado.");
  console.log(`  key_id:        ${keyId}`);
  console.log(`  private key:   ${path.join("admin-cli", "keys", "private.pem")}  (NÃO versionar)`);
  console.log(`  public key →   embutida em src/license/embeddedKey.ts`);
  console.log("\nPróximo: emita uma licença com");
  console.log(`  npm run license:issue -- --subject dev@claro.com --org claro --days 365`);
}

function issue(args) {
  const infoPath = path.join(KEYS_DIR, "keyinfo.json");
  const privPath = path.join(KEYS_DIR, "private.pem");
  if (!fs.existsSync(privPath) || !fs.existsSync(infoPath)) {
    console.error("✗ Chave privada não encontrada. Rode `npm run keygen` primeiro.");
    process.exit(1);
  }
  const { keyId } = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath, "utf8"));

  const now = Math.floor(Date.now() / 1000);
  const days = parseInt(args.days || "365", 10);
  const scope = (args.scope || "codegen,skills").split(",").map((s) => s.trim()).filter(Boolean);
  const payload = {
    subject: args.subject || "dev@claro.com",
    org: args.org || "claro",
    scope,
    issued_at: now,
    expiry: now + days * 86400,
    key_id: args["key-id"] || keyId,
  };

  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  const key = `FORGE-${payloadB64}.${b64url(sig)}`;

  console.log("✓ Licença emitida:\n");
  console.log(key);
  console.log("\n  subject:", payload.subject, "| org:", payload.org, "| scope:", scope.join("+"));
  console.log("  expira em:", new Date(payload.expiry * 1000).toISOString().slice(0, 10));
}

function revoke(args) {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const list = fs.existsSync(REVOCATION) ? JSON.parse(fs.readFileSync(REVOCATION, "utf8")) : [];
  const subject = args.subject;
  if (!subject) {
    console.error("✗ informe --subject");
    process.exit(1);
  }
  list.push({ subject, revokedAt: Math.floor(Date.now() / 1000) });
  fs.writeFileSync(REVOCATION, JSON.stringify(list, null, 2));
  console.log(`✓ ${subject} adicionado à lista de revogação. Sincronize ${path.relative(process.cwd(), REVOCATION)} com o gateway.`);
}

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);
switch (cmd) {
  case "keygen":
    keygen(args);
    break;
  case "issue":
    issue(args);
    break;
  case "revoke":
    revoke(args);
    break;
  default:
    console.log(`FORGE admin CLI

Uso:
  node admin-cli/forge-admin.mjs keygen [--key-id ed25519-2026-01]
  node admin-cli/forge-admin.mjs issue  --subject dev@claro.com --org claro --scope codegen,skills --days 365
  node admin-cli/forge-admin.mjs revoke --subject dev@claro.com

Atalhos npm:
  npm run keygen
  npm run license:issue -- --subject dev@claro.com --org claro --days 365`);
}
