import type { WarehouseKind } from "../warehouse/types";

export const SQL_DIALECTS = [
  "ansi",
  "postgres",
  "mysql",
  "bigquery",
  "snowflake",
  "redshift",
  "oracle",
  "sqlserver",
  "tsql",
  "spark",
  "databricks",
  "duckdb",
  "trino",
  "hive",
  "sqlite",
] as const;

export type SqlDialect = (typeof SQL_DIALECTS)[number];

export interface DialectResolution {
  dialect: SqlDialect;
  source: "explicit" | "connection" | "file" | "detected" | "fallback";
  confidence: "high" | "medium" | "low";
}

export function isSqlDialect(value: string | undefined): value is SqlDialect {
  return !!value && (SQL_DIALECTS as readonly string[]).includes(value.toLowerCase());
}

export function dialectForWarehouse(kind: WarehouseKind | undefined): SqlDialect | undefined {
  switch (kind) {
    case "oracle":
    case "postgres":
    case "bigquery":
    case "duckdb":
      return kind;
    default:
      return undefined;
  }
}

export function dialectFromFileName(fileName: string | undefined): SqlDialect | undefined {
  const lower = (fileName ?? "").toLowerCase();
  for (const dialect of SQL_DIALECTS) {
    if (new RegExp(`\\.${dialect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.sql$`).test(lower)) return dialect;
  }
  return undefined;
}

export function detectSqlDialect(sql: string): { dialect: SqlDialect; confidence: "medium" | "low" } | undefined {
  const source = sql ?? "";
  const rules: Array<{ dialect: SqlDialect; score: number; re: RegExp }> = [
    { dialect: "bigquery", score: 4, re: /\bQUALIFY\b|`[^`]+`|UNNEST\s*\(/i },
    { dialect: "oracle", score: 4, re: /\bNVL\s*\(|\bSYSTIMESTAMP\b|\bROWNUM\b|\bVARCHAR2\b|\bFROM\s+DUAL\b/i },
    { dialect: "postgres", score: 3, re: /::\s*[A-Za-z_]|\bILIKE\b|\bRETURNING\b|\bJSONB\b/i },
    { dialect: "sqlserver", score: 4, re: /\bTOP\s*\(?\s*\d+|\bGETDATE\s*\(|\[[^\]]+\]/i },
    { dialect: "snowflake", score: 4, re: /\bIFF\s*\(|\bFLATTEN\s*\(|\bVARIANT\b/i },
    { dialect: "spark", score: 3, re: /\bLATERAL\s+VIEW\b|\bDISTRIBUTE\s+BY\b|\bCLUSTER\s+BY\b/i },
    { dialect: "duckdb", score: 3, re: /\bread_(?:csv|json|parquet|xlsx)\s*\(|\bGROUP\s+BY\s+ALL\b|\bSUMMARIZE\b/i },
    { dialect: "mysql", score: 3, re: /\bAUTO_INCREMENT\b|\bON\s+DUPLICATE\s+KEY\b/i },
    { dialect: "sqlite", score: 3, re: /\bWITHOUT\s+ROWID\b|\bAUTOINCREMENT\b|\bPRAGMA\b/i },
  ];
  let best: { dialect: SqlDialect; score: number } | undefined;
  for (const rule of rules) {
    if (rule.re.test(source) && (!best || rule.score > best.score)) best = { dialect: rule.dialect, score: rule.score };
  }
  return best ? { dialect: best.dialect, confidence: best.score >= 4 ? "medium" : "low" } : undefined;
}

export function resolveSqlDialect(input: {
  explicit?: string;
  configured?: string;
  connectionKind?: WarehouseKind;
  fileName?: string;
  sql?: string;
}): DialectResolution {
  const explicit = input.explicit?.trim().toLowerCase();
  if (isSqlDialect(explicit) && explicit !== "ansi") return { dialect: explicit, source: "explicit", confidence: "high" };

  const configured = input.configured?.trim().toLowerCase();
  if (configured && configured !== "auto" && isSqlDialect(configured)) {
    return { dialect: configured, source: "explicit", confidence: "high" };
  }

  const connection = dialectForWarehouse(input.connectionKind);
  if (connection) return { dialect: connection, source: "connection", confidence: "high" };

  const file = dialectFromFileName(input.fileName);
  if (file) return { dialect: file, source: "file", confidence: "high" };

  const detected = detectSqlDialect(input.sql ?? "");
  if (detected) return { ...detected, source: "detected" };

  return { dialect: "ansi", source: "fallback", confidence: "low" };
}

export interface DialectFinding {
  rule: string;
  message: string;
}

export function findDialectRisks(sql: string, dialect: SqlDialect): DialectFinding[] {
  const findings: DialectFinding[] = [];
  const add = (rule: string, message: string) => findings.push({ rule, message });
  if (dialect === "postgres" || dialect === "oracle" || dialect === "sqlite") {
    if (/\bQUALIFY\b/i.test(sql)) add("qualify", `QUALIFY nao e suportado nativamente em ${dialect}; use uma CTE e filtre na consulta externa.`);
  }
  if (dialect === "oracle" && /\bLIMIT\s+\d+/i.test(sql)) {
    add("limit", "Oracle nao usa LIMIT; prefira FETCH FIRST ... ROWS ONLY.");
  }
  if ((dialect === "postgres" || dialect === "oracle") && /`[^`]+`/.test(sql)) {
    add("identifier-quotes", `${dialect} usa aspas duplas para identificadores, nao backticks.`);
  }
  if (dialect === "bigquery" && /\bNVL\s*\(/i.test(sql)) {
    add("nvl", "BigQuery nao possui NVL; use IFNULL ou COALESCE.");
  }
  if (dialect === "ansi") {
    if (/\b(QUALIFY|ILIKE|NVL|SYSTIMESTAMP|TOP\s+\d+|LIMIT\s+\d+)\b/i.test(sql) || /`[^`]+`/.test(sql)) {
      add("vendor-syntax", "A consulta contem sintaxe especifica de fornecedor; fixe o dialeto antes de trata-la como ANSI.");
    }
  }
  return findings;
}
