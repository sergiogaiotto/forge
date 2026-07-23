// Execução governada de SQL no warehouse (Onda 3) — o I/O em volta dos módulos puros: resolve a
// conexão, decide pela GOVERNANÇA DO MOTOR (SELECT auto; escrita só com readonly:false + confirmação
// modal; DROP/TRUNCATE nunca), materializa os scripts num temp dir DENTRO de .forge/ (o wrapper
// Oracle carrega a senha — apagado no finally), spawna o CLI do dev com timeout, e CAPA + MASCARA
// (LGPD) a saída antes de qualquer exibição. Senha: SecretStorage, pedida uma vez por conexão.
// Fail-open: CLI ausente vira mensagem de instalação, nunca exceção para cima.
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { hostT } from "../i18n";
import { SecretsStore } from "../secrets/SecretsStore";
import { maskDataSample } from "../util/piiScan";
import { classifySql } from "../sql/classify";
import { dialectUsesBackslashEscapes } from "../sql/lex";
import { buildSpawn, resolveExecutable, unsafeField } from "./exec";
import { decideSqlRun } from "./governance";
import { buildCostPlan, buildObservedPlan, buildRunPlan, buildTestPlan, CliPlan, isPlanError, PlanError, sanitizeWarehouseOutput } from "./sqlRunners";
import { SqlRunResult, WarehouseConnection, WarehouseSettings } from "./types";
import { EmbeddedDuckDbManager } from "./EmbeddedDuckDb";

const secretKeyFor = (connId: string) => `forge.warehouse.${connId}`;

// Prefixo dos temp dirs deste serviço — a varredura de órfãos do startup remove os que sobrarem de um
// crash (o wrapper Oracle contém a senha em claro; deixá-lo órfão no .forge/ do workspace é risco).
export const WH_TMP_PREFIX = "wh-";

export class WarehouseService {
  constructor(
    private readonly secrets: SecretsStore,
    private readonly settings: () => WarehouseSettings,
    private readonly workspaceRoot: () => string | undefined,
    // Permission model unificado: a confirmação de ESCRITA é injetada (PermissionService no Controller)
    // — um modal só para os caminhos CLI e MCP, decisão auditada e visível no Langfuse. Fallback local
    // (auto-nega) só para construção fora do Controller (testes antigos).
    private readonly confirmWrite: (action: string, subject: string, sqlPreview: string) => Promise<boolean> = async () => false,
    // Reporta ao trail unificado um BLOQUEIO de escrita pela governança do motor (DROP/TRUNCATE, escrita
    // em conexão readonly) — o mesmo desfecho "blocked" que o contrato já registrava. Default noop.
    private readonly reportBlockedWrite: (action: string, subject: string) => void = () => undefined,
    private readonly embedded?: EmbeddedDuckDbManager
  ) {}

  connections(): WarehouseConnection[] {
    const configured = this.settings().connections;
    const local = this.localLabConnection();
    return local && !configured.some((connection) => connection.id === local.id)
      ? [...configured, local]
      : configured;
  }

  resolve(id?: string): WarehouseConnection | undefined {
    const s = this.settings();
    const target = (id ?? s.defaultId ?? "").trim();
    const all = this.connections();
    if (target) return all.find((c) => c.id === target);
    return s.connections[0] ?? this.localLabConnection();
  }

  localLabConnection(): WarehouseConnection | undefined {
    const root = this.workspaceRoot();
    if (!root || !this.settings().localLab.enabled) return undefined;
    return {
      id: "forge-local",
      label: "FORGE SQL Lab",
      kind: "duckdb",
      runtime: "embedded",
      dialect: "duckdb",
      managedLocal: true,
      // O laboratório precisa materializar tabelas locais. Cada escrita continua passando pelo modal
      // governado; DROP/TRUNCATE permanecem bloqueados pelo motor sem override.
      readonly: false,
      connect: path.join(".forge", "sql", "lab.duckdb"),
    };
  }

  // Senha da conexão: SecretStorage; pede UMA vez (input mascarado) e persiste. Kinds sem senha
  // própria (bigquery/duckdb/s3/oci — auth do CLI) retornam undefined sem prompt.
  private async passwordFor(conn: WarehouseConnection): Promise<string | undefined> {
    if (conn.kind !== "oracle" && conn.kind !== "postgres") return undefined;
    // Postgres com senha na URI ou .pgpass não precisa de prompt.
    if (conn.kind === "postgres" && /:[^@/:]+@/.test(conn.connect ?? "")) return undefined;
    // Oracle: só é AUTH EXTERNA (sem senha) quando o usuário é vazio ou "/" antes do @ ("/@adw_high").
    // walletDir sozinho NÃO dispensa senha — o wallet TLS do ADW ainda pede a senha do usuário do banco
    // (achado da revisão: pular a senha gerava CONNECT sem senha e o sqlplus travava no stdin até o timeout).
    if (conn.kind === "oracle") {
      const user = (conn.connect ?? "").split("@")[0].trim();
      if (user === "" || user === "/") return undefined;
    }
    const existing = await this.secrets.get(secretKeyFor(conn.id));
    if (existing) return existing;
    const typed = await vscode.window.showInputBox({
      title: hostT("wh.pwd.title", { id: conn.id, kind: conn.kind }),
      prompt: hostT("wh.pwd.prompt"),
      password: true,
      ignoreFocusOut: true,
    });
    if (!typed) return undefined;
    await this.secrets.set(secretKeyFor(conn.id), typed);
    return typed;
  }

  // Rejeita conexões cujos campos do settings contêm metacaracteres de shell (defesa contra RCE de
  // workspace malicioso). "" = ok. Aplicado antes de QUALQUER spawn.
  private validateConn(conn: WarehouseConnection): string | null {
    for (const [f, v] of [["connect", conn.connect], ["tool", conn.tool], ["walletDir", conn.walletDir]] as const) {
      if (unsafeField(v)) return hostT("wh.err.unsafeField", { id: conn.id, field: f });
    }
    for (const s of conn.schemas ?? []) if (unsafeField(s)) return hostT("wh.err.unsafeSchema", { id: conn.id });
    return null;
  }

  // Executa SQL com governança (SELECT auto; escrita confirma; DROP/TRUNCATE/bloco nunca sem readonly:false).
  async runSql(connId: string | undefined, sql: string, opts?: { skipMask?: boolean; rowCapOverride?: number }): Promise<SqlRunResult | { refused: string }> {
    const conn = this.resolve(connId);
    if (!conn) return { refused: connId ? hostT("wh.err.connNotExists", { id: connId }) : hostT("wh.err.noneConfigured") };
    const bad = this.validateConn(conn);
    if (bad) return { refused: bad };

    const decision = decideSqlRun(sql, conn);
    if (decision.verdict === "blocked") {
      this.reportBlockedWrite(`conexão "${conn.id}": ${decision.reason}`, conn.id);
      return { refused: `⛔ ${decision.reason}` };
    }
    if (decision.verdict === "confirm") {
      const ok = await this.confirmWrite(`conexão "${conn.id}": ${decision.reason}`, conn.id, sql);
      if (!ok) return { refused: hostT("sql.writeCancelled") };
    }
    const rowCap = opts?.rowCapOverride ?? this.settings().rowCap;
    if (this.useEmbedded(conn)) {
      return this.runEmbedded(conn, sql, rowCap, opts?.skipMask);
    }
    const plan = buildRunPlan(conn, sql, { password: await this.passwordFor(conn), rowCap });
    return this.execute(conn, plan, { rowCap, skipMask: opts?.skipMask });
  }

  // Prévia de custo (EXPLAIN/dry-run) — o card promete "sem executar", então é 100% LEITURA: só verdict
  // "auto" e statement ÚNICO passam (achado crítico da revisão: costPreview pulava a governança e o
  // EXPLAIN de Oracle/PG/DuckDB cobre só o 1º statement — os finais EXECUTAVAM de verdade).
  async costPreview(connId: string | undefined, sql: string): Promise<SqlRunResult | { refused: string }> {
    const conn = this.resolve(connId);
    if (!conn) return { refused: hostT("wh.err.noneConfiguredShort") };
    const bad = this.validateConn(conn);
    if (bad) return { refused: bad };
    const decision = decideSqlRun(sql, conn);
    if (decision.verdict !== "auto") {
      return { refused: hostT("wh.err.costReadonly", { reason: decision.reason }) };
    }
    const statementCount = classifySql(sql, { backslashEscapes: dialectUsesBackslashEscapes(conn.kind) }).length;
    if (statementCount !== 1) {
      return { refused: hostT("wh.err.costReadonly", { reason: "EXPLAIN requer exatamente uma instrução SQL." }) };
    }
    if (this.useEmbedded(conn)) {
      return this.runEmbedded(conn, `EXPLAIN (FORMAT JSON) ${sql}`, 2_000, false, "DuckDB embedded EXPLAIN", 128_000);
    }
    const plan = buildCostPlan(conn, sql, { password: await this.passwordFor(conn), statementCount });
    return this.execute(conn, plan, { rowCap: 2_000, maxChars: 128_000 });
  }

  // Análise observada: EXECUTA o SELECT por meio de EXPLAIN ANALYZE. O consentimento explícito e auditado
  // acontece no Controller; aqui repetimos a governança e a regra de statement único (defesa em profundidade).
  async observedPlan(connId: string | undefined, sql: string): Promise<SqlRunResult | { refused: string }> {
    const conn = this.resolve(connId);
    if (!conn) return { refused: hostT("wh.err.noneConfiguredShort") };
    if (conn.mcp) return { refused: hostT("wh.err.observedUnavailable", { kind: `${conn.kind} via MCP` }) };
    const bad = this.validateConn(conn);
    if (bad) return { refused: bad };
    const decision = decideSqlRun(sql, conn);
    if (decision.verdict !== "auto") {
      return { refused: hostT("wh.err.observedReadonly", { reason: decision.reason }) };
    }
    const statementCount = classifySql(sql, { backslashEscapes: dialectUsesBackslashEscapes(conn.kind) }).length;
    if (statementCount !== 1) return { refused: hostT("wh.err.observedSingle") };
    if (this.useEmbedded(conn)) {
      return this.runEmbedded(conn, `EXPLAIN ANALYZE ${sql}`, 2_000, false, "DuckDB embedded EXPLAIN ANALYZE", 128_000);
    }
    const plan = buildObservedPlan(conn, sql, { password: await this.passwordFor(conn), statementCount });
    return this.execute(conn, plan, { rowCap: 2_000, maxChars: 128_000 });
  }

  async testConnection(conn: WarehouseConnection): Promise<SqlRunResult | { refused: string }> {
    const bad = this.validateConn(conn);
    if (bad) return { refused: bad };
    if (this.useEmbedded(conn)) {
      return this.runEmbedded(conn, "SELECT version() AS duckdb_version", 5, true, "DuckDB embedded");
    }
    const plan = buildTestPlan(conn, { password: await this.passwordFor(conn) });
    return this.execute(conn, plan, { rowCap: 5 });
  }

  async dispose(): Promise<void> {
    await this.embedded?.dispose();
  }

  private useEmbedded(conn: WarehouseConnection): boolean {
    return conn.kind === "duckdb" && !!this.embedded &&
      (conn.managedLocal === true || conn.runtime === "embedded" || conn.runtime === "auto");
  }

  private async runEmbedded(
    conn: WarehouseConnection,
    sql: string,
    rowCap: number,
    skipMask = false,
    command = "DuckDB embedded",
    maxChars = 16_000
  ): Promise<SqlRunResult | { refused: string }> {
    const root = this.workspaceRoot();
    if (!root || !this.embedded) return { refused: "O DuckDB embutido requer um workspace aberto." };
    const rawPath = conn.connect?.trim() || ":memory:";
    const databasePath = rawPath === ":memory:" ? rawPath : path.resolve(root, rawPath);
    if (databasePath !== ":memory:") {
      const relative = path.relative(root, databasePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return { refused: "O banco DuckDB embutido deve ficar dentro do workspace." };
      }
    }
    const cfg = this.settings().localLab;
    const tempDirectory = path.join(root, ".forge", "sql", "tmp");
    if (databasePath !== ":memory:") await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.mkdir(tempDirectory, { recursive: true });
    try {
      const result = await this.embedded.run(
        {
          databasePath,
          workspaceRoot: root,
          tempDirectory,
          memoryLimit: cfg.memoryLimit,
          maxTempDirectorySize: cfg.maxTempDirectorySize,
          threads: cfg.threads,
        },
        sql,
        rowCap,
        this.settings().timeoutSeconds * 1000
      );
      const sanitized = sanitizeWarehouseOutput(result.output, rowCap, skipMask, maxChars);
      return {
        ok: result.ok,
        exitCode: result.ok ? 0 : 1,
        output: sanitized.output,
        truncated: result.truncated || sanitized.truncated,
        durationMs: result.durationMs,
        command: `${command}${result.version ? ` (${result.version})` : ""}`,
      };
    } catch (error) {
      if (conn.runtime === "auto" && !conn.managedLocal) {
        const plan = buildRunPlan(conn, sql, { rowCap });
        return this.execute(conn, plan, { rowCap, skipMask });
      }
      return { refused: `DuckDB embutido indisponível: ${(error as Error).message}` };
    }
  }

  private async execute(
    conn: WarehouseConnection,
    plan: CliPlan | PlanError,
    opts: { rowCap: number; skipMask?: boolean; maxChars?: number }
  ): Promise<SqlRunResult | { refused: string }> {
    if (isPlanError(plan)) return { refused: plan.error };
    const toolPath = resolveExecutable(plan.tool);
    if (!toolPath) {
      return { refused: hostT("wh.err.toolMissing", { tool: plan.tool, hint: installHint(plan.tool) }) };
    }
    // Wrapper Oracle (contém a senha em claro) e consulta ficam num temp SÓ do serviço, prefixo wh-,
    // com .gitignore. A varredura de órfãos no startup (sweepWarehouseTemp) limpa o que sobrar de crash.
    const baseDir = this.workspaceRoot() ? path.join(this.workspaceRoot()!, ".forge") : os.tmpdir();
    await fs.mkdir(baseDir, { recursive: true });
    const tmpDir = await fs.mkdtemp(path.join(baseDir, WH_TMP_PREFIX));
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "*\n", "utf8");
    const started = Date.now();
    try {
      let sqlFile = "";
      let wrapper = "";
      for (const s of plan.scripts ?? []) {
        const p = path.join(tmpDir, s.name);
        if (s.name === "consulta.sql" || s.name === "explain.sql") sqlFile = p;
        if (s.name === "wrapper.sql") wrapper = p;
      }
      for (const s of plan.scripts ?? []) {
        const content = s.content.replace(/\{\{SQL_FILE\}\}/g, sqlFile);
        await fs.writeFile(path.join(tmpDir, s.name), content, "utf8");
      }
      const args = plan.args.map((a) => a.replace(/\{\{WRAPPER\}\}/g, wrapper).replace(/\{\{SQL_FILE\}\}/g, sqlFile));
      const timeoutMs = this.settings().timeoutSeconds * 1000;

      // buildSpawn: .exe/POSIX → shell:false (Node quota, nenhum metacaractere interpretado). Shims
      // .bat/.cmd do Windows → shell com caminho e args MANUALMENTE quotados (o Node RECUSA .bat/.cmd
      // sob shell:false — EINVAL, endurecimento do CVE-2024-27980). Seguro porque unsafeField já rejeitou
      // metacaracteres nos campos de settings; a linha só tem flags, conexão validada e paths temp.
      const spawn = buildSpawn(toolPath, args);
      const raw = await new Promise<{ code: number | null; out: string }>((resolve) => {
        try {
          const child = execFile(
            spawn.file,
            spawn.args,
            { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...plan.env }, cwd: tmpDir, shell: spawn.useShell },
            (err, stdout, stderr) => {
              const code = err ? ((err as { code?: number }).code as number | null) ?? 1 : 0;
              resolve({ code: typeof code === "number" ? code : 1, out: `${stdout ?? ""}\n${stderr ?? ""}`.trim() });
            }
          );
          // stdin fechado sempre: comandos como sqlplus/psql que esperam entrada não travam até o timeout.
          if (plan.stdin !== undefined) child.stdin?.write(plan.stdin);
          child.stdin?.end();
        } catch (e) {
          // execFile pode LANÇAR síncrono (ex.: EINVAL). Fail-open: nunca escapa de execute().
          resolve({ code: 1, out: hostT("wh.err.spawnFailed", { tool: plan.tool, error: (e as Error).message }) });
        }
      });

      // skipMask: consultas de METADADOS/AGREGADOS (inventário de schema, perfil de paridade, custo) —
      // o resultado não tem PII por construção (tabela,coluna,tipo / COUNT), e mascarar CORROMPE os
      // números (um count de 8 dígitos virava ▇ e a paridade dava falso "OK") — achado da revisão.
      const { output, truncated } = sanitizeWarehouseOutput(raw.out, opts.rowCap, opts.skipMask, opts.maxChars);
      return {
        ok: raw.code === 0,
        exitCode: raw.code,
        output,
        truncated,
        durationMs: Date.now() - started,
        command: plan.display,
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function installHint(tool: string): string {
  switch (tool) {
    case "sql":
      return hostT("wh.hint.sqlcl");
    case "sqlplus":
      return "Oracle Instant Client + SQL*Plus";
    case "psql":
      return "PostgreSQL client tools";
    case "bq":
      return "Google Cloud SDK (gcloud) + `gcloud auth login`";
    case "duckdb":
      return hostT("wh.hint.duckdb");
    case "aws":
      return "AWS CLI v2 + `aws configure`";
    case "oci":
      return "OCI CLI + `oci setup config`";
    default:
      return hostT("wh.hint.default");
  }
}
