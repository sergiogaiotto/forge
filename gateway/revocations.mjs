// Verificador de revogação com cache por mtime (Fase 1 de endurecimento).
//
// Antes: a revogação só era consultada em /license/activate. /license/renew e o proxy de inferência
// nunca reviam a lista — então um usuário revogado mantinha acesso ao proxy indefinidamente (renovando
// a sessão em memória) até o gateway reiniciar. Este módulo fecha o gap: o gateway consulta `isRevoked`
// em activate, renew E proxy, e a lista é relida do disco só quando o arquivo muda (stat por mtime —
// barato o bastante para rodar a cada request de proxy, sem staleness).
//
// PURO/injetável (fs via `deps`) para teste em Node sem tocar o disco real. Política de erro: um JSON
// corrompido/ilegível NÃO zera a lista conhecida — mantém o último estado bom (fail-safe conservador:
// um usuário revogado continua revogado mesmo que o arquivo depois quebre), e reporta via `onError`.
import * as nodeFs from "node:fs";

export function createRevocationChecker(revocationsPath, deps = {}) {
  const existsSync = deps.existsSync ?? nodeFs.existsSync;
  const statSync = deps.statSync ?? nodeFs.statSync;
  const readFileSync = deps.readFileSync ?? nodeFs.readFileSync;
  const onError = deps.onError ?? (() => {});

  // -1 = nunca carregado; 0 = arquivo ausente (lista vazia conhecida). set = subjects revogados.
  let cache = { mtimeMs: -1, set: new Set() };

  function refresh() {
    if (!existsSync(revocationsPath)) {
      cache = { mtimeMs: 0, set: new Set() }; // sem lista = ninguém revogado (estado conhecido)
      return;
    }
    let mtimeMs;
    try {
      mtimeMs = statSync(revocationsPath).mtimeMs;
    } catch (e) {
      onError(e); // não deu para checar o mtime — mantém o cache anterior
      return;
    }
    if (mtimeMs === cache.mtimeMs && cache.mtimeMs !== -1) return; // não mudou desde a última leitura
    try {
      const arr = JSON.parse(readFileSync(revocationsPath, "utf8"));
      const set = new Set((Array.isArray(arr) ? arr : []).map((r) => r && r.subject).filter(Boolean));
      cache = { mtimeMs, set };
    } catch (e) {
      // JSON corrompido: mantém a última lista boa (não libera geral), mas marca o mtime para não
      // repetir o parse a cada request enquanto o arquivo estiver quebrado.
      onError(e);
      cache = { mtimeMs, set: cache.set };
    }
  }

  return {
    isRevoked(subject) {
      if (!subject) return false;
      refresh();
      return cache.set.has(subject);
    },
    // Exposto para teste/observabilidade — não usar em caminho quente sem refresh().
    _snapshot() {
      return { mtimeMs: cache.mtimeMs, subjects: [...cache.set] };
    },
  };
}
