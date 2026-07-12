// Helpers PUROS de sessão do gateway, extraídos de server.mjs para teste direto (padrão obsRelay/revocations).
//
// pruneExpired  — remove as sessões vencidas do Map.
// admitSession  — expira as vencidas e diz se há vaga para MAIS uma sessão, SEM nunca remover uma sessão
//                 VIVA. O antigo `sweepSessions(true)` varria TODAS as sessões (vivas inclusive) quando a
//                 tabela batia no teto: qualquer ativação nova deslogava todo mundo (DoS de mass-logout).
// authorizeScope — autoriza a operação de proxy contra o escopo ATESTADO da licença (server-side é a
//                 autoridade: ADR-3/RNF-002). O escopo é assinado na licença e carregado na sessão.

export function pruneExpired(sessions, nowSec) {
  let removed = 0;
  for (const [token, s] of sessions) {
    if (s.expiresAt <= nowSec) {
      sessions.delete(token);
      removed++;
    }
  }
  return removed;
}

// Expira as vencidas e retorna se cabe MAIS uma sessão. NUNCA remove sessão viva — no teto de sessões
// vivas, o chamador deve RECUSAR a ativação (backpressure), não deslogar terceiros.
export function admitSession(sessions, max, nowSec) {
  pruneExpired(sessions, nowSec);
  return sessions.size < max;
}

// codegen é a base de QUALQUER geração; "skills" é exigido apenas QUANDO a requisição ativa skills
// (o proxy sabe disso pelo header x-forge-skills). Escopo VAZIO/ausente = licença legada sem escopo →
// grandfather (não trava usuários existentes; só uma licença DELIBERADAMENTE estreita é gateada).
export function authorizeScope(scope, activatesSkills) {
  const s = Array.isArray(scope) ? scope : [];
  if (s.length === 0) return { ok: true, missing: [] };
  const missing = [];
  if (!s.includes("codegen")) missing.push("codegen");
  if (activatesSkills && !s.includes("skills")) missing.push("skills");
  return { ok: missing.length === 0, missing };
}

// Nova expiração de uma RENOVAÇÃO, com TETO na expiração da LICENÇA: a sessão nunca vive além da licença
// que a autorizou. Sem o teto, uma renovação repetida mantinha viva uma sessão de licença JÁ VENCIDA
// (a revogação mordia o renew, a expiração não) e permitia pinar a tabela de sessões além do TTL.
// Retorna null quando a licença já expirou — o chamador recusa (403) e mata a sessão.
export function renewedExpiry(licenseExpiry, nowSec, ttlSec) {
  if (licenseExpiry && licenseExpiry <= nowSec) return null;
  const base = nowSec + ttlSec;
  return licenseExpiry ? Math.min(licenseExpiry, base) : base;
}
