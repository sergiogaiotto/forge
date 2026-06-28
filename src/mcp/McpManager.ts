import { SecretsStore } from "../secrets/SecretsStore";
import { EgressEnforcer } from "../net/EgressEnforcer";
import { log } from "../util/logger";
import { McpAuditor } from "./McpAuditor";
import { createTransport, McpTransportClient } from "./McpClient";
import { McpRegistry } from "./McpRegistry";
import { ToolApprovalGate } from "./ToolApprovalGate";
import { McpServerEntry, McpToolDescriptor } from "./types";

const CLIENT_INFO = { name: "forge", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

// Integra o registro (allowlist), a aplicação de egress, a resolução de
// credenciais, o portão de aprovação e o auditor (RF-070–077). O agente acessa
// as ferramentas MCP apenas por aqui.
export class McpManager {
  constructor(
    private readonly registry: McpRegistry,
    private readonly egress: EgressEnforcer,
    private readonly approvals: ToolApprovalGate,
    private readonly auditor: McpAuditor,
    private readonly secrets: SecretsStore
  ) {}

  async listTools(): Promise<McpToolDescriptor[]> {
    const out: McpToolDescriptor[] = [];
    for (const server of this.registry.enabledServers()) {
      try {
        const client = await this.connect(server);
        const res = await client.request("tools/list", {});
        const tools = (res.result as any)?.tools ?? [];
        for (const t of tools) {
          out.push({ serverId: server.id, name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? {} });
        }
        await client.close();
      } catch (err) {
        log.warn(`MCP ${server.id}: falha ao listar ferramentas`, err);
      }
    }
    return out;
  }

  async callTool(serverId: string, tool: string, args: unknown): Promise<{ ok: boolean; content: string }> {
    const server = this.registry.get(serverId);
    if (!server || !server.enabled) {
      this.auditor.record({ server: serverId, tool, scope: "n/a", outcome: "blocked", detail: "servidor não habilitado" });
      return { ok: false, content: "Servidor MCP não disponível." };
    }
    // RF-072/073: aplica o egress antes de qualquer outra coisa.
    if (server.transport === "streamableHttp" && !this.egress.isAllowed(server.url ?? "")) {
      this.auditor.record({ server: serverId, tool, scope: server.scope, outcome: "blocked", detail: "egress negado" });
      return { ok: false, content: "Endpoint MCP bloqueado pela política de egress." };
    }
    // RF-075: portão de aprovação.
    const approved = await this.approvals.requireApproval(server, tool, server.scope, args);
    if (!approved) {
      this.auditor.record({ server: serverId, tool, scope: server.scope, outcome: "denied" });
      return { ok: false, content: "Invocação de ferramenta negada pelo usuário." };
    }
    try {
      const client = await this.connect(server);
      const res = await client.request("tools/call", { name: tool, arguments: args });
      await client.close();
      if (res.error) {
        this.auditor.record({ server: serverId, tool, scope: server.scope, outcome: "error", detail: res.error.message });
        return { ok: false, content: `Erro MCP: ${res.error.message}` };
      }
      this.auditor.record({ server: serverId, tool, scope: server.scope, outcome: "ok" });
      return { ok: true, content: stringifyToolResult(res.result) };
    } catch (err) {
      this.auditor.record({ server: serverId, tool, scope: server.scope, outcome: "error", detail: (err as Error).message });
      return { ok: false, content: `Falha ao chamar MCP: ${(err as Error).message}` };
    }
  }

  private async connect(server: McpServerEntry): Promise<McpTransportClient> {
    // RF-074: credenciais vêm do SecretStorage/vault por referência, nunca do pacote.
    const headers: Record<string, string> = {};
    const env: Record<string, string> = {};
    if (server.credentialRef) {
      const secret = await this.secrets.get(SecretsStore.mcpCredential(server.credentialRef));
      if (secret) {
        headers["authorization"] = `Bearer ${secret}`;
        env.MCP_CREDENTIAL = secret;
      }
    }
    if (server.transport === "streamableHttp") this.egress.assertAllowed(server.url!);
    const client = createTransport(server, headers, env);
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    return client;
  }
}

function stringifyToolResult(result: unknown): string {
  const content = (result as any)?.content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c.text === "string" ? c.text : JSON.stringify(c))).join("\n");
  }
  return JSON.stringify(result);
}
