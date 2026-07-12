// Auto-detecção da janela de contexto REALMENTE servida pelo gateway (vLLM/HubGPU): o catálogo
// (modelCatalog) tem a capacidade do MODELO (ex.: 128k do gpt-oss-120b), mas o servidor pode servir com
// `--max-model-len` MENOR. Sem reconciliar, o orçamento (ContextBudget) confia nos 128k e estoura → HTTP
// 400 em toda geração. O endpoint OpenAI-compatível expõe isso no GET /v1/models
// (`{data:[{id, max_model_len, …}]}`). Só faz sentido p/ provedores openai-compatible (OpenAI/Anthropic
// não reduzem a janela nem expõem esse campo). FAIL-OPEN: qualquer falha → null → o chamador usa o catálogo.
import { EgressEnforcer } from "../net/EgressEnforcer";
import { safeFetch } from "../net/safeFetch";

// Extrai o max_model_len servido para `modelId` do corpo do GET /v1/models. Casa por id exato, por
// sufixo (o gateway serve "openai/gpt-oss-120b" e o config pode pedir só "gpt-oss-120b" — ou vice-versa),
// ou — quando o gateway serve UM único modelo (o caso comum do HubGPU) — usa esse único. Retorna o
// inteiro > 0, ou null se ausente/implausível. Puro/testável.
export function parseServedContextWindow(body: unknown, modelId: string): number | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const entries = data.filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
  const tail = (s: string) => s.split("/").pop() ?? s;
  const idMatch = (id: unknown): boolean =>
    typeof id === "string" && (id === modelId || id.endsWith("/" + modelId) || modelId.endsWith("/" + id) || tail(id) === tail(modelId));
  const pick = entries.find((m) => idMatch(m.id)) ?? (entries.length === 1 ? entries[0] : undefined);
  const len = pick?.max_model_len;
  return typeof len === "number" && Number.isFinite(len) && len > 0 ? Math.floor(len) : null;
}

// Consulta o GET {baseUrl}/models e devolve o max_model_len servido para o modelo (ou null). Egress-checked,
// timeout curto. FAIL-OPEN: rede/404/corpo inesperado/egress negado → null (o chamador cai no catálogo, o
// comportamento atual). O chamador monta os headers (auth do provider); no HubGPU o /models não exige auth.
export async function probeServedContextWindow(
  baseUrl: string | undefined,
  modelId: string,
  headers: Record<string, string>,
  egress: EgressEnforcer,
  timeoutMs: number
): Promise<number | null> {
  const base = (baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return null;
  const url = `${base}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    egress.assertAllowed(url);
    const res = await safeFetch(url, { method: "GET", headers, signal: ctrl.signal });
    if (!res.ok) return null;
    return parseServedContextWindow(await res.json(), modelId);
  } catch {
    return null; // fail-open: qualquer erro → sem detecção → usa o catálogo
  } finally {
    clearTimeout(timer);
  }
}
