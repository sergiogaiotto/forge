// Fonte única da verdade para o protocolo de mensagens tipado entre o host da
// extensão e a webview React. Este arquivo DEVE permanecer livre de dependências (sem `vscode`,
// sem builtins do node) para que o bundle da webview possa importá-lo.

export type ProviderType = "openai" | "anthropic" | "openai-compatible";

// Linguagens das cercas de código que o modelo emite e a extensão faz parse em propostas.
// Ficam AQUI (módulo sem dependências) para que tanto o host quanto a webview possam importá-las
// sem arrastar o systemPrompt/node para o bundle do navegador.
export const FORGE_FILE_BLOCK_LANG = "forge-file";
export const FORGE_CELL_BLOCK_LANG = "forge-cell";

// Cerca EXTERNA padrão dos blocos forge-file/forge-cell: 4 crases. Usar 4 (em vez de 3) permite que
// o CONTEÚDO do bloco tenha suas próprias cercas de 3 crases (ex.: um ```bash dentro de um README)
// sem fechar o bloco prematuramente. Os parsers aceitam N>=3 crases (retrocompat com 3), exigindo
// que o fechamento tenha o MESMO número de crases da abertura, sozinho na própria linha.
export const FORGE_FENCE = "````";

export interface ProviderPreset {
  id: string;
  label: string;
  type: ProviderType;
  baseUrl?: string;
  modelId: string;
  apiKeyDefault?: string;
  note?: string;
}

export interface ProviderSetup {
  type: ProviderType;
  modelId: string;
  baseUrl?: string;
  apiKey?: string; // enviada uma vez no setup, depois armazenada no SecretStorage e nunca devolvida
  authHeader?: string;
  timeoutSeconds: number;
}

export interface ProviderView {
  configured: boolean;
  type?: ProviderType;
  modelId?: string;
  baseUrl?: string;
  timeoutSeconds?: number;
  label?: string;
}

export interface LicenseView {
  active: boolean;
  org?: string;
  subject?: string;
  expiry?: number; // segundos unix
  scope?: string[];
  mode: "gateway" | "local";
}

export interface SkillView {
  name: string;
  description: string;
  enabled: boolean;
  source: "managed" | "user" | "workspace";
  hasValidators: boolean;
}

export interface McpServerView {
  id: string;
  transport: "stdio" | "streamableHttp";
  scope: "readonly" | "readwrite";
  enabled: boolean;
  autoApprove: boolean;
  inNetwork: boolean;
}

export interface RagView {
  enabled: boolean;
  ready: boolean;
  mode: "embeddings" | "lexical";
  files: number;
  chunks: number;
  embeddingsUrl: string;
  embeddingModel: string;
  dimensions: number; // 0 = padrão do modelo
}

// Visão do perfil do projeto para o painel da webview (stack detectada + papel + regras).
export interface ProfileView {
  stack: {
    language?: string;
    packaging?: string;
    lintFormat: string[];
    types: string[];
    tests?: string;
    libs: string[];
  };
  role?: string; // rótulo legível (ex.: "Engenheiro de dados") ou ausente
  rules: string[];
}

export interface ForgeState {
  stage: "onboarding-license" | "onboarding-provider" | "ready" | "blocked";
  license: LicenseView;
  provider: ProviderView;
  network: { internalOnly: boolean; allowedHosts: string[] };
  observability: { traceActive: boolean; managedByAdmin: boolean; login: string };
  identity: { email: string | null; emailRequired: boolean; source: "license" | "manual" | "none" };
  search: { enabled: boolean; label: string }; // busca interna via MCP (governada)
  mcp: McpServerView[];
  skills: SkillView[];
  rag: RagView;
  presets: ProviderPreset[];
  telemetryEnabled: boolean;
  version: string;
}

export type ValidatorStatus = "ok" | "failed" | "skipped";

export interface ValidatorResult {
  id: string;
  label: string;
  status: ValidatorStatus;
  gate: boolean;
  output: string;
  reason?: string;
}

export interface DiffProposal {
  id: string;
  filePath: string;
  language: string;
  original: string;
  modified: string;
  summary: string;
  activatedSkills: string[];
  // Presente quando a proposta é uma edição de CÉLULA de notebook (.ipynb).
  cell?: { op: "add" | "replace"; index?: number; after?: number };
}

// ---- Host da extensão → Webview ------------------------------------------------

export type ExtToWebview =
  | { type: "state"; state: ForgeState }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string }
  | { type: "providerTestResult"; ok: boolean; message: string; latencyMs?: number }
  | { type: "embeddingsTestResult"; ok: boolean; mode: "embeddings" | "lexical"; message: string; dims?: number; latencyMs?: number }
  | { type: "stream/start"; taskId: string }
  | { type: "stream/skill"; taskId: string; skill: string }
  | { type: "stream/reasoning"; taskId: string; delta: string }
  | { type: "stream/text"; taskId: string; delta: string }
  | { type: "stream/proposal"; taskId: string; proposal: DiffProposal }
  | { type: "stream/end"; taskId: string }
  | { type: "stream/error"; taskId: string; message: string }
  | { type: "context/attachments"; items: { id: string; label: string; bytes: number; kind: "workspace" | "upload" | "selection" | "search" }[] }
  | { type: "validation/result"; proposalId: string; results: ValidatorResult[]; gateOk: boolean; running: boolean }
  | { type: "proposal/applied"; proposalId: string }
  | { type: "proposal/discarded"; proposalId: string }
  | { type: "review/done" }
  | {
      type: "run/result";
      proposalId?: string;
      filePath: string;
      label?: string; // ex.: "testes" — quando não é a execução de um arquivo
      command: string;
      ok: boolean;
      exitCode: number | null;
      output: string;
      durationMs: number;
      skippedReason?: string;
    }
  | { type: "mcp/approvalRequest"; requestId: string; server: string; tool: string; scope: string; argsPreview: string }
  | { type: "profile/state"; profile: ProfileView };

// ---- Webview → Host da extensão ------------------------------------------------

export type WebviewToExt =
  | { type: "ready" }
  | { type: "license/submit"; key: string }
  | { type: "identity/setEmail"; email: string }
  | { type: "provider/setup"; setup: ProviderSetup }
  | { type: "provider/test"; setup: ProviderSetup }
  | { type: "provider/openSettings" }
  | { type: "embeddings/test" }
  | { type: "chat/send"; text: string; tdd?: boolean }
  | { type: "tests/run" }
  | { type: "chat/abort"; taskId: string }
  | { type: "proposal/apply"; proposalId: string }
  | { type: "proposal/discard"; proposalId: string }
  | { type: "proposal/viewDiff"; proposalId: string }
  | { type: "proposal/copy"; proposalId: string }
  | { type: "profile/addRule"; rule: string }
  | { type: "profile/open" }
  | { type: "profile/pickRole" }
  | { type: "profile/refresh" }
  | { type: "run/file"; filePath: string; proposalId?: string }
  | { type: "cell/run"; proposalId: string }
  | { type: "review/changes" }
  | { type: "context/pickWorkspaceFile" }
  | { type: "context/pickLocalFile" }
  | { type: "context/addSelection" }
  | { type: "context/removeAttachment"; id: string }
  | { type: "context/search" }
  | { type: "context/webInfo" }
  | { type: "skill/toggle"; name: string; enabled: boolean }
  | { type: "mcp/approvalResponse"; requestId: string; approved: boolean }
  | { type: "signOut" }
  | { type: "reindexSkills" };
