import { log } from "../util/logger";

export interface McpAuditRecord {
  server: string;
  tool: string;
  scope: string;
  outcome: "approved" | "denied" | "ok" | "error" | "blocked";
  detail?: string;
  ts: number;
}

// RF-076: toda invocação de ferramenta MCP é registrada para auditoria. Em uma
// implantação com gateway esses registros também fluem para o trace do Langfuse (SPEC §3.7).
export class McpAuditor {
  private readonly ring: McpAuditRecord[] = [];
  private readonly max = 500;

  record(rec: Omit<McpAuditRecord, "ts">): void {
    const full: McpAuditRecord = { ...rec, ts: Date.now() };
    this.ring.push(full);
    if (this.ring.length > this.max) this.ring.shift();
    log.info(`[MCP audit] ${full.server}.${full.tool} scope=${full.scope} → ${full.outcome}${full.detail ? " · " + full.detail : ""}`);
  }

  recent(): McpAuditRecord[] {
    return [...this.ring];
  }
}
