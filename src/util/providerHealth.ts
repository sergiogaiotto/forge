// Sonda de SAÚDE do provider (RF: o painel não pode dizer "Pronto para gerar" com o endpoint
// morto — o dev só descobria a falha no fim da montagem do contexto, com a geração explodindo).
// Semântica: "ok" = o endpoint respondeu HTTP com status < 500. 401/403/404 contam como VIVO
// (rota alcançável; auth/rota é outro problema, e a geração usa outro path). 5xx conta como
// FORA (um LB/ingress respondendo 502/503/504 significa upstream morto — a geração VAI falhar).
// 3xx também conta como FORA por política: o safeFetch é redirect:'error' fail-closed (um gateway
// que redireciona p/ página de SSO/login não serve geração) — a mensagem tenta dizer isso.
import { safeFetch } from "../net/safeFetch";
import { EgressBlockedError } from "../net/EgressEnforcer";
import type { EgressEnforcer } from "../net/EgressEnforcer";

export interface ProviderHealth {
  ok: boolean;
  status?: number; // status HTTP quando houve resposta
  latencyMs?: number;
  error?: string; // falha de rede/timeout/egress quando ok=false
  blocked?: boolean; // true quando o EgressEnforcer negou o host (config, não rede — sem retry automático)
  checkedAt: number; // epoch ms
}

export const HEALTH_PROBE_TIMEOUT_MS = 4000;
// Vermelho: re-sonda curta — VPN corporativa volta a qualquer momento e o badge deve se
// recuperar sozinho. Verde: batimento LENTO para pegar o verde-fóssil (VPN caiu com a janela
// aberta) sem spammar o gateway — 1 GET leve a cada 5 min.
export const HEALTH_RETRY_MS = 60_000;
export const HEALTH_GREEN_RECHECK_MS = 300_000;

export function healthProbeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

// Achata a cadeia de causas (undici embrulha o motivo real em e.cause — "fetch failed" sozinho
// não diz nada; o tooltip precisa do ECONNREFUSED/ETIMEDOUT/redirect real).
export function flattenErrorChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    const msg = cur instanceof Error ? cur.message : String(cur);
    if (msg && !parts.includes(msg)) parts.push(msg);
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : undefined;
  }
  return parts.join(" ← ") || "erro desconhecido";
}

export async function probeProviderHealth(
  baseUrl: string | undefined,
  headers: Record<string, string>,
  egress: EgressEnforcer,
  timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS,
  fetchImpl?: typeof fetch,
  now: () => number = Date.now
): Promise<ProviderHealth | null> {
  // Sem baseUrl (SaaS gerido: OpenAI/Anthropic) não há o que sondar — badge ausente, não vermelho.
  if (!baseUrl) return null;
  const url = healthProbeUrl(baseUrl);
  const t0 = now();
  try {
    egress.assertAllowed(url);
  } catch (e) {
    // Egress negado é CONFIG (não rede): sem retry automático — o onChange de config re-sonda.
    return { ok: false, error: flattenErrorChain(e), blocked: true, checkedAt: now() };
  }
  try {
    const res = await safeFetch(url, {
      headers,
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    // Consome/cancela o corpo para não vazar a conexão (o conteúdo é irrelevante aqui).
    try {
      await res.body?.cancel();
    } catch {
      /* corpo já consumido/fechado */
    }
    return { ok: res.status < 500, status: res.status, latencyMs: now() - t0, checkedAt: now() };
  } catch (e) {
    if (e instanceof EgressBlockedError) {
      return { ok: false, error: flattenErrorChain(e), blocked: true, latencyMs: now() - t0, checkedAt: now() };
    }
    return { ok: false, error: flattenErrorChain(e), latencyMs: now() - t0, checkedAt: now() };
  }
}
