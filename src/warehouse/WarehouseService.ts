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
import { classifySql } from "../sql/classify";
import { buildSpawn, resolveExecutable, unsafeField } from "./exec";
import { decideSqlRun } from "./governance";
import { buildCostPlan, buildRunPlan, buildTestPlan, CliPlan, isPlanError, PlanError, sanitizeWarehouseOutput } from "./sqlRunners";
import { SqlRunResult, WarehouseConnection, WarehouseSettings } from "./types";

const secretKeyFor = (connId: string) => `forge.warehouse.${connId}`;

// Prefixo dos temp dirs deste serviço — a varredura de órfãos do startup remove os que sobrarem de um
// crash (o wrapper Oracle contém a senha em claro; deixá-lo órfão no .forge/ do workspace é risco).
export const WH_TMP_PREFIX = "wh-";

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
      title: `Senha da conexão "${conn.id}" (${conn.kind})`,
      prompt: "Guardada no SecretStorage do VSCode (keyring do SO) — nunca em settings ou em disco.",
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
      if (unsafeField(v)) return `Conexão "${conn.id}": o campo \`${f}\` contém caracteres não permitidos (metacaractere de shell) — corrija forge.warehouse.connections.`;
    }
    for (const s of conn.schemas ?? []) if (unsafeField(s)) return `Conexão "${conn.id}": um item de \`schemas\` contém caracteres não permitidos.`;
    return null;
  }

  // Executa SQL com governança (SELECT auto; escrita confirma; DROP/TRUNCATE/bloco nunca sem readonly:false).
  async runSql(connId: string | undefined, sql: string, opts?: { skipMask?: boolean; rowCapOverride?: number }): Promise<SqlRunResult | { refused: string }> {
    const conn = this.resolve(connId);
    if (!conn) return { refused: connId ? `Conexão "${connId}" não existe — veja /conexoes.` : "Nenhuma conexão configurada (forge.warehouse.connections)." };
    const bad = this.validateConn(conn);
    if (bad) return { refused: bad };

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
    const rowCap = opts?.rowCapOverride ?? this.settings().rowCap;
    const plan = buildRunPlan(conn, sql, { password: await this.passwordFor(conn), rowCap });
    return this.execute(conn, plan, { rowCap, skipMask: opts?.skipMask });
  }

  // Prévia de custo (EXPLAIN/dry-run) — o card promete "sem executar", então é 100% LEITURA: só verdict
  // "auto" e statement ÚNICO passam (achado crítico da revisão: costPreview pulava a governança e o
  // EXPLAIN de Oracle/PG/DuckDB cobre só o 1º statement — os finais EXECUTAVAM de verdade).
  async costPreview(connId: string | undefined, sql: string): Promise<SqlRunResult | { refused: string }> {
    const conn = this.resolve(connId);
    if (!conn) return { refused: "Nenhuma conexão configurada." };
    const bad = this.validateConn(conn);
    if (bad) return { refused: bad };
    const decision = decideSqlRun(sql, conn);
    if (decision.verdict !== "auto") {
      return { refused: `⛔ Prévia de custo é somente leitura — a consulta contém escrita ou statement não confirmado (${decision.reason}). Rode só o SELECT que quer estimar.` };
    }
    const plan = buildCostPlan(conn, sql, { password: await this.passwordFor(conn), statementCount: classifySql(sql).length });
    return this.execute(conn, plan, { rowCap: 500 });
  }

  async testConnection(conn: WarehouseConnection): Promise<SqlRunResult | { refused: string }> {
    const bad = this.validateConn(conn);
    if (bad) return { refused: bad };
    const plan = buildTestPlan(conn, { password: await this.passwordFor(conn) });
    return this.execute(conn, plan, { rowCap: 5 });
  }

  private async execute(conn: WarehouseConnection, plan: CliPlan | PlanError, opts: { rowCap: number; skipMask?: boolean }): Promise<SqlRunResult | { refused: string }> {
    if (isPlanError(plan)) return { refused: plan.error };
    const toolPath = resolveExecutable(plan.tool);
    if (!toolPath) {
      return { refused: `A ferramenta \`${plan.tool}\` não está no PATH. Instale-a (${installHint(plan.tool)}) — o FORGE usa o CLI que você já usa, sem driver embutido.` };
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
          resolve({ code: 1, out: `Falha ao iniciar ${plan.tool}: ${(e as Error).message}` });
        }
      });

      // skipMask: consultas de METADADOS/AGREGADOS (inventário de schema, perfil de paridade, custo) —
      // o resultado não tem PII por construção (tabela,coluna,tipo / COUNT), e mascarar CORROMPE os
      // números (um count de 8 dígitos virava ▇ e a paridade dava falso "OK") — achado da revisão.
      const { output, truncated } = sanitizeWarehouseOutput(raw.out, opts.rowCap, opts.skipMask);
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
