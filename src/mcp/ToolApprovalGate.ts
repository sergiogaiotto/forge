import { log } from "../util/logger";
import { McpServerEntry } from "./types";

export type ApprovalPrompt = (req: {
  requestId: string;
  server: string;
  tool: string;
  scope: "readonly" | "readwrite";
  argsPreview: string;
}) => Promise<boolean>;

// RF-075: privilégio mínimo. Invocações de ferramentas exigem aprovação humana por padrão;
// o auto-approve é opcional por servidor (política de administrador) e nunca se aplica a uma
// chamada readwrite a menos que explicitamente concedido.
export class ToolApprovalGate {
  private counter = 0;
  constructor(private readonly prompt: ApprovalPrompt) {}

  async requireApproval(
    server: McpServerEntry,
    tool: string,
    scope: "readonly" | "readwrite",
    args: unknown
  ): Promise<boolean> {
    const effectiveScope: "readonly" | "readwrite" = scope === "readwrite" ? "readwrite" : server.scope;
    if (server.autoApprove && effectiveScope === "readonly") {
      log.info(`MCP auto-approve (readonly) ${server.id}.${tool}`);
      return true;
    }
    const requestId = `appr_${++this.counter}`;
    const argsPreview = previewArgs(args);
    const approved = await this.prompt({ requestId, server: server.id, tool, scope: effectiveScope, argsPreview });
    log.info(`MCP aprovação ${server.id}.${tool} → ${approved ? "permitido" : "negado"}`);
    return approved;
  }
}

function previewArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return String(args);
  }
}
