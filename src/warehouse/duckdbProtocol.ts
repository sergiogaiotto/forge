export interface DuckDbWorkerConfig {
  databasePath: string;
  workspaceRoot: string;
  tempDirectory: string;
  memoryLimit: string;
  maxTempDirectorySize: string;
  threads: number;
}

export type DuckDbWorkerRequest =
  | { type: "init"; config: DuckDbWorkerConfig }
  | { type: "query"; id: number; sql: string; rowCap: number };

export type DuckDbWorkerResponse =
  | { type: "ready"; version: string }
  | { type: "result"; id: number; ok: true; csv: string; truncated: boolean; durationMs: number }
  | { type: "result"; id: number; ok: false; error: string; durationMs: number }
  | { type: "fatal"; error: string };
