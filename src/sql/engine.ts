// Orquestrador do motor SQL: junta jinja-strip → classificação → anti-padrões → gate semântico de
// schema e produz ValidatorResults para o cartão da proposta — o MESMO canal dos validadores de skill
// (diff, gate, Langfuse validation.result de graça). Três resultados possíveis:
//   sql:seguranca   — achados error (DELETE/UPDATE sem WHERE, DROP/TRUNCATE, produto cartesiano);
//                     é o ÚNICO que pode bloquear o Aplicar (gate:true no modo "conservative").
//   sql:antipadroes — demais achados; sempre advisory (confiança declarada por achado).
//   sql:schema      — tabelas/colunas vs manifest dbt; sempre advisory na Onda 1 (manifest pode
//                     estar velho). Skipped com explicação quando é modelo dbt sem manifest.
// Fail-open TOTAL: qualquer exceção vira "skipped" — o motor nunca derruba uma geração. PURO.
import { ValidatorResult } from "../shared/protocol";
import { DbtIndex } from "../dbt/artifacts";
import { AntipatternOptions, findAntipatterns, renderFindings, SqlFinding } from "./antipatterns";
import { classifySql } from "./classify";
import { looksLikeDbtModel, stripJinja } from "./jinja";
import { checkAgainstSchema } from "./schemaCheck";

export type SqlGateMode = "conservative" | "advisory" | "off";

export interface SqlAnalysisContext {
  mode: SqlGateMode;
  index?: DbtIndex; // grounding dbt quando disponível
}

// Regras de SEGURANÇA: as únicas candidatas a bloqueio (baixíssimo falso-positivo por construção).
const SECURITY_RULES = new Set(["delete-sem-where", "update-sem-where", "statement-destrutivo", "produto-cartesiano"]);

export function isSqlPath(relPath: string): boolean {
  return /\.sql$/i.test((relPath ?? "").trim());
}

export function analyzeSqlProposal(relPath: string, content: string, ctx: SqlAnalysisContext): ValidatorResult[] {
  if (ctx.mode === "off" || !isSqlPath(relPath)) return [];
  try {
    const isDbt = looksLikeDbtModel(relPath, content);
    const { sql, hadJinja } = isDbt ? stripJinja(content) : { sql: content, hadJinja: false };
    const stmts = classifySql(sql);
    const opts: AntipatternOptions = { isDbtModel: isDbt, hadJinja };
    const findings = stmts.flatMap((s) => findAntipatterns(s, s.line, opts));

    const security = findings.filter((f) => SECURITY_RULES.has(f.rule));
    const style = findings.filter((f) => !SECURITY_RULES.has(f.rule));
    const results: ValidatorResult[] = [];

    // String não-terminada = parte do SQL foi APAGADA da análise: o WHERE visto (ou não visto) pode
    // ser artefato do descompasso — o gate NUNCA pode bloquear com base em análise parcial (achado da
    // revisão adversarial: `\'` sem par tanto bloqueava UPDATE filtrado quanto liberava um sem WHERE).
    const partialScan = stmts.some((s) => s.unterminated);
    if (security.length > 0) {
      results.push({
        id: "sql:seguranca",
        label: "SQL · segurança",
        status: "failed",
        gate: ctx.mode === "conservative" && !partialScan,
        output:
          (partialScan
            ? "⚠ String não-terminada no SQL — análise PARCIAL (gate rebaixado para advisory; revise manualmente):\n"
            : "") + renderFindings(security),
      });
    } else if (partialScan) {
      results.push({
        id: "sql:seguranca",
        label: "SQL · segurança",
        status: "skipped",
        gate: false,
        output: "",
        reason: "String não-terminada no SQL — a análise de segurança ficou parcial; revise DELETE/UPDATE manualmente.",
      });
    }
    results.push(
      style.length > 0
        ? { id: "sql:antipadroes", label: "SQL · anti-padrões", status: "failed", gate: false, output: renderFindings(style) }
        : {
            id: "sql:antipadroes",
            label: "SQL · anti-padrões",
            status: "ok",
            gate: false,
            output: `Sem anti-padrões nos ${stmts.length} statement${stmts.length === 1 ? "" : "s"} analisado${stmts.length === 1 ? "" : "s"}${hadJinja ? " (Jinja achatado — confiança reduzida)" : ""}.`,
          }
    );

    // Escopo do gate semântico: modelos dbt sempre; .sql avulso SÓ quando ao menos uma tabela resolve
    // no manifest (senão é migração/DDL de outra base — acusar 'tabela-desconhecida' seria ruído puro,
    // achado da revisão adversarial).
    const anyResolves = () =>
      stmts.some((s) => s.tables.some((t) => !s.ctes.includes(t) && !/^__\w+__$/.test(t) && ctx.index!.findTable(t)));
    if (ctx.index && ctx.index.size() > 0 && (isDbt || anyResolves())) {
      const schemaFindings = checkAgainstSchema(stmts, ctx.index, (s) => s.line);
      const checked = stmts.reduce((n, s) => n + s.tables.filter((t) => !s.ctes.includes(t) && !/^__\w+__$/.test(t)).length, 0);
      results.push(
        schemaFindings.length > 0
          ? { id: "sql:schema", label: "SQL · schema (dbt)", status: "failed", gate: false, output: renderFindings(schemaFindings) }
          : {
              id: "sql:schema",
              label: "SQL · schema (dbt)",
              status: "ok",
              gate: false,
              output:
                checked > 0
                  ? `${checked} referência${checked === 1 ? "" : "s"} de tabela confere${checked === 1 ? "" : "m"} com o manifest do dbt.`
                  : "Nenhuma tabela física para conferir (só CTEs/placeholders).",
            }
      );
    } else if (isDbt) {
      results.push({
        id: "sql:schema",
        label: "SQL · schema (dbt)",
        status: "skipped",
        gate: false,
        output: "",
        reason: "Sem target/manifest.json — rode `dbt parse` (ou `dbt compile`) para o FORGE validar tabelas/colunas reais.",
      });
    }
    return results;
  } catch (err) {
    return [
      {
        id: "sql:antipadroes",
        label: "SQL · anti-padrões",
        status: "skipped",
        gate: false,
        output: "",
        reason: `Análise SQL falhou (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }
}

// Evidência compacta para a lente "dados" do revisor (/revisar e CI): só os achados, sem status ok.
export function sqlEvidenceForReview(relPath: string, content: string, ctx: SqlAnalysisContext): SqlFinding[] {
  if (!isSqlPath(relPath)) return [];
  try {
    const isDbt = looksLikeDbtModel(relPath, content);
    const { sql, hadJinja } = isDbt ? stripJinja(content) : { sql: content, hadJinja: false };
    const stmts = classifySql(sql);
    const findings = stmts.flatMap((s) => findAntipatterns(s, s.line, { isDbtModel: isDbt, hadJinja }));
    // Mesmo escopo do gate: schema só para modelos dbt ou quando alguma tabela resolve no manifest.
    if (ctx.index && ctx.index.size() > 0) {
      const idx = ctx.index;
      const anyResolves = stmts.some((s) => s.tables.some((t) => !s.ctes.includes(t) && !/^__\w+__$/.test(t) && idx.findTable(t)));
      if (isDbt || anyResolves) findings.push(...checkAgainstSchema(stmts, idx, (s) => s.line));
    }
    return findings;
  } catch {
    return [];
  }
}
