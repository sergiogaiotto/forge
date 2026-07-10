// PURO (sem vscode): o log é injetado pelo Controller — o gate (e o hook de decisão do permission
// model) ficam testáveis com node puro.
import { McpServerEntry } from "./types";

export type ApprovalPrompt = (req: {
  requestId: string;
  server: string;
  tool: string;
  scope: "readonly" | "readwrite";
  argsPreview: string;
}) => Promise<boolean>;

// Desfecho de cada decisão de aprovação — alimenta o trail UNIFICADO de permissões (PermissionService).
// O card webview continua sendo a UX; o hook garante que auto-approve e negações também apareçam
// na auditoria central (antes, o auto-approve era só uma linha de log).
export type ApprovalDecisionHook = (rec: { server: string; tool: string; scope: "readonly" | "readwrite"; outcome: "auto" | "approved" | "denied"; argsPreview: string }) => void;

// RF-075: privilégio mínimo. Invocações de ferramentas exigem aprovação humana por padrão;
// o auto-approve é opcional por servidor (política de administrador) e nunca se aplica a uma
// chamada readwrite a menos que explicitamente concedido.
export class ToolApprovalGate {
  private counter = 0;
  constructor(
    private readonly prompt: ApprovalPrompt,
    private readonly onDecision?: ApprovalDecisionHook,
    private readonly logInfo: (msg: string) => void = () => undefined
  ) {}

  async requireApproval(
    server: McpServerEntry,
    tool: string,
    scope: "readonly" | "readwrite",
    args: unknown
  ): Promise<boolean> {
    const effectiveScope: "readonly" | "readwrite" = scope === "readwrite" ? "readwrite" : server.scope;
    if (server.autoApprove && effectiveScope === "readonly") {
      this.logInfo(`MCP auto-approve (readonly) ${server.id}.${tool}`);
      this.onDecision?.({ server: server.id, tool, scope: effectiveScope, outcome: "auto", argsPreview: previewArgs(args) });
      return true;
    }
    const requestId = `appr_${++this.counter}`;
    const argsPreview = previewArgs(args);
    const approved = await this.prompt({ requestId, server: server.id, tool, scope: effectiveScope, argsPreview });
    this.logInfo(`MCP aprovação ${server.id}.${tool} → ${approved ? "permitido" : "negado"}`);
    this.onDecision?.({ server: server.id, tool, scope: effectiveScope, outcome: approved ? "approved" : "denied", argsPreview });
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
