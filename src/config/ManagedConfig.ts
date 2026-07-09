import * as vscode from "vscode";
import { EgressPolicy } from "../net/EgressEnforcer";
import { McpServerEntry } from "../mcp/types";
import { CaptureMode, ObsConfig } from "../obs/types";

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

  // OCR (colar print): caminho do executável tesseract (vazio = auto-detecção no PATH + locais padrão,
  // inclusive por-usuário) e pasta tessdata dos idiomas (vazio = tessdata padrão do tesseract). Permite
  // usar um tesseract portable/per-user e adicionar idiomas sem admin.
  ocrTesseractPath(): string {
    return this.cfg().get<string>("ocr.tesseractPath", "").trim();
  }

  ocrTessdataPath(): string {
    return this.cfg().get<string>("ocr.tessdataPath", "").trim();
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

  // Gate de DEFINIÇÃO DE PRONTO (P2) no Modo Projeto: quando o conjunto está completo mas falta manifesto de
  // dependências, qualquer teste, ou um README com "como rodar", bloqueia o Aplicar de todos (bloqueio +
  // aviso, sem auto-reparo). Desligue (`false`) para projetos onde teste/README não se aplicam (ex.: script
  // descartável). Respeita o `validation.gateBlocksApply` mestre — se ele estiver off, nada bloqueia.
  definitionOfDone(): boolean {
    return this.cfg().get<boolean>("gate.definitionOfDone", true);
  }

  // Gate de SEGURANÇA (P2) no Modo Projeto: roda o bandit (SAST) sobre o projeto gerado. "conservative"
  // (padrão): só achados de severidade ALTA E confiança ALTA bloqueiam o Aplicar (senha hardcoded, eval de
  // input, cripto fraca); o resto é advisory. "advisory": nada bloqueia (só surface). "off": não roda.
  // bandit ausente → consultivo (fail-open). Respeita o `validation.gateBlocksApply` mestre.
  securityGate(): "conservative" | "advisory" | "off" {
    const v = this.cfg().get<string>("gate.security", "conservative");
    return v === "advisory" || v === "off" ? v : "conservative";
  }

  // Gate SQL (dados, Onda 1): o motor determinístico in-process analisa propostas .sql. "conservative"
  // (padrão): só achados de SEGURANÇA (DELETE/UPDATE sem WHERE, DROP/TRUNCATE, produto cartesiano)
  // bloqueiam o Aplicar; anti-padrões e schema (dbt) são sempre advisory. "advisory": nada bloqueia.
  // "off": não roda. Respeita o `validation.gateBlocksApply` mestre, como todos os gates.
  sqlGate(): "conservative" | "advisory" | "off" {
    const v = this.cfg().get<string>("gate.sql", "conservative");
    return v === "advisory" || v === "off" ? v : "conservative";
  }

  // Reconciliação de dependências (P4) no Modo Projeto: depois do gate, acrescenta ao requirements.txt GERADO
  // os pacotes que o código importa mas não declara (idempotente, conservador — nunca adiciona ambíguo).
  // Desligue (`false`) para não auto-editar a proposta do manifesto.
  reconcileDependencies(): boolean {
    return this.cfg().get<boolean>("project.reconcileDependencies", true);
  }

  // Templates de skill (P2, nível 3) no Modo Projeto: quando uma skill com `templates` no frontmatter ativa,
  // materializa os .tmpl como forge-file (scaffold determinístico, fora do LLM), em gap-fill (nunca sobrescreve
  // o que o LLM gerou). As propostas herdam o gate. Desligue (`false`) para não materializar scaffold de skill.
  skillTemplates(): boolean {
    return this.cfg().get<boolean>("skills.templates", true);
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

  // Overrides opcionais do provedor. maxOutput: teto de tokens de SAÍDA (0 = catálogo). maxContextWindow:
  // janela REAL servida pelo gateway (--max-model-len); 0 = usa a capacidade do modelo do catálogo. Defina
  // maxContextWindow quando o HubGPU/vLLM servir uma janela menor que a do modelo, para não estourar (400).
  provider(): { maxOutput: number; maxContextWindow: number } {
    return {
      maxOutput: this.cfg().get<number>("provider.maxOutput", 0),
      maxContextWindow: this.cfg().get<number>("provider.maxContextWindow", 0),
    };
  }

  run(): { enabled: boolean; timeoutSeconds: number; commands: Record<string, string> } {
    const c = this.cfg();
    return {
      enabled: c.get<boolean>("run.enabled", true),
      timeoutSeconds: c.get<number>("run.timeoutSeconds", 120),
      commands: c.get<Record<string, string>>("run.commands", {}),
    };
  }

  // Timeout PRÓPRIO do "Preparar ambiente" (venv + pip install): instalar pacotes pesados
  // (scikit-learn, pyspark…) num cache frio passa fácil dos 120s do run — matar o pip no meio
  // deixa o venv meio-populado e o dev num loop de reexecutar/falhar.
  env(): { timeoutSeconds: number } {
    return { timeoutSeconds: this.cfg().get<number>("env.timeoutSeconds", 900) };
  }

  test(): { enabled: boolean; command: string; autoInstall: boolean } {
    const c = this.cfg();
    return {
      enabled: c.get<boolean>("test.enabled", true),
      command: c.get<string>("test.command", "pytest -q"),
      // pytest ausente no pré-flight: true instala direto no venv; false pergunta (diálogo nativo).
      autoInstall: c.get<boolean>("test.autoInstall", false),
    };
  }

  // Diagnóstico LOCAL (P3): log estruturado NDJSON + bundle exportável. Sempre REDIGIDO (masked); distinto
  // da observabilidade do Langfuse (opt-in/egress). `enabled` permite desligar a gravação local por política.
  diagnostics(): { enabled: boolean } {
    return { enabled: this.cfg().get<boolean>("diagnostics.enabled", true) };
  }

  search(): { server: string; tool: string; queryArg: string } {
    const c = this.cfg();
    return {
      server: c.get<string>("search.server", "").trim(),
      tool: c.get<string>("search.tool", "search"),
      queryArg: c.get<string>("search.queryArg", "query"),
    };
  }

  // Config da observabilidade do cliente (sink direto Langfuse). A secretKey NÃO vem daqui —
  // fica no SecretStorage (RNF-010). Em produção governada, prefira o gateway-relay.
  observability(): ObsConfig {
    const c = this.cfg();
    const cap = c.get<string>("observability.langfuse.capture", "masked");
    return {
      enabled: c.get<boolean>("observability.langfuse.enabled", false),
      baseUrl: c.get<string>("observability.langfuse.baseUrl", "https://cloud.langfuse.com").trim(),
      publicKey: c.get<string>("observability.langfuse.publicKey", "").trim(),
      environment: c.get<string>("observability.langfuse.env", "development").trim() || "development",
      sampleRate: c.get<number>("observability.langfuse.sampleRate", 1.0),
      capture: (cap === "full" || cap === "metadata-only" ? cap : "masked") as CaptureMode,
    };
  }

  onChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("forge")) listener();
    });
  }
}
