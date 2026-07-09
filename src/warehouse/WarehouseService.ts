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
import { SecretsStore } from "../secrets/SecretsStore";
import { maskDataSample } from "../util/piiScan";
import { decideSqlRun } from "./governance";
import { buildCostPlan, buildRunPlan, buildTestPlan, capCsv, CliPlan, isPlanError, PlanError } from "./sqlRunners";
import { SqlRunResult, WarehouseConnection, WarehouseSettings } from "./types";

const secretKeyFor = (connId: string) => `forge.warehouse.${connId}`;

export class WarehouseService {
  constructor(
    private readonly secrets: SecretsStore,
    private readonly settings: () => WarehouseSettings,
    private readonly workspaceRoot: () => string | undefined
  ) {}

  connections(): WarehouseConnection[] {
    return this.settings().connections;
  }

  resolve(id?: string): WarehouseConnection | undefined {
    const s = this.settings();
    const target = (id ?? s.defaultId ?? "").trim();
    if (target) return s.connections.find((c) => c.id === target);
    return s.connections[0];
  }

  // Senha da conexão: SecretStorage; pede UMA vez (input mascarado) e persiste. Kinds sem senha
  // própria (bigquery/duckdb/s3/oci — auth do CLI) retornam undefined sem prompt.
  private async passwordFor(conn: WarehouseConnection): Promise<string | undefined> {
    if (conn.kind !== "oracle" && conn.kind !== "postgres") return undefined;
    // Postgres com senha na URI ou .pgpass, e Oracle com wallet/external auth, não precisam de prompt.
    if (conn.kind === "postgres" && /:[^@/:]+@/.test(conn.connect ?? "")) return undefined;
    if (conn.kind === "oracle" && conn.walletDir) return undefined;
    const existing = await this.secrets.get(secretKeyFor(conn.id));
    if (existing) return existing;
    const typed = await vscode.window.showInputBox({
      title: `Senha da conexão "${conn.id}" (${conn.kind})`,
      prompt: "Guardada no SecretStorage do VSCode (keyring do SO) — nunca em settings ou em disco.",
      password: true,
      ignoreFocusOut: true,
    });
    if (!typed) return undefined;
    await this.secrets.set(secretKeyFor(conn.id), typed);
    return typed;
  }

  // Executa SQL com governança. `confirmed` pula o modal (chamadas já confirmadas pelo dev na UI).
  async runSql(connId: string | undefined, sql: string, opts?: { label?: string; skipGovernance?: boolean }): Promise<SqlRunResult | { refused: string }> {
    const conn = this.resolve(connId);
    if (!conn) return { refused: connId ? `Conexão "${connId}" não existe — veja /conexoes.` : "Nenhuma conexão configurada (forge.warehouse.connections)." };

    if (!opts?.skipGovernance) {
      const decision = decideSqlRun(sql, conn);
      if (decision.verdict === "blocked") return { refused: `⛔ ${decision.reason}` };
      if (decision.verdict === "confirm") {
        const pick = await vscode.window.showWarningMessage(
          `FORGE · conexão "${conn.id}": ${decision.reason}`,
          { modal: true, detail: sql.slice(0, 600) },
          "Executar escrita"
        );
        if (pick !== "Executar escrita") return { refused: "Execução cancelada pelo dev (escrita não confirmada)." };
      }
    }
    const plan = buildRunPlan(conn, sql, { password: await this.passwordFor(conn), rowCap: this.settings().rowCap });
    return this.execute(conn, plan);
  }

  async costPreview(connId: string | undefined, sql: string): Promise<SqlRunResult | { refused: string }> {
    const conn = this.resolve(connId);
    if (!conn) return { refused: "Nenhuma conexão configurada." };
    const plan = buildCostPlan(conn, sql, { password: await this.passwordFor(conn) });
    return this.execute(conn, plan);
  }

  async testConnection(conn: WarehouseConnection): Promise<SqlRunResult | { refused: string }> {
    const plan = buildTestPlan(conn, { password: await this.passwordFor(conn) });
    return this.execute(conn, plan);
  }

  private async execute(conn: WarehouseConnection, plan: CliPlan | PlanError): Promise<SqlRunResult | { refused: string }> {
    if (isPlanError(plan)) return { refused: plan.error };
    const baseDir = this.workspaceRoot() ? path.join(this.workspaceRoot()!, ".forge") : os.tmpdir();
    await fs.mkdir(baseDir, { recursive: true });
    const tmpDir = await fs.mkdtemp(path.join(baseDir, "wh-"));
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

      const raw = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = execFile(
          plan.tool,
          args,
          { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...plan.env }, cwd: tmpDir, shell: process.platform === "win32" },
          (err, stdout, stderr) => {
            if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
              resolve({ code: null, out: `__ENOENT__${plan.tool}` });
              return;
            }
            const code = err ? ((err as { code?: number }).code as number | null) ?? 1 : 0;
            resolve({ code: typeof code === "number" ? code : 1, out: `${stdout ?? ""}\n${stderr ?? ""}`.trim() });
          }
        );
        if (plan.stdin !== undefined) {
          child.stdin?.write(plan.stdin);
          child.stdin?.end();
        }
      });

      if (raw.out.startsWith("__ENOENT__")) {
        const tool = raw.out.slice("__ENOENT__".length);
        return { refused: `A ferramenta \`${tool}\` não está no PATH. Instale-a (${installHint(tool)}) — o FORGE usa o CLI que você já usa, sem driver embutido.` };
      }
      const capped = capCsv(raw.out, this.settings().rowCap);
      return {
        ok: raw.code === 0,
        exitCode: raw.code,
        output: maskDataSample(capped.text).slice(0, 16000),
        truncated: capped.truncated,
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
      return "SQLcl — baixe em oracle.com/sqlcl; conecta 19c, 26ai, Exadata e ADW (wallet)";
    case "sqlplus":
      return "Oracle Instant Client + SQL*Plus";
    case "psql":
      return "PostgreSQL client tools";
    case "bq":
      return "Google Cloud SDK (gcloud) + `gcloud auth login`";
    case "duckdb":
      return "duckdb.org — binário único";
    case "aws":
      return "AWS CLI v2 + `aws configure`";
    case "oci":
      return "OCI CLI + `oci setup config`";
    default:
      return "instale e garanta no PATH";
  }
}
