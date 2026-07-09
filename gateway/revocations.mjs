// Verificador de revogação com cache por assinatura de arquivo (Fase 1 de endurecimento).
//
// Antes: a revogação só era consultada em /license/activate. /license/renew e o proxy de inferência
// nunca reviam a lista — então um usuário revogado mantinha acesso ao proxy indefinidamente (renovando
// a sessão em memória) até o gateway reiniciar. Este módulo fecha o gap: o gateway consulta `isRevoked`
// em activate, renew E proxy, e a lista é relida do disco só quando o arquivo muda.
//
// Robustez (achados da revisão adversarial):
//  - CANONICALIZAÇÃO: subjects são comparados em trim+lowercase dos dois lados — um subject emitido
//    `Dev@Claro.com` e revogado `dev@claro.com` (e-mail é case-insensitive na prática) ainda casa.
//  - ASSINATURA mtime+size, não só mtime: dois writes na mesma resolução de mtime (NTFS ~1ms) não
//    mascaram mais a nova revogação quando o tamanho muda (o caso comum — a lista cresce). Um TTL de
//    segurança relê ao menos a cada STALE_TTL_MS mesmo com assinatura idêntica.
//  - COLD-START fail-safe: se o arquivo existe mas não parseia ANTES de qualquer carga boa, NÃO cacheia
//    a falha como lista vazia — mantém re-tentando a cada chamada (auto-cura quando o operador corrige)
//    e reporta via onError (o gateway loga em ERROR). Depois de uma lista boa, um JSON quebrado mantém
//    a última lista conhecida (um revogado continua revogado).
//
// PURO/injetável (fs + clock via `deps`) para teste em Node sem tocar o disco real.
import * as nodeFs from "node:fs";

const STALE_TTL_MS = 5000; // rede de segurança: relê ao menos a cada 5s mesmo com assinatura idêntica

function canon(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

export function createRevocationChecker(revocationsPath, deps = {}) {
  const existsSync = deps.existsSync ?? nodeFs.existsSync;
  const statSync = deps.statSync ?? nodeFs.statSync;
  const readFileSync = deps.readFileSync ?? nodeFs.readFileSync;
  const onError = deps.onError ?? (() => {});
  const now = deps.now ?? Date.now;

  let loadedOnce = false; // já lemos uma lista boa (ou confirmamos ausência) ao menos uma vez?
  let sig = ""; // assinatura "mtimeMs:size" do arquivo na última leitura
  let lastReadAt = 0;
  let set = new Set(); // subjects revogados, já canonicalizados

  function refresh() {
    if (!existsSync(revocationsPath)) {
      set = new Set(); // sem lista = ninguém revogado (estado conhecido e seguro)
      sig = "absent";
      loadedOnce = true;
      lastReadAt = now();
      return;
    }
    let st;
    try {
      st = statSync(revocationsPath);
    } catch (e) {
      onError(e); // não deu para checar o arquivo — mantém o estado anterior
      return;
    }
    const nextSig = `${st.mtimeMs}:${st.size}`;
    const fresh = now() - lastReadAt <= STALE_TTL_MS;
    if (loadedOnce && nextSig === sig && fresh) return; // nada mudou e ainda fresco → usa cache
    try {
      const arr = JSON.parse(readFileSync(revocationsPath, "utf8"));
      set = new Set((Array.isArray(arr) ? arr : []).map((r) => canon(r && r.subject)).filter(Boolean));
      sig = nextSig;
      loadedOnce = true;
      lastReadAt = now();
    } catch (e) {
      onError(e);
      if (loadedOnce) {
        // Já tínhamos uma lista boa: mantém-a (fail-safe — revogado continua revogado) e marca a
        // assinatura para não re-parsear em loop enquanto o arquivo estiver quebrado.
        sig = nextSig;
        lastReadAt = now();
      }
      // Cold-start (nunca houve lista boa): NÃO cacheia a falha — a próxima chamada re-tenta o parse,
      // auto-curando assim que o operador corrigir o arquivo. `set` fica vazio nesse intervalo, então
      // o gateway deve tratar o onError de cold-start como estado a alertar (log em ERROR).
    }
  }

  return {
    isRevoked(subject) {
      const s = canon(subject);
      if (!s) return false;
      refresh();
      return set.has(s);
    },
    // true quando já lemos uma lista boa/ausência ao menos uma vez (para o gateway detectar cold-start
    // inseguro: arquivo presente mas ainda ilegível).
    isReady() {
      return loadedOnce;
    },
    // Exposto para teste/observabilidade — não usar em caminho quente sem refresh().
    _snapshot() {
      return { sig, loadedOnce, subjects: [...set] };
    },
  };
}
