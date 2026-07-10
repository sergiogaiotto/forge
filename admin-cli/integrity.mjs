// Integridade e proveniência do .vsix (Fase 4 do hardening). O pacote é distribuído por rede/artefato
// (guia do admin §6) sem NADA que prove que o arquivo é íntegro e veio do admin. Este módulo dá dois
// níveis, na MESMA cadeia de confiança Ed25519 das licenças:
//   1. INTEGRIDADE (sempre): SHA-256 do .vsix — detecta corrupção/adulteração acidental. Qualquer um
//      recomputa e compara, sem chave.
//   2. PROVENIÊNCIA (opcional): assinatura Ed25519 dos bytes do .vsix com a chave PRIVADA do admin — só
//      quem tem a privada (a mesma que assina licenças) consegue gerar. O destinatário verifica contra a
//      chave PÚBLICA (keyinfo.json / a embutida no cliente).
//
// PURO (só node:crypto) e reusável pelo admin-cli (core.mjs) e pelos testes. Byte-idêntico à
// verificação de licença do gateway (mesmo prefixo SPKI, mesmo crypto.verify(null, ...)).
import * as crypto from "node:crypto";

// Prefixo DER SPKI de uma chave pública Ed25519 crua (32 bytes) — idêntico ao gateway/LicenseVerifier.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "="), "base64");

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Reconstrói a chave pública Ed25519 a partir dos 32 bytes crus em base64 (formato do keyinfo/embedded).
function publicKeyFromRawB64(publicKeyB64) {
  const raw = Buffer.from(publicKeyB64, "base64");
  if (raw.length !== 32) throw new Error(`chave pública Ed25519 inválida (${raw.length} bytes, esperado 32)`);
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

// Monta o manifesto de integridade. `signer` (opcional) = { privateKeyPem, keyId } → adiciona a
// assinatura Ed25519 dos BYTES do .vsix. Sem signer, o manifesto tem só o hash (integridade sem
// proveniência). O manifesto é o que o admin PUBLICA ao lado do .vsix.
export function buildManifest({ fileName, version, bytes, signer }) {
  const manifest = {
    file: fileName,
    version: version ?? null,
    size: bytes.length,
    algorithm: "sha256",
    sha256: sha256Hex(bytes),
    signatureAlgorithm: "ed25519",
  };
  if (signer && signer.privateKeyPem) {
    const privateKey = crypto.createPrivateKey(signer.privateKeyPem);
    manifest.signature = b64url(crypto.sign(null, bytes, privateKey));
    if (signer.keyId) manifest.keyId = signer.keyId;
  }
  return manifest;
}

// Verifica um .vsix contra o manifesto publicado + a chave pública do admin.
//   - tamanho e sha256 SEMPRE conferidos (integridade).
//   - assinatura conferida quando presente no manifesto E há publicKeyB64 (proveniência).
//   - `requireSignature`: modo ESTRITO. Assinatura ausente OU inválida ⇒ ok=false. É o modo para o
//     usuário final e o gate de CI de release — sem ele, o SHA-256 sozinho não protege contra um
//     atacante ativo (o .vsix e o manifesto viajam JUNTOS: quem troca o .vsix por malware apaga a
//     assinatura e recomputa o hash sem precisar de chave). O modo permissivo (default) é só para o
//     fluxo dev/CI onde o manifesto ainda é hash-only.
// Retorna { ok, integrity, provenance, reason }. `provenance` = "signed" | "unsigned" | "invalid".
export function verifyManifest({ bytes, manifest, publicKeyB64, requireSignature = false }) {
  if (!manifest || typeof manifest !== "object") return { ok: false, integrity: false, provenance: "unsigned", reason: "manifesto ausente ou inválido" };
  if (typeof manifest.size === "number" && manifest.size !== bytes.length) {
    return { ok: false, integrity: false, provenance: "unsigned", reason: `tamanho diverge (manifesto ${manifest.size}, arquivo ${bytes.length})` };
  }
  const actual = sha256Hex(bytes);
  // Comparação em tempo constante do hash (evita canal lateral de timing). Exige EXATAMENTE 64 chars
  // hex E comprimento igual ANTES do timingSafeEqual — um sha256 curto/ausente falha aqui (o padEnd é
  // só para o timingSafeEqual não lançar por buffers de tamanhos diferentes, nunca para "casar por prefixo").
  const expected = String(manifest.sha256 || "");
  const integrity =
    expected.length === 64 &&
    actual.length === 64 &&
    crypto.timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
  if (!integrity) return { ok: false, integrity: false, provenance: "unsigned", reason: "sha256 diverge — arquivo corrompido ou adulterado" };

  if (!manifest.signature) {
    // Íntegro, mas sem assinatura: no modo estrito isso é FALHA (downgrade de proveniência — um atacante
    // que controla o canal apaga a assinatura e recomputa o hash). No permissivo, passa com aviso.
    return requireSignature
      ? { ok: false, integrity: true, provenance: "unsigned", reason: "modo estrito: o manifesto NÃO está assinado — proveniência não pode ser provada (possível remoção de assinatura)" }
      : { ok: true, integrity: true, provenance: "unsigned", reason: "íntegro, mas SEM assinatura (proveniência não verificada)" };
  }
  if (!publicKeyB64) {
    return { ok: false, integrity: true, provenance: "invalid", reason: "manifesto assinado, mas nenhuma chave pública fornecida para verificar" };
  }
  let valid = false;
  try {
    valid = crypto.verify(null, bytes, publicKeyFromRawB64(publicKeyB64), b64urlDecode(manifest.signature));
  } catch (e) {
    return { ok: false, integrity: true, provenance: "invalid", reason: `falha ao verificar assinatura: ${e.message}` };
  }
  return valid
    ? { ok: true, integrity: true, provenance: "signed", reason: "íntegro e assinado pela chave do admin" }
    : { ok: false, integrity: true, provenance: "invalid", reason: "assinatura NÃO confere com a chave pública — arquivo não veio deste admin" };
}
