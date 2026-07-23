import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { DuckDbWorkerConfig, DuckDbWorkerRequest, DuckDbWorkerResponse } from "./duckdbProtocol";

if (!parentPort) throw new Error("DuckDB worker requires a parent port.");

let instance: DuckDBInstance | undefined;
let connection: DuckDBConnection | undefined;
let queue = Promise.resolve();

function send(message: DuckDbWorkerResponse): void {
  parentPort!.postMessage(message);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsToCsv(columns: string[], rows: Record<string, unknown>[]): string {
  if (columns.length === 0) return "";
  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n");
}

async function initialize(config: DuckDbWorkerConfig): Promise<void> {
  await fs.mkdir(path.dirname(config.databasePath), { recursive: true });
  await fs.mkdir(config.tempDirectory, { recursive: true });
  const duckdb = await import("@duckdb/node-api");
  instance = await duckdb.DuckDBInstance.create(config.databasePath, {
    threads: String(Math.max(1, config.threads)),
    memory_limit: config.memoryLimit,
    temp_directory: config.tempDirectory,
    max_temp_directory_size: config.maxTempDirectorySize,
  });
  connection = await instance.connect();
  const allowed = [config.workspaceRoot, path.dirname(config.databasePath), config.tempDirectory]
    .map((entry) => sqlString(path.resolve(entry).replace(/\\/g, "/")))
    .join(",");
  await connection.run(
    [
      `SET allowed_directories=[${allowed}]`,
      "SET enable_external_access=false",
      "SET autoinstall_known_extensions=false",
      "SET autoload_known_extensions=false",
      "SET allow_community_extensions=false",
      "SET lock_configuration=true",
    ].join("; ")
  );
  send({ type: "ready", version: duckdb.version() });
}

async function runQuery(id: number, sql: string, rowCap: number): Promise<void> {
  const started = Date.now();
  if (!connection) {
    send({ type: "result", id, ok: false, error: "DuckDB worker is not initialized.", durationMs: Date.now() - started });
    return;
  }
  try {
    const reader = await connection.streamAndReadUntil(sql, Math.max(1, rowCap + 1));
    const columns = reader.columnNames();
    const rows = (await reader.getRowObjectsJson()) as Record<string, unknown>[];
    const truncated = rows.length > rowCap;
    send({
      type: "result",
      id,
      ok: true,
      csv: rowsToCsv(columns, rows.slice(0, rowCap)),
      truncated,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    send({
      type: "result",
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    });
  }
}

parentPort.on("message", (message: DuckDbWorkerRequest) => {
  if (message.type === "init") {
    queue = queue.then(() => initialize(message.config)).catch((error) => {
      send({ type: "fatal", error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  queue = queue.then(() => runQuery(message.id, message.sql, message.rowCap));
});

parentPort.on("close", () => {
  connection?.closeSync();
  instance?.closeSync();
});
