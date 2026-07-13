// Ledger de gasto de TOKENS por subject e DIA (UTC) — o teto AUTORITATIVO do FinOps (#12). O orçamento
// (tokens/dia) vem ASSINADO na licença (como o scope), então é não-spoofável; o gateway é a autoridade
// (ADR-3/RNF-002). Tokens são a unidade: o gateway os conta de forma autoritativa (extractUsage) e NÃO
// precisa de tabela de preços server-side (o cliente traduz tokens→R$ só para exibir). PURO/injetável
// (padrão sessions/revocations); o I/O (persistência durável) fica no server.mjs.
//
// Ledger = Map<subject, { day: "YYYY-MM-DD", tokens: number }> — só o dia CORRENTE por subject. Um dia
// diferente = rollover implícito (spentToday/charge zeram).
//
// RESERVA→RECONCILIAÇÃO (fecha a corrida check-then-charge): o proxy RESERVA um estimado (input + max de
// saída) SINCRONAMENTE no admit — no mesmo tick do overBudget, sem await entre eles — então requisições
// CONCORRENTES do mesmo subject veem a reserva e são barradas (o estouro fica limitado a ~uma requisição
// em voo, não ao burst inteiro). Ao fim do stream, `settle` troca a reserva pelo custo REAL.
//
// Escopo: teto por INSTÂNCIA e eventualmente-consistente (o ledger é persistido periodicamente; ver
// server.mjs). Atrás de várias réplicas, use um store compartilhado — mesma ressalva de sessions/rateBuckets.

export function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD em UTC
}

// Tokens já gastos HOJE pelo subject (0 se ausente ou de outro dia — rollover).
export function spentToday(ledger, subject, day) {
  const e = ledger.get(subject);
  return e && e.day === day ? e.tokens : 0;
}

// Já estourou o orçamento? budget ausente/<=0 = ILIMITADO (grandfather licenças sem budget assinado).
export function overBudget(ledger, subject, day, budget) {
  if (!budget || budget <= 0) return false;
  return spentToday(ledger, subject, day) >= budget;
}

// Cobra tokens do subject no dia (dia diferente zera a base — rollover). Retorna o novo total do dia.
export function charge(ledger, subject, day, tokens) {
  const e = ledger.get(subject);
  const base = e && e.day === day ? e.tokens : 0;
  const add = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  const total = base + add;
  ledger.set(subject, { day, tokens: total });
  return total;
}

// Estimativa CONSERVADORA do custo em tokens de uma requisição, para RESERVAR no admit. input ~ len/4
// (JSON infla, o que é bom p/ um teto); saída = max_tokens do corpo, senão o default configurado. Regex
// bounded (varredura linear, sem quantificador aninhado) — mesmo cuidado anti-ReDoS do extractUsage.
export function estimateRequestTokens(bodyText, defaultMaxOut) {
  const s = typeof bodyText === "string" ? bodyText : "";
  const inputEst = Math.ceil(s.length / 4);
  const m = /"max_tokens"\s*:\s*(\d+)/.exec(s);
  const maxOut = m ? parseInt(m[1], 10) : (Number.isFinite(defaultMaxOut) && defaultMaxOut > 0 ? Math.floor(defaultMaxOut) : 0);
  return inputEst + maxOut;
}

// Estimativa CONSERVADORA de tokens REALMENTE consumidos quando o upstream NÃO ecoou o bloco `usage` (apesar
// do include_usage injetado — upstream que o ignora). Input do corpo enviado, output do texto recebido, ~len/4
// cada. É o FALLBACK que impede o settle de estornar a reserva a zero quando não há usage — o chamador só o usa
// se houve OUTPUT (geração real); output vazio (502/sem geração) segue estornando (actual=0). PURO.
export function estimateActualTokens(bodyText, outputText) {
  const inp = typeof bodyText === "string" ? Math.ceil(bodyText.length / 4) : 0;
  const out = typeof outputText === "string" ? Math.ceil(outputText.length / 4) : 0;
  return inp + out;
}

// Reconcilia uma RESERVA: troca `reserve` (estimado, cobrado no admit) pelo `actual` (real, pós-stream).
// Aplica o delta ao total do dia com piso 0. Se o dia virou durante o stream (rollover no meio), a reserva
// se perdeu — cobra só o actual no dia corrente.
export function settle(ledger, subject, day, reserve, actual) {
  const r = Number.isFinite(reserve) && reserve > 0 ? Math.floor(reserve) : 0;
  const a = Number.isFinite(actual) && actual > 0 ? Math.floor(actual) : 0;
  const e = ledger.get(subject);
  if (!e || e.day !== day) {
    if (a > 0) ledger.set(subject, { day, tokens: a });
    return;
  }
  ledger.set(subject, { day, tokens: Math.max(0, e.tokens - r + a) });
}

// Poda entradas de dias anteriores (mantém o ledger enxuto). Chamado no flush.
export function pruneOldDays(ledger, day) {
  let removed = 0;
  for (const [k, v] of ledger) {
    if (v.day !== day) {
      ledger.delete(k);
      removed++;
    }
  }
  return removed;
}

// Serializa SÓ o dia corrente para persistência durável (JSON { day, entries: { subject: tokens } }).
export function serializeLedger(ledger, day) {
  // Object.create(null): sem protótipo, um subject chamado "__proto__" vira propriedade PRÓPRIA (o `{}`
  // dispararia o setter de __proto__ e a entrada sumiria do JSON — perda de gasto na durabilidade).
  const entries = Object.create(null);
  for (const [k, v] of ledger) if (v.day === day) entries[k] = v.tokens;
  return JSON.stringify({ day, entries });
}

// Reconstrói o ledger de um JSON persistido. Corrompido/ausente → Map vazio (fail-safe). Um ledger de
// dia ANTERIOR carrega inofensivo — spentToday/charge fazem rollover pelo dia corrente.
export function parseLedger(json) {
  const ledger = new Map();
  try {
    const o = JSON.parse(json);
    if (o && typeof o === "object" && typeof o.day === "string" && o.entries && typeof o.entries === "object") {
      for (const [k, t] of Object.entries(o.entries)) {
        if (typeof t === "number" && Number.isFinite(t) && t >= 0) ledger.set(k, { day: o.day, tokens: t });
      }
    }
  } catch {
    /* corrompido → ledger vazio */
  }
  return ledger;
}
