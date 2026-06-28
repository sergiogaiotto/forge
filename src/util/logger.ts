import * as vscode from "vscode";

// Canal de saída centralizado. Deliberadamente nunca registramos valores secretos aqui —
// os chamadores passam apenas referências/formas redigidas (RNF-001).
class Logger {
  private channel: vscode.OutputChannel | undefined;

  init(context: vscode.ExtensionContext): void {
    this.channel = vscode.window.createOutputChannel("FORGE", { log: true } as any) ?? vscode.window.createOutputChannel("FORGE");
    context.subscriptions.push(this.channel);
  }

  private ts(): string {
    // new Date() é adequado no runtime do host da extensão.
    return new Date().toISOString();
  }

  private write(level: string, msg: string, ...args: unknown[]): void {
    const extra = args.length ? " " + args.map((a) => safeStringify(a)).join(" ") : "";
    const line = `[${this.ts()}] [${level}] ${msg}${extra}`;
    this.channel?.appendLine(line);
    if (level === "ERROR") {
      // Espelha os erros no console de desenvolvimento durante o desenvolvimento.
      // eslint-disable-next-line no-console
      console.error(line);
    }
  }

  info(msg: string, ...args: unknown[]): void {
    this.write("INFO", msg, ...args);
  }
  warn(msg: string, ...args: unknown[]): void {
    this.write("WARN", msg, ...args);
  }
  error(msg: string, ...args: unknown[]): void {
    this.write("ERROR", msg, ...args);
  }

  show(): void {
    this.channel?.show(true);
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = new Logger();
