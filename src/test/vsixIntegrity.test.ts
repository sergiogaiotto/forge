import assert from "node:assert/strict";
import { test } from "node:test";
import * as crypto from "node:crypto";
// @ts-expect-error — módulo .mjs puro do admin-cli (sem tipos), importado só para teste.
import { buildManifest, sha256Hex, verifyManifest } from "../../admin-cli/integrity.mjs";

// Par Ed25519 efêmero + a chave pública crua em base64 (formato do keyinfo.json/embeddedKey).
function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const publicKeyB64 = Buffer.from(der.subarray(der.length - 32)).toString("base64");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { publicKeyB64, privateKeyPem };
}

const VSIX = Buffer.from("conteúdo binário fake de um .vsix \x00\x01\x02", "utf8");

test("sha256Hex: hex de 64 chars, estável, sensível a 1 byte", () => {
  const h = sha256Hex(VSIX);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, sha256Hex(Buffer.from(VSIX))); // estável
  assert.notEqual(h, sha256Hex(Buffer.concat([VSIX, Buffer.from("x")]))); // 1 byte muda tudo
});

test("buildManifest sem signer: só hash/size (integridade, sem proveniência)", () => {
  const m = buildManifest({ fileName: "forge-2.9.0.vsix", version: "2.9.0", bytes: VSIX });
  assert.equal(m.file, "forge-2.9.0.vsix");
  assert.equal(m.version, "2.9.0");
  assert.equal(m.size, VSIX.length);
  assert.equal(m.sha256, sha256Hex(VSIX));
  assert.equal(m.signature, undefined);
  assert.equal(m.keyId, undefined);
});

test("round-trip assinado: buildManifest com signer → verifyManifest ok+signed", () => {
  const { publicKeyB64, privateKeyPem } = makeKeypair();
  const m = buildManifest({ fileName: "forge-2.9.0.vsix", version: "2.9.0", bytes: VSIX, signer: { privateKeyPem, keyId: "ed25519-2026-01" } });
  assert.ok(m.signature, "deveria ter assinatura");
  assert.equal(m.keyId, "ed25519-2026-01");
  const r = verifyManifest({ bytes: VSIX, manifest: m, publicKeyB64 });
  assert.equal(r.ok, true);
  assert.equal(r.integrity, true);
  assert.equal(r.provenance, "signed");
});

test("manifesto NÃO assinado: verifyManifest ok de integridade, mas provenance unsigned", () => {
  const m = buildManifest({ fileName: "f.vsix", bytes: VSIX });
  const r = verifyManifest({ bytes: VSIX, manifest: m, publicKeyB64: undefined });
  assert.equal(r.ok, true);
  assert.equal(r.provenance, "unsigned");
  assert.match(r.reason, /sem assinatura/i);
});

test("adulteração de bytes: hash diverge → FALHA de integridade (mesmo com assinatura)", () => {
  const { publicKeyB64, privateKeyPem } = makeKeypair();
  const m = buildManifest({ fileName: "f.vsix", bytes: VSIX, signer: { privateKeyPem, keyId: "k" } });
  const tampered = Buffer.concat([VSIX, Buffer.from("MALWARE")]);
  const r = verifyManifest({ bytes: tampered, manifest: m, publicKeyB64 });
  assert.equal(r.ok, false);
  assert.equal(r.integrity, false);
  assert.match(r.reason, /sha256 diverge|tamanho diverge/i);
});

test("assinatura de OUTRA chave: integridade ok, mas proveniência inválida (não veio deste admin)", () => {
  const admin = makeKeypair();
  const impostor = makeKeypair();
  // manifesto assinado pelo impostor, verificado contra a pública do admin
  const m = buildManifest({ fileName: "f.vsix", bytes: VSIX, signer: { privateKeyPem: impostor.privateKeyPem, keyId: "k" } });
  const r = verifyManifest({ bytes: VSIX, manifest: m, publicKeyB64: admin.publicKeyB64 });
  assert.equal(r.ok, false);
  assert.equal(r.integrity, true); // o arquivo é o mesmo (hash confere)
  assert.equal(r.provenance, "invalid");
  assert.match(r.reason, /não confere|não veio/i);
});

test("manifesto assinado mas SEM pública fornecida: não passa (não dá para provar proveniência)", () => {
  const { privateKeyPem } = makeKeypair();
  const m = buildManifest({ fileName: "f.vsix", bytes: VSIX, signer: { privateKeyPem, keyId: "k" } });
  const r = verifyManifest({ bytes: VSIX, manifest: m, publicKeyB64: undefined });
  assert.equal(r.ok, false);
  assert.equal(r.provenance, "invalid");
  assert.match(r.reason, /nenhuma chave pública/i);
});

test("sha256 truncado/ausente no manifesto → falha de integridade (não passa por comprimento)", () => {
  const r1 = verifyManifest({ bytes: VSIX, manifest: { size: VSIX.length, sha256: "abc" }, publicKeyB64: undefined });
  assert.equal(r1.ok, false);
  assert.equal(r1.integrity, false);
  const r2 = verifyManifest({ bytes: VSIX, manifest: { size: VSIX.length }, publicKeyB64: undefined });
  assert.equal(r2.ok, false);
});
