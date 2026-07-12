// Extrai a contagem de tokens do stream SSE do provedor (campo `usage` no formato OpenAI). PURO.
//
// Order-INDEPENDENT: lê prompt_tokens e completion_tokens SEPARADAMENTE, cada um pelo seu próprio regex,
// então o mapeamento prompt→input / completion→output está SEMPRE correto — independentemente da ORDEM
// em que os campos aparecem no corpo. O código anterior tentava normalizar via índices m[1]/m[2] FIXOS
// sobre dois regexes alternativos e, na ordem PADRÃO do OpenAI (prompt_tokens ANTES de completion_tokens),
// INVERTIA os dois — todo registro de token ficava trocado. Testado em ambas as ordens (gatewayUsage.test.ts).
//
// Pega a ÚLTIMA ocorrência de cada campo: em streaming com include_usage o bloco de usage vem uma vez no
// fim, mas provedores que emitem usage cumulativo em vários chunks devolvem o total no último. Sem
// quantificador aninhado nem alternância ambígua (varredura linear O(n)) — sem risco de ReDoS no egresso.
export function extractUsage(sse) {
  const s = typeof sse === "string" ? sse : "";
  const last = (re) => {
    const g = new RegExp(re, "g");
    let m;
    let out = null;
    while ((m = g.exec(s)) !== null) out = m[1];
    return out;
  };
  const prompt = last('"prompt_tokens"\\s*:\\s*(\\d+)');
  const completion = last('"completion_tokens"\\s*:\\s*(\\d+)');
  return {
    inputTokens: prompt ? parseInt(prompt, 10) : 0,
    outputTokens: completion ? parseInt(completion, 10) : 0,
  };
}
