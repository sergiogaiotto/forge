// SPEC §6.6 — entradas do catálogo MCP curadas pelo administrador (configurações gerenciadas).
export type McpTransport = "stdio" | "streamableHttp";

export interface McpServerEntry {
  id: string;
  transport: McpTransport;
  command?: string; // stdio
  args?: string[]; // stdio
  url?: string; // streamableHttp (deve ser intra-rede)
  scope: "readonly" | "readwrite";
  autoApprove: boolean; // padrão false (RF-075)
  credentialRef?: string; // referência a um segredo, nunca o valor (RF-074)
  enabled: boolean;
}

export interface McpToolDescriptor {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
