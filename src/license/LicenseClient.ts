import { EgressEnforcer } from "../net/EgressEnforcer";
import { safeFetch } from "../net/safeFetch";
import { log } from "../util/logger";
import { LicenseVerifier } from "./LicenseVerifier";
import { SessionToken, VerifyErr } from "./types";

// RF-013/015: lado cliente da validação de licença.
//  - modo gateway: o gateway na rede é a autoridade; ele pode recusar uma
//    licença revogada/desconhecida mesmo quando a assinatura local é válida.
//  - modo local: nenhum gateway provisionado ainda (dev/PoC). Sintetizamos um
//    token de sessão a partir do payload verificado localmente. O modelo de
//    ameaças (RNF-002) é explícito quanto a isso ser um dissuasor, não um controle.
export class LicenseClient {
  constructor(
    private readonly verifier: LicenseVerifier,
    private readonly egress: EgressEnforcer,
    private readonly getConfig: () => { mode: "gateway" | "local"; gatewayUrl: string }
  ) {}

  async activate(key: string): Promise<{ token: SessionToken } | { error: VerifyErr }> {
    const local = this.verifier.verifyLocal(key);
    if (!local.ok) {
      return { error: local };
    }
    const { mode, gatewayUrl } = this.getConfig();

    if (mode === "gateway" && gatewayUrl) {
      return this.activateViaGateway(key, gatewayUrl);
    }

    // Modo local: o token espelha o tempo de vida do payload.
    const token: SessionToken = {
      token: "local:" + base64urlOf(`${local.payload.subject}|${local.payload.org}|${local.payload.expiry}`),
      expiresAt: Math.min(local.payload.expiry, Math.floor(Date.now() / 1000) + 3600),
      subject: local.payload.subject,
      org: local.payload.org,
    };
    log.info(`Licença ativada (modo local) para ${local.payload.subject} / ${local.payload.org}.`);
    return { token };
  }

  async renew(current: SessionToken, key: string): Promise<SessionToken | undefined> {
    const { mode, gatewayUrl } = this.getConfig();
    if (mode === "gateway" && gatewayUrl) {
      try {
        const res = await this.gatewayFetch(`${trimSlash(gatewayUrl)}/license/renew`, {
          token: current.token,
        });
        if (!res.ok) return undefined;
        return (await res.json()) as SessionToken;
      } catch (err) {
        log.warn("Renovação de licença via gateway falhou", err);
        return undefined;
      }
    }
    // Modo local: reverifica a chave original.
    const local = this.verifier.verifyLocal(key);
    if (!local.ok) return undefined;
    return {
      ...current,
      expiresAt: Math.min(local.payload.expiry, Math.floor(Date.now() / 1000) + 3600),
    };
  }

  private async activateViaGateway(
    key: string,
    gatewayUrl: string
  ): Promise<{ token: SessionToken } | { error: VerifyErr }> {
    try {
      const res = await this.gatewayFetch(`${trimSlash(gatewayUrl)}/license/activate`, { key });
      if (res.status === 403 || res.status === 401) {
        return {
          error: { ok: false, code: "signature", message: "Licença recusada pelo gateway (revogada ou desconhecida)." },
        };
      }
      if (!res.ok) {
        return { error: { ok: false, code: "signature", message: `Gateway retornou ${res.status}.` } };
      }
      const token = (await res.json()) as SessionToken;
      log.info(`Licença validada pelo gateway para ${token.subject} / ${token.org}.`);
      return { token };
    } catch (err) {
      log.error("Falha ao contatar o gateway de licença", err);
      return { error: { ok: false, code: "signature", message: "Não foi possível contatar o gateway de licença." } };
    }
  }

  private async gatewayFetch(url: string, body: unknown): Promise<Response> {
    this.egress.assertAllowed(url);
    return safeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function base64urlOf(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
