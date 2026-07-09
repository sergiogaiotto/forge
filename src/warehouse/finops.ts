// FinOps (/custo, Onda 4): consultas determinísticas de metadados por dialeto — top consultas por
// custo/tempo dos últimos 7 dias. Fontes: BigQuery INFORMATION_SCHEMA.JOBS (bytes processados =
// custo direto), Postgres pg_stat_statements (exige a extensão), Oracle v$sql (exige privilégio de
// dicionário — Exadata/ADW inclusos). Sem privilégio/extensão a consulta falha e o card explica —
// fail-open, nunca inventa números. PURO.
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
      return { error: "DuckDB é local — não há histórico de custo de warehouse para analisar." };
    default:
      return { error: "Relatório de custo não disponível para este tipo de conexão." };
  }
}

export function renderFinopsCard(connLabel: string, kind: WarehouseKind, csv: string): string {
  const lines = (csv ?? "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return [
      `### Custo · \`${connLabel}\``,
      "",
      "Nenhum dado retornado. Causas comuns: falta de privilégio no dicionário (Oracle v$sql), extensão `pg_stat_statements` ausente (Postgres), ou region errada no `schemas` da conexão (BigQuery).",
    ].join("\n");
  }
  const header = lines[0].split(",");
  const rows = lines.slice(1, 16).map((l) => `| ${l.split(",").join(" | ")} |`);
  const hint =
    kind === "bigquery"
      ? "1 TB processado ≈ US$ 6,25 (on-demand). Ataque primeiro os maiores `tb_processados`: SELECT * e falta de filtro de partição são as causas nº 1."
      : kind === "oracle"
        ? "Alto `gets_por_exec` = consulta cara por execução (índice/plano); alto `execucoes` × tempo médio = candidato a cache/materialização."
        : "Alto `tempo_total_s` com muitas `execucoes` = otimize a consulta; poucas execuções muito lentas = revise plano/índices.";
  return [
    `### Custo (últimos 7 dias) · \`${connLabel}\``,
    "",
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows,
    "",
    `💡 ${hint}`,
    "_Fonte determinística: metadados do próprio warehouse — nenhum dado de negócio saiu do banco._",
  ].join("\n");
}
