import { Worker } from "node:worker_threads";
import type { DuckDbWorkerConfig, DuckDbWorkerRequest, DuckDbWorkerResponse } from "./duckdbProtocol";

export interface EmbeddedDuckDbRunResult {
  ok: boolean;
  output: string;
  truncated: boolean;
  durationMs: number;
  version?: string;
}

interface Pending {
  resolve: (value: EmbeddedDuckDbRunResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class WorkerSession {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readyPromise: Promise<string>;
  private readyResolve!: (version: string) => void;
  private readyReject!: (error: Error) => void;
  private nextId = 1;
  private closed = false;

  constructor(
    workerPath: string,
    config: DuckDbWorkerConfig,
    private readonly onDead: () => void
  ) {
    this.readyPromise = new Promise<string>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.worker = new Worker(workerPath);
    this.worker.on("message", (message: DuckDbWorkerResponse) => this.onMessage(message));
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) this.fail(new Error(`DuckDB worker exited with code ${code}.`));
    });
    this.worker.postMessage({ type: "init", config } satisfies DuckDbWorkerRequest);
  }

  private onMessage(message: DuckDbWorkerResponse): void {
    if (message.type === "ready") {
      this.readyResolve(message.version);
      return;
    }
    if (message.type === "fatal") {
      this.fail(new Error(message.error));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve({
        ok: true,
        output: message.csv,
        truncated: message.truncated,
        durationMs: message.durationMs,
      });
    } else {
      pending.resolve({ ok: false, output: message.error, truncated: false, durationMs: message.durationMs });
    }
  }

  private fail(error: Error): void {
    this.readyReject(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closed) {
      this.closed = true;
      this.onDead();
    }
  }

  async run(sql: string, rowCap: number, timeoutMs: number): Promise<EmbeddedDuckDbRunResult> {
    const version = await this.readyPromise;
    if (this.closed) throw new Error("DuckDB worker is closed.");
    const id = this.nextId++;
    return new Promise<EmbeddedDuckDbRunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void this.dispose();
        reject(new Error(`DuckDB query timed out after ${Math.ceil(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => resolve({ ...result, version }),
        reject,
        timer,
      });
      this.worker.postMessage({ type: "query", id, sql, rowCap } satisfies DuckDbWorkerRequest);
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("DuckDB worker was closed."));
    }
    this.pending.clear();
    await this.worker.terminate();
    this.onDead();
  }
}

export class EmbeddedDuckDbManager {
  private readonly sessions = new Map<string, WorkerSession>();

  constructor(private readonly workerPath: string) {}

  run(config: DuckDbWorkerConfig, sql: string, rowCap: number, timeoutMs: number): Promise<EmbeddedDuckDbRunResult> {
    const key = config.databasePath;
    let session = this.sessions.get(key);
    if (!session) {
      session = new WorkerSession(this.workerPath, config, () => this.sessions.delete(key));
      this.sessions.set(key, session);
    }
    return session.run(sql, rowCap, timeoutMs);
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.dispose()));
  }
}
