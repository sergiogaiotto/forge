import { EgressEnforcer } from "../../net/EgressEnforcer";
import { ProviderType } from "../../shared/protocol";
import { combineSignals, HttpError, sseLines } from "../../util/http";
import { DEFAULT_MAX_TOKENS } from "../presets";
import { buildAuthHeaders, ChatMessage, CreateMessageOptions, LLMProvider, ProviderRuntimeConfig, StreamChunk, ToolDefinition } from "../types";

// Adaptador universal (ADR-4). HubGPU, vLLM, Ollama e LM Studio falam todos o
// formato de fio Chat Completions da OpenAI, então compartilham esta implementação.
export class OpenAICompatibleProvider implements LLMProvider {
  readonly type: ProviderType = "openai-compatible";
  readonly modelId: string;

  constructor(private readonly cfg: ProviderRuntimeConfig, private readonly egress: EgressEnforcer) {
    this.modelId = cfg.modelId;
  }

  protected endpoint(): string {
    const base = (this.cfg.baseUrl ?? "").replace(/\/+$/, "");
    return `${base}/chat/completions`;
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
      stream: true,
      stream_options: { include_usage: true },
      // Teto explícito de saída: sem ele o gateway corta o "arquivo completo" no meio. Ver
      // DEFAULT_MAX_TOKENS. cfg.maxTokens permite override por configuração quando definido.
      max_tokens: this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: "system", content: systemPrompt }, ...messages.map(toOpenAIMessage)],
    };
    // gpt-oss e afins aceitam `reasoning_effort` (low/medium/high) no corpo Chat Completions.
    if (this.cfg.reasoningEffort) body.reasoning_effort = this.cfg.reasoningEffort;
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map(toOpenAITool);
      body.tool_choice = "auto";
    }

    const signal = combineSignals(opts.signal, opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...buildAuthHeaders(this.cfg), ...(opts.extraHeaders ?? {}) },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        yield { kind: "error", message: `Tempo limite (${this.cfg.timeoutSeconds}s) ou cancelado.` };
        return;
      }
      yield { kind: "error", message: `Falha de conexão ao provedor: ${e.message}` };
      return;
    }

    if (!res.ok) {
      const text = await safeText(res);
      // Damos uma dica acionável em pt-BR conforme a causa provável do 400, em vez de só repassar o
      // corpo cru (técnico, em inglês). A dica é específica: reasoning_effort não aceito vs. janela de tokens.
      let hint = "";
      if (res.status === 400) {
        const low = text.toLowerCase();
        if (low.includes("reasoning_effort") || low.includes("unknown") || low.includes("unexpected") || low.includes("parameter")) {
          hint = " (o gateway pode não aceitar o parâmetro reasoning_effort — reduza/ajuste o esforço de raciocínio)";
        } else if (low.includes("token") || low.includes("context") || low.includes("length")) {
          hint = " (o limite de tokens de saída somado ao contexto pode exceder a janela do modelo no gateway)";
        }
      }
      throw new HttpError(res.status, `Provedor retornou ${res.status}${hint}: ${text.slice(0, 500)}`);
    }

    // Acumula os fragmentos de chamada de ferramenta do streaming por índice.
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    // Garante que o aviso de truncamento seja emitido no máximo uma vez por resposta.
    let warnedLength = false;

    for await (const data of sseLines(res.body)) {
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.usage) {
        yield {
          kind: "usage",
          inputTokens: json.usage.prompt_tokens ?? 0,
          outputTokens: json.usage.completion_tokens ?? 0,
        };
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      // Modelos gpt-oss / de raciocínio expõem o chain-of-thought separadamente.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        yield { kind: "reasoning", text: reasoning };
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { kind: "text", text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const acc = toolAcc.get(idx) ?? { id: tc.id ?? `call_${idx}`, name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolAcc.set(idx, acc);
        }
      }
      if (choice.finish_reason === "tool_calls") {
        for (const acc of toolAcc.values()) {
          yield { kind: "tool_call", id: acc.id, name: acc.name, arguments: acc.args };
        }
        toolAcc.clear();
      }
      // Resposta cortada por atingir o teto de tokens de saída. Aviso NÃO-fatal: o conteúdo
      // parcial já recebido é preservado (não viramos `error`, que abortaria o parse das propostas).
      // Nota: tool_calls truncadas por "length" ficam com `args` (JSON) incompleto e são
      // intencionalmente descartadas — emiti-las entregaria argumentos inválidos a quem as consome.
      if (choice.finish_reason === "length" && !warnedLength) {
        warnedLength = true;
        const cap = this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
        yield {
          kind: "warning",
          message: `Resposta truncada por atingir o limite de ${cap} tokens de saída. O arquivo pode estar incompleto — peça a continuação ou aumente o limite de tokens.`,
        };
      }
    }
  }
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  }
  return { role: m.role, content: m.content };
}

function toOpenAITool(t: ToolDefinition): Record<string, unknown> {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
