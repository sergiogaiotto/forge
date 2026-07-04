import { EgressEnforcer } from "../../net/EgressEnforcer";
import { ProviderType } from "../../shared/protocol";
import { combineSignals, HttpError, sseLines } from "../../util/http";
import { DEFAULT_MAX_TOKENS } from "../presets";
import { buildAuthHeaders, ChatMessage, CreateMessageOptions, LLMProvider, ProviderRuntimeConfig, StreamChunk, ToolDefinition } from "../types";

// Piso de timeout do modo NÃO-streaming: a resposta inteira chega de uma vez (não há chunks provando
// vida), e o raciocínio do gpt-oss pode levar dezenas de segundos antes de qualquer conteúdo. Não
// herdar o piso curto do esforço "low" (120s), que cortaria one-shots longos. 300s casa o esforço "medium".
const NON_STREAMING_MIN_TIMEOUT_MS = 300_000;

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

  // Monta o corpo Chat Completions. O `stream` liga/desliga o SSE; o resto (max_tokens, reasoning_effort,
  // temperature, response_format, tools) é idêntico nos dois transportes — daí ser fatorado aqui.
  private buildBody(systemPrompt: string, messages: ChatMessage[], opts: CreateMessageOptions, streaming: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.cfg.modelId,
      stream: streaming,
      // Teto explícito de saída: sem ele o gateway corta o "arquivo completo" no meio. Ver
      // DEFAULT_MAX_TOKENS. cfg.maxTokens permite override por configuração quando definido.
      max_tokens: this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: "system", content: systemPrompt }, ...messages.map(toOpenAIMessage)],
    };
    if (streaming) body.stream_options = { include_usage: true };
    // gpt-oss e afins aceitam `reasoning_effort` (low/medium/high) no corpo Chat Completions.
    if (this.cfg.reasoningEffort) body.reasoning_effort = this.cfg.reasoningEffort;
    // `!== undefined` (não truthiness): temperature 0 é um valor VÁLIDO e o mais usado aqui.
    if (this.cfg.temperature !== undefined) body.temperature = this.cfg.temperature;
    // JSON GARANTIDO pelo decoder (guided decoding do vLLM/OpenAI): para tarefas de saída JSON
    // estrita (blueprint), elimina a loteria do parse — o servidor só emite JSON válido.
    if (opts.jsonResponse) body.response_format = { type: "json_object" };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map(toOpenAITool);
      body.tool_choice = "auto";
    }
    return body;
  }

  // Faz o POST com a degradação automática de response_format: gateway antigo pode rejeitar com 400.
  // Reenvia UMA vez sem o campo (o chamador segue com o pipeline tolerante de parse). Mutila `body` de
  // propósito (remove response_format) para o retry-once de resposta malformada reusar o mesmo corpo.
  // Compartilhado entre streaming e não-streaming — não duplicar, senão o não-streaming perde a degradação.
  private async fetchWithDegradation(doFetch: (b: Record<string, unknown>) => Promise<Response>, body: Record<string, unknown>, opts: CreateMessageOptions): Promise<Response> {
    let res = await doFetch(body);
    if (!res.ok && res.status === 400 && opts.jsonResponse) {
      const errText = await safeText(res);
      if (/response_format|json_object|guided/i.test(errText)) {
        delete body.response_format;
        res = await doFetch(body);
      } else {
        // 400 por OUTRA causa: re-embrulha para o tratamento padrão do chamador (corpo já consumido).
        throw new HttpError(400, `Provedor retornou 400${hintFor400(errText)}: ${errText.slice(0, 500)}`);
      }
    }
    return res;
  }

  async *createMessage(
    systemPrompt: string,
    messages: ChatMessage[],
    opts: CreateMessageOptions
  ): AsyncIterable<StreamChunk> {
    const url = this.endpoint();
    this.egress.assertAllowed(url);

    const streaming = opts.streaming ?? true;
    const body = this.buildBody(systemPrompt, messages, opts, streaming);
    // Não-streaming recebe a resposta inteira de uma vez → piso de timeout maior (ver constante).
    const timeoutMs = streaming ? opts.timeoutMs : Math.max(opts.timeoutMs, NON_STREAMING_MIN_TIMEOUT_MS);
    const signal = combineSignals(opts.signal, timeoutMs);
    const doFetch = (payload: Record<string, unknown>): Promise<Response> =>
      fetch(url, {
        method: "POST",
        headers: { ...buildAuthHeaders(this.cfg), ...(opts.extraHeaders ?? {}) },
        body: JSON.stringify(payload),
        signal,
      });

    let res: Response;
    try {
      res = await this.fetchWithDegradation(doFetch, body, opts);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        yield { kind: "error", message: `Tempo limite (${Math.round(timeoutMs / 1000)}s) ou cancelado.` };
        return;
      }
      yield { kind: "error", message: `Falha de conexão ao provedor: ${e.message}` };
      return;
    }

    if (!res.ok) {
      const text = await safeText(res);
      const hint = res.status === 400 ? hintFor400(text) : "";
      throw new HttpError(res.status, `Provedor retornou ${res.status}${hint}: ${text.slice(0, 500)}`);
    }

    if (streaming) yield* this.streamChunks(res);
    // O retry-once do não-streaming passa pela MESMA degradação de response_format (via
    // fetchWithDegradation), não pelo fetch cru — senão um 400 tardio (nó que rejeita o campo) num
    // retry viraria erro seco em vez de degradar-e-suceder.
    else yield* this.nonStreamingChunks(res, () => this.fetchWithDegradation(doFetch, body, opts));
  }

  // Caminho STREAMING (SSE): consome os deltas e emite os StreamChunk incrementalmente.
  private async *streamChunks(res: Response): AsyncIterable<StreamChunk> {
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
        yield this.lengthWarning();
      }
    }
  }

  // Caminho NÃO-STREAMING: uma única resposta JSON. Emite a MESMA sequência de StreamChunk que o
  // streaming (usage → reasoning → text → tool_call → warning-se-length) para os consumidores não
  // perceberem diferença. O gpt-oss/HubGPU aqui ISOLA o raciocínio em `reasoning_content` (não vaza
  // o canal harmony no `content`) e o `finish_reason` vem confiável no corpo.
  private async *nonStreamingChunks(res: Response, refetch: () => Promise<Response>): AsyncIterable<StreamChunk> {
    let json: any;
    try {
      json = await this.readJsonWithRetry(res, refetch);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      yield { kind: "error", message: `Falha ao ler a resposta do provedor: ${(err as Error).message}` };
      return;
    }
    // Sem `choices` mesmo após o retry-once: resposta transitória inválida do gateway (não é o caso
    // legítimo de content vazio — esse tem `choices` com message.content === "").
    if (!Array.isArray(json?.choices) || json.choices.length === 0) {
      yield { kind: "error", message: "Provedor retornou resposta sem 'choices' (inválida) mesmo após retry." };
      return;
    }
    if (json.usage) {
      yield { kind: "usage", inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 };
    }
    const choice = json.choices[0];
    const msg = choice.message ?? {};
    const reasoning = msg.reasoning_content ?? msg.reasoning;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      yield { kind: "reasoning", text: reasoning };
    }
    if (typeof msg.content === "string" && msg.content.length > 0) {
      yield { kind: "text", text: msg.content };
    }
    // Tool calls no não-streaming já vêm completas em message.tool_calls (não fragmentadas). Emitidas só
    // quando finish_reason=="tool_calls" (paridade com o streaming; truncadas por "length" são descartadas).
    // Fallback do id pelo ÍNDICE (como no streaming) — se o gateway omitir tc.id em várias chamadas,
    // "call_0" fixo colidiria; "call_${i}" mantém ids distintos.
    if (choice.finish_reason === "tool_calls" && Array.isArray(msg.tool_calls)) {
      for (let i = 0; i < msg.tool_calls.length; i++) {
        const tc = msg.tool_calls[i];
        yield { kind: "tool_call", id: tc.id ?? `call_${i}`, name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" };
      }
    }
    if (choice.finish_reason === "length") {
      yield this.lengthWarning();
    }
  }

  // Lê o corpo JSON; se ele NÃO parsear ou vier sem `choices` (resposta transitória do gateway), refaz
  // a chamada UMA vez. NUNCA retria por `content === ""`: content vazio COM choices é resultado legítimo
  // (o raciocínio consumiu todo o max_tokens) — retriar só queimaria tokens repetindo o mesmo.
  private async readJsonWithRetry(res: Response, refetch: () => Promise<Response>): Promise<any> {
    const parse = async (r: Response): Promise<any | null> => {
      let j: any;
      try {
        j = await r.json();
      } catch {
        return null;
      }
      return Array.isArray(j?.choices) && j.choices.length > 0 ? j : null;
    };
    const first = await parse(res);
    if (first) return first;
    // malformado / sem choices → retry-once (pela via com degradação de response_format)
    const res2 = await refetch();
    if (!res2.ok) {
      const text = await safeText(res2);
      const hint = res2.status === 400 ? hintFor400(text) : "";
      throw new HttpError(res2.status, `Provedor retornou ${res2.status}${hint}: ${text.slice(0, 500)}`);
    }
    return (await parse(res2)) ?? {}; // {} sem choices → o chamador emite o erro de "sem choices"
  }

  private lengthWarning(): StreamChunk {
    const cap = this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
    return {
      kind: "warning",
      message: `Resposta truncada por atingir o limite de ${cap} tokens de saída. O arquivo pode estar incompleto — peça a continuação ou aumente o limite de tokens.`,
    };
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

// Dica acionável em pt-BR conforme a causa provável do 400, em vez de só repassar o corpo cru.
// Ordem importa: "temperature" antes do check genérico de "parameter" — senão a dica mandaria o
// usuário ajustar o esforço de raciocínio para um erro causado pela temperature.
function hintFor400(text: string): string {
  const low = text.toLowerCase();
  if (low.includes("temperature")) {
    return " (o modelo não aceita o parâmetro temperature enviado — modelos de raciocínio da OpenAI só aceitam o default)";
  }
  if (low.includes("reasoning_effort") || low.includes("unknown") || low.includes("unexpected") || low.includes("parameter")) {
    return " (o gateway pode não aceitar o parâmetro reasoning_effort — reduza/ajuste o esforço de raciocínio)";
  }
  if (low.includes("token") || low.includes("context") || low.includes("length")) {
    return " (o limite de tokens de saída somado ao contexto pode exceder a janela do modelo no gateway)";
  }
  return "";
}
