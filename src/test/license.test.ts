import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { test } from "node:test";
import { LicenseVerifier } from "../license/LicenseVerifier";

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function rawPub(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

function issue(privateKey: crypto.KeyObject, payload: Record<string, unknown>): string {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = crypto.sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  return `FORGE-${payloadB64}.${b64url(sig)}`;
}

const KEY_ID = "ed25519-test";
const now = Math.floor(Date.now() / 1000);
const validPayload = {
  subject: "dev@claro.com",
  org: "claro",
  scope: ["codegen", "skills"],
  issued_at: now - 100,
  expiry: now + 3600,
  key_id: KEY_ID,
};

test("valid license verifies", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const verifier = new LicenseVerifier(rawPub(publicKey), KEY_ID, ["codegen"]);
  const result = verifier.verifyLocal(issue(privateKey, validPayload), now);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.payload.org, "claro");
});

test("tampered signature is rejected", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const verifier = new LicenseVerifier(rawPub(publicKey), KEY_ID, ["codegen"]);
  const key = issue(privateKey, validPayload);
  const tampered = key.slice(0, -3) + (key.endsWith("AAA") ? "BBB" : "AAA");
  const result = verifier.verifyLocal(tampered, now);
  assert.equal(result.ok, false);
});

test("license signed by a different key is rejected", () => {
  const a = crypto.generateKeyPairSync("ed25519");
  const b = crypto.generateKeyPairSync("ed25519");
  const verifier = new LicenseVerifier(rawPub(a.publicKey), KEY_ID, ["codegen"]);
  const result = verifier.verifyLocal(issue(b.privateKey, validPayload), now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "signature");
});

test("expired license is rejected", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const verifier = new LicenseVerifier(rawPub(publicKey), KEY_ID, ["codegen"]);
  const result = verifier.verifyLocal(issue(privateKey, { ...validPayload, expiry: now - 10 }), now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "expired");
});

test("wrong key_id is rejected", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const verifier = new LicenseVerifier(rawPub(publicKey), KEY_ID, ["codegen"]);
  const result = verifier.verifyLocal(issue(privateKey, { ...validPayload, key_id: "other" }), now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "key_id");
});

test("missing required scope is rejected", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const verifier = new LicenseVerifier(rawPub(publicKey), KEY_ID, ["codegen"]);
  const result = verifier.verifyLocal(issue(privateKey, { ...validPayload, scope: ["skills"] }), now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "scope");
});

test("malformed key is rejected", () => {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const verifier = new LicenseVerifier(rawPub(publicKey), KEY_ID, ["codegen"]);
  assert.equal(verifier.verifyLocal("not-a-license", now).ok, false);
  assert.equal(verifier.verifyLocal("FORGE-onlyonepart", now).ok, false);
});
