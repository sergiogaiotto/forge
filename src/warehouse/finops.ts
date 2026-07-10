// FinOps (/custo, Onda 4): consultas determinísticas de metadados por dialeto — top consultas por
// custo/tempo dos últimos 7 dias. Fontes: BigQuery INFORMATION_SCHEMA.JOBS (bytes processados =
// custo direto), Postgres pg_stat_statements (exige a extensão), Oracle v$sql (exige privilégio de
// dicionário — Exadata/ADW inclusos). Sem privilégio/extensão a consulta falha e o card explica —
// fail-open, nunca inventa números. PURO.
import { hostT } from "../i18n";
import { WarehouseKind } from "./types";

export function topQueriesSql(kind: WarehouseKind, scope?: string): string | { error: string } {
  switch (kind) {
    case "bigquery": {
      // scope = region do INFORMATION_SCHEMA (ex.: "region-us", "region-southamerica-east1").
      const region = scope && scope.startsWith("region-") ? scope : "region-us";
      return [
        "SELECT user_email AS usuario,",
        "  ROUND(SUM(total_bytes_processed) / POW(10, 12), 3) AS tb_processados,",
        "  COUNT(*) AS consultas,",
        "  SUBSTR(ANY_VALUE(query), 1, 80) AS exemplo",
        `FROM \`${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT`,
        "WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)",
        "  AND job_type = 'QUERY' AND state = 'DONE'",
        "GROUP BY user_email",
        "ORDER BY 2 DESC",
        "LIMIT 15",
      ].join("\n");
    }
    case "postgres":
      return [
        "SELECT LEFT(query, 80) AS consulta,",
        "  calls AS execucoes,",
        "  ROUND((total_exec_time / 1000)::numeric, 1) AS tempo_total_s,",
        "  ROUND((mean_exec_time)::numeric, 1) AS media_ms",
        "FROM pg_stat_statements",
        "ORDER BY total_exec_time DESC",
        "LIMIT 15",
      ].join("\n");
    case "oracle":
      return [
        "SELECT * FROM (",
        "  SELECT SUBSTR(sql_text, 1, 80) AS consulta,",
        "    executions AS execucoes,",
        "    ROUND(elapsed_time / 1e6, 1) AS tempo_total_s,",
        "    ROUND(buffer_gets / GREATEST(executions, 1)) AS gets_por_exec",
        "  FROM v$sql",
        "  WHERE parsing_schema_name NOT IN ('SYS','SYSTEM')",
        "  ORDER BY elapsed_time DESC",
        ") WHERE ROWNUM <= 15",
      ].join("\n");
    case "duckdb":
      return { error: hostT("fin.err.duckdb") };
    default:
      return { error: hostT("fin.err.unavailable") };
  }
}

export function renderFinopsCard(connLabel: string, kind: WarehouseKind, csv: string): string {
  const lines = (csv ?? "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return [hostT("fin.head", { id: connLabel }), "", hostT("fin.noData")].join("\n");
  }
  const header = lines[0].split(",");
  const rows = lines.slice(1, 16).map((l) => `| ${l.split(",").join(" | ")} |`);
  const hint = kind === "bigquery" ? hostT("fin.hint.bq") : kind === "oracle" ? hostT("fin.hint.oracle") : hostT("fin.hint.other");
  return [
    hostT("fin.head7d", { id: connLabel }),
    "",
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows,
    "",
    `💡 ${hint}`,
    hostT("fin.footer"),
  ].join("\n");
}
