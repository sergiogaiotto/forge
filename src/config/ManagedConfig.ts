import * as vscode from "vscode";
import { EgressPolicy } from "../net/EgressEnforcer";
import { McpServerEntry } from "../mcp/types";

export interface RagConfig {
  enabled: boolean;
  embeddingsUrl: string;
  embeddingModel: string;
  embeddingDimensions: number; // 0 = padrão do modelo (1024 no Qwen3-Embedding-0.6B)
  maxChunks: number;
  maxFileSizeKb: number;
  include: string[];
  exclude: string[];
}

// Lê as configurações `forge.*` gerenciadas pelo admin. Em uma implantação real elas são
// distribuídas via política de configurações gerenciadas/corporativas; aqui elas resolvem a partir do
// escopo de configuração padrão do VSCode.
export class ManagedConfig {
  private cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("forge");
  }

  gatewayUrl(): string {
    return this.cfg().get<string>("gateway.url", "").trim();
  }

  licenseMode(): "gateway" | "local" {
    return this.cfg().get<"gateway" | "local">("license.mode", "local");
  }

  managedSkillsDir(): string {
    return this.cfg().get<string>("skills.managedDir", "").trim();
  }

  // Caminho para um perfil de projeto GERIDO PELO ADMIN (padrões/convenções da organização),
  // injetado em todo prompt como camada de menor precedência. Vazio = sem camada admin.
  managedProfile(): string {
    return this.cfg().get<string>("project.managedProfile", "").trim();
  }

  retrievalThreshold(): number {
    return this.cfg().get<number>("skills.retrievalThreshold", 15);
  }

  topK(): number {
    return this.cfg().get<number>("skills.topK", 8);
  }

  egressPolicy(): EgressPolicy {
    return {
      allowExternal: this.cfg().get<boolean>("egress.allowExternal", false),
      allowedHosts: this.cfg().get<string[]>("egress.allowedHosts", ["hub-gpus.claro.com.br"]),
    };
  }

  mcpCatalog(): McpServerEntry[] {
    return this.cfg().get<McpServerEntry[]>("mcp.catalog", []);
  }

  gateBlocksApply(): boolean {
    return this.cfg().get<boolean>("validation.gateBlocksApply", true);
  }

  rag(): RagConfig {
    const c = this.cfg();
    return {
      enabled: c.get<boolean>("rag.enabled", true),
      embeddingsUrl: c.get<string>("rag.embeddings.url", "").trim(),
      embeddingModel: c.get<string>("rag.embeddings.model", "Qwen/Qwen3-Embedding-0.6B"),
      embeddingDimensions: c.get<number>("rag.embeddings.dimensions", 0),
      maxChunks: c.get<number>("rag.maxChunks", 8),
      maxFileSizeKb: c.get<number>("rag.maxFileSizeKb", 512),
      include: c.get<string[]>("rag.include", []),
      exclude: c.get<string[]>("rag.exclude", []),
    };
  }

  telemetryEnabled(): boolean {
    return this.cfg().get<boolean>("telemetry.enabled", false);
  }

  requireEmail(): boolean {
    return this.cfg().get<boolean>("identity.requireEmail", false);
  }

  run(): { enabled: boolean; timeoutSeconds: number; commands: Record<string, string> } {
    const c = this.cfg();
    return {
      enabled: c.get<boolean>("run.enabled", true),
      timeoutSeconds: c.get<number>("run.timeoutSeconds", 120),
      commands: c.get<Record<string, string>>("run.commands", {}),
    };
  }

  test(): { enabled: boolean; command: string } {
    const c = this.cfg();
    return {
      enabled: c.get<boolean>("test.enabled", true),
      command: c.get<string>("test.command", "pytest -q"),
    };
  }

  search(): { server: string; tool: string; queryArg: string } {
    const c = this.cfg();
    return {
      server: c.get<string>("search.server", "").trim(),
      tool: c.get<string>("search.tool", "search"),
      queryArg: c.get<string>("search.queryArg", "query"),
    };
  }

  onChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("forge")) listener();
    });
  }
}
