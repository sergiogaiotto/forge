import * as crypto from "node:crypto";
import { EMBEDDED_KEY_ID, EMBEDDED_PUBLIC_KEY_B64 } from "./embeddedKey";
import { LicensePayload, VerifyResult } from "./types";

// Cabeçalho DER SPKI fixo para uma chave pública Ed25519. Prefixá-lo à chave
// crua de 32 bytes permite que node:crypto construa um KeyObject verificável sem dependências.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const LICENSE_PREFIX = "FORGE-";

export function base64urlDecode(input: string): Buffer {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4 !== 0) s += "=";
  return Buffer.from(s, "base64");
}

export function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function publicKeyFromRaw(rawB64: string): crypto.KeyObject {
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 32) {
    throw new Error(`embedded public key must be 32 raw bytes, got ${raw.length}`);
  }
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/**
 * RF-012: verifica a assinatura Ed25519 contra a chave pública embutida e
 * valida key_id, expiry e scope — totalmente offline. Isto é um dissuasor,
 * não o controle autoritativo (o gateway é — ADR-3, RNF-002).
 */
export class LicenseVerifier {
  constructor(
    private readonly publicKeyB64: string = EMBEDDED_PUBLIC_KEY_B64,
    private readonly keyId: string = EMBEDDED_KEY_ID,
    private readonly requiredScopes: string[] = ["codegen"]
  ) {}

  isConfigured(): boolean {
    return this.publicKeyB64 !== "PLACEHOLDER_PUBLIC_KEY_BASE64";
  }

  verifyLocal(key: string, nowSeconds: number = Math.floor(Date.now() / 1000)): VerifyResult {
    const raw = key.trim().startsWith(LICENSE_PREFIX) ? key.trim().slice(LICENSE_PREFIX.length) : key.trim();
    const dot = raw.indexOf(".");
    if (dot < 1 || dot === raw.length - 1) {
      return { ok: false, code: "format", message: "Formato inválido: esperado payload.signature." };
    }
    const payloadB64 = raw.slice(0, dot);
    const sigB64 = raw.slice(dot + 1);

    let payload: LicensePayload;
    try {
      payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8")) as LicensePayload;
    } catch {
      return { ok: false, code: "payload", message: "Payload da licença não é um JSON válido." };
    }

    let signatureValid = false;
    try {
      const pub = publicKeyFromRaw(this.publicKeyB64);
      signatureValid = crypto.verify(null, Buffer.from(payloadB64, "utf8"), pub, base64urlDecode(sigB64));
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      return { ok: false, code: "signature", message: "Assinatura Ed25519 inválida." };
    }

    if (payload.key_id !== this.keyId) {
      return {
        ok: false,
        code: "key_id",
        message: `key_id "${payload.key_id}" não corresponde à chave embutida "${this.keyId}".`,
      };
    }
    if (typeof payload.issued_at === "number" && payload.issued_at - 60 > nowSeconds) {
      return { ok: false, code: "not_yet_valid", message: "Licença ainda não é válida (issued_at no futuro)." };
    }
    if (typeof payload.expiry !== "number" || payload.expiry <= nowSeconds) {
      return { ok: false, code: "expired", message: "Licença expirada." };
    }
    const scope = Array.isArray(payload.scope) ? payload.scope : [];
    const missing = this.requiredScopes.filter((s) => !scope.includes(s));
    if (missing.length > 0) {
      return { ok: false, code: "scope", message: `Escopo insuficiente; faltam: ${missing.join(", ")}.` };
    }

    return { ok: true, payload };
  }
}
