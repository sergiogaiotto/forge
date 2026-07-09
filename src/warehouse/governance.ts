// Governança por MOTOR da execução de SQL (Onda 3): a decisão de rodar não vem de prompt — vem do
// classificador determinístico (P1). SELECT/leitura roda; escrita exige conexão readonly:false E
// confirmação humana; DROP/TRUNCATE nunca rodam (sem override, como no altimate — mas aqui a regra
// vale igual para o caminho tradicional e para o MCP). SQL que o scanner não entende por inteiro
// (string não-terminada) é tratado como escrita: análise parcial nunca ganha benefício da dúvida
// para EXECUTAR (o inverso do gate de proposta, onde análise parcial não pode BLOQUEAR). PURO.
import { classifySql } from "../sql/classify";

export type RunVerdict = "auto" | "confirm" | "blocked";

export interface RunDecision {
  verdict: RunVerdict;
  reason: string;
  kinds: string[]; // tipos de statement encontrados (para o modal e a auditoria)
}

export function decideSqlRun(sql: string, conn: { readonly?: boolean }): RunDecision {
  const stmts = classifySql(sql);
  const kinds = [...new Set(stmts.map((s) => s.kind))];
  const isReadonly = conn.readonly !== false; // default: somente leitura

  if (stmts.length === 0) return { verdict: "blocked", reason: "Nenhum statement SQL reconhecido.", kinds };

  if (stmts.some((s) => s.destructive)) {
    return {
      verdict: "blocked",
      reason: "DROP/TRUNCATE são destrutivos e NUNCA executam pelo FORGE — rode manualmente se for intencional.",
      kinds,
    };
  }
  const unterminated = stmts.some((s) => s.unterminated);
  const writes = stmts.filter((s) => s.write).map((s) => s.kind.toUpperCase());
  // Defesa em profundidade: statement que o classificador não entendeu por inteiro (kind "other" não
  // vazio) NUNCA é leitura garantida — trata como escrita (achado da revisão: dialetos/sintaxes fora
  // do KIND_RE não podem cair no verdict "auto").
  const unknown = stmts.some((s) => s.kind === "other" && s.stripped.trim().length > 0);
  if (writes.length > 0 || unterminated || unknown) {
    const what =
      writes.length > 0
        ? writes.join(", ")
        : unterminated
          ? "SQL não classificável por inteiro (string não-terminada)"
          : "SQL cuja natureza o motor não confirma como somente-leitura";
    if (isReadonly) {
      return {
        verdict: "blocked",
        reason: `A conexão é somente-leitura e a consulta contém escrita (${what}). Peça ao admin uma conexão com readonly:false se a escrita é esperada.`,
        kinds,
      };
    }
    return { verdict: "confirm", reason: `A consulta contém escrita (${what}) — confirme antes de executar.`, kinds };
  }
  return { verdict: "auto", reason: "Somente leitura.", kinds };
}
