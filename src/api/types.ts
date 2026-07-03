import { ProviderType, ReasoningEffort } from "../shared/protocol";

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
  // Aviso NÃO-fatal (ex.: resposta truncada por limite de tokens). Diferente de `error`,
  // não aborta o stream nem descarta o conteúdo parcial já recebido.
  | { kind: "warning"; message: string }
  | { kind: "error"; message: string };

export interface CreateMessageOptions {
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  timeoutMs: number;
  // Headers de metadados de trace (x-forge-*) propagados ao gateway para a
  // observabilidade (login, sessão, skills, modelo). Nunca contêm segredos.
  extraHeaders?: Record<string, string>;
  // Saída JSON GARANTIDA pelo decoder (response_format json_object — guided decoding do vLLM/
  // OpenAI). Para tarefas de JSON estrito (blueprint). O provider degrada automaticamente (reenvia
  // sem o campo) se o gateway rejeitar com 400; provedores sem suporte (Anthropic) ignoram.
  jsonResponse?: boolean;
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
  // Teto de tokens de SAÍDA. Sem isso, gateways OpenAI-compatíveis (HubGPU/vLLM) aplicam um
  // default baixo e cortam o "arquivo completo" no meio (finish_reason: "length"). Ausente =
  // usa DEFAULT_MAX_TOKENS.
  maxTokens?: number;
  // Esforço de raciocínio (gpt-oss/OpenAI-compatível). Enviado como `reasoning_effort` no corpo.
  reasoningEffort?: ReasoningEffort;
  // Temperatura de amostragem. Ausente = default do servidor. As tarefas ESTRUTURADAS one-shot
  // (blueprint/charter) fixam 0: variância de amostragem é inimiga de JSON/formato estrito.
  temperature?: number;
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
