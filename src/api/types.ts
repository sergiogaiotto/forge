import { ProviderType } from "../shared/protocol";

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // Schema JSON
}

export type StreamChunk =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; arguments: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | { kind: "error"; message: string };

export interface CreateMessageOptions {
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  timeoutMs: number;
  // Headers de metadados de trace (x-forge-*) propagados ao gateway para a
  // observabilidade (login, sessão, skills, modelo). Nunca contêm segredos.
  extraHeaders?: Record<string, string>;
}

export interface LLMProvider {
  readonly type: ProviderType;
  readonly modelId: string;
  createMessage(
    systemPrompt: string,
    messages: ChatMessage[],
    opts: CreateMessageOptions
  ): AsyncIterable<StreamChunk>;
}

export interface ProviderRuntimeConfig {
  type: ProviderType;
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  authHeader?: string; // "Nome-Do-Header: valor"
  timeoutSeconds: number;
}

export function buildAuthHeaders(cfg: ProviderRuntimeConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.authHeader && cfg.authHeader.includes(":")) {
    const idx = cfg.authHeader.indexOf(":");
    const name = cfg.authHeader.slice(0, idx).trim();
    const value = cfg.authHeader.slice(idx + 1).trim();
    if (name) headers[name] = value;
    return headers;
  }
  if (cfg.apiKey && cfg.apiKey !== "not-needed") {
    headers["authorization"] = `Bearer ${cfg.apiKey}`;
  }
  return headers;
}
