// Auxiliares de HTTP por streaming compartilhados pelos provedores. Usa o fetch global (Node 18+),
// mantendo o host da extensão livre de dependências (RNF-016).

export function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  // AbortSignal.any está disponível no Node 20+.
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any([signal, timeout]);
  }
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  timeout.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}

/**
 * Lê um corpo `text/event-stream` e emite cada string de payload `data:`
 * (excluindo o `[DONE]` terminal). Funciona com o ReadableStream web que
 * o fetch retorna no Node.
 */
export async function* sseLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      // Os limites de eventos são quebras de linha; frames SSE podem agrupar várias linhas `data:`.
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!rawLine.startsWith("data:")) continue;
        const data = rawLine.slice(5).trim();
        if (data === "[DONE]") return;
        if (data.length > 0) yield data;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignorar */
    }
  }
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
