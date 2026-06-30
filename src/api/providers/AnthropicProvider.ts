import { EgressEnforcer } from "../../net/EgressEnforcer";
import { combineSignals, HttpError, sseLines } from "../../util/http";
import { DEFAULT_MAX_TOKENS } from "../presets";
import { ChatMessage, CreateMessageOptions, LLMProvider, ProviderRuntimeConfig, StreamChunk, ToolDefinition } from "../types";

// RF-026/027: formato Messages nativo da Anthropic (não Chat Completions). O uso de ferramentas
// segue o schema da Anthropic; o raciocínio aparece como deltas de `thinking`.
export class AnthropicProvider implements LLMProvider {
  readonly type = "anthropic" as const;
  readonly modelId: string;

  constructor(private readonly cfg: ProviderRuntimeConfig, private readonly egress: EgressEnforcer) {
    this.modelId = cfg.modelId;
  }

  private endpoint(): string {
    const base = (this.cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    return `${base}/v1/messages`;
  }

  async *createMessage(
    systemPrompt: string,
    messages: ChatMessage[],
    opts: CreateMessageOptions
  ): AsyncIterable<StreamChunk> {
    const url = this.endpoint();
    this.egress.assertAllowed(url);

    const body: Record<string, unknown> = {
      model: this.cfg.modelId,
      // Mesmo teto generoso dos demais provedores (ver DEFAULT_MAX_TOKENS): evita que o "arquivo
      // completo" seja cortado. cfg.maxTokens permite override por configuração.
      max_tokens: this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      system: systemPrompt,
      messages: messages.map(toAnthropicMessage),
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map(toAnthropicTool);
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(opts.extraHeaders ?? {}),
    };
    if (this.cfg.apiKey && this.cfg.apiKey !== "not-needed") headers["x-api-key"] = this.cfg.apiKey;

    const signal = combineSignals(opts.signal, opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (err) {
      const e = err as Error;
      yield { kind: "error", message: e.name === "TimeoutError" ? `Tempo limite (${this.cfg.timeoutSeconds}s).` : `Falha de conexão: ${e.message}` };
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, `Anthropic retornou ${res.status}: ${text.slice(0, 500)}`);
    }

    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let inputTokens = 0;

    for await (const data of sseLines(res.body)) {
      let evt: any;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      switch (evt.type) {
        case "message_start":
          inputTokens = evt.message?.usage?.input_tokens ?? 0;
          break;
        case "content_block_start":
          if (evt.content_block?.type === "tool_use") {
            toolBlocks.set(evt.index, { id: evt.content_block.id, name: evt.content_block.name, json: "" });
          }
          break;
        case "content_block_delta": {
          const d = evt.delta ?? {};
          if (d.type === "text_delta" && d.text) yield { kind: "text", text: d.text };
          else if (d.type === "thinking_delta" && d.thinking) yield { kind: "reasoning", text: d.thinking };
          else if (d.type === "input_json_delta" && d.partial_json !== undefined) {
            const b = toolBlocks.get(evt.index);
            if (b) b.json += d.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const b = toolBlocks.get(evt.index);
          if (b) {
            yield { kind: "tool_call", id: b.id, name: b.name, arguments: b.json || "{}" };
            toolBlocks.delete(evt.index);
          }
          break;
        }
        case "message_delta":
          if (evt.usage?.output_tokens !== undefined) {
            yield { kind: "usage", inputTokens, outputTokens: evt.usage.output_tokens };
          }
          // Truncamento por atingir o teto de tokens: a Anthropic sinaliza com stop_reason
          // "max_tokens". Aviso NÃO-fatal, preservando o conteúdo parcial (espelha o OpenAI-compat).
          if (evt.delta?.stop_reason === "max_tokens") {
            const cap = this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
            yield {
              kind: "warning",
              message: `Resposta truncada por atingir o limite de ${cap} tokens de saída. O arquivo pode estar incompleto — peça a continuação ou aumente o limite de tokens.`,
            };
          }
          break;
      }
    }
  }
}

function toAnthropicMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
    };
  }
  return { role: m.role, content: m.content };
}

function toAnthropicTool(t: ToolDefinition): Record<string, unknown> {
  return { name: t.name, description: t.description, input_schema: t.parameters };
}
