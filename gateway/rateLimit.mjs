// Rate-limit PURO (token bucket por CHAVE), extraído de server.mjs para teste direto (padrão sessions/obsRelay).
// O Map de buckets vive no server.mjs; estas funções operam sobre ele com o relógio (now) INJETADO (determinístico
// em teste). A CHAVE é escolhida pelo chamador — por SUBJECT, NÃO por token: keyar por token deixaria um subject
// com N sessões (N tokens) multiplicar o próprio limite por N (bypass do rate-limit; achado do survey).
//
// PODA: um bucket CHEIO (tokens >= cap) e ocioso é INDISTINGUÍVEL de ausente — o rateLimited recria um bucket
// cheio idêntico no próximo acesso à chave. Logo removê-lo NÃO altera nenhuma decisão futura, e isso bounda a
// memória do Map (sem poda, um bucket por token/subject já visto ficaria retido para sempre — leak em sessão longa).

// Decide+consome 1 do bucket da chave. true = LIMITADO (sem token disponível). Muta o bucket no Map (cria cheio
// se ausente — um chamador novo começa com o balde cheio). `now` = Date.now() (injetado). Puro.
export function rateLimited(buckets, key, capPerMin, now) {
  const refillPerMs = capPerMin / 60000;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: capPerMin, updatedAt: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(capPerMin, b.tokens + (now - b.updatedAt) * refillPerMs);
  b.updatedAt = now;
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}

// Remove os buckets que, em `now`, estariam CHEIOS (refilados ao cap) — equivalentes a ausentes (ver acima).
// Bounda a memória do Map. Retorna quantos removeu. O(n) — o chamador a dispara só ao encostar num teto de
// chaves (barato no caminho comum), não a cada request. Puro.
export function pruneRateBuckets(buckets, capPerMin, now) {
  const refillPerMs = capPerMin / 60000;
  let removed = 0;
  for (const [k, b] of buckets) {
    const refilled = Math.min(capPerMin, b.tokens + (now - b.updatedAt) * refillPerMs);
    if (refilled >= capPerMin) {
      buckets.delete(k);
      removed++;
    }
  }
  return removed;
}
