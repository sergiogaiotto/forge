// Política de egress deny-by-default (RNF-014, ADR-7). Toda URL de saída que a
// extensão está prestes a abrir — provider, gateway, propagação Langfuse, MCP —
// é verificada aqui primeiro. Hosts externos são bloqueados e registrados a menos
// que o admin abra explicitamente o portão (forge.egress.allowExternal) e adicione o host.
//
// Mantido livre do logger baseado no VSCode para ser testável em unidade em Node puro;
// o chamador injeta um sink de warn.
import { isIP } from "node:net";

export interface EgressPolicy {
  allowExternal: boolean;
  allowedHosts: string[];
  // Quando true (padrão), hosts in-network de LAN (`.internal`/`.local`/IP privado) são liberados
  // automaticamente sem constar na allowlist — conveniente numa rede corporativa fechada. Um admin que
  // queira defesa em profundidade contra redirecionamento de egress (ex.: um settings apontando
  // `rag.embeddings.url` para um host interno arbitrário) define `false`: aí SÓ o loopback é liberado
  // automaticamente; qualquer host de LAN precisa estar explicitamente em `allowedHosts`. Ausente = true
  // (retrocompatível). Loopback (localhost/127.x/::1) é SEMPRE permitido — tooling local legítimo, não
  // vetor de exfiltração para a rede.
  trustInNetwork?: boolean;
}

export type WarnFn = (message: string) => void;

// Loopback: sempre in-network (Ollama/LM Studio/gateway local). Nunca é vetor de exfiltração LAN.
const LOOPBACK_IP = /^(127\.|::1$|0:0:0:0:0:0:0:1$)/i;
// LAN/privado: in-network só quando trustInNetwork (default). Redirecionável por settings — o gate.
const PRIVATE_LAN_IP =
  /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|fc00:|fd00:|fe80:)/i;

export class EgressBlockedError extends Error {
  constructor(public readonly target: string) {
    super(`Egress bloqueado por política (deny-by-default): ${target}`);
    this.name = "EgressBlockedError";
  }
}

export class EgressEnforcer {
  constructor(private policy: EgressPolicy, private readonly warn: WarnFn = (m) => console.warn(m)) {}

  update(policy: EgressPolicy): void {
    this.policy = policy;
  }

  /** Hosts que contam como in-network mesmo sem estarem listados. */
  private isInNetwork(host: string): boolean {
    // IPv6 vem entre colchetes de `new URL(...).hostname` (ex.: "[::1]") — normaliza para casar o regex.
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h === "ip6-localhost") return true;
    // CRÍTICO: os regex de faixa só valem para IP LITERAL. Sem esta guarda, um hostname público como
    // `127.0.0.1.attacker.com` ou `10.evil.com` casaria `^127\.`/`^10\.` por PREFIXO de string e seria
    // tratado como in-network — furando o deny-by-default e o modo trustInNetwork:false (achado da
    // revisão adversarial: SSRF/exfiltração via settings de egress). isIP()==0 ⇒ não é IP ⇒ não é faixa.
    const literalIp = isIP(h) !== 0;
    // Loopback é sempre liberado (tooling local), independente de trustInNetwork — mas só IP real.
    if (literalIp && LOOPBACK_IP.test(h)) return true;
    // LAN/privado só quando o admin confia na rede (padrão). Com trustInNetwork:false, exige allowlist.
    if (this.policy.trustInNetwork === false) return false;
    if (h.endsWith(".local") || h.endsWith(".internal")) return true;
    if (literalIp && PRIVATE_LAN_IP.test(h)) return true;
    return false;
  }

  isAllowed(target: string): boolean {
    let host: string;
    try {
      host = new URL(target).hostname.toLowerCase();
    } catch {
      // comandos stdio / alvos não-URL não são egress de rede.
      return true;
    }
    if (this.policy.allowedHosts.map((x) => x.toLowerCase()).includes(host)) return true;
    if (this.isInNetwork(host)) return true;
    if (this.policy.allowExternal) return true;
    return false;
  }

  /** Lança EgressBlockedError se o alvo não for permitido, após registrar o log. */
  assertAllowed(target: string): void {
    if (!this.isAllowed(target)) {
      this.warn(`Egress NEGADO: ${target} (host fora da allowlist in-network).`);
      throw new EgressBlockedError(target);
    }
  }
}
