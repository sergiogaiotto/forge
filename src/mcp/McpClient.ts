import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { safeFetch } from "../net/safeFetch";
import { sseLines } from "../util/http";
import { McpServerEntry } from "./types";

export interface JsonRpcResult {
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpTransportClient {
  request(method: string, params: unknown): Promise<JsonRpcResult>;
  close(): Promise<void>;
}

// --- Transporte HTTP streamable (intra-rede, ex.: Oracle SQLcl MCP) -----------
export class StreamableHttpClient implements McpTransportClient {
  private id = 0;
  private sessionId: string | undefined;
  constructor(private readonly url: string, private readonly headers: Record<string, string>) {}

  async request(method: string, params: unknown): Promise<JsonRpcResult> {
    const body = { jsonrpc: "2.0", id: ++this.id, method, params };
    const res = await safeFetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      for await (const data of sseLines(res.body)) {
        try {
          const msg = JSON.parse(data);
          if (msg.id === body.id) return { result: msg.result, error: msg.error };
        } catch {
          /* ignorar */
        }
      }
      return { error: { code: -1, message: "stream encerrado sem resposta" } };
    }
    const json = (await res.json()) as JsonRpcResult & { result?: unknown; error?: any };
    return { result: json.result, error: json.error };
  }

  async close(): Promise<void> {
    /* sem estado */
  }
}

// --- Transporte stdio (processo local, enquadramento Content-Length estilo LSP) --------
export class StdioClient implements McpTransportClient {
  private proc: ChildProcessWithoutNullStreams;
  private id = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, (r: JsonRpcResult) => void>();

  constructor(command: string, args: string[], env: Record<string, string>) {
    this.proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: "pipe", windowsHide: true });
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on("data", () => undefined);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) return;
      const payload = this.buffer.subarray(start, start + len).toString("utf8");
      this.buffer = this.buffer.subarray(start + len);
      try {
        const msg = JSON.parse(payload);
        const resolver = this.pending.get(msg.id);
        if (resolver) {
          this.pending.delete(msg.id);
          resolver({ result: msg.result, error: msg.error });
        }
      } catch {
        /* ignorar */
      }
    }
  }

  request(method: string, params: unknown): Promise<JsonRpcResult> {
    const id = ++this.id;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const framed = `Content-Length: ${Buffer.byteLength(msg, "utf8")}\r\n\r\n${msg}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(framed);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ error: { code: -2, message: "timeout" } });
        }
      }, 30_000);
    });
  }

  async close(): Promise<void> {
    this.proc.kill();
  }
}

export function createTransport(entry: McpServerEntry, headers: Record<string, string>, env: Record<string, string>): McpTransportClient {
  if (entry.transport === "streamableHttp") {
    return new StreamableHttpClient(entry.url!, headers);
  }
  return new StdioClient(entry.command!, entry.args ?? [], env);
}
