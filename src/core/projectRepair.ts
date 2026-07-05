// Onda 2 — auto-reparo dirigido pelo gate. Quando o gate workspace-wide (Onda 1) reprova arquivos por
// DRIFT de contrato (import/atributo fantasma), este módulo decide O QUE re-pedir ao modelo: cada
// arquivo reprovado + os erros exatos do gate + o CONTEÚDO REAL dos arquivos que ele importa e que
// PASSARAM (o contrato a copiar em vez de re-alucinar). Puro/testável — a geração e a troca de proposta
// (I/O) ficam no Controller.repairProjectFromGate.
import type { BlueprintFile } from "../shared/protocol";

// Normaliza para casar propostas × blueprint × saída do gate. Espelha normGatePath (barras pra frente,
// colapsa //, tira ./ e / final) E ainda tira / inicial — assim normRepairPath(normGatePath(x)) ===
// normRepairPath(x) para todo formato (o gate reporta caminhos já passados por normGatePath, e o mapa de
// conteúdo do reparo usa esta função; sem o alinhamento, um caminho com // ou / final não casaria).
// Exportada para o Controller montar o mapa com a MESMA chave que este módulo consulta.
export const normRepairPath = (p: string): string =>
  (p ?? "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "").trim();
const norm = normRepairPath;

export interface RepairContract {
  path: string;
  content: string;
}
export interface RepairTarget {
  path: string; // caminho normalizado do arquivo reprovado
  content: string; // conteúdo ATUAL (drifado) da proposta — o modelo vê o que errou
  errors: string[]; // erros do gate (mypy) atribuídos a este arquivo
  contracts: RepairContract[]; // conteúdo REAL dos arquivos-fonte que ele deve reusar
}

export interface SelectRepairOptions {
  maxContracts?: number; // teto de arquivos de contrato por alvo (protege a janela de tokens)
  maxContractChars?: number; // teto de chars por contrato (idem)
}

// Monta os alvos de reparo a partir dos erros por-arquivo do gate, do conteúdo de cada proposta (por
// caminho normalizado) e do blueprint (deps declaradas). Para cada arquivo reprovado, o contrato é o
// conteúdo dos seus deps que PASSARAM (um dep também reprovado não é contrato confiável). Se o arquivo
// não tem deps confiáveis, cai para TODOS os arquivos que passaram (capados) — o modelo ainda vê as
// assinaturas reais em vez de re-alucinar a API convencional. Determinístico.
export function selectRepairTargets(
  fileErrors: { path: string; errors: string[] }[],
  contentByPath: Map<string, string>,
  blueprint: BlueprintFile[],
  opts: SelectRepairOptions = {}
): RepairTarget[] {
  const maxContracts = opts.maxContracts ?? 12;
  const maxChars = opts.maxContractChars ?? 8000;
  const failed = new Set(fileErrors.map((f) => norm(f.path)));
  const depsByPath = new Map(blueprint.map((f) => [norm(f.path), (f.deps ?? []).map(norm)]));
  const cap = (c: string): string => (c.length > maxChars ? `${c.slice(0, maxChars)}\n# … (conteúdo truncado para caber no contexto)` : c);

  const targets: RepairTarget[] = [];
  for (const fe of fileErrors) {
    const p = norm(fe.path);
    const content = contentByPath.get(p);
    if (content === undefined || !fe.errors?.length) continue; // sem a proposta ou sem erro real: nada a reparar

    const contracts: RepairContract[] = [];
    const seen = new Set<string>([p]);
    // 1) Preferência: os deps DECLARADOS que passaram no gate (o contrato mais preciso).
    for (const d of depsByPath.get(p) ?? []) {
      if (seen.has(d) || failed.has(d)) continue;
      const c = contentByPath.get(d);
      if (c === undefined) continue;
      contracts.push({ path: d, content: cap(c) });
      seen.add(d);
      if (contracts.length >= maxContracts) break;
    }
    // 2) Fallback (deps ausentes/esparsas): todos os arquivos que passaram, capados.
    if (contracts.length === 0) {
      for (const [dp, c] of contentByPath) {
        if (seen.has(dp) || failed.has(dp)) continue;
        contracts.push({ path: dp, content: cap(c) });
        seen.add(dp);
        if (contracts.length >= maxContracts) break;
      }
    }
    targets.push({ path: p, content, errors: fe.errors, contracts });
  }
  return targets;
}
