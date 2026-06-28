// Payload de licença assinado (ver SPEC §6.2).
export interface LicensePayload {
  subject: string; // dev@org.com
  org: string; // claro
  scope: string[]; // ex.: ["codegen", "skills"]
  issued_at: number; // segundos unix
  expiry: number; // segundos unix
  key_id: string; // ex.: "ed25519-2026-01"
}

export interface VerifyOk {
  ok: true;
  payload: LicensePayload;
}

export interface VerifyErr {
  ok: false;
  code:
    | "format"
    | "signature"
    | "key_id"
    | "expired"
    | "not_yet_valid"
    | "scope"
    | "payload";
  message: string;
}

export type VerifyResult = VerifyOk | VerifyErr;

export interface SessionToken {
  token: string;
  expiresAt: number; // segundos unix
  subject: string;
  org: string;
}
