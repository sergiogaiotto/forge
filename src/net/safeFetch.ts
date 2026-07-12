// Fetch de saída redirect-safe — a peça que faltava no egress deny-by-default (RNF-014, ADR-7).
//
// O EgressEnforcer.assertAllowed valida SÓ a URL inicial, UMA vez, antes do fetch. Mas o undici
// (o fetch do Node) segue redirect por PADRÃO (redirect:'follow', até 20 saltos) e em 307/308
// PRESERVA método + corpo. Consequência: um host permitido comprometido/MITM responde 307 e o
// mesmo POST — system prompt + chunks de RAG + o arquivo do editor — é reenviado a um host
// ARBITRÁRIO, fora da allowlist. O assertAllowed nunca vê o destino do salto → exfiltração
// silenciosa que fura o deny-by-default (achado #01 do survey de oportunidades).
//
// Defesa fail-closed: redirect:'error' faz o fetch REJEITAR qualquer 3xx em vez de segui-lo.
// Por que não redirect:'manual' + re-assertAllowed(location) a cada salto? Porque no undici o
// modo 'manual' devolve uma resposta OPACA (type:'opaqueredirect', status 0, sem Location
// legível): seguir o redirect manualmente exigiria a API dispatch de baixo nível — não é o
// esforço S desta correção e traz risco próprio. Os endpoints do FORGE (gateway/provider/
// langfuse/mcp) são fixos e não redirecionam; recusar 3xx é a postura correta. Um redirect
// legítimo passa a ser decisão EXPLÍCITA de allowlist (adicionar o host de destino), não um
// default silencioso.
//
// Choke point ÚNICO: todos os fetch de saída de produção passam por aqui (um fix numa cópia
// espalhada não propagaria — exatamente a classe de bug que já mordeu o repo). fetchImpl é
// injetável para os sinks que já injetam fetch em teste (ex.: GatewayRelaySink).

export interface SafeFetchInit extends RequestInit {
  /** Impl de fetch injetável (testes / relay governado). Ausente = fetch global. */
  fetchImpl?: typeof fetch;
}

export function safeFetch(url: string, init: SafeFetchInit = {}): Promise<Response> {
  const { fetchImpl, ...rest } = init;
  // redirect:'error' por ÚLTIMO no spread: força a política mesmo que o chamador passe outro valor.
  return (fetchImpl ?? fetch)(url, { ...rest, redirect: "error" });
}
