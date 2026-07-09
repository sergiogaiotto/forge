// Conexões de warehouse (Onda 3): o dev conecta pelo caminho TRADICIONAL (os CLIs que já usa —
// SQLcl/sqlplus para Oracle 19c/26ai/Exadata/ADW, psql, bq, duckdb, aws/oci para object storage) OU
// via MCP do catálogo do admin. O FORGE nunca embute driver nativo: spawna a ferramenta do dev
// (padrão pytest/mypy/tesseract — fail-open quando ausente), a credencial fica no SecretStorage e o
// egress é do CLI, não da extensão. Governança é do MOTOR (governance.ts), não do prompt.

export type WarehouseKind = "oracle" | "postgres" | "bigquery" | "duckdb" | "s3" | "oci-os";

export interface WarehouseConnection {
  id: string; // referência nos comandos (/executar-sql <id>) e no SecretStorage
  label?: string;
  kind: WarehouseKind;
  // Escrita: default TRUE (SELECT-only; INSERT/UPDATE/… bloqueados). readonly:false → escrita pede
  // CONFIRMAÇÃO explícita no modal. DROP/TRUNCATE são bloqueados SEMPRE, sem override.
  readonly?: boolean;
  // Caminho tradicional — string de conexão da ferramenta:
  //   oracle:   "user@tns_alias" ou "user@//host:1521/service" (senha via SecretStorage; ADW: walletDir)
  //   postgres: URI/DSN do psql ("postgresql://user@host:5432/db"; senha via SecretStorage → PGPASSWORD)
  //   bigquery: id do projeto GCP (auth = gcloud do dev)
  //   duckdb:   caminho do .duckdb/.db (vazio = :memory:)
  //   s3:       "s3://bucket/prefixo" (auth = aws CLI) · oci-os: "namespace/bucket" (auth = oci CLI)
  connect?: string;
  tool?: string; // força o binário (sqlcl→"sql", "sqlplus", "psql", "bq", "duckdb", "aws", "oci")
  walletDir?: string; // Oracle ADW/wallet: vira TNS_ADMIN no ambiente do CLI
  env?: Record<string, string>; // extras (ex.: CLOUDSDK_CORE_PROJECT, AWS_PROFILE, OCI_CLI_PROFILE)
  // Caminho MCP (alternativa governada): tool do catálogo que recebe o SQL em `sqlArg`.
  mcp?: { server: string; tool: string; sqlArg: string };
  // Escopo do snapshot de schema (/schema-db): owners (Oracle), schemas (PG), datasets (BigQuery —
  // obrigatório lá). Também usado como escopo do /custo no BigQuery (region ou dataset).
  schemas?: string[];
}

export interface WarehouseSettings {
  connections: WarehouseConnection[];
  defaultId: string; // conexão usada quando o comando não nomeia uma
  rowCap: number; // linhas máximas exibidas/retornadas de um SELECT (LGPD: amostra, nunca o dataset)
  timeoutSeconds: number;
}

export interface SqlRunResult {
  ok: boolean;
  exitCode: number | null;
  output: string; // CSV/texto já CAPADO e MASCARADO (PII) — é o que pode ir para card/contexto
  truncated: boolean;
  durationMs: number;
  command: string; // linha exibida no card (sem segredos)
}
