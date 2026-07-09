// Planos de execução por CLI (caminho TRADICIONAL da Onda 3): construtores PUROS de linha de comando,
// scripts-wrapper e ambiente para cada ferramenta que o dev já usa — SQLcl ("sql") e sqlplus para a
// família Oracle (19c, 26ai, Exadata, ADW via wallet/TNS_ADMIN), psql, bq, duckdb, aws/oci para
// object storage. O I/O (temp files, spawn, timeout) fica no WarehouseService; aqui é 100% testável.
// Segredo NUNCA vai em argv (aparece na lista de processos): Oracle recebe a senha no script-wrapper
// temporário (apagado no finally), psql via env PGPASSWORD, bq/aws/oci usam a auth do próprio CLI.
import { maskDataSample } from "../util/piiScan";
import { WarehouseConnection } from "./types";

export interface CliPlan {
  tool: string; // binário
  args: string[];
  env?: Record<string, string>;
  stdin?: string; // SQL via stdin (bq/duckdb)
  // Arquivos a materializar no temp dir antes do spawn ({{SQL_FILE}} nos args/scripts vira o caminho real).
  scripts?: { name: string; content: string }[];
  display: string; // linha exibida no card — SEM segredos
}

export interface PlanError {
  error: string;
}

export function isPlanError(p: CliPlan | PlanError): p is PlanError {
  return (p as PlanError).error !== undefined;
}

// Garante um terminador executável no fim do SQL Oracle. `;` termina um statement comum; `/` executa
// o buffer (necessário para bloco PL/SQL BEGIN…END). Não mexe se já houver um terminador.
export function oracleTerminate(sql: string): string {
  const trimmed = (sql ?? "").trimEnd();
  if (/[;/]\s*$/.test(trimmed)) return trimmed + "\n";
  const isBlock = /\b(BEGIN|DECLARE)\b/i.test(trimmed.slice(0, 200)) && /END\s*$/i.test(trimmed);
  return trimmed + (isBlock ? "\n/\n" : "\n;\n");
}

const ORA_PRELUDE = ["SET SQLFORMAT csv", "SET FEEDBACK OFF", "SET ECHO OFF", "SET VERIFY OFF", "WHENEVER SQLERROR EXIT FAILURE"];
const SQLPLUS_PRELUDE = ["SET MARKUP CSV ON", "SET FEEDBACK OFF", "SET ECHO OFF", "SET VERIFY OFF", "SET PAGESIZE 0", "WHENEVER SQLERROR EXIT FAILURE"];

// Monta "user/senha@resto" a partir de connect "user@resto" + senha do SecretStorage. Senha entre
// aspas duplas (caracteres especiais); nunca em argv — só dentro do script temporário.
function oracleConnectString(connect: string, password?: string): string | undefined {
  const at = connect.indexOf("@");
  if (at <= 0) return undefined;
  const user = connect.slice(0, at);
  const rest = connect.slice(at + 1);
  return password ? `${user}/"${password.replace(/"/g, '""')}"@${rest}` : `${connect}`;
}

export function buildRunPlan(conn: WarehouseConnection, sql: string, opts: { password?: string; rowCap: number }): CliPlan | PlanError {
  const connect = (conn.connect ?? "").trim();
  switch (conn.kind) {
    case "oracle": {
      if (!connect.includes("@")) return { error: `Conexão "${conn.id}": connect deve ser "usuario@alias_tns" ou "usuario@//host:porta/servico".` };
      const tool = conn.tool === "sqlplus" ? "sqlplus" : (conn.tool ?? "sql"); // SQLcl instala como "sql"
      const prelude = tool === "sqlplus" ? SQLPLUS_PRELUDE : ORA_PRELUDE;
      const full = oracleConnectString(connect, opts.password);
      // connect DENTRO do script (via /nolog): a senha nunca aparece em argv nem no display.
      const wrapper = [
        ...prelude,
        `CONNECT ${full}`,
        `@"{{SQL_FILE}}"`,
        "EXIT",
      ].join("\n");
      return {
        tool,
        args: ["-s", "/nolog", "@{{WRAPPER}}"],
        env: conn.walletDir ? { TNS_ADMIN: conn.walletDir, ...conn.env } : conn.env,
        scripts: [
          // Terminador OBRIGATÓRIO no Oracle: um `@script` sem `;`/`/` final NÃO executa o buffer (sai 0
          // sem rodar nada — e a paridade dava falso "OK"). Só adiciona se faltar (um `;`/`/` já presente
          // significa que executou — reexecutar duplicaria escritas). Achado da revisão adversarial.
          { name: "consulta.sql", content: oracleTerminate(sql) },
          { name: "wrapper.sql", content: wrapper },
        ],
        display: `${tool} -s ${connect} @consulta.sql`,
      };
    }
    case "postgres": {
      if (!connect) return { error: `Conexão "${conn.id}": connect deve ser a URI/DSN do psql.` };
      return {
        tool: conn.tool ?? "psql",
        args: [connect, "--csv", "-v", "ON_ERROR_STOP=1", "-f", "{{SQL_FILE}}"],
        env: opts.password ? { PGPASSWORD: opts.password, ...conn.env } : conn.env,
        scripts: [{ name: "consulta.sql", content: sql }],
        display: `psql ${connect.replace(/:[^@/:]+@/, ":***@")} -f consulta.sql`,
      };
    }
    case "bigquery":
      return {
        tool: conn.tool ?? "bq",
        args: [
          "query",
          "--nouse_legacy_sql",
          "--format=csv",
          `--max_rows=${opts.rowCap}`,
          ...(connect ? [`--project_id=${connect}`] : []),
        ],
        env: conn.env,
        stdin: sql,
        display: `bq query --format=csv${connect ? ` --project_id=${connect}` : ""}`,
      };
    case "duckdb":
      return {
        tool: conn.tool ?? "duckdb",
        args: [...(connect ? [connect] : []), "-csv"],
        env: conn.env,
        stdin: sql,
        display: `duckdb ${connect || ":memory:"} -csv`,
      };
    case "s3":
    case "oci-os":
      return { error: `Conexão "${conn.id}" é de OBJECT STORAGE — não executa SQL. Use /conexoes para listar o conteúdo, ou uma conexão duckdb para consultar arquivos.` };
    default:
      return { error: `Tipo de conexão desconhecido: ${(conn as WarehouseConnection).kind}` };
  }
}

// Dry-run de CUSTO antes de executar (Onda 3): BigQuery estima bytes escaneados sem rodar;
// Oracle/Postgres/DuckDB mostram o plano (EXPLAIN) — leitura de metadados, nunca os dados. Para os
// dialetos que PREFIXAM EXPLAIN, exige statement ÚNICO: com `SELECT 1; DELETE t`, o EXPLAIN cobriria só
// o 1º e o segundo EXECUTARIA (achado crítico da revisão). O --dry_run do BigQuery é seguro por natureza.
export function buildCostPlan(conn: WarehouseConnection, sql: string, opts: { password?: string; statementCount?: number }): CliPlan | PlanError {
  const multi = (opts.statementCount ?? 1) > 1;
  switch (conn.kind) {
    case "bigquery":
      return {
        tool: conn.tool ?? "bq",
        args: ["query", "--nouse_legacy_sql", "--dry_run", ...(conn.connect ? [`--project_id=${conn.connect}`] : [])],
        env: conn.env,
        stdin: sql,
        display: "bq query --dry_run",
      };
    case "postgres": {
      if (multi) return { error: "Prévia de custo aceita só UM statement — selecione apenas o SELECT que quer estimar." };
      const plan = buildRunPlan(conn, `EXPLAIN ${sql.replace(/;\s*$/, "")}`, { password: opts.password, rowCap: 500 });
      return isPlanError(plan) ? plan : { ...plan, display: plan.display.replace("consulta.sql", "explain.sql") };
    }
    case "oracle": {
      if (multi) return { error: "Prévia de custo aceita só UM statement — selecione apenas o SELECT que quer estimar." };
      const wrapped = `EXPLAIN PLAN FOR\n${sql.replace(/;\s*$/, "")};\nSELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY());`;
      return buildRunPlan(conn, wrapped, { password: opts.password, rowCap: 500 });
    }
    case "duckdb":
      if (multi) return { error: "Prévia de custo aceita só UM statement." };
      return buildRunPlan(conn, `EXPLAIN ${sql.replace(/;\s*$/, "")}`, { password: opts.password, rowCap: 500 });
    default:
      return { error: "Prévia de custo não disponível para este tipo de conexão." };
  }
}

// Plano de TESTE do /conexoes: presença do CLI + um toque barato (SELECT 1 / listagem de 1 objeto).
export function buildTestPlan(conn: WarehouseConnection, opts: { password?: string }): CliPlan | PlanError {
  switch (conn.kind) {
    case "s3":
      return {
        tool: conn.tool ?? "aws",
        args: ["s3", "ls", conn.connect ?? "", "--page-size", "5"],
        env: conn.env,
        display: `aws s3 ls ${conn.connect ?? ""}`,
      };
    case "oci-os": {
      const [ns, bucket] = (conn.connect ?? "").split("/");
      return {
        tool: conn.tool ?? "oci",
        args: ["os", "object", "list", "--namespace", ns ?? "", "--bucket-name", bucket ?? "", "--limit", "5"],
        env: conn.env,
        display: `oci os object list --bucket-name ${bucket ?? ""}`,
      };
    }
    case "bigquery":
      return buildRunPlan(conn, "SELECT 1 AS ok", { password: opts.password, rowCap: 1 });
    case "oracle":
      return buildRunPlan(conn, "SELECT 1 AS ok FROM dual", { password: opts.password, rowCap: 1 });
    default:
      return buildRunPlan(conn, "SELECT 1 AS ok", { password: opts.password, rowCap: 1 });
  }
}

// Pós-processamento COMPARTILHADO da saída de warehouse (caminho CLI e MCP): cap de linhas + máscara
// LGPD — o mesmo contrato de SqlRunResult.output ("já capado e mascarado") num lugar só (o ramo MCP
// deixava PII crua no chat). Metadados/agregados passam skipMask=true (mascarar corromperia os números).
// PURO/testável (sem vscode).
export function sanitizeWarehouseOutput(text: string, rowCap: number, skipMask = false): { output: string; truncated: boolean } {
  const capped = capCsv(text, rowCap);
  return { output: (skipMask ? capped.text : maskDataSample(capped.text)).slice(0, 16000), truncated: capped.truncated };
}

// Capa o CSV em N linhas de DADOS (a 1ª é cabeçalho quando houver ≥2). O rowCap protege o dev de
// despejar um dataset no chat — e a LGPD: o que circula é amostra mascarada, nunca a tabela.
export function capCsv(text: string, rowCap: number): { text: string; truncated: boolean } {
  const lines = (text ?? "").split(/\r?\n/);
  const limit = rowCap + 1; // + cabeçalho
  if (lines.length <= limit) return { text: (text ?? "").trim(), truncated: false };
  return { text: lines.slice(0, limit).join("\n").trim(), truncated: true };
}

// Card markdown do resultado (tabela quando o CSV é pequeno; bloco de código quando largo).
export function renderResultCard(title: string, display: string, output: string, opts: { ok: boolean; truncated: boolean; durationMs: number; rowCap: number }): string {
  const lines = output.split(/\r?\n/).filter((l) => l.trim());
  const asTable = opts.ok && lines.length >= 2 && lines.length <= 30 && (lines[0].match(/,/g)?.length ?? 0) <= 7;
  const body = asTable
    ? [
        `| ${lines[0].split(",").join(" | ")} |`,
        `|${lines[0].split(",").map(() => "---").join("|")}|`,
        ...lines.slice(1).map((l) => `| ${l.split(",").join(" | ")} |`),
      ].join("\n")
    : "```\n" + (output || "(sem saída)") + "\n```";
  return [
    `### ${title}`,
    "",
    body,
    "",
    `${opts.ok ? "✅" : "❌"} \`${display}\` · ${(opts.durationMs / 1000).toFixed(1)}s${opts.truncated ? ` · ⚠ amostra capada em ${opts.rowCap} linhas` : ""}`,
    "_Valores sensíveis são mascarados localmente antes de qualquer exibição (LGPD)._",
  ].join("\n");
}
