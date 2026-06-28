// Política de egress deny-by-default (RNF-014, ADR-7). Toda URL de saída que a
// extensão está prestes a abrir — provider, gateway, propagação Langfuse, MCP —
// é verificada aqui primeiro. Hosts externos são bloqueados e registrados a menos
// que o admin abra explicitamente o portão (forge.egress.allowExternal) e adicione o host.
//
// Mantido livre do logger baseado no VSCode para ser testável em unidade em Node puro;
// o chamador injeta um sink de warn.
export interface EgressPolicy {
  allowExternal: boolean;
  allowedHosts: string[];
}

export type WarnFn = (message: string) => void;

const PRIVATE_IP =
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc00:|fd00:|fe80:)/i;

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
    const h = host.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
    if (PRIVATE_IP.test(h)) return true;
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
