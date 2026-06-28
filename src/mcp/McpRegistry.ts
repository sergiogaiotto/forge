import { McpServerView } from "../shared/protocol";
import { EgressEnforcer } from "../net/EgressEnforcer";
import { log } from "../util/logger";
import { McpServerEntry } from "./types";

// RF-070/071/073: catálogo de servidores MCP curado pelo administrador. O próprio
// catálogo é uma allowlist — apenas servidores listados, habilitados e intra-rede são conectáveis.
export class McpRegistry {
  private entries: McpServerEntry[] = [];

  constructor(private readonly egress: EgressEnforcer) {}

  load(entries: McpServerEntry[]): void {
    this.entries = entries.filter((e) => this.isValid(e));
    const dropped = entries.length - this.entries.length;
    if (dropped > 0) log.warn(`${dropped} entrada(s) de MCP rejeitada(s) (egress externo ou schema inválido).`);
  }

  // RF-072: endpoints streamableHttp devem ser intra-rede. stdio é local.
  private isValid(e: McpServerEntry): boolean {
    if (!e.id) return false;
    if (e.transport === "streamableHttp") {
      if (!e.url) return false;
      if (!this.egress.isAllowed(e.url)) {
        log.warn(`MCP "${e.id}" recusado: URL externa/fora da allowlist (${e.url}).`);
        return false;
      }
    }
    if (e.transport === "stdio" && !e.command) return false;
    return true;
  }

  list(): McpServerEntry[] {
    return [...this.entries];
  }

  enabledServers(): McpServerEntry[] {
    return this.entries.filter((e) => e.enabled);
  }

  get(id: string): McpServerEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  toViews(): McpServerView[] {
    return this.entries.map((e) => ({
      id: e.id,
      transport: e.transport,
      scope: e.scope,
      enabled: e.enabled,
      autoApprove: e.autoApprove,
      inNetwork: e.transport === "stdio" ? true : this.egress.isAllowed(e.url ?? ""),
    }));
  }
}
