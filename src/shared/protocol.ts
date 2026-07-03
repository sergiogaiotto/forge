// Fonte única da verdade para o protocolo de mensagens tipado entre o host da
// extensão e a webview React. Este arquivo DEVE permanecer livre de dependências (sem `vscode`,
// sem builtins do node) para que o bundle da webview possa importá-lo.

export type ProviderType = "openai" | "anthropic" | "openai-compatible";

// Artefatos que se VISUALIZAM num painel de preview (webview) em vez de executar como processo.
// Compartilhado entre host (roteamento da execução) e webview (rótulo do botão) — sem deps de node.
export function isRenderablePath(filePath: string): boolean {
  return /\.(html?|svg)$/i.test(filePath);
}

// Charter do projeto (Charter Wizard): seções editáveis do .forge/project.md, redigidas com auxílio
// do modelo. As chaves são estáveis (o webview e o Controller compartilham este contrato).
export type CharterKey = "purpose" | "rules" | "fr" | "nfr";
export type CharterSections = Record<CharterKey, string>;
export const CHARTER_KEYS: CharterKey[] = ["purpose", "rules", "fr", "nfr"];

// Modo Projeto — Fase F: blueprint aprovável (plano de arquivos) + status de orquestração.
export interface BlueprintFile {
  path: string;
  purpose: string;
  deps: string[];
}
export type ProjectFileStatus = "pending" | "generating" | "complete" | "applied" | "failed";
export interface BlueprintFileView extends BlueprintFile {
  status: ProjectFileStatus;
}
export interface ProjectBlueprintView {
  language: ProjectLanguage;
  architecture: ProjectArchitecture;
  brief: string;
  files: BlueprintFileView[];
}

// Modo Projeto: linguagem e arquétipo de arquitetura escolhidos pelo dev para gerar um projeto completo.
export type ProjectLanguage = "python" | "typescript" | "java" | "go";
export type ProjectArchitecture = "hexagonal" | "clean" | "layered" | "mvc";
export const PROJECT_LANGUAGES: ProjectLanguage[] = ["python", "typescript", "java", "go"];
export const PROJECT_ARCHITECTURES: ProjectArchitecture[] = ["hexagonal", "clean", "layered", "mvc"];

// Esforço de raciocínio do modelo (gpt-oss e afins). Mais esforço = raciocínio mais longo e melhor,
// porém mais lento — por isso o timeout é elevado automaticamente junto (ver TIMEOUT_BY_EFFORT).
export type ReasoningEffort = "low" | "medium" | "high";
export const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";
// Timeout (segundos) por nível. `medium` = 300s preserva o default histórico; `high` dá ao
// gpt-oss-120b o tempo de concluir respostas longas (arquivo completo) sem cortar por timeout.
export const TIMEOUT_BY_EFFORT: Record<ReasoningEffort, number> = { low: 120, medium: 300, high: 600 };
export function effectiveTimeoutSeconds(effort: ReasoningEffort | undefined): number {
  return TIMEOUT_BY_EFFORT[effort ?? DEFAULT_REASONING_EFFORT];
}
// Só o gpt-oss (servido OpenAI-compatível, ex.: HubGPU) entende reasoning_effort. Restringir por
// modelId evita enviar o campo a outros modelos OpenAI-compatíveis (Llama, etc.) e mostrar o seletor
// onde ele não faz efeito.
export function supportsReasoningEffort(type: ProviderType | undefined, modelId: string | undefined): boolean {
  return type === "openai-compatible" && /gpt-oss/i.test(modelId ?? "");
}

// Os modelos de RACIOCÍNIO da OpenAI (o-series, gpt-5) REJEITAM temperature != 1 com 400
// ("Unsupported value: 'temperature' does not support 0 with this model") — não enviar o campo a
// eles. Gateways OpenAI-compatíveis (HubGPU/vLLM/Ollama) e a Anthropic aceitam temperature 0.
export function supportsTemperature(type: ProviderType | undefined, modelId: string | undefined): boolean {
  if (type !== "openai") return true;
  return !/(^|\/)(o[134](\b|-)|gpt-5)/i.test(modelId ?? "");
}

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
  reasoningEffort?: ReasoningEffort;
}

export interface ProviderView {
  configured: boolean;
  type?: ProviderType;
  modelId?: string;
  baseUrl?: string;
  timeoutSeconds?: number; // timeout EFETIVO (derivado do esforço) — o que será aplicado na geração
  label?: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoningEffort?: boolean; // true só para provedores OpenAI-compatíveis (gpt-oss)
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

// ---- Visualizador read-only de Skills e RAG (o dev inspeciona o que é injetado) ----
export interface SkillInspectView {
  name: string;
  description: string;
  source: "managed" | "user" | "workspace";
  enabled: boolean;
  relFile: string; // caminho amigável do SKILL.md (raiz + nome, sem expor o caminho absoluto todo)
  validators: string[]; // ids dos validadores da skill
}

export interface RagChunkView {
  id: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  hasVector: boolean;
  preview: string; // primeiras linhas do trecho (read-only, truncado)
}

export interface RagFileView {
  relPath: string;
  language: string;
  chunks: number;
}

export interface RagInspectView {
  enabled: boolean;
  ready: boolean;
  mode: "embeddings" | "lexical";
  files: number;
  chunks: number;
  maxChunks: number;
  capped: boolean;
  embeddingsUrl: string;
  embeddingModel: string;
  dimensions: number;
  fileList: RagFileView[];
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
  // true quando a geração esgotou as tentativas de continuação e o arquivo pode estar incompleto —
  // entrega honesta, em vez de um arquivo truncado disfarçado de completo.
  partial?: boolean;
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
  // usage: tokens REAIS da geração (somados entre continuações) — alimenta /tokens e a barra de status.
  | { type: "stream/end"; taskId: string; usage?: { inputTokens: number; outputTokens: number } }
  // usage: tokens JÁ consumidos até o erro (parcial) — sem ele /tokens subcontaria gasto real.
  | { type: "stream/error"; taskId: string; message: string; usage?: { inputTokens: number; outputTokens: number } }
  // Aviso NÃO-fatal ancorado à resposta (ex.: truncamento por limite de tokens). Fica visível no
  // balão do assistente — diferente do `notice`, que é um toast efêmero (some em segundos).
  | { type: "stream/notice"; taskId: string; level: "warn" | "info"; message: string }
  | { type: "context/attachments"; items: { id: string; label: string; bytes: number; kind: "workspace" | "upload" | "selection" | "search" }[] }
  | { type: "validation/result"; proposalId: string; results: ValidatorResult[]; gateOk: boolean; running: boolean }
  | { type: "proposal/applied"; proposalId: string }
  | { type: "proposal/discarded"; proposalId: string }
  | { type: "review/done" }
  // Ciclo de vida da execução de arquivo: start (botão trava, cartão ao vivo) → output (streaming) →
  // result (final). `where` indica onde a execução acontece: terminal central ou painel lateral.
  | { type: "run/start"; runId: string; proposalId?: string; filePath: string; label?: string; command: string; where: "terminal" | "panel" }
  | { type: "run/output"; runId: string; delta: string }
  | {
      type: "run/result";
      runId?: string;
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
  | { type: "profile/state"; profile: ProfileView }
  | { type: "charter/state"; sections: CharterSections }
  | { type: "charter/drafting"; section: CharterKey }
  // warning: aviso não-fatal ancorado NA SEÇÃO dentro do modal (um toast ficaria atrás do backdrop).
  | { type: "charter/drafted"; section: CharterKey; text: string; warning?: string }
  | { type: "charter/error"; section: CharterKey; message: string }
  | { type: "skills/inspect"; skills: SkillInspectView[] }
  | { type: "skills/body"; name: string; body: string }
  | { type: "rag/inspect"; index: RagInspectView }
  | { type: "rag/file"; relPath: string; chunks: RagChunkView[] }
  // Etapa do PLANEJAMENTO (antes do blueprint chegar): narra o progresso ("analisando requisitos" →
  // "montando a árvore" → "ordenando por dependência") em vez de um spinner estático.
  | { type: "project/planStep"; label: string }
  // warning: aviso não-fatal exibido DENTRO do modal do plano (ex.: plano parcial após truncamento).
  | { type: "project/blueprint"; blueprint: ProjectBlueprintView; warning?: string }
  | { type: "project/blueprintError"; message: string }
  | { type: "project/status"; files: BlueprintFileView[] }
  // Atualização PONTUAL do status de UM arquivo (progresso um-a-um durante a geração) — evita reenviar
  // o array inteiro a cada arquivo que fecha.
  | { type: "project/fileStatus"; path: string; status: ProjectFileStatus }
  | { type: "project/done" }
  // Todos os arquivos do projeto foram APLICADOS (após "Aplicar tudo"). O webview desmarca o Modo
  // Projeto automaticamente — fim de fluxo: a próxima mensagem volta a ser chat/diagnóstico normal.
  | { type: "project/appliedAll" }
  // Fecha o modal do projeto SEM erro (ex.: o texto era pergunta/diagnóstico e foi redirecionado ao
  // chat pela defesa em profundidade do host). Diferente de blueprintError, que mostra toast de erro.
  | { type: "project/closed" }
  // Resposta do /contexto: orçamento da janela calculado pelo HOST (mesmo deriveBudget da geração).
  | { type: "context/report"; report: ContextReport }
  // Cartão pós-seleção do PAPEL: o que o papel carrega (linha de estilo + skills relacionadas) —
  // substitui o toast de 5s que sumia antes de o dev ler.
  | { type: "profile/roleCard"; card: RoleCard };

export interface RoleCard {
  role: string; // slug canônico
  label: string; // rótulo legível
  guidance: string; // a linha de estilo que passa a entrar em todo prompt
  skills: { name: string; enabled: boolean; installed: boolean }[]; // relacionadas ao papel
}

// Relatório do /contexto — números em TOKENS (estimativas heurísticas onde indicado).
export interface ContextReport {
  modelId: string;
  contextWindow: number; // janela reconciliada (catálogo × forge.provider.maxContextWindow)
  outputReserve: number;
  inputBudget: number;
  pinnedTokens: number; // prompt base (modo CHAT) + perfil (estimado; TDD/Projeto são um pouco maiores)
  historyTokens: number; // estimado
  historyTurns: number;
  attachments: number; // anexos pendentes (consumidos no próximo envio)
  attachmentTokens: number; // estimado — anexos entram INTEIROS no próximo envio (até 8 × 16k chars)
  ragChunks: number; // chunks indexados disponíveis para recuperação
  sessionInputTokens: number; // usage REAL acumulado da sessão
  sessionOutputTokens: number;
}

// ---- Webview → Host da extensão ------------------------------------------------

export type WebviewToExt =
  | { type: "ready" }
  | { type: "license/submit"; key: string }
  | { type: "identity/setEmail"; email: string }
  | { type: "provider/setup"; setup: ProviderSetup }
  | { type: "provider/test"; setup: ProviderSetup }
  | { type: "provider/setEffort"; effort: ReasoningEffort }
  | { type: "provider/openSettings" }
  | { type: "embeddings/test" }
  | { type: "chat/send"; text: string; tdd?: boolean }
  // /limpar: zera o histórico e os anexos DO HOST (o "Nova conversa" da webview limpa só a UI).
  | { type: "chat/clear" }
  // /contexto: pede o relatório do orçamento da janela (o host responde com context/report).
  | { type: "context/inspect" }
  | { type: "project/start"; text: string; language: ProjectLanguage; architecture: ProjectArchitecture }
  | { type: "project/blueprint"; text: string; language: ProjectLanguage; architecture: ProjectArchitecture }
  | { type: "project/generate" }
  | { type: "project/cancel" }
  | { type: "proposal/applyAll" }
  | { type: "tests/run" }
  | { type: "env/prepare" }
  | { type: "chat/abort"; taskId: string }
  | { type: "proposal/apply"; proposalId: string }
  | { type: "proposal/discard"; proposalId: string }
  | { type: "proposal/viewDiff"; proposalId: string }
  | { type: "proposal/copy"; proposalId: string }
  | { type: "profile/addRule"; rule: string }
  | { type: "profile/open" }
  | { type: "profile/pickRole" }
  | { type: "profile/refresh" }
  | { type: "charter/open" }
  | { type: "charter/draft"; section: CharterKey; brief: string }
  | { type: "charter/save"; sections: CharterSections }
  | { type: "charter/genTests"; fr: string; nfr: string }
  | { type: "inspect/open" }
  | { type: "skills/body"; name: string }
  | { type: "rag/file"; relPath: string }
  | { type: "run/file"; filePath: string; proposalId?: string }
  | { type: "preview/open"; filePath: string; proposalId?: string }
  | { type: "proposal/applyAndRun"; proposalId: string }
  | { type: "proposal/applyAndPreview"; proposalId: string }
  | { type: "run/cancel"; runId: string }
  | { type: "run/focusTerminal"; runId: string }
  | { type: "cell/run"; proposalId: string }
  | { type: "review/changes" }
  | { type: "context/pickWorkspaceFile" }
  | { type: "context/pickLocalFile" }
  | { type: "context/addSelection" }
  | { type: "context/addTerminalSelection" }
  // Print colado no chat: o host roda OCR (tesseract do sistema) e anexa o TEXTO extraído.
  | { type: "context/addImage"; dataUrl: string }
  | { type: "context/removeAttachment"; id: string }
  | { type: "context/search" }
  | { type: "context/webInfo" }
  | { type: "skill/toggle"; name: string; enabled: boolean }
  | { type: "mcp/approvalResponse"; requestId: string; approved: boolean }
  | { type: "signOut" }
  | { type: "reindexSkills" };
