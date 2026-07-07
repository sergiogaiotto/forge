import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createProvider } from "../api/ProviderFactory";
import { DEFAULT_TIMEOUT_SECONDS, PROVIDER_PRESETS } from "../api/presets";
import { ProviderRuntimeConfig } from "../api/types";
import { ChatMessage } from "../api/types";
import { ManagedConfig } from "../config/ManagedConfig";
import { LicenseClient } from "../license/LicenseClient";
import { LicenseVerifier } from "../license/LicenseVerifier";
import { SessionToken } from "../license/types";
import { McpAuditor } from "../mcp/McpAuditor";
import { McpManager } from "../mcp/McpManager";
import { McpRegistry } from "../mcp/McpRegistry";
import { ToolApprovalGate } from "../mcp/ToolApprovalGate";
import { CodebaseIndex } from "../rag/CodebaseIndex";
import { EgressEnforcer } from "../net/EgressEnforcer";
import { SecretsStore } from "../secrets/SecretsStore";
import { ContextAssembler } from "../skills/ContextAssembler";
import { SkillLoader, SkillRoot } from "../skills/SkillLoader";
import { DEFAULT_SELECTOR_CONFIG, SkillSelector } from "../skills/SkillSelector";
import { gatePassed, SkillValidator } from "../skills/SkillValidator";
import { clampOutputToServed, getModelMeta, resolveMaxOutput } from "../api/modelCatalog";
import { mapImportsToPackages, mergeRequirements, parsePinnedRequirements, reconcileRequirements, renderRequirements, scanPythonImports } from "../util/pythonDeps";
import { buildBanditInstall, buildMypyInstall, buildPytestInstall, buildPytestProbe, buildVenvSetupCommand, chooseTestCommand, findVenvPython, isPytestCommand, resolveTestCommand } from "../util/pythonEnv";
import { redactSecrets } from "../util/redact";
import { ObsEvent } from "../obs/types";
import { estimateTokens, estimateTokensOf } from "../util/tokenEstimate";
import { deriveBudget } from "./ContextBudget";
import { PreviewService } from "./PreviewService";
import { SkillMeta, SkillValidatorSpec } from "../skills/types";
import {
  BlueprintFile,
  BlueprintFileView,
  CharterKey,
  CHARTER_KEYS,
  CharterSections,
  DEFAULT_REASONING_EFFORT,
  MAX_OUTPUT_PRESETS,
  maxOutputLabel,
  ProjectBlueprintView,
  ProjectFileStatus,
  effectiveTimeoutSeconds,
  ExtToWebview,
  ForgeState,
  LicenseView,
  ProjectArchitecture,
  ProjectLanguage,
  ProjectFramework,
  ProjectUI,
  ProviderSetup,
  ProviderView,
  ReasoningEffort,
  SkillView,
  supportsReasoningEffort,
  supportsTemperature,
  WebviewToExt,
} from "../shared/protocol";
import { EmailIdentity, isEmail, osLogin, resolveEmailIdentity } from "../util/identity";
import { log } from "../util/logger";
import { exec, execFile } from "node:child_process";
import { buildAcceptanceTestsRequest, buildBasePrompt, buildBlueprintRetryRequest, buildBlueprintSystemPrompt, buildCharterContinuationPrompt, buildCharterSystemPrompt, buildProjectFromBlueprintPrompt, buildProjectPrompt, buildProjectRepairPrompt, buildReviewPrompt, buildSummarizeSystemPrompt, buildTddPrompt, ProjectPromptContext } from "./systemPrompt";
import { GateCheckResult, mypyUnavailable, normGatePath, parseCompileallErrors, parseMypyErrors, ProjectGateSummary, summarizeGate, syntheticInitDirs } from "./projectGate";
import { normRepairPath, selectRepairTargets } from "./projectRepair";
import { parseFileBlocks } from "../util/fileBlocks";
import { buildFewShotTurn } from "../util/fewShot";
import { runFileCheck } from "../util/execCheck";
import { summarizeSmoke } from "../util/smoke";
import { findLayerViolations, LAYER_RULE } from "../util/layerCheck";
import { evaluateDodGate } from "../util/dodCheck";
import { parseBanditReport, SecurityMode, splitSecurityFindings } from "../util/banditParse";
import { pickBlueprintFromChannels, topoSort } from "../util/blueprint";
import { extractFinalChannel, stitchHarmonyParts, stripHarmony } from "../util/harmony";
import { charterProbablyCut } from "../util/charterCut";
import { classifyProjectIntent } from "../util/projectIntent";
import { parseImageDataUrl, parseTesseractLangs, pickOcrLangs, resolveTesseractCmd, tesseractCandidates } from "../util/ocr";
import { safeWorkspacePath } from "../util/safePath";
import { appendRule, CHARTER_SECTIONS, collectRules, defaultProfileSkeleton, getSection, PROFILE_RELPATH, PURPOSE_SECTION, renderProfileBlock, setSection } from "../util/projectProfile";
import { DetectedStack, detectStack, renderStackBlock, STACK_PROBE_FILES } from "../util/stackDetect";
import { validatorsFromStack } from "../skills/stackValidators";
import { Role, resolveRole, roleGuidance, roleGuidanceLine, roleLabel, roleSkills, setRole, stripFrontmatter } from "../util/roleDefaults";
import { Observability } from "../obs/Observability";
import { LangfuseDirectSink } from "../obs/LangfuseDirectSink";
import { LocalDiagnosticsLog } from "../obs/LocalDiagnosticsLog";
import { renderDiagnosticsBundle } from "../obs/diagnostics";
import { Runner } from "./Runner";
import { RunService } from "./RunService";
import { Task } from "./Task";

const GS_PROVIDER = "forge.provider";
// Reserva de entrada ao clampar o teto de saída contra a janela servida — margem para o prompt caber
// junto com a saída (best-effort; o fail-soft de 400 do provider cobre o residual).
const OUTPUT_INPUT_RESERVE = 4096;
const GS_LICENSE_META = "forge.license.meta";
const GS_IDENTITY_EMAIL = "forge.identity.email";
const WS_DISABLED_SKILLS = "forge.skills.disabled";

interface ProviderPersisted {
  type: ProviderRuntimeConfig["type"];
  modelId: string;
  baseUrl?: string;
  authHeader?: string;
  timeoutSeconds: number;
  label?: string;
  reasoningEffort?: ReasoningEffort;
  maxOutput?: number; // teto de saída escolhido por sessão (seletor/paleta); 0/ausente = auto/catálogo
}

export class Controller {
  private readonly config = new ManagedConfig();
  private readonly secrets: SecretsStore;
  private readonly egress: EgressEnforcer;
  private readonly verifier = new LicenseVerifier();
  private readonly licenseClient: LicenseClient;
  private readonly loader = new SkillLoader();
  private readonly assembler = new ContextAssembler();
  private readonly registry: McpRegistry;
  private readonly auditor = new McpAuditor();
  private readonly approvalGate: ToolApprovalGate;
  private readonly mcp: McpManager;
  private readonly rag: CodebaseIndex;
  private readonly obs: Observability;

  private readonly sessionId = crypto.randomUUID(); // id de sessão p/ correlação no Langfuse
  private readonly diag: LocalDiagnosticsLog; // log de diagnóstico LOCAL (P3) — sempre-ligado, redigido
  private skills: SkillMeta[] = [];
  private sessionToken: SessionToken | undefined;
  // Fase F: sessão do Modo Projeto — o blueprint aprovado e o status por arquivo (orquestração).
  private projectSession: { language: ProjectLanguage; architecture: ProjectArchitecture; ui?: ProjectUI; framework?: ProjectFramework; brief: string; files: BlueprintFileView[] } | null = null;
  private licenseKey: string | undefined;
  private history: ChatMessage[] = [];
  private pendingAttachments: { id: string; label: string; kind: "workspace" | "upload" | "selection" | "search"; content: string }[] = [];
  private attachmentSeq = 0;
  private currentTask: Task | undefined;
  // Usage REAL acumulado da sessão (todas as gerações, incl. continuações) — /contexto e /tokens.
  private sessionUsage = { input: 0, output: 0 };
  private readonly runService: RunService;
  private readonly previewService: PreviewService;
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();

  private poster: ((msg: ExtToWebview) => void) | undefined;
  // Pedido pendente de abrir um modal do webview (Índice/Perfil) via comando de paleta — vai no estado
  // (ForgeState.uiPanel) com seq monotônico; limpo quando o webview confirma (`ui/panelConsumed`).
  private uiPanel: { panel: "inspect" | "profile"; seq: number } | undefined;
  private uiPanelSeq = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.secrets = new SecretsStore(context.secrets);
    this.egress = new EgressEnforcer(this.config.egressPolicy(), (m) => log.warn(m));
    this.licenseClient = new LicenseClient(this.verifier, this.egress, () => ({
      mode: this.config.licenseMode(),
      gatewayUrl: this.config.gatewayUrl(),
    }));
    this.registry = new McpRegistry(this.egress);
    this.approvalGate = new ToolApprovalGate((req) =>
      new Promise<boolean>((resolve) => {
        this.pendingApprovals.set(req.requestId, resolve);
        this.post({ type: "mcp/approvalRequest", ...req });
      })
    );
    this.mcp = new McpManager(this.registry, this.egress, this.approvalGate, this.auditor, this.secrets);
    this.rag = new CodebaseIndex(this.egress, () => this.config.rag(), () => this.workspaceRoot());
    this.rag.setOnChange(() => void this.postState()); // atualiza o indicador de RAG ao vivo
    // Diagnóstico LOCAL (P3): log estruturado sempre-ligado em globalStorage/logs, redigido, independente
    // do opt-in do Langfuse. Recebe o MESMO ObsEvent via o tee em Observability (antes do gate de egress).
    this.diag = new LocalDiagnosticsLog(
      path.join(this.context.globalStorageUri.fsPath, "logs"),
      () => this.sessionId,
      { enabled: () => this.config.diagnostics().enabled, now: () => new Date().toISOString() }
    );
    this.obs = new Observability(
      () => this.config.observability(),
      new LangfuseDirectSink(() => this.config.observability(), () => this.secrets.get(SecretsStore.KEY_LANGFUSE_SECRET), this.egress),
      { onError: (m) => log.warn(m) },
      this.diag
    );
    this.previewService = new PreviewService({
      workspaceRoot: () => this.workspaceRoot(),
      post: (msg) => this.post(msg),
    });
    context.subscriptions.push(this.previewService);
    this.runService = new RunService({
      post: (msg) => this.post(msg),
      workspaceRoot: () => this.workspaceRoot(),
      runConfig: () => this.config.run(),
      onResult: (r) => this.obs.record({ type: "run.result", filePath: r.filePath, label: r.label, ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs }),
      openPreview: (relPath) => void this.previewService.openPreview(relPath),
      // O "Executar" de .py usa o python do venv do projeto (mesmo ambiente do Preparar/Testes).
      venvPython: () => {
        const ws = this.workspaceRoot();
        return ws ? findVenvPython(ws, process.platform === "win32", existsSync, process.env.VIRTUAL_ENV) : undefined;
      },
    });
    context.subscriptions.push(this.runService);

    context.subscriptions.push(
      this.config.onChange(() => {
        this.egress.update(this.config.egressPolicy());
        this.registry.load(this.config.mcpCatalog());
        void this.postState();
      })
    );
  }

  async initialize(): Promise<void> {
    this.registry.load(this.config.mcpCatalog());
    void this.sweepValidatorTemp(); // remove órfãos .forge/val-* de um host morto antes do finally
    void this.diag.prune(7 * 24 * 60 * 60 * 1000); // higiene: descarta logs de diagnóstico com +7 dias
    await this.reindexSkills();
    await this.restoreSession();
    this.setupWatchers();
    // Drena os eventos de observabilidade em lote; flush final ao desativar.
    const obsTimer = setInterval(() => void this.obs.flush(), 4000);
    this.context.subscriptions.push({ dispose: () => { clearInterval(obsTimer); void this.obs.flush(); } });
    // Indexação do codebase em background — não bloqueia a ativação.
    void this.rag.build();
    log.info(`FORGE inicializado. Licença ${this.sessionToken ? "ativa" : "ausente"}; ${this.skills.length} skills.`);
  }

  /** Reindexação incremental do RAG ao salvar/criar/excluir arquivos (RF-041). */
  private setupWatchers(): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.context.subscriptions.push(
      watcher,
      watcher.onDidChange((uri) => void this.rag.updateFile(uri)),
      watcher.onDidCreate((uri) => void this.rag.updateFile(uri)),
      watcher.onDidDelete((uri) => void this.rag.removeFile(uri))
    );
  }

  async reindexCodebase(): Promise<void> {
    await this.rag.build();
    const s = this.rag.status();
    void vscode.window.showInformationMessage(
      `FORGE RAG: ${s.files} arquivos, ${s.chunks} trechos (modo ${s.mode}).`
    );
  }

  setPoster(post: (msg: ExtToWebview) => void): void {
    this.poster = post;
  }

  private post(msg: ExtToWebview): void {
    this.poster?.(msg);
  }

  // ---- ciclo de vida da sessão -----------------------------------------------

  private async restoreSession(): Promise<void> {
    this.licenseKey = await this.secrets.get(SecretsStore.KEY_LICENSE);
    const raw = await this.secrets.get(SecretsStore.KEY_SESSION_TOKEN);
    if (!raw) return;
    let token: SessionToken;
    try {
      token = JSON.parse(raw) as SessionToken;
    } catch {
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (token.expiresAt > now) {
      this.sessionToken = token;
      return;
    }
    // Expirado — tenta renovar (RF-015).
    if (this.licenseKey) {
      const renewed = await this.licenseClient.renew(token, this.licenseKey);
      if (renewed) {
        this.sessionToken = renewed;
        await this.secrets.set(SecretsStore.KEY_SESSION_TOKEN, JSON.stringify(renewed));
      }
    }
  }

  /** RF-015: garante uma sessão válida antes de qualquer inferência. */
  private async ensureSession(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    if (this.sessionToken && this.sessionToken.expiresAt > now + 30) return true;
    if (this.sessionToken && this.licenseKey) {
      const renewed = await this.licenseClient.renew(this.sessionToken, this.licenseKey);
      if (renewed) {
        this.sessionToken = renewed;
        await this.secrets.set(SecretsStore.KEY_SESSION_TOKEN, JSON.stringify(renewed));
        return true;
      }
    }
    this.sessionToken = undefined;
    await this.postState();
    return false;
  }

  // ---- skills ----------------------------------------------------------------

  async reindexSkills(): Promise<void> {
    const roots = this.skillRoots();
    const discovered = await this.loader.discover(roots);
    const disabled = new Set(this.context.workspaceState.get<string[]>(WS_DISABLED_SKILLS, []));
    this.skills = discovered.map((s) => ({ ...s, enabled: !disabled.has(s.name) }));
  }

  private skillRoots(): SkillRoot[] {
    const roots: SkillRoot[] = [];
    const managed = this.config.managedSkillsDir();
    roots.push({ path: managed || path.join(this.context.extensionPath, "skills"), source: "managed" });
    roots.push({ path: path.join(os.homedir(), ".forge", "skills"), source: "user" });
    const ws = this.workspaceRoot();
    if (ws) {
      roots.push({ path: path.join(ws, ".forge", "skills"), source: "workspace" });
      roots.push({ path: path.join(ws, ".claude", "skills"), source: "workspace" }); // RF-038
    }
    return roots;
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  // Remove diretórios de validação órfãos (.forge/val-*) deixados por um host encerrado antes do
  // finally do SkillValidator — restaura o auto-limpeza que o os.tmpdir dava de graça. Best-effort.
  private async sweepValidatorTemp(): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) return;
    const dir = path.join(ws, ".forge");
    try {
      const entries = await fs.readdir(dir);
      await Promise.all(
        entries
          .filter((e) => e.startsWith("val-"))
          .map((e) => fs.rm(path.join(dir, e), { recursive: true, force: true }).catch(() => undefined))
      );
    } catch {
      /* .forge ausente — nada a limpar */
    }
  }

  // ---- perfil do projeto (.forge/project.md) ---------------------------------

  // Lê os perfis na ordem de precedência usuário → workspace (workspace tem a palavra final), como
  // documentos SEPARABLES — para que papel e frontmatter sejam resolvidos por documento, não no blob
  // mesclado. Tolerante a ausência. O admin pode semear padrões via managedSkillsDir (onda futura).
  private async loadProfileSources(): Promise<string[]> {
    // Ordem = precedência crescente: admin (padrões da organização) → usuário → workspace.
    // O último a declarar um papel vence; os corpos são concatenados nessa ordem.
    const candidates: string[] = [];
    const admin = this.config.managedProfile();
    if (admin) candidates.push(admin);
    candidates.push(path.join(os.homedir(), PROFILE_RELPATH));
    const ws = this.workspaceRoot();
    if (ws) candidates.push(path.join(ws, PROFILE_RELPATH));
    const out: string[] = [];
    for (const p of candidates) {
      try {
        const t = (await fs.readFile(p, "utf8")).trim();
        if (t) out.push(t);
      } catch {
        /* arquivo ausente — ok */
      }
    }
    return out;
  }

  // Lê os arquivos-âncora da raiz e devolve a stack detectada (linguagem, gerenciador, lint/tipos/
  // testes, libs). Vazia se não houver workspace. Dela derivamos tanto o bloco do prompt quanto os
  // validadores de convenções.
  private async detectWorkspaceStack(): Promise<DetectedStack> {
    const ws = this.workspaceRoot();
    if (!ws) return { lintFormat: [], types: [], libs: [] };
    const files: Record<string, string | undefined> = {};
    await Promise.all(
      STACK_PROBE_FILES.map(async (name) => {
        try {
          files[name] = await fs.readFile(path.join(ws, name), "utf8");
        } catch {
          files[name] = undefined;
        }
      })
    );
    return detectStack(files);
  }

  // Computa e envia ao painel a visão do perfil: stack detectada (ao vivo) + papel + regras.
  async postProfileState(): Promise<void> {
    const [stack, sources] = await Promise.all([this.detectWorkspaceStack(), this.loadProfileSources()]);
    const role = resolveRole(sources);
    const rules = collectRules(sources.map(stripFrontmatter));
    this.post({
      type: "profile/state",
      profile: {
        stack: {
          language: stack.language,
          packaging: stack.packaging,
          lintFormat: stack.lintFormat,
          types: stack.types,
          tests: stack.tests,
          libs: stack.libs,
        },
        role: role ? roleLabel(role) : undefined,
        rules,
      },
    });
  }

  async addProjectRule(rule: string): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) {
      this.post({ type: "notice", level: "warn", message: "Abra uma pasta no VSCode para salvar regras do projeto." });
      return;
    }
    const abs = path.join(ws, PROFILE_RELPATH);
    let existing = "";
    try {
      existing = await fs.readFile(abs, "utf8");
    } catch {
      /* primeiro uso */
    }
    const updated = appendRule(existing, rule);
    if (updated === existing) {
      this.post({ type: "notice", level: "info", message: "Essa regra já está no perfil do projeto." });
      return;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, updated, "utf8");
    this.post({ type: "notice", level: "info", message: `Regra adicionada ao perfil do projeto (${PROFILE_RELPATH}).` });
    this.obs.record({ type: "profile.ruleAdded" });
    void this.postProfileState();
  }

  async openProjectProfile(): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) {
      this.post({ type: "notice", level: "warn", message: "Abra uma pasta no VSCode para ter um perfil do projeto." });
      return;
    }
    const abs = path.join(ws, PROFILE_RELPATH);
    try {
      await fs.access(abs);
    } catch {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, defaultProfileSkeleton(), "utf8");
    }
    await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false });
  }

  // Seletor nativo de papel: grava o `papel:` no frontmatter do .forge/project.md, que passa a
  // ajustar o estilo/defaults injetados no prompt.
  async pickProjectRole(): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) {
      this.post({ type: "notice", level: "warn", message: "Abra uma pasta no VSCode para definir o papel do projeto." });
      return;
    }
    const items: { label: string; role: Role }[] = [
      { label: "Cientista de dados", role: "cientista-de-dados" },
      { label: "Engenheiro de dados", role: "engenheiro-de-dados" },
      { label: "Engenheiro de ML", role: "engenheiro-de-ml" },
      { label: "Engenheiro de IA", role: "engenheiro-de-ia" },
      { label: "Engenheiro de software", role: "engenheiro-de-software" },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Seu papel no projeto — ajusta o estilo e os defaults do FORGE",
    });
    if (!pick) return;
    const abs = path.join(ws, PROFILE_RELPATH);
    let existing = "";
    try {
      existing = await fs.readFile(abs, "utf8");
    } catch {
      existing = defaultProfileSkeleton();
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, setRole(existing, pick.role), "utf8");
    // Cartão ancorado no chat (em vez do toast de 5s): mostra a linha de estilo que passa a entrar
    // em todo prompt e as skills managed relacionadas ao papel — transparência do que mudou.
    const related = roleSkills(pick.role).map((name) => {
      const s = this.skills.find((k) => k.name === name);
      return { name, enabled: s?.enabled ?? false, installed: !!s };
    });
    this.post({ type: "profile/roleCard", card: { role: pick.role, label: pick.label, guidance: roleGuidanceLine(pick.role), skills: related } });
    this.obs.record({ type: "profile.roleSet", role: pick.role });
    void this.postProfileState();
  }

  // ---- Charter Wizard (Propósito/Regras/RF/RNF assistidos pelo modelo) --------

  // Lê o .forge/project.md atual (ou "" se não existir). Normaliza CRLF→LF para o valor das seções
  // não vazar `\r` interior ao textarea/arquivo (higiene de EOL; o parsing já é robusto a CRLF).
  private async readCharterDoc(): Promise<string> {
    const ws = this.workspaceRoot();
    if (!ws) return "";
    try {
      return (await fs.readFile(path.join(ws, PROFILE_RELPATH), "utf8")).replace(/\r\n/g, "\n");
    } catch {
      return "";
    }
  }

  private charterSectionsFrom(doc: string): CharterSections {
    return Object.fromEntries(CHARTER_SECTIONS.map((s) => [s.key, getSection(doc, s.header)])) as CharterSections;
  }

  // Contexto do WORKSPACE injetado nos prompts do Modo Projeto (blueprint + geração): o PROPÓSITO do
  // charter (.forge/project.md) e as dependências fixadas do requirements.txt. Fecha os dois achados da
  // auditoria — charter ignorado (saía o exemplo Pedido/Pagamento) e libs/versões alucinadas.
  private async projectPromptContext(): Promise<ProjectPromptContext> {
    const ws = this.workspaceRoot();
    const [doc, reqs] = await Promise.all([
      this.readCharterDoc(),
      ws ? fs.readFile(path.join(ws, "requirements.txt"), "utf8").catch(() => "") : Promise.resolve(""),
    ]);
    return { purpose: getSection(doc, PURPOSE_SECTION), pinnedDeps: parsePinnedRequirements(reqs) };
  }

  // Abre o wizard: manda ao webview o conteúdo atual de cada seção do charter.
  async openCharter(): Promise<void> {
    this.post({ type: "charter/state", sections: this.charterSectionsFrom(await this.readCharterDoc()) });
  }

  // Pede ao modelo para REDIGIR uma seção a partir do rascunho do dev + contexto (stack + outras seções).
  // Geração ONE-SHOT (texto puro, sem blocos de arquivo); registra trace como as demais gerações.
  // `live`: as 4 seções COMO ESTÃO no wizard (inclui texto digitado e não salvo) — sem isso o contexto
  // viria só do .forge/project.md em disco e um Propósito recém-digitado não ancoraria as demais seções.
  async draftCharterSection(section: CharterKey, brief: string, live?: CharterSections): Promise<void> {
    if (!CHARTER_KEYS.includes(section)) return;
    if (!(await this.ensureSession())) {
      this.post({ type: "charter/error", section, message: "Licença requerida para redigir com o modelo." });
      return;
    }
    const runtime = await this.runtimeProviderConfig();
    if (!runtime) {
      this.post({ type: "charter/error", section, message: "Configure um provedor antes de redigir (Configurar provedor)." });
      return;
    }
    // Valida o egress ANTES de abrir o trace (não registra uma geração que nunca sairá para a rede).
    try {
      this.egress.assertAllowed(runtime.baseUrl ?? (runtime.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"));
    } catch (e) {
      this.post({ type: "charter/error", section, message: (e as Error)?.message ?? String(e) });
      return;
    }
    this.post({ type: "charter/drafting", section });

    const [stack, doc] = await Promise.all([this.detectWorkspaceStack(), this.readCharterDoc()]);
    // Contexto = seções do WIZARD quando enviadas (valor por chave, mesmo vazio: o dev pode ter limpado
    // um campo de propósito), com fallback no disco por chave (mensagem antiga/sem o campo).
    const disk = this.charterSectionsFrom(doc);
    const current = Object.fromEntries(CHARTER_KEYS.map((k) => [k, live?.[k] ?? disk[k] ?? ""])) as CharterSections;
    // Tetos defensivos como no resto do FORGE: o brief (textarea, pode ter texto colado) e cada bloco
    // de contexto são limitados para não estourar a janela/custo do modelo.
    const others = CHARTER_SECTIONS.filter((s) => s.key !== section)
      .map((s) => {
        const body = current[s.key];
        return body.trim() ? renderProfileBlock(`${s.header}\n${body}`, 1500) : "";
      })
      .filter((s) => s.trim());
    const label = CHARTER_SECTIONS.find((s) => s.key === section)?.label ?? section;
    const cappedBrief = brief.trim().slice(0, 4000);
    // Campo vazio com Propósito preenchido → a instrução aponta o Propósito como ESCOPO da redação
    // (Regras/RF/RNF de "um sistema qualquer" não servem; o system prompt reforça a mesma âncora).
    const hasPurposeAnchor = section !== "purpose" && current.purpose.trim();
    const userMsg = [
      "Contexto do projeto:",
      [renderProfileBlock(renderStackBlock(stack), 1500), ...others].filter((s) => s.trim()).join("\n\n") || "(sem contexto adicional detectado)",
      "",
      `Rascunho/instrução do dev para a seção "${label}":`,
      cappedBrief ||
        (hasPurposeAnchor
          ? `(vazio — derive a seção do PROPÓSITO do projeto acima: ele define o escopo; redija "${label}" cumprindo o objetivo desta seção dentro desse escopo)`
          : "(vazio — proponha do zero, coerente com o contexto acima)"),
    ].join("\n");

    const taskId = `charter_${section}_${this.sessionId}`;
    const started = Date.now();
    this.obs.record({
      type: "generation.start",
      taskId,
      mode: "charter",
      model: runtime.modelId,
      provider: runtime.type,
      skills: [],
      sessionId: this.sessionId,
      userId: this.resolveIdentity().email ?? "",
    });
    let text = "";
    let delivered = ""; // o texto EFETIVAMENTE entregue ao wizard (pode vir do resgate do raciocínio)
    let error: string | undefined;
    let continuationRounds = 0; // emendas automáticas disparadas (p/ aviso honesto e trace)
    const parts: string[] = []; // content de cada rodada — costurado por stitchHarmonyParts no fim
    const usage = { inputTokens: 0, outputTokens: 0 }; // usage REAL da geração (chunks do provider)
    try {
      const sr = this.structuredRuntime(runtime); // esforço "low" + temperature 0 (formato estrito)
      const provider = createProvider(sr, this.egress);
      const headers = this.buildTraceHeaders([], sr.modelId, sr.type, sr.reasoningEffort, "charter");
      let truncated = false;
      let reasoning = "";
      // Corte por limite de tokens (finish_reason=length) COM conteúdo parcial → o FORGE continua
      // SOZINHO: reenvia a conversa com o parcial como turno do assistente + "siga do ponto exato",
      // até 2 rodadas. Só se AINDA assim cortar é que o aviso ancorado na seção aparece (o dev não
      // deveria ter que clicar "Redigir" de novo por um corte que o host sabe detectar e emendar).
      const MAX_CONTINUATION_ROUNDS = 2;
      const messages: ChatMessage[] = [{ role: "user", content: userMsg }];
      for (let round = 0; ; round++) {
        let roundText = "";
        let roundTruncated = false;
        for await (const chunk of provider.createMessage(buildCharterSystemPrompt(section), messages, {
          timeoutMs: runtime.timeoutSeconds * 1000,
          extraHeaders: headers,
          // NÃO-streaming: o gpt-oss/HubGPU isola o raciocínio em reasoning_content (não vaza o canal
          // harmony no content, como no streaming) e o finish_reason vem confiável — a base do truncated.
          streaming: false,
        })) {
          if (chunk.kind === "text") roundText += chunk.text;
          else if (chunk.kind === "reasoning") reasoning += chunk.text; // p/ resgate se o content vier vazio
          else if (chunk.kind === "usage") {
            usage.inputTokens += chunk.inputTokens;
            usage.outputTokens += chunk.outputTokens;
          } else if (chunk.kind === "warning") roundTruncated = true; // finish_reason=length: seção cortada
          else if (chunk.kind === "error") {
            error = chunk.message;
            break;
          }
        }
        if (roundText) parts.push(roundText);
        text += roundText;
        // Sinal de corte desta rodada. PRIMÁRIO: finish_reason=length (roundTruncated). REFORÇO: o
        // HubGPU às vezes corta reportando "stop" em vez de "length" (corte sem sinal, reproduzido ao
        // vivo) — aí a heurística estrutural CONSERVADORA (charterProbablyCut) sobre o texto acumulado
        // pega o corte. Só consultada quando NÃO houve o sinal de length E houve conteúdo novo; listas
        // de RF/RNF bem-formadas não disparam (só hífen pendurado ou palavra de ligação no fim).
        const cutByShape = !roundTruncated && roundText.trim() !== "" && charterProbablyCut(stitchHarmonyParts(parts));
        // Rodada SEM conteúdo novo não dá baixa no truncamento anterior: o gateway pode rotear a
        // continuação inteira para reasoning_content e fechar com finish=stop — a seção segue
        // cortada e o aviso PRECISA sair (entregar corte silencioso é a falha proibida abaixo).
        if (roundText.trim() || roundTruncated) truncated = roundTruncated || cutByShape;
        // Continua SÓ com corte confirmado E conteúdo novo nesta rodada — sem conteúdo novo, repetir
        // daria o mesmo resultado (ex.: o raciocínio devorou o max_tokens inteiro e nada saiu).
        if (error || !truncated || !roundText.trim() || round >= MAX_CONTINUATION_ROUNDS) break;
        continuationRounds++;
        log.info("charter: seção cortada no limite de tokens — continuando de onde parou", { section, round: round + 1 });
        messages.push({ role: "assistant", content: roundText }, { role: "user", content: buildCharterContinuationPrompt(label) });
      }
      // Erro SEM continuação em curso → erro seco, como antes (charter/error preserva o rascunho do
      // dev; um parcial curto de rodada única pode ser pior que o rascunho que ele apagaria). Erro
      // NUMA RODADA DE CONTINUAÇÃO (timeout/429 na emenda) com parcial em mãos → entrega o parcial
      // com aviso: antes do loop o mesmo truncamento entregava o parcial; a emenda não pode regredir
      // isso para um erro que descarta o texto já gerado.
      if (error && !(continuationRounds > 0 && parts.some((p) => p.trim()))) this.post({ type: "charter/error", section, message: error });
      else {
        // stitchHarmonyParts: costura as rodadas saneando o vazamento harmony POR RODADA (stripHarmony
        // no concatenado descartaria rodadas anteriores se cada uma vazasse seu próprio marcador).
        // Content vazio → resgate CONSERVADOR do canal de raciocínio: só se o marcador do canal final
        // existir lá (o gateway roteou a resposta inteira p/ reasoning_content); raciocínio bruto NUNCA.
        let clean = stitchHarmonyParts(parts);
        if (!clean.trim() && reasoning.trim()) {
          clean = extractFinalChannel(reasoning) ?? "";
          if (clean) log.info("charter: seção recuperada do canal de raciocínio (content vazio)");
        }
        if (!clean.trim()) {
          // Resposta VAZIA (típico: o raciocínio consumiu todo o max_tokens e nenhum texto saiu).
          // charter/error preserva o rascunho digitado — postar drafted:"" APAGARIA o texto do dev.
          log.warn("charter: sem conteúdo utilizável", {
            section,
            truncated,
            contentChars: text.length,
            reasoningChars: reasoning.length,
            reasoningHead: reasoning.slice(0, 300),
          });
          this.post({
            type: "charter/error",
            section,
            message:
              error ??
              (truncated
                ? "O modelo atingiu o limite de tokens antes de redigir a seção. Tente de novo; se persistir, aumente forge.provider.maxOutput."
                : "O modelo não retornou conteúdo para a seção. Tente de novo (detalhes no painel Output → FORGE)."),
          });
        } else {
          delivered = clean; // o trace obs reflete o que o dev recebeu (inclusive resgatado do raciocínio)
          // NUNCA salvar seção cortada silenciosamente (aconteceu num project.md real: frases terminando
          // no meio da palavra). O aviso vai ancorado NA SEÇÃO, dentro do modal — um toast ficaria
          // atrás do backdrop do wizard e sumiria em 5s sem ser visto. A redação do aviso é HONESTA:
          // só afirma que houve continuação automática quando ela de fato rodou.
          this.post({
            type: "charter/drafted",
            section,
            text: clean,
            warning: error
              ? `A redação foi interrompida por um erro antes de terminar (${error}) — o final pode estar faltando. Revise antes de salvar (ou redija de novo).`
              : truncated
                ? continuationRounds > 0
                  ? "A seção seguiu cortada mesmo após o FORGE continuar a redação automaticamente — o final pode estar faltando. Revise antes de salvar (ou redija de novo)."
                  : "A seção foi truncada no limite de tokens — o final pode estar faltando. Revise antes de salvar (ou redija de novo)."
                : undefined,
          });
        }
      }
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
      // Exceção lançada (ex.: 429/5xx do provider) NUMA RODADA DE CONTINUAÇÃO com parcial em mãos:
      // mesmo tratamento do erro em stream — entrega o parcial com aviso em vez de descartar.
      const partial = continuationRounds > 0 ? stitchHarmonyParts(parts) : "";
      if (partial.trim()) {
        delivered = partial;
        this.post({
          type: "charter/drafted",
          section,
          text: partial,
          warning: `A redação foi interrompida por um erro antes de terminar (${error}) — o final pode estar faltando. Revise antes de salvar (ou redija de novo).`,
        });
      } else {
        this.post({ type: "charter/error", section, message: error });
      }
    } finally {
      const end: ObsEvent = {
        type: "generation.end",
        taskId,
        durationMs: Date.now() - started,
        model: runtime.modelId,
        // O trace reflete as emendas: o usage soma TODAS as chamadas, então o input registra que
        // houve continuação (sem duplicar o prompt inteiro por rodada).
        input: continuationRounds > 0 ? `${userMsg}\n\n[FORGE: +${continuationRounds} continuação(ões) automática(s) após corte por limite de tokens]` : userMsg,
        output: delivered || text,
        usage,
        proposals: 0,
        error,
      };
      this.trackUsage(end); // charter também consome tokens — /contexto precisa contabilizar
      this.obs.record(end);
    }
  }

  // Grava as 4 seções no .forge/project.md (preserva frontmatter/papel e o resto do arquivo).
  async saveCharter(sections: CharterSections): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) {
      this.post({ type: "notice", level: "error", message: "Abra uma pasta no VSCode para salvar o charter." });
      return;
    }
    let doc = await this.readCharterDoc();
    for (const s of CHARTER_SECTIONS) doc = setSection(doc, s.header, sections[s.key] ?? "");
    const abs = path.join(ws, PROFILE_RELPATH);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, doc, "utf8");
    this.post({ type: "notice", level: "info", message: "Charter salvo em .forge/project.md (injetado em todo prompt)." });
    this.post({ type: "charter/state", sections: this.charterSectionsFrom(doc) });
    void this.postProfileState(); // as regras podem ter mudado
  }

  // Requisitos → Testes: gera testes de aceitação (modo TDD, propostas aplicáveis) a partir dos
  // Requisitos Funcionais/Não Funcionais do charter. Recebe os requisitos ATUAIS do wizard (mesmo não
  // salvos), evitando divergência com o project.md em disco. Reusa todo o pipeline de geração/proposta.
  async generateAcceptanceTests(fr: string, nfr: string): Promise<void> {
    if (!fr.trim() && !nfr.trim()) {
      this.post({
        type: "notice",
        level: "warn",
        message: "Preencha os Requisitos (funcionais/não funcionais) no Charter antes de gerar os testes de aceitação.",
      });
      return;
    }
    await this.startTask(buildAcceptanceTestsRequest(fr, nfr), "tdd");
  }

  // ---- Modo Projeto · Fase F (blueprint aprovável → orquestração → aplicar tudo) --------

  // Passo 1: gera o BLUEPRINT (plano de arquivos) sem código, para o dev aprovar. One-shot.
  async generateBlueprint(text: string, language: ProjectLanguage, architecture: ProjectArchitecture, ui?: ProjectUI, framework?: ProjectFramework): Promise<void> {
    if (!text.trim()) return;
    // Defesa em profundidade: se o texto é pergunta/diagnóstico (frontend antigo/divergente que ainda
    // mandou project/blueprint), não gaste inferência com o plano — feche o modal e responda no chat.
    if (classifyProjectIntent(text) === "chat") {
      this.post({ type: "project/closed" });
      await this.startTask(text, "normal");
      return;
    }
    if (!(await this.ensureSession())) {
      this.post({ type: "project/blueprintError", message: "Licença requerida para planejar o projeto." });
      return;
    }
    if (this.resolveIdentity().emailRequired) {
      this.post({ type: "project/blueprintError", message: "Informe seu e-mail na configuração inicial antes de planejar." });
      await this.postState();
      return;
    }
    const runtime = await this.runtimeProviderConfig();
    if (!runtime) {
      this.post({ type: "project/blueprintError", message: "Configure um provedor antes de planejar." });
      return;
    }
    try {
      this.egress.assertAllowed(runtime.baseUrl ?? (runtime.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"));
    } catch (e) {
      this.post({ type: "project/blueprintError", message: (e as Error)?.message ?? String(e) });
      return;
    }
    // Narração do planejamento (o modal mostra a etapa atual em vez de um spinner estático).
    this.post({ type: "project/planStep", label: "Analisando os requisitos e desenhando a arquitetura…" });
    const sr = this.structuredRuntime(runtime); // esforço "low" + temperature 0 (formato estrito)
    // Injeta o charter (propósito) + deps fixadas já no PLANO: o blueprint precisa refletir o domínio
    // real e as libs do workspace, não um exemplo canônico (achado da auditoria: charter ignorado).
    const system = buildBlueprintSystemPrompt(language, architecture, ui, framework, await this.projectPromptContext());
    const brief = text.slice(0, 6000);
    const taskId = `project_plan_${this.sessionId}_${Date.now()}`;
    const started = Date.now();
    this.obs.record({
      type: "generation.start",
      taskId,
      mode: "project",
      model: sr.modelId,
      provider: sr.type,
      skills: [],
      sessionId: this.sessionId,
      userId: this.resolveIdentity().email ?? "",
    });
    let obsOutput = "";
    let obsError: string | undefined;
    const obsUsage = { inputTokens: 0, outputTokens: 0 }; // somado entre as tentativas
    const addUsage = (u: { inputTokens: number; outputTokens: number }) => {
      obsUsage.inputTokens += u.inputTokens;
      obsUsage.outputTokens += u.outputTokens;
    };
    try {
      // Tentativa 1: pedido normal.
      const a1 = await this.streamBlueprintAttempt(sr, system, brief, "Raciocinando sobre a arquitetura…");
      obsOutput = a1.text || a1.reasoning;
      addUsage(a1.usage);
      if (a1.error) {
        obsError = a1.error;
        this.post({ type: "project/blueprintError", message: a1.error });
        return;
      }
      this.post({ type: "project/planStep", label: "Ordenando os arquivos por dependência…" });
      let picked = this.pickBlueprint(a1);
      // Plano PARCIAL reparado (corte sem sinal): NÃO curto-circuita — a conversão recebe o texto
      // original (cap bipartido preserva as pontas) e frequentemente recupera o plano COMPLETO,
      // inclusive o arquivo cortado cujo path está visível. O parcial vira FALLBACK garantido.
      let fallback: typeof picked | null = null;
      if (picked.files.length > 0 && picked.salvaged) {
        fallback = picked;
        picked = { ...picked, files: [] }; // força a escalada para a conversão
      }
      // Tentativa 2 (escalada): a 1ª não trouxe array parseável/completo em NENHUM canal. Se o modelo
      // chegou a responder, pedimos a CONVERSÃO da própria resposta (mecânica, quase sempre converge);
      // se veio vazio, repetimos com a exigência de formato reforçada.
      if (!picked.files.length) {
        log.warn("blueprint: 1ª tentativa sem plano completo — escalando para a conversão", {
          contentChars: a1.text.length,
          reasoningChars: a1.reasoning.length,
          truncated: a1.truncated,
          parcialReparado: fallback ? fallback.files.length : 0,
          contentHead: a1.text.slice(0, 300),
          reasoningHead: a1.reasoning.slice(0, 300),
        });
        this.post({ type: "project/planStep", label: "A resposta veio sem o plano completo — pedindo a conversão…" });
        // A 2ª tentativa AMOSTRA (temperatura default do servidor) em vez de repetir a greedy: com
        // temperature 0 as duas tentativas eram deterministicamente idênticas — se a 1ª degenerou
        // (greedy no gpt-oss pode repetir/derivar), a 2ª degenerava igual, e o "Tentar de novo" também.
        const srRetry: ProviderRuntimeConfig = { ...sr };
        delete srRetry.temperature;
        const a2 = await this.streamBlueprintAttempt(srRetry, system, buildBlueprintRetryRequest(brief, a1.text || a1.reasoning), "Convertendo o plano…");
        obsOutput = a2.text || a2.reasoning || obsOutput;
        addUsage(a2.usage);
        if (a2.error) {
          if (fallback) {
            // A conversão morreu, mas o parcial reparado existe — entregue-o com o aviso, em vez
            // do erro seco (o plano vai à aprovação humana de qualquer forma).
            log.warn("blueprint: conversão falhou — usando o plano parcial reparado da 1ª tentativa", { erro: a2.error });
            picked = fallback;
          } else {
            obsError = a2.error;
            this.post({ type: "project/blueprintError", message: a2.error });
            return;
          }
        } else {
          picked = this.pickBlueprint(a2);
          if ((a1.text || a1.reasoning).trim()) {
            // Herda os marcadores da 1ª SÓ quando a 2ª CONVERTEU material prévio: truncamento como
            // antes; e se a matéria-prima veio CORTADA (fallback existia), o plano convertido pode
            // estar sem os arquivos da cauda — o aviso de revisão continua aparecendo.
            picked.truncated = picked.truncated || a1.truncated;
            picked.salvaged = picked.salvaged || fallback !== null;
          }
          if (!picked.files.length && fallback) {
            log.warn("blueprint: conversão sem plano válido — usando o parcial reparado da 1ª tentativa");
            picked = fallback;
          }
        }
      }
      if (!picked.files.length) {
        // Diagnóstico de campo: o motivo REAL fica no Output → FORGE (o modal mostra o resumo).
        log.warn("blueprint: sem array válido após 2 tentativas", {
          truncated: picked.truncated,
          contentChars: obsOutput.length,
          head: obsOutput.slice(0, 400),
        });
        const detail = picked.truncated
          ? "O modelo atingiu o limite de tokens de saída antes de terminar o plano — aumente forge.provider.maxOutput ou reduza o escopo da descrição."
          : obsOutput.trim()
            ? "O modelo respondeu, mas sem um array JSON de plano válido, mesmo após pedir a conversão."
            : "O modelo não retornou conteúdo (a resposta veio vazia nas duas tentativas).";
        obsError = detail;
        // Trecho do que veio DENTRO do modal: diagnóstico instantâneo sem abrir o Output (o log
        // completo continua lá). Whitespace colapsado para caber numa linha do modal.
        const flat = obsOutput.trim().replace(/\s+/g, " ");
        const head = flat.slice(0, 140) + (flat.length > 140 ? "…" : ""); // … só quando cortou de fato
        this.post({
          type: "project/blueprintError",
          message: `${detail} Detalhes técnicos no painel Output → FORGE. Tente de novo — ou ajuste o modelo/esforço no rodapé.${head ? ` Início da resposta: "${head}"` : ""}`,
        });
        return;
      }
      if (picked.fromReasoning) {
        // O gateway roteou a resposta final para o canal de raciocínio (harmony sem canal final).
        // O plano recuperado é o array COMPLETO que o modelo emitiu — registra para diagnóstico.
        log.info("blueprint: plano recuperado do canal de raciocínio (content vazio/sem array)");
      }
      if (picked.salvaged) {
        // warn (não info): condição anômala do gateway — o irmão do diagnóstico de falha usa warn.
        log.warn("blueprint: resposta cortada SEM sinal de truncamento — plano reparado/convertido", { files: picked.files.length });
      }
      this.projectSession = { language, architecture, ui, framework, brief: text, files: picked.files.map((f) => ({ ...f, status: "pending" as ProjectFileStatus })) };
      this.post({
        type: "project/blueprint",
        blueprint: { language, architecture, brief: text, files: this.projectSession.files },
        // Resposta cortada (com OU sem sinal de truncamento) mas o reparo recuperou os objetos
        // completos: plano PARCIAL utilizável. O aviso vai DENTRO do modal (toast ficaria atrás).
        warning: picked.truncated
          ? "A resposta truncou no limite de tokens e recuperei um plano parcial — arquivos do fim podem faltar. Revise a lista antes de aprovar (ou tente de novo)."
          : picked.salvaged
            ? "A resposta veio cortada no meio do plano (sem sinal de truncamento) e recuperei os arquivos completos — os do fim podem faltar. Revise a lista antes de aprovar (ou tente de novo)."
            : undefined,
      });
    } catch (e) {
      obsError = (e as Error)?.message ?? String(e);
      this.post({ type: "project/blueprintError", message: obsError });
    } finally {
      const end: ObsEvent = { type: "generation.end", taskId, durationMs: Date.now() - started, model: sr.modelId, input: brief, output: obsOutput, usage: obsUsage, proposals: 0, error: obsError };
      this.trackUsage(end); // o planejamento também consome tokens — /contexto contabiliza
      this.obs.record(end);
    }
  }

  // Uma tentativa de streaming do blueprint: acumula content E raciocínio (o gateway pode rotear a
  // resposta final para reasoning_content quando o gpt-oss não emite o canal final), marca truncamento
  // (finish_reason=length) e narra o progresso no modal (heartbeat durante o raciocínio).
  private async streamBlueprintAttempt(
    sr: ProviderRuntimeConfig,
    system: string,
    userMsg: string,
    beatLabel: string
  ): Promise<{ text: string; reasoning: string; truncated: boolean; usage: { inputTokens: number; outputTokens: number }; error?: string }> {
    const provider = createProvider(sr, this.egress);
    const headers = this.buildTraceHeaders([], sr.modelId, sr.type, sr.reasoningEffort, "project");
    let text = "";
    let reasoning = "";
    let truncated = false;
    let gotText = false;
    const usage = { inputTokens: 0, outputTokens: 0 };
    const started = Date.now();
    // Heartbeat por TIMER: no não-streaming a resposta chega inteira de uma vez (sem chunks provando
    // vida durante o raciocínio), então o modal ficaria congelado 30-120s. O timer reposta o planStep
    // com o contador de segundos até o plano chegar; é limpo no finally.
    const beat = setInterval(() => {
      if (!gotText) this.post({ type: "project/planStep", label: `${beatLabel} (${Math.round((Date.now() - started) / 1000)}s)` });
    }, 1500);
    try {
      for await (const chunk of provider.createMessage(system, [{ role: "user", content: userMsg }], {
        timeoutMs: sr.timeoutSeconds * 1000,
        extraHeaders: headers,
        // JSON garantido pelo decoder (vLLM guided decoding) — o provider degrada sozinho se o
        // gateway rejeitar; o pipeline tolerante de parse continua como rede de segurança.
        jsonResponse: true,
        // NÃO-streaming: finish_reason confiável no corpo (base do `truncated` do salvage) e sem
        // vazamento harmony quebrando o JSON.parse. O salvage/retry seguem como rede de segurança.
        streaming: false,
      })) {
        if (chunk.kind === "text") {
          if (!gotText) {
            gotText = true;
            clearInterval(beat);
            this.post({ type: "project/planStep", label: "Recebendo o plano do modelo…" });
          }
          text += chunk.text;
        } else if (chunk.kind === "reasoning") {
          reasoning += chunk.text;
        } else if (chunk.kind === "usage") {
          usage.inputTokens += chunk.inputTokens;
          usage.outputTokens += chunk.outputTokens;
        } else if (chunk.kind === "warning") {
          truncated = true; // finish_reason=length: o raciocínio/output estourou o max_tokens
        } else if (chunk.kind === "error") {
          return { text, reasoning, truncated, usage, error: chunk.message };
        }
      }
    } catch (e) {
      return { text, reasoning, truncated, usage, error: (e as Error)?.message ?? String(e) };
    } finally {
      clearInterval(beat);
    }
    return { text, reasoning, truncated, usage };
  }

  // Extrai o plano de uma tentativa (lógica pura em pickBlueprintFromChannels): content tolerante;
  // canal de raciocínio SÓ via marcador de canal final (o raciocínio bruto ecoa o schema do prompt —
  // parseá-lo fabricaria plano falso e pularia a conversão); plano com <2 arquivos é inválido.
  private pickBlueprint(a: { text: string; reasoning: string; truncated: boolean }): {
    files: BlueprintFile[];
    truncated: boolean;
    fromReasoning: boolean;
    salvaged: boolean;
  } {
    const picked = pickBlueprintFromChannels(a);
    return { files: topoSort(picked.files), truncated: a.truncated, fromReasoning: picked.fromReasoning, salvaged: picked.salvaged };
  }

  // Passo 2: gera o projeto GUIADO pelo blueprint aprovado (Task reusa continuação/proposta/validação).
  async generateFromBlueprint(): Promise<void> {
    const s = this.projectSession;
    if (!s) {
      this.post({ type: "notice", level: "warn", message: "Nenhum blueprint aprovado. Planeje o projeto primeiro." });
      return;
    }
    // Pré-checagens (as mesmas do startTask) ANTES de marcar "gerando" — senão uma falha precoce (licença/
    // e-mail/provedor) deixaria o modal preso em "gerando…" (o project/done só é postado após o run).
    if (!(await this.ensureSession())) {
      this.post({ type: "project/blueprintError", message: "Licença requerida para gerar o projeto." });
      return;
    }
    if (this.resolveIdentity().emailRequired) {
      this.post({ type: "project/blueprintError", message: "Informe seu e-mail na configuração inicial antes de gerar." });
      await this.postState();
      return;
    }
    if (!(await this.runtimeProviderConfig())) {
      this.post({ type: "project/blueprintError", message: "Nenhum provedor configurado." });
      return;
    }
    for (const f of s.files) if (f.status !== "applied") f.status = "generating";
    this.post({ type: "project/status", files: s.files });
    await this.startTask(s.brief, "project", {
      language: s.language,
      architecture: s.architecture,
      ui: s.ui,
      framework: s.framework,
      files: s.files.map((f) => ({ path: f.path, purpose: f.purpose, deps: f.deps })),
    });
  }

  cancelProject(): void {
    this.currentTask?.abort(); // aborta a geração em andamento, se houver
    this.projectSession = null;
    this.post({ type: "project/done" });
  }

  // Fase F: durante a geração guiada, marca UM arquivo como "gerado" assim que seu bloco fecha no
  // streaming (progresso um-a-um). Só promove 'generating' → 'complete' (não mexe em 'applied'/'failed');
  // idempotente por arquivo. A reconciliação final em startTask continua sendo a autoridade.
  private markProjectFileComplete(filePath: string): void {
    const s = this.projectSession;
    if (!s) return;
    const norm = (p: string) => p.replace(/^[./\\]+/, ""); // casa './x' da proposta com 'x' do blueprint
    const f = s.files.find((x) => norm(x.path) === norm(filePath));
    if (f && f.status === "generating") {
      f.status = "complete";
      this.post({ type: "project/fileStatus", path: f.path, status: "complete" }); // patch pontual (não o array todo)
    }
  }

  // Passo 3: aplica TODAS as propostas, na ordem topológica do blueprint quando houver. NÃO aplica em
  // lote os arquivos PARCIAIS (truncados) — gravá-los silenciosamente seria perigoso; o dev aplica pelo
  // cartão individual (que avisa). Ao final, resumo honesto (aplicados/bloqueados/parciais pulados).
  async applyAllProposals(opts?: { forceBlocked?: boolean }): Promise<void> {
    if (!this.currentTask) return;
    const norm = (p: string) => p.replace(/^[./\\]+/, ""); // casa './x' com 'x' do blueprint
    const order = this.projectSession ? this.projectSession.files.map((f) => norm(f.path)) : [];
    const rank = (fp: string) => {
      const i = order.indexOf(norm(fp));
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const all = [...this.currentTask.proposals.values()].map((p) => p.proposal).filter((p) => !p.cell);
    const partial = all.filter((p) => p.partial);
    const toApply = all.filter((p) => !p.partial);
    const sorted = order.length ? toApply.slice().sort((a, b) => rank(a.filePath) - rank(b.filePath)) : toApply;
    let applied = 0;
    let blocked = 0;
    for (const p of sorted) {
      const ok = await this.applyProposal(p.id, { force: opts?.forceBlocked });
      if (ok) {
        applied++;
        if (this.projectSession) {
          const f = this.projectSession.files.find((x) => norm(x.path) === norm(p.filePath));
          if (f) f.status = "applied";
        }
      } else {
        blocked++;
      }
    }
    if (this.projectSession) {
      this.post({ type: "project/status", files: this.projectSession.files });
      // Fim de fluxo: se TODOS os arquivos do blueprint estão aplicados, o webview desmarca o Modo Projeto.
      if (this.projectSession.files.length > 0 && this.projectSession.files.every((f) => f.status === "applied")) {
        this.post({ type: "project/appliedAll" });
      }
    }
    const parts = [`${applied} aplicado(s)`];
    if (blocked) parts.push(`${blocked} bloqueado(s) pelo quality gate${opts?.forceBlocked ? "" : ' — use "Forçar bloqueados" se revisou'}`);
    if (partial.length) parts.push(`${partial.length} parcial(is) pulado(s) — revise e aplique pelo cartão`);
    this.post({ type: "notice", level: partial.length || blocked ? "warn" : "info", message: `Aplicar tudo: ${parts.join(" · ")}.` });
  }

  // ---- Visualizador read-only de Skills e RAG (o dev inspeciona o que é injetado) ------

  // Abre o inspetor: envia a lista de skills e o resumo do índice RAG (dados já em memória).
  async inspectOpen(): Promise<void> {
    this.post({
      type: "skills/inspect",
      skills: this.skills.map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
        enabled: s.enabled,
        relFile: `${s.source}/${path.basename(s.path)}/SKILL.md`, // amigável (não expõe o caminho absoluto/username)
        validators: s.validators.map((v) => v.id),
      })),
    });
    const st = this.rag.status();
    const lim = this.rag.limits();
    const ragCfg = this.config.rag();
    this.post({
      type: "rag/inspect",
      index: {
        enabled: ragCfg.enabled,
        ready: st.ready,
        mode: st.mode,
        files: st.files,
        chunks: st.chunks,
        maxChunks: lim.maxChunks,
        capped: lim.capped,
        embeddingsUrl: ragCfg.embeddingsUrl,
        embeddingModel: ragCfg.embeddingModel,
        dimensions: ragCfg.embeddingDimensions,
        fileList: this.rag.listIndexedFiles(),
      },
    });
  }

  // Carrega o corpo (markdown) de uma SKILL.md sob demanda — read-only.
  async inspectSkillBody(name: string): Promise<void> {
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) {
      // Sempre responde (senão o painel de detalhe fica preso em "carregando…" se a skill sumiu num reindex).
      this.post({ type: "skills/body", name, body: "(skill não encontrada — reabra o Índice)" });
      return;
    }
    let body = "";
    try {
      body = await this.loader.loadBody(skill);
    } catch (e) {
      body = `(erro ao ler SKILL.md: ${(e as Error)?.message ?? String(e)})`;
    }
    this.post({ type: "skills/body", name, body });
  }

  // Chunks indexados de um arquivo (read-only): linhas, símbolo, se tem vetor, e um preview truncado.
  // O preview é REDIGIDO (mascara valores de segredo tipo `api_key: …`) — o viewer não deve virar uma
  // superfície fácil de extrair credenciais que por acaso tenham sido indexadas.
  inspectRagFile(relPath: string): void {
    const chunks = this.rag.fileChunks(relPath).map((c) => ({
      id: c.id,
      startLine: c.startLine,
      endLine: c.endLine,
      symbol: c.symbol,
      hasVector: c.hasVector,
      preview: redactSecrets(c.text.split("\n").slice(0, 8).join("\n")).slice(0, 600),
    }));
    this.post({ type: "rag/file", relPath, chunks });
  }

  // Configura a observabilidade direta (sink Langfuse): guarda a secretKey no SecretStorage
  // (nunca em settings, RNF-010). baseUrl/publicKey/enabled ficam em forge.observability.langfuse.*.
  async setupObservability(): Promise<void> {
    const secret = await vscode.window.showInputBox({
      prompt: "Langfuse secret key (sk-lf-…) — guardada no SecretStorage, nunca em settings",
      password: true,
      placeHolder: "sk-lf-...",
      ignoreFocusOut: true,
    });
    if (secret === undefined) return;
    await this.secrets.set(SecretsStore.KEY_LANGFUSE_SECRET, secret.trim());
    this.post({
      type: "notice",
      level: "info",
      message:
        "Secret do Langfuse salva. Habilite forge.observability.langfuse.enabled, defina baseUrl/publicKey e adicione o host do Langfuse em forge.egress.allowedHosts.",
    });
  }

  // ---- estado ----------------------------------------------------------------

  buildState(): ForgeState {
    const provider = this.providerView();
    const licenseActive = !!this.sessionToken;
    const license = this.licenseView();
    const identity = this.resolveIdentity();
    let stage: ForgeState["stage"];
    if (!licenseActive) stage = "onboarding-license";
    else if (!provider.configured || identity.emailRequired) stage = "onboarding-provider";
    else stage = "ready";

    const policy = this.config.egressPolicy();
    const ragStatus = this.rag.status();
    const ragCfg = this.config.rag();
    return {
      stage,
      license,
      provider,
      network: { internalOnly: !policy.allowExternal, allowedHosts: policy.allowedHosts },
      observability: { traceActive: this.config.gatewayUrl() !== "", managedByAdmin: true, login: osLogin() },
      identity,
      search: { enabled: this.config.search().server !== "", label: "Buscar (rede interna)" },
      mcp: this.registry.toViews(),
      skills: this.skills.map(this.toSkillView),
      rag: {
        enabled: ragCfg.enabled,
        ready: ragStatus.ready,
        mode: ragStatus.mode,
        files: ragStatus.files,
        chunks: ragStatus.chunks,
        embeddingsUrl: ragCfg.embeddingsUrl,
        embeddingModel: ragCfg.embeddingModel,
        dimensions: ragCfg.embeddingDimensions,
      },
      presets: PROVIDER_PRESETS,
      telemetryEnabled: this.config.telemetryEnabled(),
      version: "1.0.0",
      uiPanel: this.uiPanel,
    };
  }

  // RF-063: resolve a identidade (e-mail) do dev a partir do subject da licença,
  // do e-mail informado manualmente e da política do admin (requireEmail).
  private resolveIdentity(): EmailIdentity {
    const meta = this.context.globalState.get<{ subject?: string }>(GS_LICENSE_META);
    const manual = this.context.globalState.get<string>(GS_IDENTITY_EMAIL);
    return resolveEmailIdentity({
      subject: meta?.subject,
      manualEmail: manual,
      requireEmail: this.config.requireEmail(),
    });
  }

  async setEmail(email: string): Promise<void> {
    const value = (email ?? "").trim();
    if (!isEmail(value)) {
      this.post({ type: "notice", level: "error", message: "E-mail inválido. Informe um e-mail corporativo válido." });
      return;
    }
    await this.context.globalState.update(GS_IDENTITY_EMAIL, value);
    this.post({ type: "notice", level: "info", message: "E-mail registrado para a observabilidade." });
    await this.postState();
  }

  private toSkillView(s: SkillMeta): SkillView {
    return {
      name: s.name,
      description: s.description,
      enabled: s.enabled,
      source: s.source,
      hasValidators: s.validators.length > 0,
    };
  }

  private licenseView(): LicenseView {
    const meta = this.context.globalState.get<{ org: string; subject: string; expiry: number; scope: string[] }>(GS_LICENSE_META);
    return {
      active: !!this.sessionToken,
      org: meta?.org,
      subject: meta?.subject,
      expiry: meta?.expiry,
      scope: meta?.scope,
      mode: this.config.licenseMode(),
    };
  }

  private providerView(): ProviderView {
    const p = this.context.globalState.get<ProviderPersisted>(GS_PROVIDER);
    if (!p) return { configured: false };
    const effort = p.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    const supports = supportsReasoningEffort(p.type, p.modelId);
    return {
      configured: true,
      type: p.type,
      modelId: p.modelId,
      baseUrl: p.baseUrl,
      // timeout EFETIVO: para gpt-oss o esforço eleva o piso (mantendo um override maior do
      // onboarding); para os demais, o valor configurado no onboarding é preservado intacto.
      timeoutSeconds: supports ? Math.max(p.timeoutSeconds, effectiveTimeoutSeconds(effort)) : p.timeoutSeconds,
      label: p.label ?? `${p.type} · ${p.modelId}`,
      reasoningEffort: effort,
      supportsReasoningEffort: supports,
      maxOutput: p.maxOutput ?? 0,
    };
  }

  async postState(): Promise<void> {
    this.post({ type: "state", state: this.buildState() });
  }

  // ---- tratamento de mensagens -----------------------------------------------

  async handleMessage(msg: WebviewToExt): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.postState();
        break;
      case "license/submit":
        await this.activateLicense(msg.key);
        break;
      case "identity/setEmail":
        await this.setEmail(msg.email);
        break;
      case "provider/setup":
        await this.setupProvider(msg.setup);
        break;
      case "provider/test":
        await this.testProvider(msg.setup);
        break;
      case "provider/setEffort":
        await this.setReasoningEffort(msg.effort);
        break;
      case "provider/setMaxOutput":
        await this.setMaxOutput(msg.maxTokens);
        break;
      case "provider/openSettings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "forge");
        break;
      case "embeddings/test":
        await this.testEmbeddings();
        break;
      case "chat/send":
        await this.startTask(msg.text, msg.tdd ? "tdd" : "normal");
        break;
      case "chat/clear":
        // /limpar: o "Nova conversa" da webview zera só a UI; aqui zera o que o HOST reenviaria.
        // Aborta a task em VOO primeiro — sem isso ela seguiria queimando tokens e despejando
        // stream/text na conversa "nova" (task fantasma confirmada em revisão adversarial).
        this.currentTask?.abort();
        this.history = [];
        this.pendingAttachments = [];
        this.postAttachments();
        this.post({ type: "notice", level: "info", message: "Contexto limpo: histórico e anexos zerados." });
        break;
      case "chat/summarize":
        await this.summarizeHistory();
        break;
      case "context/inspect":
        await this.reportContext();
        break;
      case "project/start":
        await this.startTask(msg.text, "project", { language: msg.language, architecture: msg.architecture, ui: msg.ui, framework: msg.framework });
        break;
      case "project/blueprint":
        await this.generateBlueprint(msg.text, msg.language, msg.architecture, msg.ui, msg.framework);
        break;
      case "project/generate":
        await this.generateFromBlueprint();
        break;
      case "project/cancel":
        this.cancelProject();
        break;
      case "proposal/applyAll":
        await this.applyAllProposals({ forceBlocked: msg.forceBlocked });
        break;
      case "tests/run":
        await this.runTests();
        break;
      case "env/prepare":
        await this.prepareEnv();
        break;
      case "chat/abort":
        this.currentTask?.abort();
        break;
      case "proposal/apply":
        await this.applyProposal(msg.proposalId, { force: msg.force });
        break;
      case "codeBlock/save":
        await this.saveCodeBlock(msg.filePath, msg.content);
        break;
      case "proposal/applyAndRun":
        await this.applyAndRun(msg.proposalId, { force: msg.force });
        break;
      case "proposal/applyAndPreview":
        await this.applyAndPreview(msg.proposalId, { force: msg.force });
        break;
      case "proposal/discard": {
        const fp = this.currentTask?.getProposal(msg.proposalId)?.proposal.filePath ?? "";
        this.post({ type: "proposal/discarded", proposalId: msg.proposalId });
        this.obs.record({ type: "proposal.discarded", filePath: fp });
        break;
      }
      case "proposal/viewDiff":
        await this.viewDiff(msg.proposalId);
        break;
      case "proposal/copy":
        await this.copyProposal(msg.proposalId);
        break;
      case "run/file":
        await this.runService.runFile(msg.filePath, msg.proposalId);
        break;
      case "preview/open":
        await this.previewService.openPreview(msg.filePath);
        this.obs.record({ type: "run.result", filePath: msg.filePath, label: "preview", ok: true, exitCode: 0, durationMs: 0 });
        break;
      case "run/cancel":
        this.runService.cancel(msg.runId);
        break;
      case "run/focusTerminal":
        this.runService.focusTerminal();
        break;
      case "cell/run":
        await this.runCell(msg.proposalId);
        break;
      case "review/changes":
        await this.reviewChanges();
        break;
      case "context/pickWorkspaceFile":
        await this.pickWorkspaceFile();
        break;
      case "context/pickLocalFile":
        await this.pickLocalFile();
        break;
      case "context/addSelection":
        await this.addSelectionAttachment();
        break;
      case "context/addTerminalSelection":
        await this.addTerminalSelectionAttachment();
        break;
      case "context/addImage":
        await this.addImageOcrAttachment(msg.dataUrl);
        break;
      case "context/removeAttachment":
        this.pendingAttachments = this.pendingAttachments.filter((a) => a.id !== msg.id);
        this.postAttachments();
        break;
      case "context/search":
        await this.searchInternal();
        break;
      case "context/webInfo":
        this.post({
          type: "notice",
          level: "info",
          message: "Por política, o FORGE não navega na internet pública (soberania de dados). O admin pode habilitar uma fonte interna (MCP) em forge.search.server.",
        });
        break;
      case "skill/toggle":
        await this.toggleSkill(msg.name, msg.enabled);
        break;
      case "mcp/approvalResponse": {
        const resolver = this.pendingApprovals.get(msg.requestId);
        if (resolver) {
          this.pendingApprovals.delete(msg.requestId);
          resolver(msg.approved);
        }
        break;
      }
      case "profile/addRule":
        await this.addProjectRule(msg.rule);
        break;
      case "profile/open":
        await this.openProjectProfile();
        break;
      case "profile/pickRole":
        await this.pickProjectRole();
        break;
      case "profile/refresh":
        await this.postProfileState();
        break;
      case "charter/open":
        await this.openCharter();
        break;
      case "charter/draft":
        await this.draftCharterSection(msg.section, msg.brief, msg.sections);
        break;
      case "charter/save":
        await this.saveCharter(msg.sections);
        break;
      case "charter/genTests":
        await this.generateAcceptanceTests(msg.fr, msg.nfr);
        break;
      case "inspect/open":
        await this.inspectOpen();
        break;
      case "ui/panelConsumed":
        // o webview abriu o modal pedido pela paleta — limpa o pedido e re-emite o estado limpo para
        // que qualquer remount futuro NÃO reabra (fecha a janela de corrida).
        this.uiPanel = undefined;
        await this.postState();
        break;
      case "skills/body":
        await this.inspectSkillBody(msg.name);
        break;
      case "rag/file":
        this.inspectRagFile(msg.relPath);
        break;
      case "signOut":
        await this.signOut();
        break;
      case "reindexSkills":
        await this.reindexSkills();
        await this.postState();
        break;
    }
  }

  // ---- licença ---------------------------------------------------------------

  async activateLicense(key: string): Promise<void> {
    if (!this.verifier.isConfigured()) {
      this.post({
        type: "notice",
        level: "error",
        message: "Chave pública de licença não embutida. Rode `npm run keygen` (admin) antes de validar licenças.",
      });
      return;
    }
    const result = await this.licenseClient.activate(key);
    if ("error" in result) {
      this.post({ type: "notice", level: "error", message: `Licença recusada: ${result.error.message}` });
      await this.postState();
      return;
    }
    this.sessionToken = result.token;
    this.licenseKey = key;
    await this.secrets.set(SecretsStore.KEY_LICENSE, key);
    await this.secrets.set(SecretsStore.KEY_SESSION_TOKEN, JSON.stringify(result.token));

    const local = this.verifier.verifyLocal(key);
    if (local.ok) {
      await this.context.globalState.update(GS_LICENSE_META, {
        org: local.payload.org,
        subject: local.payload.subject,
        expiry: local.payload.expiry,
        scope: local.payload.scope,
      });
    }
    this.post({ type: "notice", level: "info", message: "Licença ativada." });
    await this.postState();
  }

  async signOut(): Promise<void> {
    await this.secrets.delete(SecretsStore.KEY_SESSION_TOKEN);
    await this.secrets.delete(SecretsStore.KEY_LICENSE);
    await this.secrets.delete(SecretsStore.providerApiKey("default"));
    await this.context.globalState.update(GS_PROVIDER, undefined);
    await this.context.globalState.update(GS_LICENSE_META, undefined);
    await this.context.globalState.update(GS_IDENTITY_EMAIL, undefined);
    this.sessionToken = undefined;
    this.licenseKey = undefined;
    this.history = [];
    this.pendingAttachments = [];
    await this.postState();
  }

  // ---- provedor --------------------------------------------------------------

  async setupProvider(setup: ProviderSetup): Promise<void> {
    if (setup.apiKey !== undefined) {
      await this.secrets.set(SecretsStore.providerApiKey("default"), setup.apiKey);
    }
    const existing = this.context.globalState.get<ProviderPersisted>(GS_PROVIDER);
    const persisted: ProviderPersisted = {
      type: setup.type,
      modelId: setup.modelId,
      baseUrl: setup.baseUrl,
      authHeader: setup.authHeader,
      timeoutSeconds: setup.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS,
      label: `${setup.type === "openai-compatible" ? "HubGPU/compat" : setup.type} · ${setup.modelId}`,
      // preserva o esforço já escolhido pelo usuário num re-setup; senão usa o default.
      reasoningEffort: setup.reasoningEffort ?? existing?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      // idem para o teto de saída do seletor: um re-setup (trocar baseUrl/re-salvar) não pode APAGAR a
      // escolha do usuário. Só é resetado quando o MODELO muda (outro modelo pode ter janela diferente).
      maxOutput: setup.modelId === existing?.modelId ? existing?.maxOutput : undefined,
    };
    await this.context.globalState.update(GS_PROVIDER, persisted);
    this.post({ type: "notice", level: "info", message: "Provedor configurado." });
    await this.postState();
  }

  // Troca o esforço de raciocínio (low/medium/high) pelo seletor do rodapé. Persiste e re-emite o
  // estado — o timeout efetivo passa a derivar do novo esforço na próxima geração.
  async setReasoningEffort(effort: ReasoningEffort): Promise<void> {
    const p = this.context.globalState.get<ProviderPersisted>(GS_PROVIDER);
    if (!p) return;
    await this.context.globalState.update(GS_PROVIDER, { ...p, reasoningEffort: effort });
    await this.postState();
  }

  // Troca o teto de tokens de SAÍDA por sessão (seletor do rodapé). 0 = auto (catálogo/config). O valor
  // é validado (>=0) e persistido; a próxima geração o resolve com precedência sessão > config > catálogo
  // e clamp contra a janela servida (resolveOutputTokens) — sem risco de 400 por valor alto demais.
  async setMaxOutput(maxTokens: number): Promise<void> {
    const p = this.context.globalState.get<ProviderPersisted>(GS_PROVIDER);
    if (!p) return;
    const v = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0;
    await this.context.globalState.update(GS_PROVIDER, { ...p, maxOutput: v });
    await this.postState();
  }

  // Comando de paleta "FORGE: definir máximo de tokens de saída": QuickPick com os presets.
  async pickMaxOutput(): Promise<void> {
    const p = this.context.globalState.get<ProviderPersisted>(GS_PROVIDER);
    if (!p) {
      this.post({ type: "notice", level: "warn", message: "Configure um provedor antes de definir o máximo de tokens de saída." });
      return;
    }
    const current = p.maxOutput ?? 0;
    const items = MAX_OUTPUT_PRESETS.map((v) => ({
      label: v === 0 ? "auto (catálogo do modelo)" : `${maxOutputLabel(v)} tokens`,
      description: v === current ? "atual" : v === 0 ? "usa o teto do catálogo / config do admin" : "rebaixado à janela servida se necessário",
      value: v,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: "Máximo de tokens de saída (por sessão)", placeHolder: "Escolha o teto de saída — valores altos são rebaixados ao que o gateway serve" });
    if (pick) await this.setMaxOutput(pick.value);
  }

  // Comando de paleta → abre um modal do webview (Índice/Perfil). Registra o pedido no ESTADO (com seq
  // monotônico) e re-emite o estado, em vez de postar uma mensagem fire-and-forget: assim o webview
  // recebe o pedido no handshake ready→postState mesmo no cold start / fim do onboarding (quando o
  // listener ainda não montou). O extension.ts revela a view antes (focusView). O webview abre o modal
  // uma única vez (compara o seq) e confirma via `ui/panelConsumed`, que limpa o pedido aqui.
  openWebviewPanel(panel: "inspect" | "profile"): void {
    this.uiPanel = { panel, seq: ++this.uiPanelSeq };
    void this.postState();
  }

  // Teto de saída efetivo: precedência sessão > config admin > catálogo, com CLAMP contra a janela
  // SERVIDA (forge.provider.maxContextWindow || catálogo) menos uma reserva de entrada — evita o footgun
  // de um valor alto que o gateway recusaria com 400 (é rebaixado automaticamente). O 400 residual (raro)
  // segue coberto pelo fail-soft de hintFor400 no provider.
  // `sessionMaxOutput`: o teto por-sessão do PROVIDER EM QUESTÃO (0 = sem escolha). Recebido explícito,
  // não lido do globalState — no "Testar conexão" o setup pode ser um provider/modelo DIFERENTE do
  // persistido, e herdar a sessão do provider antigo testaria um teto que o modelo em teste nunca usaria.
  private resolveOutputTokens(type: ProviderRuntimeConfig["type"], modelId: string, sessionMaxOutput: number): number {
    const meta = getModelMeta(type, modelId);
    const cfg = this.config.provider();
    const requested = sessionMaxOutput > 0 ? sessionMaxOutput : cfg.maxOutput; // sessão vence a config do admin
    return clampOutputToServed(resolveMaxOutput(requested, meta), meta, cfg.maxContextWindow, OUTPUT_INPUT_RESERVE);
  }

  private async runtimeProviderConfig(): Promise<ProviderRuntimeConfig | undefined> {
    const p = this.context.globalState.get<ProviderPersisted>(GS_PROVIDER);
    if (!p) return undefined;
    const apiKey = (await this.secrets.get(SecretsStore.providerApiKey("default"))) ?? "not-needed";
    // Teto de saída REAL do modelo (catálogo), sobrescrevível por config. Sem isto, toda geração caía
    // no DEFAULT_MAX_TOKENS fixo (16384), ignorando a janela de 128k do gpt-oss-120b.
    const meta = getModelMeta(p.type, p.modelId);
    const maxTokens = this.resolveOutputTokens(p.type, p.modelId, p.maxOutput ?? 0);
    if (!meta.supportsReasoningEffort) {
      // Provedores sem esforço (Anthropic/OpenAI/Llama): preserva o timeout do onboarding e não
      // envia reasoning_effort.
      return { ...p, apiKey, maxTokens, reasoningEffort: undefined };
    }
    const reasoningEffort = p.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    // gpt-oss: o esforço eleva o piso de timeout (esforços maiores levam mais tempo), mas um override
    // maior do onboarding é respeitado — evita cortar respostas longas (arquivo completo) no meio.
    return { ...p, apiKey, maxTokens, reasoningEffort, timeoutSeconds: Math.max(p.timeoutSeconds, effectiveTimeoutSeconds(reasoningEffort)) };
  }

  // Tarefas ESTRUTURADAS one-shot (blueprint, charter): rebaixa o esforço de raciocínio para "low"
  // quando o modelo o suporta (gpt-oss). Esforço ALTO faz o raciocínio DEVORAR o max_tokens e TRUNCAR o
  // output final — o array do plano fica incompleto (parseBlueprint → []) e as seções do charter são
  // cortadas no meio da palavra. Essas tarefas são estruturais, não precisam de raciocínio profundo;
  // "low" garante que o output caiba. temperature 0: amostragem determinística — variância é inimiga
  // de formato estrito (JSON) — mas SÓ onde o modelo aceita (os modelos de raciocínio da OpenAI
  // rejeitam temperature != 1 com 400). (A geração de CÓDIGO mantém o esforço/temperatura do usuário.)
  private structuredRuntime(runtime: ProviderRuntimeConfig): ProviderRuntimeConfig {
    const sr: ProviderRuntimeConfig = { ...runtime };
    if (supportsTemperature(sr.type, sr.modelId)) sr.temperature = 0;
    if (sr.reasoningEffort) sr.reasoningEffort = "low";
    return sr;
  }

  async testProvider(setup: ProviderSetup): Promise<void> {
    const cfg: ProviderRuntimeConfig = {
      type: setup.type,
      modelId: setup.modelId,
      baseUrl: setup.baseUrl,
      authHeader: setup.authHeader,
      apiKey: setup.apiKey || "not-needed",
      timeoutSeconds: Math.min(setup.timeoutSeconds || 30, 30),
      // Envia o teto EFETIVO com clamp (config + janela servida). Passa sessão=0: o teto por-sessão é do
      // provider já configurado, não do que está sendo TESTADO (que pode ser outro modelo/janela). Assim
      // um 400 por max_tokens excedendo o --max-model-len aparece já no "Testar conexão", fielmente.
      maxTokens: this.resolveOutputTokens(setup.type, setup.modelId, 0),
      // Exercita o MESMO corpo da geração real: se o gateway recusar reasoning_effort, o erro aparece
      // já no "Testar conexão", não silenciosamente na primeira geração.
      reasoningEffort: supportsReasoningEffort(setup.type, setup.modelId)
        ? setup.reasoningEffort ?? DEFAULT_REASONING_EFFORT
        : undefined,
    };
    const started = Date.now();
    try {
      this.egress.assertAllowed(cfg.baseUrl ?? (cfg.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"));
      const provider = createProvider(cfg, this.egress);
      let gotSomething = false;
      for await (const chunk of provider.createMessage(
        "Você é um healthcheck. Responda apenas 'ok'.",
        [{ role: "user", content: "ping" }],
        { timeoutMs: cfg.timeoutSeconds * 1000 }
      )) {
        if (chunk.kind === "error") {
          this.post({ type: "providerTestResult", ok: false, message: chunk.message });
          return;
        }
        if (chunk.kind === "text" || chunk.kind === "usage" || chunk.kind === "reasoning" || chunk.kind === "warning") {
          gotSomething = true;
          break;
        }
      }
      this.post({
        type: "providerTestResult",
        ok: gotSomething,
        message: gotSomething ? "Conexão bem-sucedida." : "Sem resposta do modelo.",
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      this.post({ type: "providerTestResult", ok: false, message: (err as Error).message });
    }
  }

  // Teste de conexão do embedding (RAG) — espelha o botão "Testar" do hub interno.
  async testEmbeddings(): Promise<void> {
    const r = await this.rag.testEmbeddings();
    this.post({ type: "embeddingsTestResult", ok: r.ok, mode: r.mode, message: r.message, dims: r.dims, latencyMs: r.latencyMs });
  }

  // ---- alternância de skills -------------------------------------------------

  async toggleSkill(name: string, enabled: boolean): Promise<void> {
    const skill = this.skills.find((s) => s.name === name);
    if (skill) skill.enabled = enabled;
    const disabled = new Set(this.context.workspaceState.get<string[]>(WS_DISABLED_SKILLS, []));
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await this.context.workspaceState.update(WS_DISABLED_SKILLS, [...disabled]);
    await this.postState();
  }

  // ---- geração ---------------------------------------------------------------

  async startTask(
    text: string,
    mode: "normal" | "tdd" | "project" = "normal",
    project?: { language: ProjectLanguage; architecture: ProjectArchitecture; ui?: ProjectUI; framework?: ProjectFramework; files?: BlueprintFile[] }
  ): Promise<void> {
    if (!text.trim()) return;
    // RF-010/015: condiciona a inferência a uma sessão válida.
    if (!(await this.ensureSession())) {
      this.post({ type: "notice", level: "error", message: "Licença requerida. Ative a licença para gerar código." });
      return;
    }
    // RF-063: identidade obrigatória quando não há coleta automática do e-mail.
    if (this.resolveIdentity().emailRequired) {
      this.post({ type: "notice", level: "error", message: "Informe seu e-mail na configuração inicial antes de gerar código." });
      await this.postState();
      return;
    }
    const runtime = await this.runtimeProviderConfig();
    if (!runtime) {
      this.post({ type: "notice", level: "error", message: "Nenhum provedor configurado." });
      return;
    }

    const selector = new SkillSelector({
      ...DEFAULT_SELECTOR_CONFIG,
      retrievalThreshold: this.config.retrievalThreshold(),
      topK: this.config.topK(),
    });
    const discovery = selector.selectForDiscovery(this.skills, text);
    const toActivate = selector.selectForActivation(discovery, text);
    const activated = await Promise.all(
      toActivate.map(async (meta) => ({ meta, body: await this.loader.loadBody(meta) }))
    );

    const ragStart = Date.now();
    let retrievedContext = await this.gatherContext(text);
    if (this.pendingAttachments.length > 0) {
      const att = this.pendingAttachments.map((a) => `### Anexo: ${a.label}\n\`\`\`\n${a.content}\n\`\`\``).join("\n\n");
      retrievedContext = `Anexos fornecidos pelo usuário:\n${att}\n\n${retrievedContext}`;
      this.pendingAttachments = [];
      this.postAttachments(); // limpa os chips (anexos são consumidos no envio)
    }
    const ragMs = Date.now() - ragStart; // P3: span da recuperação de contexto (RAG + anexos)
    // Contexto do projeto (charter + deps fixadas) reforçado no prompt de GERAÇÃO, junto da lista de
    // arquivos — mesmo já indo via projectProfile, hammerar propósito/deps aqui reduz o drift (a auditoria
    // mostrou o modelo ignorando o charter). Só no Modo Projeto (evita I/O extra em chat/tdd).
    const asmStart = Date.now(); // P3: span da MONTAGEM do prompt (perfil/stack + orçamento + assemble)
    const projectCtx = mode === "project" ? await this.projectPromptContext() : undefined;
    const basePrompt =
      mode === "project" && project
        ? project.files && project.files.length > 0
          ? buildProjectFromBlueprintPrompt(this.workspaceName(), project.language, project.architecture, project.files, project.ui, project.framework, projectCtx) // Fase F: plano aprovado
          : buildProjectPrompt(this.workspaceName(), project.language, project.architecture, project.ui, project.framework, projectCtx)
        : mode === "tdd"
        ? buildTddPrompt(this.workspaceName())
        : buildBasePrompt(this.workspaceName());
    // Combina a stack detectada (sempre fresca), a orientação do papel (workspace vence) e os corpos
    // dos perfis. Papel e frontmatter resolvidos POR DOCUMENTO (não no blob) para honrar precedência
    // e não vazar o frontmatter do segundo arquivo na prosa.
    const [stack, sources] = await Promise.all([this.detectWorkspaceStack(), this.loadProfileSources()]);
    const body = sources.map(stripFrontmatter).filter((s) => s.trim()).join("\n\n");
    const projectProfile = renderProfileBlock(
      [renderStackBlock(stack), roleGuidance(resolveRole(sources)), body].filter((s) => s.trim()).join("\n\n")
    );
    // Orçamento de ENTRADA derivado da janela real do modelo (em vez do antigo 24000 fixo em chars):
    // a saída já está reservada em runtime.maxTokens (catálogo), então a entrada usa o resto da janela.
    // A janela é reconciliada com o limite real do servidor (forge.provider.maxContextWindow), se definido.
    const budget = deriveBudget(
      getModelMeta(runtime.type, runtime.modelId),
      runtime.maxTokens ?? 0,
      this.config.provider().maxContextWindow
    );
    const assembled = this.assembler.assemble({
      basePrompt,
      projectProfile,
      discoverySkills: discovery,
      activatedSkills: activated,
      retrievedContext,
      history: this.history,
      query: text,
      inputBudgetTokens: budget.inputBudget,
    });
    const asmMs = Date.now() - asmStart;

    // Convenções-como-validators: as ferramentas detectadas (ruff/mypy/eslint/…) viram validadores
    // advisory do quality gate, checando o código gerado contra o ferramental real do projeto.
    const validators: SkillValidatorSpec[] = dedupeValidators([
      ...activated.flatMap((a) => a.meta.validators),
      ...validatorsFromStack(stack),
    ]);
    const provider = createProvider(runtime, this.egress);
    const taskId = `task_${Date.now()}`;
    const task = new Task({
      taskId,
      provider,
      systemPrompt: assembled.systemPrompt,
      messages: assembled.messages,
      activatedSkillNames: assembled.activatedSkillNames,
      validators,
      skillValidator: new SkillValidator(this.workspaceRoot()),
      workspaceRoot: this.workspaceRoot(),
      timeoutMs: runtime.timeoutSeconds * 1000,
      // RF-063: propaga identidade do dev (login), sessão, modelo e skills ao
      // gateway para a observabilidade — nunca segredos.
      extraHeaders: this.buildTraceHeaders(assembled.activatedSkillNames, runtime.modelId, runtime.type, runtime.reasoningEffort, mode),
      emit: (e) => {
        this.trackUsage(e);
        this.obs.record(e);
      },
      obsMeta: {
        mode,
        model: runtime.modelId,
        provider: runtime.type,
        sessionId: this.sessionId,
        userId: this.resolveIdentity().email ?? "",
        org: this.context.globalState.get<{ org?: string }>(GS_LICENSE_META)?.org,
        // P3: params EFETIVOS da geração, capturados no generation.start (evidência do que produziu a saída).
        reasoningEffort: runtime.reasoningEffort,
        maxOutputTokens: runtime.maxTokens,
        inputBudgetTokens: budget.inputBudget,
        // Tempos de rag/assemble medidos ANTES do taskId; o Task os emite como phase.timing APÓS o
        // generation.start (para anexarem ao trace certo no Langfuse — ver Task.run).
        ragMs,
        assembleMs: asmMs,
      },
      post: (m) => this.post(m),
      // Modo Projeto: à medida que cada bloco de arquivo FECHA no streaming, marca "gerado" um a um,
      // em vez de tudo em lote no fim. A reconciliação final (complete/failed) segue autoritativa.
      onFileClosed:
        mode === "project" && this.projectSession ? (filePath) => this.markProjectFileComplete(filePath) : undefined,
    });
    this.currentTask = task;

    // Registra o turno do usuário; o turno do assistente é anexado após a conclusão.
    this.history.push({ role: "user", content: text });
    await task.run();
    // P1 few-shot vivo: empilha um turno COMPACTO do que o modelo GEROU (cabeçalhos forge-file preservados).
    // Sem isto o histórico só teria o stub "Apliquei em X" e, no turno seguinte, o modelo não veria seu
    // próprio output no protocolo — revertendo para cerca comum (o sintoma copiar/colar). null (sem
    // forge-file) → nada a empilhar. History é host-only (não vai à webview). O cap de 20 abaixo o limita.
    const fewShot = buildFewShotTurn(task.getGenerated());
    if (fewShot) this.history.push({ role: "assistant", content: fewShot });
    // Fase F: reconcilia o status do FileTree — arquivo do blueprint que virou proposta = "complete";
    // o que o modelo NÃO gerou = "failed" (não "pending", que se confundiria com o estado inicial).
    if (mode === "project" && project?.files && project.files.length > 0 && this.projectSession) {
      const norm = (p: string) => p.replace(/^[./\\]+/, ""); // casa './x' da proposta com 'x' do blueprint
      const proposed = new Set([...task.proposals.values()].map((p) => norm(p.proposal.filePath)));
      let done = 0;
      for (const f of this.projectSession.files) {
        if (f.status === "applied") {
          done++;
          continue;
        }
        if (proposed.has(norm(f.path))) {
          f.status = "complete";
          done++;
        } else {
          f.status = "failed";
        }
      }
      this.post({ type: "project/status", files: this.projectSession.files });
      const total = this.projectSession.files.length;
      if (done === 0) {
        // Falha TOTAL da geração (ex.: erro do provedor no meio do stream, que vira stream/error e NÃO
        // gera propostas). Em vez de um project/done silencioso (modal "concluído" sem nada), mantém o
        // modal com o erro + a lista (vermelha) + "Aprovar e gerar" habilitado — o dev vê e regenera.
        this.post({ type: "project/blueprintError", message: 'Não consegui gerar nenhum arquivo (falha do provedor ou limite de tokens). Ajuste e clique em "Aprovar e gerar" para tentar de novo.' });
      } else {
        // Gate WORKSPACE-WIDE antes do "Pronto": compila/importa o CONJUNTO gerado e bloqueia o Aplicar
        // dos arquivos que não passam (drift de contrato cross-file). Alimenta entry.gateOk. Roda ANTES
        // do project/done para o modal já abrir com os cartões reprovados pintados.
        let gate = await this.runProjectGate(project.language, project.architecture, done === total);
        // Onda 2: AUTO-REPARO dirigido pelo gate — enquanto houver arquivo reprovado, re-pede SÓ esses
        // arquivos (com os erros do mypy + o CONTRATO REAL dos que passaram) e re-roda o gate, até verde ou
        // o teto de rodadas. O gate continua BLOQUEANDO o Aplicar se não fechar — nunca entrega em silêncio.
        const MAX_PROJECT_REPAIRS = 2;
        for (let round = 1; gate && gate.fileErrors.length > 0 && round <= MAX_PROJECT_REPAIRS; round++) {
          this.post({ type: "notice", level: "info", message: `Auto-reparo do projeto: ${gate.fileErrors.length} arquivo(s) com erro de contrato — regenerando (rodada ${round}/${MAX_PROJECT_REPAIRS})…` });
          const repairStart = Date.now(); // P3: span de cada rodada de auto-reparo (nova chamada ao provedor)
          const n = await this.repairProjectFromGate(gate, project, runtime);
          this.obs.record({ type: "phase.timing", taskId: this.currentTask?.taskId ?? "", phase: "repair", durationMs: Date.now() - repairStart });
          if (n === 0) break; // nada regenerado (falha do provedor / sem alvo casável) — insistir não ajuda
          gate = await this.runProjectGate(project.language, project.architecture, done === total);
        }
        // Violações de arquitetura NÃO passam pelo auto-reparo (ver runProjectGate): avisa o dev para
        // corrigir a DIREÇÃO do import — os arquivos seguem bloqueados no Aplicar até então.
        if (gate?.architectureErrors?.length) {
          this.post({ type: "notice", level: "warn", message: `Arquitetura: ${gate.architectureErrors.length} arquivo(s) violam a regra de camadas (a camada interna importa a externa) — corrija a DIREÇÃO do import (inverta a dependência / use uma port). Esses arquivos estão bloqueados no Aplicar.` });
        }
        // Definição de pronto (P2): requisitos AUSENTES do conjunto (manifesto/teste/README). Como a falta
        // não se atribui a um arquivo, bloqueia o Aplicar de TODOS — o dev gera o que falta e re-roda. Não
        // entra no auto-reparo (é bloco de arquivo NOVO, que o reparo de type-drift descarta): só avisa.
        if (gate?.dodErrors?.length) {
          this.post({ type: "notice", level: "warn", message: `Definição de pronto: o projeto está incompleto (${gate.dodErrors.length} requisito(s) faltando) — Aplicar bloqueado até fechar. ${gate.dodErrors.join(" ")}` });
        }
        // Segurança (P2): achados de ALTO risco do bandit bloqueiam o arquivo. Fora do auto-reparo — o dev
        // corrige a vulnerabilidade (o prompt de reparo de type-drift não sabe endereçar segurança).
        if (gate?.securityErrors?.length) {
          this.post({ type: "notice", level: "warn", message: `Segurança: ${gate.securityErrors.length} arquivo(s) com achado de ALTO risco do bandit (severidade+confiança altas) — Aplicar bloqueado. Corrija a vulnerabilidade apontada no cartão.` });
        }
        // Reconciliação de dependências (P4): o DoD garante que o manifesto EXISTE; aqui garantimos que está
        // CORRETO — acrescenta ao requirements.txt gerado os pacotes que o código importa mas não declara.
        // Só com o projeto COMPLETO (uma geração parcial ainda não tem todos os imports). Não é gate: corrige
        // a proposta do manifesto e re-posta o cartão. Ver reconcileProjectRequirements.
        if (done === total) this.reconcileProjectRequirements();
        // Smoke test ADVISORY (P4): se o conjunto passou no gate estático (sem erros por-arquivo nem
        // amplos), tenta RODAR a suíte gerada no venv do workspace — o sinal "de fato roda". Nunca
        // bloqueia; degrada em silêncio sem venv/pytest/deps. NÃO roda se QUALQUER eixo do gate bloqueou:
        // além de compilação/contrato, um bloqueio de SEGURANÇA (bandit) ou de ARQUITETURA. O de segurança é
        // crítico — o gate marcou o arquivo como ALTO risco de EXECUÇÃO (shell injection / eval); rodar o
        // pytest importaria e EXECUTARIA justo o código que o gate recusou aplicar (o bandit é AST, não
        // executa — o smoke executaria). Achado da revisão adversarial.
        if (gate && gate.fileErrors.length === 0 && gate.projectErrors.length === 0 && !gate.securityErrors?.length && !gate.architectureErrors?.length) {
          await this.runProjectSmoke(project.language, taskId);
        }
        this.post({ type: "project/done" });
        if (done < total) {
          this.post({ type: "notice", level: "warn", message: `Projeto: ${done}/${total} arquivos gerados. Os que faltaram estão em vermelho — clique em "Aprovar e gerar" de novo para completar.` });
        }
      }
    }
    // Mantém o histórico limitado.
    if (this.history.length > 20) this.history = this.history.slice(-20);
  }

  // Gate workspace-wide do Modo Projeto (Onda 1). Materializa TODAS as propostas juntas numa árvore temp
  // (contida via safeWorkspacePath), semeia `__init__.py` sintéticos e roda compileall + mypy sobre o
  // CONJUNTO — pegando o drift de contrato que a validação por-arquivo (isolada) não vê. O resultado por
  // arquivo alimenta `entry.gateOk`; `applyProposal` já recusa `!gateOk` quando gateBlocksApply().
  // Degradação segura: se as ferramentas não rodam (sem python/mypy), o gate é CONSULTIVO — não bloqueia.
  private async runProjectGate(language: ProjectLanguage, architecture: ProjectArchitecture, complete: boolean): Promise<ProjectGateSummary | null> {
    const task = this.currentTask;
    if (!task || language !== "python") return null; // Onda 1: Python-only (compileall/mypy)
    // Espera as validações por-arquivo em voo antes de tocar em gateOk (senão uma advisory tardia
    // reescreveria o veredito do gate de volta para true — corrida real).
    await task.settleValidations();

    // Exclui células (.ipynb) e PARCIAIS (truncados): o parcial é conhecidamente incompleto e já tem
    // tratamento honesto próprio (pulado no "Aplicar tudo" + aviso no cartão) — um SyntaxError por corte
    // não deve virar bloqueio de gate, e materializá-lo poluiria a resolução do conjunto.
    const props = [...task.proposals.values()].filter((e) => !e.proposal.cell && !e.proposal.partial);
    const hasPy = props.some((e) => e.proposal.filePath.toLowerCase().endsWith(".py"));
    if (!hasPy) return null; // nada compilável — gate não se aplica

    const gateStart = Date.now(); // P3: span do gate (compileall/mypy/arquitetura/DoD/segurança)
    let root: string | undefined;
    try {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-gate-"));
      // Materializa a árvore (cada path CONTIDO na raiz temp) + __init__.py sintéticos. Compartilhado
      // com o smoke test (runProjectSmoke) — ver writeProjectTree.
      await this.writeProjectTree(root, props);

      const py = await this.resolveGatePython();
      // Onda 1.5: garante o mypy no venv ANTES de checar — sem ele o gate só teria compileall (sintaxe) e
      // ficaria "parcial", deixando passar o drift de contrato (o ImportError fantasma que derruba o app).
      await this.ensureGateMypy(py);
      // Garante o bandit no venv (best-effort, como o mypy) para o gate de segurança morder out-of-the-box.
      const securityMode = this.config.securityGate();
      if (securityMode !== "off") await this.ensureGateBandit(py);
      const timeoutMs = 120_000;
      const outputCap = 32_000; // teto amplo: um projeto MUITO drifado emite muitos erros; não truncar a atribuição
      const checks: GateCheckResult[] = [];

      // compileall (stdlib, gate:true): pega erro de SINTAXE em qualquer arquivo do conjunto.
      const compile = await runFileCheck({ id: "gate:compileall", label: "compileall", gate: true }, py, ["-m", "compileall", "-q", "."], { cwd: root, timeoutMs, outputCap });
      checks.push({ result: compile, errors: parseCompileallErrors(compile.output, root) });

      // mypy (gate:true quando instalado): pega o DRIFT de contrato (import/atributo fantasma) cross-file.
      // --ignore-missing-imports neutraliza o ruído de deps de terceiros (fastapi/jinja não instalados no
      // temp) preservando os erros de módulos DESTE projeto. Não instalado → skipped (consultivo).
      let mypy = await runFileCheck(
        { id: "gate:mypy", label: "mypy", gate: true },
        py,
        ["-m", "mypy", "--ignore-missing-imports", "--no-error-summary", "--no-color-output", "--hide-error-context", "--no-pretty", "."],
        { cwd: root, timeoutMs, outputCap }
      );
      if (mypyUnavailable(mypy)) mypy = { ...mypy, status: "skipped", reason: "mypy não instalado (gate consultivo)" };
      const mypyErrors = mypy.status === "failed" ? parseMypyErrors(mypy.output, root) : new Map<string, string[]>();
      // Defesa em profundidade: mypy que reprovou SEM nenhum erro `path:linha` atribuível não type-checou
      // — ABORTOU (fatal/coleta, ex.: exit 2). Um type-check real sempre emite linhas atribuíveis. Tratar
      // como consultivo (skipped) em vez de deixar passar mascarado: o resumo vira "parcial", não "verde".
      if (mypy.status === "failed" && mypyErrors.size === 0) {
        mypy = { ...mypy, status: "skipped", reason: "mypy não pôde analisar (abort/fatal) — gate consultivo" };
      }
      checks.push({ result: mypy, errors: mypyErrors });

      const gate = summarizeGate(checks); // SÓ toolchain (compileall/mypy) → advisory/resumo honestos

      // Gate de ARQUITETURA (P2): a REGRA DE OURO — a camada interna (domínio/entidades/model) não pode
      // importar a externa (adapters/infra/repository). O mypy não pega (importar na direção errada tipa e
      // compila). PURO sobre o conteúdo das propostas (roda até sem Python). Fica SEPARADO do toolchain:
      // BLOQUEIA o Aplicar, mas (1) FORA do summarizeGate — para não poluir advisory/parcial quando só ele
      // roda; e (2) FORA do auto-reparo de type-drift — cujo prompt "reuse o contrato" empurraria a
      // re-violar. O dev corrige a DIREÇÃO do import (inverter a dependência / usar uma port).
      const violations = findLayerViolations(
        props.map((e) => ({ path: normGatePath(e.proposal.filePath), content: e.proposal.modified })),
        architecture
      );
      const architectureErrors = violations.map((v) => ({
        path: v.path,
        errors: [`viola a arquitetura ${architecture}: ${LAYER_RULE[architecture]}. Import(s) proibido(s) da camada externa: ${v.imports.join(", ")}.`],
      }));

      // Definição de PRONTO (DoD, P2): requisitos AUSENTES do CONJUNTO (manifesto de deps / qualquer teste /
      // README com "como rodar"). Diferente da arquitetura (que culpa UM arquivo), a falta é do conjunto —
      // não se atribui a um arquivo. Só avalia quando COMPLETO (todo o blueprint gerado); geração parcial
      // (falha do provedor) não deve bloquear. O universo do DoD é o PROJETO INTEIRO — as propostas desta
      // rodada (INCLUSIVE as parciais/truncadas, que aqui entram por PRESENÇA — não pelo `props` filtrado, que
      // as descarta) MAIS os arquivos já APLICADOS em rodadas anteriores. Sem isso o DoD acusaria como ausente
      // um manifesto/README que só truncou ou que já foi aplicado (falsos-positivos da revisão adversarial).
      // Quando algo falta de fato, FECHA o Aplicar de TODOS — bloqueio + aviso, SEM auto-reparo (o que falta é
      // bloco de arquivo NOVO, que o reparo de type-drift descarta).
      const dodProposals = [...task.proposals.values()]
        .filter((e) => !e.proposal.cell)
        .map((e) => ({ path: normGatePath(e.proposal.filePath), content: e.proposal.modified, partial: e.proposal.partial }));
      const appliedPaths = (this.projectSession?.files ?? [])
        .filter((f) => f.status === "applied")
        .map((f) => normGatePath(f.path));
      const dod = evaluateDodGate({ complete, enabled: this.config.definitionOfDone(), language, proposals: dodProposals, appliedPaths });
      const dodErrors = dod.errors;
      const dodBlocksAll = dod.blocks;

      // Gate de SEGURANÇA (P2): SAST (bandit) sobre a árvore materializada. Conservador — só severidade ALTA
      // E confiança ALTA BLOQUEIA (senha hardcoded, eval de input, cripto fraca); o resto é advisory. O bandit
      // analisa por AST (NÃO executa o código, ao contrário do smoke test). SEPARADO do toolchain (fora do
      // summarizeGate/auto-reparo), como a arquitetura. bandit ausente/sem relatório → null (fail-open).
      const security = securityMode !== "off" ? await this.runSecurityScan(py, root, securityMode) : null;
      const securityErrors = security?.blocking ?? [];
      const securityAdvisories = security?.advisories ?? [];

      // Propaga por-arquivo para gateOk: bloqueia arquivo com erro do TOOLCHAIN (atribuído), violação de
      // arquitetura OU achado de segurança bloqueante; o DoD (ausência project-level) bloqueia TODOS.
      // gatePassed([]) = true no caso comum; um validador de skill gate:true reprovado persiste.
      const blocked = new Set([...gate.fileErrors.map((f) => f.path), ...violations.map((v) => v.path), ...securityErrors.map((s) => s.path)]);
      for (const e of props) {
        e.gateOk = gatePassed(e.results ?? []) && !blocked.has(normGatePath(e.proposal.filePath)) && !dodBlocksAll;
      }

      const totalBlocked = gate.fileErrors.length + architectureErrors.length + securityErrors.length;
      const fileParts: string[] = [];
      if (gate.fileErrors.length) fileParts.push(`${gate.fileErrors.length} de compilação/contrato`);
      if (architectureErrors.length) fileParts.push(`${architectureErrors.length} de arquitetura (regra de camadas)`);
      if (securityErrors.length) fileParts.push(`${securityErrors.length} de segurança (bandit ALTO)`);
      const summary = dodBlocksAll
        ? `Definição de pronto: o projeto está incompleto (${dodErrors.length} requisito(s) faltando) — Aplicar bloqueado até fechar.${totalBlocked > 0 ? ` Também ${totalBlocked} arquivo(s) com erro (${fileParts.join(" · ")}).` : ""}`
        : totalBlocked > 0
          ? `Gate reprovou: ${totalBlocked} arquivo(s) bloqueados${fileParts.length ? ` — ${fileParts.join(" · ")}` : ""}. Corrija antes de aplicar.`
          : securityAdvisories.length
            ? `${gate.summary} · segurança: ${securityAdvisories.length} aviso(s) do bandit (não bloqueiam).`
            : gate.summary;
      // A UI pinta os cartões de compilação/arquitetura/segurança (por-arquivo) e mostra DoD + avisos de
      // segurança como project-level; o auto-reparo (que consome o gate RETORNADO) recebe só os fileErrors.
      const securityView = securityAdvisories.length > 12 ? [...securityAdvisories.slice(0, 12), `… e mais ${securityAdvisories.length - 12} aviso(s) — veja o log de diagnóstico.`] : securityAdvisories;
      this.post({ type: "project/gate", advisory: gate.advisory, partial: gate.partial, summary, files: [...gate.fileErrors, ...architectureErrors, ...securityErrors], projectErrors: gate.projectErrors, dod: dodErrors, security: securityView });
      log.info(`Gate do projeto: ${summary} (rodou: ${gate.ran.join(", ") || "nada"}${architectureErrors.length ? ", camadas" : ""}${dodBlocksAll ? ", definição-de-pronto" : ""}${security ? ", segurança" : ""}; pulou: ${gate.skipped.join(", ") || "nada"})`);
      return { ...gate, summary, architectureErrors, dodErrors, securityErrors, securityAdvisories };
    } catch (e) {
      // Falha do PRÓPRIO gate (temp/exec) nunca deve travar a entrega — degrada para consultivo.
      log.warn("Gate do projeto falhou ao executar — seguindo consultivo", e);
      this.post({ type: "project/gate", advisory: true, partial: false, summary: "Não consegui rodar o gate de compilação (ambiente) — nada foi bloqueado.", files: [], projectErrors: [], dod: [], security: [] });
      return null;
    } finally {
      if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
      this.obs.record({ type: "phase.timing", taskId: task.taskId, phase: "gate", durationMs: Date.now() - gateStart });
    }
  }

  // Materializa as propostas de arquivo numa árvore temp (cada path CONTIDO na raiz via safeWorkspacePath)
  // e semeia os __init__.py sintéticos para os imports cross-file resolverem. COMPARTILHADO pelo gate
  // estático (compileall/mypy) e pelo smoke test (pytest). Retorna os caminhos relativos materializados.
  private async writeProjectTree(root: string, props: { proposal: { filePath: string; modified: string } }[]): Promise<string[]> {
    const relPaths: string[] = [];
    for (const e of props) {
      const abs = safeWorkspacePath(root, e.proposal.filePath);
      if (!abs) continue;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, e.proposal.modified, "utf8");
      relPaths.push(normGatePath(e.proposal.filePath));
    }
    for (const dir of syntheticInitDirs(relPaths)) {
      const abs = safeWorkspacePath(root, `${dir}/__init__.py`);
      if (!abs) continue;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, "", "utf8");
    }
    return relPaths;
  }

  // Smoke test ADVISORY (P4): depois do gate estático verde, tenta RODAR a suíte gerada (pytest) contra a
  // árvore materializada usando o VENV do workspace — o sinal "de fato roda", além de "compila e tipa". As
  // deps de terceiros resolvem do venv; os módulos do projeto, da árvore temp (cwd). NUNCA bloqueia o
  // Aplicar e NUNCA instala nada (egress deny-by-default): sem venv/pytest/deps, degrada para advisory.
  // Respeita forge.test.enabled e só roda quando há suíte gerada (test_*.py / *_test.py). O `taskId`
  // ancora o aviso na resposta da geração.
  private async runProjectSmoke(language: ProjectLanguage, taskId: string): Promise<void> {
    if (language !== "python" || !this.config.test().enabled) return;
    const task = this.currentTask;
    if (!task) return;
    const props = [...task.proposals.values()].filter((e) => !e.proposal.cell && !e.proposal.partial);
    const hasTests = props.some((e) => /(^|\/)test_[^/]*\.py$|_test\.py$/i.test(normGatePath(e.proposal.filePath)));
    if (!hasTests) return; // sem suíte gerada — nada a rodar
    const ws = this.workspaceRoot();
    const venvPy = ws ? findVenvPython(ws, process.platform === "win32", existsSync, process.env.VIRTUAL_ENV) : undefined;
    if (!venvPy) {
      this.post({ type: "stream/notice", taskId, level: "info", message: "Smoke test dos testes gerados pulado: sem venv do workspace. Rode Preparar ambiente para validar que o projeto de fato roda." });
      return;
    }
    let root: string | undefined;
    try {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-smoke-"));
      await this.writeProjectTree(root, props);
      const timeoutMs = this.config.run().timeoutSeconds * 1000;
      // -p no:cacheprovider: não escreve .pytest_cache na árvore temp (que é descartada mesmo).
      const result = await runFileCheck(
        { id: "smoke:pytest", label: "pytest (smoke)", gate: false },
        venvPy,
        ["-m", "pytest", "-q", "-p", "no:cacheprovider"],
        { cwd: root, timeoutMs, outputCap: 8000 }
      );
      const verdict = summarizeSmoke(result);
      this.post({ type: "stream/notice", taskId, level: verdict.level, message: verdict.message });
      log.info(`Smoke test do projeto: ${verdict.message}`);
    } catch (e) {
      // Falha do PRÓPRIO smoke (temp/exec) nunca trava a entrega — é advisory.
      log.warn("Smoke test do projeto falhou ao executar — ignorado (advisory)", e);
    } finally {
      if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // Reconciliação de dependências (P4): depois do gate, confere se o requirements.txt GERADO declara os
  // pacotes que o código gerado de fato IMPORTA e acrescenta os AUSENTES à proposta do manifesto. O DoD
  // garante que o manifesto EXISTE; isto garante que está CORRETO — o gap que faz "instala e roda" falhar.
  // Auto-corrige a proposta (idempotente/conservador via reconcileRequirements) e re-posta o cartão
  // (stream/proposalUpdate, o mesmo do auto-reparo). pyproject-only fica de fora (editar TOML é frágil; o
  // Preparar ambiente ainda completa no install). PURO na decisão (reconcileRequirements); aqui só coleta e
  // reage. Nunca bloqueia. Chamado só com o projeto COMPLETO.
  private reconcileProjectRequirements(): void {
    if (!this.config.reconcileDependencies()) return;
    const task = this.currentTask;
    if (!task) return;
    // Exclui células e parciais (o parcial pode ter imports cortados — reconciliar sobre ele erraria).
    const props = [...task.proposals.values()].filter((e) => !e.proposal.cell && !e.proposal.partial);
    const isReqTxt = (p: string) => /(^|\/)requirements[^/]*\.txt$/i.test(p) || /(^|\/)requirements\/[^/]+\.txt$/i.test(p);
    const manifest = props.find((e) => isReqTxt(normGatePath(e.proposal.filePath)));
    if (!manifest) return; // sem requirements.txt (pyproject-only / ausente) → fora do escopo desta reconciliação
    const pyFiles = props
      .filter((e) => e.proposal.filePath.toLowerCase().endsWith(".py"))
      .map((e) => ({ path: normGatePath(e.proposal.filePath), content: e.proposal.modified }));
    if (pyFiles.length === 0) return; // nada de Python → nada a reconciliar
    // Caminhos do projeto INTEIRO para os módulos locais: propostas desta rodada + arquivos já aplicados
    // (só o path basta para reconhecer um módulo local — sem I/O).
    const projectPaths = [
      ...props.map((e) => normGatePath(e.proposal.filePath)),
      ...(this.projectSession?.files ?? []).filter((f) => f.status === "applied").map((f) => normGatePath(f.path)),
    ];
    let content: string;
    let added: string[];
    try {
      ({ content, added } = reconcileRequirements(pyFiles, projectPaths, manifest.proposal.modified));
    } catch (e) {
      log.warn("Reconciliação de dependências falhou — seguindo (não bloqueia)", e);
      return;
    }
    if (added.length === 0) return; // manifesto já coerente
    // Auto-corrige a proposta NO LUGAR (mesmo id) e re-posta o cartão para refletir o arquivo corrigido.
    manifest.proposal = { ...manifest.proposal, modified: content };
    this.post({ type: "stream/proposalUpdate", proposal: manifest.proposal });
    this.post({ type: "notice", level: "info", message: `Reconciliação de dependências: adicionei ao ${manifest.proposal.filePath} ${added.length} pacote(s) usado(s) no código mas não declarado(s): ${added.join(", ")}. Revise antes de aplicar.` });
    log.info(`Reconciliação: +${added.length} em ${manifest.proposal.filePath} (${added.join(", ")})`);
  }

  // Onda 2 — AUTO-REPARO dirigido pelo gate. Recebe o veredito do gate (arquivos reprovados + erros do
  // mypy) e re-pede ao modelo SÓ esses arquivos, injetando o CONTEÚDO REAL dos arquivos que passaram (o
  // contrato). Cada arquivo regenerado SUBSTITUI a proposta existente NO LUGAR (mesmo id → sem cartão
  // duplicado; volta a "pending"). Retorna quantos arquivos foram efetivamente trocados. Falha do provedor
  // ou nenhum alvo casável → 0 (o chamador para o loop). O gate roda de novo depois e decide o gateOk.
  private async repairProjectFromGate(
    gate: ProjectGateSummary,
    project: { language: ProjectLanguage; architecture: ProjectArchitecture; files?: BlueprintFile[] },
    runtime: ProviderRuntimeConfig
  ): Promise<number> {
    const task = this.currentTask;
    if (!task) return 0;
    // Só arquivos (não células) e não-parciais: um parcial já tem tratamento próprio e não é contrato confiável.
    const entries = [...task.proposals.values()].filter((e) => !e.proposal.cell && !e.proposal.partial);
    const byPath = new Map(entries.map((e) => [normRepairPath(e.proposal.filePath), e.proposal.modified] as const));
    const targets = selectRepairTargets(gate.fileErrors, byPath, project.files ?? []);
    if (targets.length === 0) return 0;

    const system = buildProjectRepairPrompt(this.workspaceName(), project.language, project.architecture, targets);
    const provider = createProvider(runtime, this.egress);
    const headers = this.buildTraceHeaders([], runtime.modelId, runtime.type, runtime.reasoningEffort, "project");
    let text = "";
    try {
      for await (const chunk of provider.createMessage(system, [{ role: "user", content: "Corrija os arquivos reprovados conforme as instruções e os contratos reais acima." }], {
        timeoutMs: runtime.timeoutSeconds * 1000,
        extraHeaders: headers,
      })) {
        if (chunk.kind === "text") text += chunk.text;
        else if (chunk.kind === "error") {
          log.warn("Auto-reparo do projeto: erro do provedor", chunk.message);
          break;
        }
      }
    } catch (e) {
      log.warn("Auto-reparo do projeto falhou ao gerar", e);
      return 0;
    }

    // Aplica só os blocos cujos caminhos estavam no reparo — substitui a proposta existente no lugar.
    const targetPaths = new Set(targets.map((t) => t.path));
    let repaired = 0;
    for (const b of parseFileBlocks(text)) {
      const bp = normRepairPath(b.path);
      if (!targetPaths.has(bp)) continue; // ignora arquivos fora da lista de reparo
      const entry = entries.find((e) => normRepairPath(e.proposal.filePath) === bp);
      if (!entry) continue;
      entry.proposal.modified = b.content;
      entry.proposal.partial = false;
      entry.results = []; // a validação por-arquivo anterior é do conteúdo DRIFADO — obsoleta; limpa p/ o re-gate
      entry.gateOk = true; // reset otimista; o próximo runProjectGate reavalia e bloqueia se ainda falhar
      this.post({ type: "stream/proposalUpdate", proposal: entry.proposal });
      repaired++;
    }
    return repaired;
  }

  // Resolve um comando de Python utilizável para o gate: venv do workspace primeiro (maior chance de ter
  // mypy + deps), senão sonda `python`/`python3`/`py`. null → nenhum encontrado (o gate ficará consultivo
  // via ENOENT). Uma sondagem barata evita rodar compileall/mypy contra um comando inexistente.
  private async resolveGatePython(): Promise<string> {
    const ws = this.workspaceRoot();
    const isWin = process.platform === "win32";
    const venv = ws ? findVenvPython(ws, isWin, existsSync, process.env.VIRTUAL_ENV) : undefined;
    const candidates = [venv, "python", "python3", "py"].filter((c): c is string => !!c);
    for (const cand of candidates) {
      const probe = await runFileCheck({ id: "probe", label: "python", gate: false }, cand, ["--version"], { timeoutMs: 15_000 });
      if (probe.status !== "skipped") return cand; // achou (rodou; ENOENT vira skipped)
    }
    return candidates[0] ?? "python"; // nada respondeu: usa o 1º e deixa o ENOENT tornar o gate consultivo
  }

  // Onda 1.5: garante o mypy no venv do workspace (best-effort). O gate só pega o DRIFT de contrato
  // cross-file via mypy; compileall só vê sintaxe. Sem mypy o gate fica "parcial" e não bloqueia — então
  // um projeto que não roda (import fantasma) passaria. Instala SÓ quando o python do gate É o venv do
  // workspace (nunca polui o python global). Falha/offline → não instala, gate degrada para "parcial".
  private async ensureGateMypy(py: string): Promise<void> {
    try {
      const ws = this.workspaceRoot();
      if (!ws) return;
      const isWin = process.platform === "win32";
      const venv = findVenvPython(ws, isWin, existsSync, process.env.VIRTUAL_ENV);
      if (!venv || py !== venv) return; // só num venv do workspace; nunca no python global/system
      const probe = await runFileCheck({ id: "probe", label: "mypy", gate: false }, py, ["-m", "mypy", "--version"], { timeoutMs: 15_000 });
      if (probe.status === "ok") return; // mypy já disponível no venv
      if (this.runService.isBusy()) return; // não atropela uma execução em andamento
      // Best-effort: se a instalação não iniciar/falhar (offline, sem índice pip), o gate fica "parcial".
      await this.runService.runCommand("gate · mypy (coerência)", buildMypyInstall(venv), this.config.env().timeoutSeconds * 1000);
    } catch (e) {
      log.warn("Gate: não consegui garantir o mypy no venv — seguindo (o gate pode ficar parcial)", e);
    }
  }

  // Garante o bandit no venv do workspace (best-effort, espelho do ensureGateMypy). Só num venv do
  // workspace (nunca no python global/system). Falha/offline → não instala; o gate de segurança fica
  // consultivo (não bloqueia). Chamado só quando forge.gate.security != "off".
  private async ensureGateBandit(py: string): Promise<void> {
    try {
      const ws = this.workspaceRoot();
      if (!ws) return;
      const isWin = process.platform === "win32";
      const venv = findVenvPython(ws, isWin, existsSync, process.env.VIRTUAL_ENV);
      if (!venv || py !== venv) return; // só num venv do workspace; nunca no python global/system
      const probe = await runFileCheck({ id: "probe", label: "bandit", gate: false }, py, ["-m", "bandit", "--version"], { timeoutMs: 15_000 });
      if (probe.status === "ok") return; // bandit já disponível no venv
      if (this.runService.isBusy()) return; // não atropela uma execução em andamento
      await this.runService.runCommand("gate · bandit (segurança)", buildBanditInstall(venv), this.config.env().timeoutSeconds * 1000);
    } catch (e) {
      log.warn("Gate: não consegui garantir o bandit no venv — seguindo (segurança consultiva)", e);
    }
  }

  // Gate de SEGURANÇA (P2): roda o bandit (SAST) sobre a árvore temp materializada e classifica os achados
  // de forma conservadora (só severidade+confiança ALTAS bloqueiam). bandit ausente/sem relatório → null
  // (fail-open: nada bloqueia). Análise por AST — NÃO executa o código gerado (distinto do smoke test).
  private async runSecurityScan(py: string, root: string, mode: SecurityMode): Promise<{ blocking: { path: string; errors: string[] }[]; advisories: string[] } | null> {
    // O relatório vai para um ARQUIVO (`-o`), NÃO para o stdout. Isso o torna imune a: (1) fusão de
    // stdout+stderr do runner — um aviso do interpretador com `{`/`}` quebraria o recorte do JSON; (2)
    // truncamento por outputCap; (3) frases benignas do código escaneado ("no such file or directory")
    // confundindo a heurística de disponibilidade. Achados da revisão adversarial. O `.json` fica DENTRO da
    // árvore temp (descartada no finally) e o bandit só varre `.py`, então não se escaneia a si mesmo.
    const reportPath = path.join(root, ".forge-bandit-report.json");
    // -q silencia o progresso; -f json + -o escreve o relatório; -r . varre a árvore. Exit 1 quando ACHA
    // issues é NORMAL — o veredito vem do relatório, não do código de saída.
    const result = await runFileCheck(
      { id: "gate:bandit", label: "bandit", gate: false },
      py,
      ["-m", "bandit", "-r", ".", "-f", "json", "-o", reportPath, "-q"],
      { cwd: root, timeoutMs: 120_000, outputCap: 8_000 }
    );
    if (result.status === "skipped") return null; // ENOENT (sem python) / timeout → inconclusivo (fail-open)
    // Relatório ausente/ilegível (bandit não instalado → não escreve arquivo; ou crash) → null (fail-open).
    // parseBanditReport distingue "sem relatório" (null) de "rodou e nada achou" ([]) — um relatório
    // truncado nunca é confundido com varredura limpa.
    const reportRaw = await fs.readFile(reportPath, "utf8").catch(() => "");
    const findings = parseBanditReport(reportRaw);
    if (findings === null) return null;
    // bandit emite caminhos relativos ao cwd (=root) por causa do `-r .`; o ramo absoluto é defensivo.
    const rel = (p: string): string => {
      const raw = (p ?? "").trim();
      return raw && (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) ? normGatePath(path.relative(root, raw)) : normGatePath(raw);
    };
    return splitSecurityFindings(findings.map((f) => ({ ...f, path: rel(f.path) })), mode);
  }

  private workspaceName(): string {
    return vscode.workspace.workspaceFolders?.[0]?.name ?? "workspace";
  }

  // /resumir: compacta o histórico do host num turno sintético — libera janela sem perder o fio.
  // One-shot estruturado (mesmo endurecimento do charter/blueprint: esforço low + temperature 0,
  // stripHarmony, resgate do canal de raciocínio) — nunca substitui o histórico por lixo.
  private async summarizeHistory(): Promise<void> {
    if (this.history.length === 0) {
      this.post({ type: "notice", level: "info", message: "Nada para resumir — o histórico está vazio." });
      return;
    }
    if (!(await this.ensureSession())) {
      this.post({ type: "notice", level: "error", message: "Licença requerida para resumir." });
      return;
    }
    const runtime = await this.runtimeProviderConfig();
    if (!runtime) {
      this.post({ type: "notice", level: "warn", message: "Configure um provedor antes de resumir." });
      return;
    }
    try {
      this.egress.assertAllowed(runtime.baseUrl ?? (runtime.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"));
    } catch (e) {
      this.post({ type: "notice", level: "error", message: (e as Error)?.message ?? String(e) });
      return;
    }
    const turns = this.history.length;
    const snapshot = this.history; // referência p/ detectar mutação concorrente (push/clear/slice)
    const full = this.history.map((h) => `${h.role === "user" ? "DEV" : "FORGE"}: ${h.content}`).join("\n\n");
    // Teto defensivo mantendo a CAUDA: o corte pelo começo descartaria exatamente os turnos mais
    // recentes — as decisões que o /resumir existe para preservar (prioridade invertida confirmada
    // em revisão; mesmo espírito do historyWithinBudget do assembler).
    const convo = full.length > 24_000 ? full.slice(-24_000) : full;
    const taskId = `summarize_${this.sessionId}_${Date.now()}`;
    const started = Date.now();
    const sr = this.structuredRuntime(runtime);
    const usage = { inputTokens: 0, outputTokens: 0 };
    let text = "";
    let reasoning = "";
    let error: string | undefined;
    try {
      const provider = createProvider(sr, this.egress);
      const headers = this.buildTraceHeaders([], sr.modelId, sr.type, sr.reasoningEffort, "normal");
      for await (const chunk of provider.createMessage(buildSummarizeSystemPrompt(), [{ role: "user", content: convo }], {
        timeoutMs: sr.timeoutSeconds * 1000,
        extraHeaders: headers,
        // NÃO-streaming: raciocínio isolado (sem vazamento harmony no resumo) e finish_reason confiável.
        streaming: false,
      })) {
        if (chunk.kind === "text") text += chunk.text;
        else if (chunk.kind === "reasoning") reasoning += chunk.text;
        else if (chunk.kind === "usage") {
          usage.inputTokens += chunk.inputTokens;
          usage.outputTokens += chunk.outputTokens;
        } else if (chunk.kind === "error") {
          error = chunk.message;
          break;
        }
      }
      if (error) {
        this.post({ type: "notice", level: "error", message: `Não consegui resumir: ${error}` });
        return;
      }
      let clean = stripHarmony(text);
      if (!clean.trim() && reasoning.trim()) clean = extractFinalChannel(reasoning) ?? "";
      if (!clean.trim()) {
        this.post({ type: "notice", level: "error", message: "O modelo não retornou o resumo — o histórico foi mantido intacto. Tente de novo." });
        return;
      }
      // Substitui os turnos pelo resumo SÓ com um resumo válido em mãos E se o histórico não mudou
      // durante o stream (o dev pode ter enviado mensagem, aplicado proposta ou dado /limpar nesse
      // meio-tempo — sobrescrever perderia turnos ou ressuscitaria conversa apagada).
      if (this.history !== snapshot || this.history.length !== turns) {
        this.post({ type: "notice", level: "warn", message: "O histórico mudou durante o resumo — descartei o resumo para não perder nada. Rode /resumir de novo." });
        return;
      }
      this.history = [{ role: "user", content: `Contexto (resumo da conversa anterior):\n${clean}` }];
      this.post({ type: "chat/summarized", summary: clean, turns });
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
      this.post({ type: "notice", level: "error", message: `Não consegui resumir: ${error}` });
    } finally {
      const end: ObsEvent = { type: "generation.end", taskId, durationMs: Date.now() - started, model: sr.modelId, input: convo.slice(0, 2000), output: text, usage, proposals: 0, error };
      this.trackUsage(end);
      this.obs.record(end);
    }
  }

  // /contexto: relatório do orçamento da janela com os MESMOS cálculos da geração (deriveBudget +
  // os mesmos blocos pinned) — números que o dev pode confiar, não uma segunda estimativa divergente.
  private async reportContext(): Promise<void> {
    const runtime = await this.runtimeProviderConfig();
    if (!runtime) {
      this.post({ type: "notice", level: "warn", message: "Configure um provedor para ver o orçamento de contexto." });
      return;
    }
    const [stack, sources] = await Promise.all([this.detectWorkspaceStack(), this.loadProfileSources()]);
    const body = sources.map(stripFrontmatter).filter((s) => s.trim()).join("\n\n");
    const projectProfile = renderProfileBlock(
      [renderStackBlock(stack), roleGuidance(resolveRole(sources)), body].filter((s) => s.trim()).join("\n\n")
    );
    const basePrompt = buildBasePrompt(this.workspaceName());
    const budget = deriveBudget(getModelMeta(runtime.type, runtime.modelId), runtime.maxTokens ?? 0, this.config.provider().maxContextWindow);
    const rag = this.rag.status();
    this.post({
      type: "context/report",
      report: {
        modelId: runtime.modelId,
        contextWindow: budget.contextWindow,
        outputReserve: budget.outputReserve,
        inputBudget: budget.inputBudget,
        pinnedTokens: estimateTokens(basePrompt) + estimateTokens(projectProfile),
        historyTokens: estimateTokensOf(this.history.map((h) => h.content)),
        historyTurns: this.history.length,
        attachments: this.pendingAttachments.length,
        attachmentTokens: estimateTokensOf(this.pendingAttachments.map((a) => a.content)),
        ragChunks: rag.chunks,
        sessionInputTokens: this.sessionUsage.input,
        sessionOutputTokens: this.sessionUsage.output,
      },
    });
  }

  // Acumula o usage REAL (prompt/completion tokens) das gerações da sessão — alimenta o /contexto.
  private trackUsage(e: ObsEvent): void {
    if (e.type === "generation.end" && "usage" in e && e.usage) {
      this.sessionUsage.input += e.usage.inputTokens ?? 0;
      this.sessionUsage.output += e.usage.outputTokens ?? 0;
    }
  }

  // Headers x-forge-* propagados ao gateway (RF-063/064). Apenas metadados — o
  // gateway transforma em atributos do trace no Langfuse (userId = login).
  private buildTraceHeaders(
    activatedSkills: string[],
    modelId: string,
    providerType: string,
    reasoningEffort?: ReasoningEffort,
    mode?: string
  ): Record<string, string> {
    const meta = this.context.globalState.get<{ org: string; subject: string }>(GS_LICENSE_META);
    const identity = this.resolveIdentity();
    return {
      "x-forge-email": identity.email ?? "", // identidade principal (userId no Langfuse)
      "x-forge-login": osLogin(), // metadado secundário
      "x-forge-session": this.sessionId,
      "x-forge-org": meta?.org ?? "",
      "x-forge-subject": meta?.subject ?? "",
      "x-forge-provider": providerType,
      "x-forge-model": modelId,
      "x-forge-skills": activatedSkills.join(","),
      "x-forge-effort": reasoningEffort ?? "", // esforço de raciocínio aplicado (vazio quando N/A)
      "x-forge-mode": mode ?? "", // normal | tdd | project | review
    };
  }

  // Contexto recuperado: trechos relevantes do codebase (RAG: embeddings ou
  // BM25 lexical) + o conteúdo do editor ativo (RF-041, RNF-009).
  private async gatherContext(query: string): Promise<string> {
    const parts: string[] = [];

    try {
      const cfg = this.config.rag();
      if (cfg.enabled) {
        const hits = await this.rag.retrieve(query, cfg.maxChunks);
        if (hits.length > 0) {
          const blocks = hits
            .map((h) => {
              const head = `// ${h.chunk.relPath}:${h.chunk.startLine}-${h.chunk.endLine}${h.chunk.symbol ? " — " + h.chunk.symbol : ""}`;
              const body = h.chunk.text.length > 1200 ? h.chunk.text.slice(0, 1200) + "\n// … (truncado)" : h.chunk.text;
              return `${head}\n${body}`;
            })
            .join("\n\n");
          parts.push(`Trechos relevantes do codebase (${this.rag.status().mode}, top ${hits.length}):\n${blocks}`);
        }
      }
    } catch (err) {
      log.warn("RAG: recuperação falhou, seguindo só com o editor ativo.", err);
    }

    // Notebook ativo: lista as células com índice ABSOLUTO (para edição por célula).
    const nbEditor = vscode.window.activeNotebookEditor;
    if (nbEditor) {
      const nb = nbEditor.notebook;
      const rel = this.workspaceRoot() ? path.relative(this.workspaceRoot()!, nb.uri.fsPath) : nb.uri.fsPath;
      const cells = nb
        .getCells()
        .map((c) => {
          const kind = c.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code";
          const src = c.document.getText();
          const preview = src.length > 600 ? src.slice(0, 600) + "\n# … (truncado)" : src;
          return `[${c.index}] (${kind})\n${preview}`;
        })
        .join("\n\n");
      parts.push(`Notebook aberto: ${rel} (${nb.cellCount} células; use op=replace index=N ou op=add after=N):\n${cells}`);
      return parts.join("\n\n");
    }

    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === "file") {
      const doc = editor.document;
      const rel = this.workspaceRoot() ? path.relative(this.workspaceRoot()!, doc.uri.fsPath) : doc.fileName;
      const text = doc.getText();
      const clipped = text.length > 5000 ? text.slice(0, 5000) + "\n# … (truncado)" : text;
      parts.push(`Arquivo aberto: ${rel}\n\`\`\`\n${clipped}\n\`\`\``);
    }
    return parts.join("\n\n");
  }

  // ---- anexos de contexto (workspace / upload / seleção) ---------------------

  private postAttachments(): void {
    this.post({
      type: "context/attachments",
      items: this.pendingAttachments.map((a) => ({ id: a.id, label: a.label, bytes: a.content.length, kind: a.kind })),
    });
  }

  private addAttachment(label: string, kind: "workspace" | "upload" | "selection" | "search", content: string): void {
    const capped = content.length > 16000 ? content.slice(0, 16000) + "\n… (truncado)" : content;
    this.pendingAttachments.push({ id: `att_${++this.attachmentSeq}`, label, kind, content: capped });
    if (this.pendingAttachments.length > 8) this.pendingAttachments = this.pendingAttachments.slice(-8);
    this.postAttachments();
  }

  async pickWorkspaceFile(): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) {
      this.post({ type: "notice", level: "warn", message: "Abra uma pasta no VSCode para anexar arquivos do workspace." });
      return;
    }
    const uris = await vscode.workspace.findFiles("**/*", "{**/node_modules/**,**/.git/**,**/dist/**,**/.venv/**,**/__pycache__/**}", 3000);
    const items = uris.map((u) => ({ label: path.relative(ws, u.fsPath).split(path.sep).join("/"), uri: u }));
    const pick = await vscode.window.showQuickPick(items.map((i) => i.label), { placeHolder: "Anexar arquivo do workspace ao contexto" });
    if (!pick) return;
    const chosen = items.find((i) => i.label === pick);
    if (!chosen) return;
    try {
      this.addAttachment(pick, "workspace", await fs.readFile(chosen.uri.fsPath, "utf8"));
    } catch {
      this.post({ type: "notice", level: "error", message: `Não foi possível ler ${pick} (binário?).` });
    }
  }

  async pickLocalFile(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Anexar ao FORGE" });
    if (!picks || !picks[0]) return;
    const uri = picks[0];
    try {
      this.addAttachment(path.basename(uri.fsPath), "upload", await fs.readFile(uri.fsPath, "utf8"));
    } catch {
      this.post({ type: "notice", level: "error", message: "Não foi possível ler o arquivo (provavelmente binário). Suportado: texto." });
    }
  }

  async addSelectionAttachment(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.post({ type: "notice", level: "warn", message: "Selecione um trecho no editor para anexar." });
      return;
    }
    const rel = this.workspaceRoot() ? path.relative(this.workspaceRoot()!, editor.document.uri.fsPath) : editor.document.fileName;
    this.addAttachment(`${path.basename(rel)} (seleção)`, "selection", editor.document.getText(editor.selection));
  }

  // Anexa a seleção do TERMINAL. Não há API pública para ler a seleção de um terminal (a interface
  // Terminal não expõe `selection`), então o caminho realista é copiá-la via comando do workbench e ler
  // o clipboard — SEMPRE restaurando o conteúdo anterior depois (efeito colateral zero, mesmo sob erro).
  async addTerminalSelectionAttachment(): Promise<void> {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      this.post({ type: "notice", level: "warn", message: "Nenhum terminal ativo. Abra um terminal e selecione um trecho para anexar." });
      return;
    }
    const prev = await vscode.env.clipboard.readText();
    let sel = prev;
    try {
      terminal.show(true); // torna o terminal ativo VISÍVEL sem roubar o foco do chat
      await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
      // A escrita no clipboard pode ser assíncrona ALÉM do await do comando (renderer/pty) — relê por um
      // curto período até o valor mudar, evitando um falso-negativo intermitente por corrida.
      for (let i = 0; i < 8 && sel === prev; i++) {
        await new Promise((r) => setTimeout(r, 25));
        sel = await vscode.env.clipboard.readText();
      }
    } finally {
      await vscode.env.clipboard.writeText(prev); // restaura o clipboard do usuário haja o que houver
    }
    if (!sel || sel === prev) {
      this.post({ type: "notice", level: "warn", message: "Selecione um trecho no terminal para anexar e tente novamente." });
      return;
    }
    this.addAttachment(`${terminal.name} (terminal)`, "selection", sel);
  }

  // Ponto 6: OCR de um print colado no chat via o `tesseract` do SISTEMA (leve, sem inchar o .vsix).
  // Grava a imagem num arquivo temporário, roda o tesseract com os idiomas disponíveis (prefere por+eng)
  // e anexa o TEXTO extraído. Degrada com clareza quando o tesseract não está instalado.
  private static readonly OCR_MAX_BYTES = 8 * 1024 * 1024; // prints raramente passam de 2-3 MB
  private ocrInFlight = false; // evita N processos tesseract concorrentes em Ctrl+V repetido
  async addImageOcrAttachment(dataUrl: string): Promise<void> {
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) {
      this.post({ type: "notice", level: "warn", message: "Não reconheci a imagem colada. Cole um print (PNG/JPG) ou o texto do log." });
      return;
    }
    const buf = Buffer.from(parsed.base64, "base64");
    if (buf.length === 0 || buf.length > Controller.OCR_MAX_BYTES) {
      this.post({ type: "notice", level: "warn", message: "Imagem inválida ou grande demais para OCR (máx. 8 MB)." });
      return;
    }
    if (this.ocrInFlight) {
      this.post({ type: "notice", level: "info", message: "Já estou extraindo o texto de um print — aguarde terminar." });
      return;
    }
    this.ocrInFlight = true;
    // Resolve QUAL tesseract usar (config explícita → locais padrão/por-usuário → PATH) e a pasta de
    // idiomas (tessdata) opcional. Permite tesseract portable/per-user e `por` sem admin, sem embutir binário.
    const cmd = resolveTesseractCmd(this.config.ocrTesseractPath(), tesseractCandidates(process.env), existsSync);
    const tdPath = this.config.ocrTessdataPath();
    const tdArgs = tdPath ? ["--tessdata-dir", tdPath] : [];
    const tmp = path.join(os.tmpdir(), `forge-ocr-${crypto.randomUUID()}.${parsed.ext || "png"}`);
    let wrote = false; // distingue a falha de GRAVAR o temp da falha de RODAR o tesseract
    try {
      await fs.writeFile(tmp, buf);
      wrote = true;
      this.post({ type: "notice", level: "info", message: "Extraindo texto do print (OCR)…" });
      const langs = pickOcrLangs(await this.listTesseractLangs(cmd, tdArgs));
      const text = (await this.runTesseract(cmd, tmp, langs, tdArgs)).trim();
      if (!text) {
        this.post({ type: "notice", level: "warn", message: "Não encontrei texto legível no print. Se for um erro/log, cole o texto direto." });
        return;
      }
      this.addAttachment("print (OCR)", "upload", text);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (!wrote) {
        this.post({ type: "notice", level: "error", message: `Não consegui preparar o print para OCR: ${err.message ?? String(err)}` });
      } else if (err.code === "ENOENT") {
        this.post({
          type: "notice",
          level: "warn",
          message:
            "OCR requer o 'tesseract' acessível (no PATH, ou configure o caminho em forge.ocr.tesseractPath — pode ser um tesseract portable, sem admin). Enquanto isso, cole o texto do log direto no chat.",
        });
      } else {
        // Se o dev apontou um tessdata próprio, o erro do tesseract costuma ser "data file not found" —
        // aponta a config a revisar em vez de só a mensagem crua.
        const hint = tdPath ? " Verifique forge.ocr.tessdataPath (a pasta precisa conter os .traineddata dos idiomas)." : "";
        this.post({ type: "notice", level: "error", message: `Falha no OCR do print: ${err.message ?? String(err)}${hint}` });
      }
    } finally {
      this.ocrInFlight = false;
      fs.unlink(tmp).catch(() => {}); // limpa o temporário haja o que houver
    }
  }

  // Idiomas instalados no tesseract (`--list-langs`). Se o binário faltar/erro, retorna [] (o run
  // principal surfacia o ENOENT com a mensagem de instalação). `--list-langs` costuma escrever no stderr.
  private listTesseractLangs(cmd: string, tdArgs: string[]): Promise<string[]> {
    return new Promise((resolve) => {
      execFile(cmd, [...tdArgs, "--list-langs"], { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
        resolve(err ? [] : parseTesseractLangs(`${stdout}\n${stderr}`));
      });
    });
  }

  // Roda o OCR: `tesseract [--tessdata-dir DIR] <img> stdout [-l por+eng]`. Timeout e buffer limitados.
  private runTesseract(cmd: string, imgPath: string, langs: string[], tdArgs: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [...tdArgs, imgPath, "stdout"];
      if (langs.length) args.push("-l", langs.join("+"));
      execFile(cmd, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  // Busca interna GOVERNADA via MCP — substitui a "web" pública por uma fonte
  // in-network (egress/aprovação/auditoria já aplicados pelo McpManager).
  async searchInternal(): Promise<void> {
    const cfg = this.config.search();
    if (!cfg.server) {
      this.post({ type: "notice", level: "info", message: "Busca interna não configurada (defina forge.search.server)." });
      return;
    }
    const query = await vscode.window.showInputBox({
      prompt: `Buscar na fonte interna (${cfg.server})`,
      placeHolder: "termos da busca…",
    });
    if (!query || !query.trim()) return;
    this.post({ type: "notice", level: "info", message: `Buscando "${query}" em ${cfg.server}…` });
    const res = await this.mcp.callTool(cfg.server, cfg.tool, { [cfg.queryArg]: query.trim() });
    if (!res.ok) {
      this.post({ type: "notice", level: "error", message: `Busca falhou: ${res.content}` });
      return;
    }
    this.addAttachment(`🔍 ${query.trim()}`, "search", `Resultados da busca interna para "${query.trim()}":\n${res.content}`);
  }

  // ---- propostas -------------------------------------------------------------

  async applyProposal(proposalId: string, opts?: { force?: boolean }): Promise<boolean> {
    const entry = this.currentTask?.getProposal(proposalId);
    if (!entry) {
      this.post({ type: "notice", level: "warn", message: "Proposta não encontrada (expirada)." });
      return false;
    }
    // Escape CONSCIENTE do gate: "Aplicar assim mesmo, revisei" (opts.force) pula a recusa, mas o override é
    // registrado (obs proposal.applied {forced} + aviso). Sem force, comportamento idêntico ao anterior.
    const gateBlocked = this.config.gateBlocksApply() && !entry.gateOk;
    if (gateBlocked && !opts?.force) {
      this.post({
        type: "notice",
        level: "error",
        message: "Quality gate reprovado: corrija os problemas apontados pelos validadores — ou use \"Aplicar assim mesmo, revisei\" para aplicar sob sua responsabilidade.",
      });
      return false;
    }
    const forcedOverride = gateBlocked && opts?.force === true;
    const ws = this.workspaceRoot();
    if (!ws) {
      this.post({ type: "notice", level: "error", message: "Abra uma pasta no VSCode para aplicar mudanças." });
      return false;
    }

    // Edição de célula de notebook (.ipynb) — aplica via NotebookEdit, preservando o resto.
    if (entry.proposal.cell) {
      const ok = await this.applyCellProposal(proposalId, entry);
      if (ok) {
        this.post({ type: "proposal/applied", proposalId });
        this.obs.record({ type: "proposal.applied", filePath: entry.proposal.filePath, forced: forcedOverride });
        if (forcedOverride) this.post({ type: "notice", level: "warn", message: `Aplicado por cima do gate reprovado (sob sua revisão): ${entry.proposal.filePath} — registrado no diagnóstico.` });
      }
      return ok;
    }

    // Contenção: o filePath vem do modelo — recusa escrever FORA do workspace (`../`, absoluto, outra unidade).
    const abs = safeWorkspacePath(ws, entry.proposal.filePath);
    if (!abs) {
      this.post({ type: "notice", level: "error", message: `Caminho fora do workspace recusado: ${entry.proposal.filePath}` });
      return false;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, entry.proposal.modified, "utf8");
    this.history.push({ role: "assistant", content: `Apliquei a alteração em ${entry.proposal.filePath}.` });
    this.post({ type: "proposal/applied", proposalId });
    this.obs.record({ type: "proposal.applied", filePath: entry.proposal.filePath, forced: forcedOverride });
    if (forcedOverride) this.post({ type: "notice", level: "warn", message: `Aplicado por cima do gate reprovado (sob sua revisão): ${entry.proposal.filePath} — registrado no diagnóstico.` });
    const docUri = vscode.Uri.file(abs);
    await vscode.window.showTextDocument(docUri, { preview: false });
    return true;
  }

  // Botão "Salvar como arquivo" do CodeBox (Onda 3): transforma um trecho em cerca comum numa PROPOSTA
  // aplicável (card + diff + gate + Aplicar), com o caminho CONFIRMADO pelo dev — não escreve direto.
  // Reusa todo o pipeline de proposta, então o dev revê o diff e o quality gate continua valendo. O
  // caminho é validado (safeWorkspacePath) aqui e de novo no applyProposal (defesa em profundidade).
  private async saveCodeBlock(filePath: string, content: string): Promise<void> {
    const rel = (filePath ?? "").trim();
    if (!rel) {
      this.post({ type: "notice", level: "warn", message: "Informe um caminho de arquivo para salvar o trecho." });
      return;
    }
    const ws = this.workspaceRoot();
    if (!ws) {
      this.post({ type: "notice", level: "error", message: "Abra uma pasta no VSCode para salvar um trecho como arquivo." });
      return;
    }
    if (!safeWorkspacePath(ws, rel)) {
      this.post({ type: "notice", level: "error", message: `Caminho inválido ou fora do workspace: ${rel}` });
      return;
    }
    const task = this.currentTask;
    if (!task) {
      this.post({ type: "notice", level: "warn", message: "Gere uma resposta antes de salvar um trecho como arquivo." });
      return;
    }
    const proposal = await task.registerManualProposal(rel, content);
    // O reducer da webview anexa a proposta ao último balão do assistente (ignora o taskId; postamos o da
    // task só para satisfazer o tipo). A cerca comum ```lang PERMANECE visível no balão — o strip do
    // reducer (stripFileBlockOfPath) só remove blocos forge-file, nunca cercas comuns; isso é intencional:
    // o dev mantém o código à vista, agora com um cartão "Aplicar" ao lado.
    this.post({ type: "stream/proposal", taskId: task.taskId, proposal });
  }

  // Aplica uma proposta de célula no notebook ao vivo e registra o índice final
  // (para execução por célula). Retorna false se algo impedir a aplicação.
  private async applyCellProposal(
    proposalId: string,
    entry: { proposal: import("../shared/protocol").DiffProposal; cellIndex?: number }
  ): Promise<boolean> {
    const ws = this.workspaceRoot();
    const abs = ws ? safeWorkspacePath(ws, entry.proposal.filePath) : null;
    if (!abs) {
      this.post({ type: "notice", level: "error", message: `Caminho fora do workspace recusado: ${entry.proposal.filePath}` });
      return false;
    }
    const uri = vscode.Uri.file(abs);
    let nb: vscode.NotebookDocument;
    try {
      nb = await vscode.workspace.openNotebookDocument(uri);
    } catch (err) {
      this.post({ type: "notice", level: "error", message: `Não foi possível abrir o notebook: ${(err as Error).message}` });
      return false;
    }
    await vscode.window.showNotebookDocument(nb, { preview: false });

    const cell = entry.proposal.cell!;
    const cellData = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, entry.proposal.modified, "python");
    const edit = new vscode.WorkspaceEdit();
    let targetIndex: number;
    if (cell.op === "replace" && cell.index !== undefined && cell.index < nb.cellCount) {
      targetIndex = cell.index;
      edit.set(uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(targetIndex, targetIndex + 1), [cellData])]);
    } else {
      targetIndex = cell.after !== undefined ? Math.min(cell.after + 1, nb.cellCount) : nb.cellCount;
      edit.set(uri, [vscode.NotebookEdit.insertCells(targetIndex, [cellData])]);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      this.post({ type: "notice", level: "error", message: "Falha ao aplicar a célula no notebook." });
      return false;
    }
    entry.cellIndex = targetIndex;
    this.history.push({ role: "assistant", content: `Apliquei uma célula em ${entry.proposal.filePath} (índice ${targetIndex}).` });
    return true;
  }

  // Executa uma célula aplicada e captura a saída (com auto-cura se houver erro).
  async runCell(proposalId: string): Promise<void> {
    const entry = this.currentTask?.getProposal(proposalId);
    if (!entry || !entry.proposal.cell || entry.cellIndex === undefined) {
      this.post({ type: "notice", level: "warn", message: "Aplique a célula antes de executá-la." });
      return;
    }
    const ws = this.workspaceRoot();
    const uri = vscode.Uri.file(path.join(ws!, entry.proposal.filePath));
    const index = entry.cellIndex;
    try {
      await vscode.commands.executeCommand("notebook.cell.execute", { start: index, end: index + 1 }, uri);
    } catch (err) {
      this.post({ type: "notice", level: "error", message: `Falha ao executar a célula (kernel disponível?): ${(err as Error).message}` });
      return;
    }
    const nb = vscode.workspace.notebookDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    const { text, isError } = readCellOutputs(nb, index);
    this.post({
      type: "run/result",
      proposalId,
      filePath: entry.proposal.filePath,
      label: `célula [${index}]`,
      command: `notebook.cell.execute [${index}]`,
      ok: !isError,
      exitCode: isError ? 1 : 0,
      output: text || "(sem saída capturada — veja a célula no notebook)",
      durationMs: 0,
    });
    this.obs.record({ type: "run.result", filePath: entry.proposal.filePath, label: `célula [${index}]`, ok: !isError, exitCode: isError ? 1 : 0, durationMs: 0 });
  }

  async copyProposal(proposalId: string): Promise<void> {
    const entry = this.currentTask?.getProposal(proposalId);
    if (!entry) {
      this.post({ type: "notice", level: "warn", message: "Proposta não encontrada (expirada)." });
      return;
    }
    await vscode.env.clipboard.writeText(entry.proposal.modified);
    this.post({ type: "notice", level: "info", message: `Conteúdo de ${entry.proposal.filePath} copiado.` });
  }

  async viewDiff(proposalId: string): Promise<void> {
    const entry = this.currentTask?.getProposal(proposalId);
    if (!entry) return;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "forge-diff-"));
    const ext = path.extname(entry.proposal.filePath) || ".txt";
    const left = path.join(tmp, "atual" + ext);
    const right = path.join(tmp, "proposto" + ext);
    await fs.writeFile(left, entry.proposal.original, "utf8");
    await fs.writeFile(right, entry.proposal.modified, "utf8");
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(left),
      vscode.Uri.file(right),
      `${entry.proposal.filePath} — FORGE (atual ↔ proposto)`
    );
  }

  // ---- execução (com auto-cura via UI) ---------------------------------------

  async runActiveFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const ws = this.workspaceRoot();
    if (!editor || editor.document.uri.scheme !== "file" || !ws) {
      void vscode.window.showWarningMessage("FORGE: abra um arquivo do workspace para executar.");
      return;
    }
    await editor.document.save();
    const rel = path.relative(ws, editor.document.uri.fsPath).split(path.sep).join("/");
    await this.runService.runFile(rel);
    await vscode.commands.executeCommand("forge.sidebar.focus");
  }

  // Aplica a proposta e, se aplicada (e não for célula), executa o arquivo logo em seguida — do diff
  // ao "rodando" em um clique. A execução transmite o ciclo de vida (start/output/result) pela webview.
  async applyAndRun(proposalId: string, opts?: { force?: boolean }): Promise<void> {
    const entry = this.currentTask?.getProposal(proposalId);
    const applied = await this.applyProposal(proposalId, opts);
    if (applied && entry && !entry.proposal.cell) {
      await this.runService.runFile(entry.proposal.filePath, proposalId);
    }
  }

  // Grava o arquivo E abre o preview — num único handler, garantindo a ordem (o preview lê o arquivo
  // só depois de gravado), diferente de postar apply + preview/open como mensagens concorrentes.
  async applyAndPreview(proposalId: string, opts?: { force?: boolean }): Promise<void> {
    const entry = this.currentTask?.getProposal(proposalId);
    const applied = await this.applyProposal(proposalId, opts);
    if (applied && entry && !entry.proposal.cell) {
      await this.previewService.openPreview(entry.proposal.filePath);
      this.obs.record({ type: "run.result", filePath: entry.proposal.filePath, label: "preview", ok: true, exitCode: 0, durationMs: 0 });
    }
  }

  // Roda a suíte de testes (pytest por padrão) — TDD / quality gate de testes.
  async runTests(): Promise<void> {
    const testCfg = this.config.test();
    if (!testCfg.enabled) {
      this.post({ type: "notice", level: "warn", message: "Testes desabilitados (forge.test.enabled = false)." });
      return;
    }
    const ws = this.workspaceRoot();
    if (!ws) {
      this.post({ type: "notice", level: "error", message: "Abra uma pasta no VSCode para rodar os testes." });
      return;
    }
    // Serializa contra o RunService: rodar pytest enquanto "Preparar ambiente" cria/popula o mesmo venv
    // daria ModuleNotFoundError intermitente (venv parcial). Compartilham o interpretador do .venv.
    if (this.runService.isBusy()) {
      this.post({ type: "notice", level: "info", message: "Há uma execução em andamento (ex.: preparar ambiente). Aguarde ou cancele." });
      return;
    }
    const runner = new Runner(ws);
    const isWin = process.platform === "win32";
    // Comando ciente da STACK: default intocado num projeto Node (vitest/jest) COM script `test`
    // real vira `npm test` — antes rodava pytest do nada e falhava. Override do admin sempre vence.
    const stack = await this.detectWorkspaceStack();
    const chosen = chooseTestCommand(testCfg.command, "pytest -q", stack.tests, await this.hasNpmTestScript(ws));
    // PRÉ-FLIGHT (família pytest): proba o pytest no ambiente onde os testes VÃO RODAR — com venv,
    // o interpretador do venv; sem venv, o binário `pytest` do PATH (o mesmo que será executado).
    let venvPython = findVenvPython(ws, isWin, existsSync, process.env.VIRTUAL_ENV);
    if (isPytestCommand(chosen)) {
      const probe = await runner.runRaw(buildPytestProbe(venvPython), 20_000);
      if (!probe.ok) {
        // A cura instala coisas via RunService — se a execução está desabilitada por governança,
        // seja honesto de cara em vez de falhar depois com mensagem enganosa.
        if (!this.config.run().enabled) {
          this.post({ type: "notice", level: "warn", message: "pytest ausente e a execução de comandos está desabilitada (forge.run.enabled) — instale manualmente no venv." });
          return;
        }
        let proceed = testCfg.autoInstall;
        if (!proceed) {
          const install = "Instalar e rodar";
          const pick = await vscode.window.showInformationMessage(
            venvPython
              ? "O pytest não está instalado no ambiente (.venv). Instalar agora e rodar os testes?"
              : "Não há venv neste projeto. Criar o .venv com as dependências do código, instalar o pytest e rodar os testes?",
            install,
            "Cancelar"
          );
          proceed = pick === install;
        }
        if (!proceed) {
          this.post({ type: "notice", level: "info", message: "Testes cancelados: pytest ausente no ambiente." });
          return;
        }
        // O diálogo fica aberto indefinidamente — outra execução pode ter começado nesse meio-tempo.
        if (this.runService.isBusy()) {
          this.post({ type: "notice", level: "info", message: "Há uma execução em andamento — rode os testes de novo quando ela terminar." });
          return;
        }
        if (!venvPython) {
          // SEM venv: cria o ambiente COMPLETO (venv + dependências do código) — um .venv só com
          // pytest rodaria a suíte num interpretador pelado (ModuleNotFoundError geral).
          await this.prepareEnv();
          venvPython = findVenvPython(ws, isWin, existsSync, process.env.VIRTUAL_ENV);
          if (!venvPython) {
            this.post({ type: "notice", level: "error", message: "Não consegui criar o venv — veja o cartão 'ambiente'." });
            return;
          }
        }
        const installed = await this.runService.runCommand("pytest · instalação", buildPytestInstall(venvPython), this.config.env().timeoutSeconds * 1000);
        if (!installed.started) {
          // NÃO rodou (guarda do RunService) — mensagem fiel, sem apontar para cartão inexistente.
          this.post({ type: "notice", level: "info", message: "A instalação do pytest não iniciou (há uma execução em andamento ou a execução está desabilitada). Tente de novo." });
          return;
        }
        if (!installed.ok) {
          this.post({ type: "notice", level: "error", message: "A instalação do pytest falhou — veja o cartão de execução." });
          return;
        }
      }
    }
    // Roda pytest pelo interpretador do venv do projeto (python -m pytest), não pelo PATH global —
    // elimina o "ModuleNotFoundError: No module named pytest" quando o venv não está ativado no shell.
    const command = resolveTestCommand(chosen, venvPython);
    const result = await runner.runRaw(command, this.config.run().timeoutSeconds * 1000);
    this.post({
      type: "run/result",
      filePath: "",
      label: "testes",
      command: result.command,
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output,
      durationMs: result.durationMs,
      skippedReason: result.skippedReason,
    });
    this.obs.record({ type: "run.result", filePath: "", label: "testes", ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs });
  }

  // "Preparar ambiente": cria o venv do projeto e instala as dependências. Três modos:
  //   requirements.txt existe → instala + INCREMENTA (imports do código ausentes do arquivo, com
  //     confirmação nativa); pyproject instalável → `pip install -e .` como antes;
  //   NENHUM manifesto → detecta os imports do código, GERA o requirements.txt e instala (antes
  //     desistia com um aviso — agora o ambiente nasce do zero).
  // Streaming pelo spawn (cmd.exe/sh), então o `&&` funciona mesmo com o terminal em PowerShell.
  async prepareEnv(): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) {
      this.post({ type: "notice", level: "error", message: "Abra uma pasta no VSCode para preparar o ambiente." });
      return;
    }
    const reqPath = path.join(ws, "requirements.txt");
    const hasReq = existsSync(reqPath);
    const hasPyproject = existsSync(path.join(ws, "pyproject.toml"));
    let install: "requirements" | "editable" | "none";
    if (hasReq) {
      install = "requirements";
      // INCREMENTO: pacotes usados no código e ausentes do requirements — pergunta antes de mexer
      // em arquivo do dev (diálogo nativo; um toast não coleta resposta).
      const detected = await this.detectWorkspacePackages(ws);
      if (detected.length > 0) {
        try {
          const existing = await fs.readFile(reqPath, "utf8");
          // Arquivo em UTF-16 (BOM FF FE) decodificado como utf8 vira lixo com bytes NUL — o merge
          // "não reconheceria" nada e a reescrita CORROMPERIA o arquivo do dev. Pula o incremento.
          if (existing.includes("\u0000")) throw new Error("requirements.txt em encoding não-UTF-8");
          const merged = mergeRequirements(existing, detected);
          if (merged.added.length > 0) {
            const addAndInstall = "Adicionar e instalar";
            const pick = await vscode.window.showInformationMessage(
              `Detectei no código pacote(s) ausente(s) do requirements.txt: ${merged.added.join(", ")}. Adicionar?`,
              addAndInstall,
              "Instalar só o que está listado"
            );
            if (pick === addAndInstall) {
              await fs.writeFile(reqPath, merged.content, "utf8");
              this.post({ type: "notice", level: "info", message: `requirements.txt incrementado: ${merged.added.join(", ")}.` });
            }
          }
        } catch {
          /* requirements ilegível → segue com o install normal */
        }
      }
    } else if (hasPyproject) {
      // Só usa `pip install -e .` se o pyproject for INSTALÁVEL ([build-system]/[project]); um
      // pyproject só-de-ferramentas (ruff/pytest/black) quebraria o `-e .` — nesse caso só cria o venv.
      let pyproject = "";
      try {
        pyproject = await fs.readFile(path.join(ws, "pyproject.toml"), "utf8");
      } catch {
        /* ilegível → trata como não-instalável */
      }
      install = /^\s*\[(build-system|project)\]/m.test(pyproject) ? "editable" : "none";
      if (install === "none") {
        this.post({
          type: "notice",
          level: "info",
          message: "pyproject.toml sem [project]/[build-system]: crio o venv e atualizo o pip (adicione requirements.txt ou torne o pacote instalável para instalar dependências).",
        });
      }
    } else {
      // SEM manifesto: o ambiente nasce do código. Detecta os imports de terceiros e gera o
      // requirements.txt (arquivo NOVO — nada é sobrescrito; o cabeçalho explica a origem).
      const detected = await this.detectWorkspacePackages(ws);
      if (detected.length > 0) {
        await fs.writeFile(reqPath, renderRequirements(detected), "utf8");
        this.post({
          type: "notice",
          level: "info",
          message: `requirements.txt gerado com ${detected.length} pacote(s) detectado(s) no código: ${detected.join(", ")}. Revise à vontade.`,
        });
        install = "requirements";
      } else {
        install = "none";
        this.post({ type: "notice", level: "info", message: "Nenhuma dependência de terceiros detectada — crio o venv (.venv) e atualizo o pip." });
      }
    }
    const isWin = process.platform === "win32";
    const venvPython = findVenvPython(ws, isWin, existsSync, process.env.VIRTUAL_ENV);
    const command = buildVenvSetupCommand({ isWindows: isWin, venvPython, install });
    // Timeout próprio (forge.env.timeoutSeconds, default 900s): pip install pesado em cache frio
    // passa fácil dos 120s do run normal — matar no meio deixa o venv meio-populado.
    await this.runService.runCommand("ambiente", command, this.config.env().timeoutSeconds * 1000);
  }

  // O package.json da raiz tem um script `test` REAL? (gate do fallback `npm test` — sem o script,
  // `npm test` falha com "Missing script" e viraria um falso "testes falharam" no cartão.)
  private async hasNpmTestScript(ws: string): Promise<boolean> {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(ws, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      return typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim().length > 0;
    } catch {
      return false;
    }
  }

  // Varre os .py do workspace (com tetos) e devolve os pacotes PyPI de terceiros usados no código.
  // Lê só o INÍCIO de cada arquivo (imports vivem no topo) para não pesar em projetos grandes.
  private async detectWorkspacePackages(ws: string): Promise<string[]> {
    // `env/` (python -m venv env é invocação padrão), .tox e site-packages também são excluídos —
    // senão os imports das libs INSTALADAS poluem a detecção e estouram o teto de 300 arquivos.
    const uris = await vscode.workspace.findFiles(
      "**/*.py",
      "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.venv/**,**/venv/**,**/env/**,**/.tox/**,**/site-packages/**,**/__pycache__/**,**/.env/**}",
      300
    );
    const sources: string[] = [];
    const local = new Set<string>();
    for (const uri of uris) {
      const rel = path.relative(ws, uri.fsPath).replace(/\\/g, "/");
      // Módulos LOCAIS: o basename de cada .py e TODOS os segmentos de diretório do caminho —
      // num layout src/, `from adapters import x` referencia src/adapters/, que não é o 1º segmento
      // (e "adapters" EXISTE no PyPI: instalaria uma lib de ML errada silenciosamente).
      local.add(path.basename(rel, ".py"));
      for (const seg of rel.split("/").slice(0, -1)) if (seg) local.add(seg);
      try {
        const content = await fs.readFile(uri.fsPath, "utf8");
        sources.push(content.slice(0, 16_000));
      } catch {
        /* ilegível → ignora */
      }
    }
    return mapImportsToPackages(scanPythonImports(sources), local);
  }

  // ---- revisão de código (in-network) ----------------------------------------

  // Comando "Exportar diagnóstico" (P3): gera um bundle REDIGIDO (manifesto + resumo + eventos NDJSON da
  // sessão atual) e abre no editor para o dev anexar a um relato de bug. Tudo LOCAL — nada é enviado.
  async exportDiagnostics(): Promise<void> {
    try {
      const dir = path.join(this.context.globalStorageUri.fsPath, "logs");
      await fs.mkdir(dir, { recursive: true });
      const records = this.diag.records();
      const text = renderDiagnosticsBundle(records, this.diagnosticsManifest());
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `forge-diagnostico-${stamp}.md`);
      await fs.writeFile(file, text, "utf8");
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
      void vscode.window.showInformationMessage(`FORGE: diagnóstico exportado (${records.length} eventos, redigido). Anexe este arquivo ao relato de bug.`);
    } catch (e) {
      log.error("Falha ao exportar diagnóstico", e);
      this.post({ type: "notice", level: "error", message: "Não consegui exportar o diagnóstico (veja Mostrar logs)." });
    }
  }

  // Manifesto do bundle: versões + config NÃO-secreta (NUNCA segredos/chaves — só presença booleana quando
  // relevante). Serve ao suporte para reproduzir o ambiente sem expor credenciais.
  private diagnosticsManifest(): Record<string, unknown> {
    const obs = this.config.observability();
    return {
      forgeVersion: this.context.extension?.packageJSON?.version ?? "?",
      vscodeVersion: vscode.version,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      sessionId: this.sessionId,
      skills: this.skills.length,
      langfuseEnabled: obs.enabled,
      langfuseCapture: obs.capture,
      diagnosticsEnabled: this.config.diagnostics().enabled,
      egress: this.config.egressPolicy(),
      generatedAt: new Date().toISOString(),
    };
  }

  async reviewChanges(): Promise<void> {
    if (!(await this.ensureSession())) {
      this.post({ type: "notice", level: "error", message: "Licença requerida para revisar." });
      return;
    }
    if (this.resolveIdentity().emailRequired) {
      this.post({ type: "notice", level: "error", message: "Informe seu e-mail na configuração inicial antes de revisar." });
      return;
    }
    const runtime = await this.runtimeProviderConfig();
    if (!runtime) {
      this.post({ type: "notice", level: "error", message: "Nenhum provedor configurado." });
      return;
    }

    const diff = await this.gatherDiff();
    if (!diff) {
      this.post({ type: "notice", level: "info", message: "Nenhuma alteração para revisar." });
      return;
    }

    const provider = createProvider(runtime, this.egress);
    const taskId = `review_${Date.now()}`;
    const task = new Task({
      taskId,
      provider,
      systemPrompt: buildReviewPrompt(),
      messages: [{ role: "user", content: `Revise estas alterações do workspace (\`git diff\`):\n\n\`\`\`diff\n${diff}\n\`\`\`` }],
      activatedSkillNames: ["FORGE Review (in-network)"],
      validators: [],
      skillValidator: new SkillValidator(this.workspaceRoot()),
      workspaceRoot: this.workspaceRoot(),
      timeoutMs: runtime.timeoutSeconds * 1000,
      extraHeaders: this.buildTraceHeaders(["review"], runtime.modelId, runtime.type, runtime.reasoningEffort),
      emit: (e) => {
        this.trackUsage(e);
        this.obs.record(e);
      },
      obsMeta: {
        mode: "review",
        model: runtime.modelId,
        provider: runtime.type,
        sessionId: this.sessionId,
        userId: this.resolveIdentity().email ?? "",
        org: this.context.globalState.get<{ org?: string }>(GS_LICENSE_META)?.org,
        // P3: params efetivos (o review não deriva inputBudget — fica omitido).
        reasoningEffort: runtime.reasoningEffort,
        maxOutputTokens: runtime.maxTokens,
      },
      post: (m) => this.post(m),
    });
    this.currentTask = task;
    await task.run();
    this.post({ type: "review/done" }); // alimenta o checklist "Definição de Pronto"
    this.obs.record({ type: "review.done" });
  }

  // git diff (working tree vs HEAD); fallback: conteúdo do editor ativo.
  private async gatherDiff(): Promise<string> {
    const ws = this.workspaceRoot();
    if (ws) {
      const tryDiff = async (args: string) => {
        try {
          return await execCapture(`git --no-pager ${args}`, ws);
        } catch {
          return "";
        }
      };
      let out = await tryDiff("diff HEAD");
      if (!out.trim()) out = await tryDiff("diff");
      if (!out.trim()) out = await tryDiff("diff --staged");
      if (out.trim()) return out.slice(0, 24000);
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === "file") {
      const rel = ws ? path.relative(ws, editor.document.uri.fsPath) : editor.document.fileName;
      const text = editor.document.getText().slice(0, 20000);
      return `// (sem git: revisando o arquivo aberto ${rel})\n${text}`;
    }
    return "";
  }
}

function execCapture(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function dedupeValidators(validators: SkillValidatorSpec[]): SkillValidatorSpec[] {
  const seen = new Map<string, SkillValidatorSpec>();
  for (const v of validators) if (!seen.has(v.id)) seen.set(v.id, v);
  return [...seen.values()];
}

// Extrai texto e flag de erro das saídas de uma célula de notebook executada.
function readCellOutputs(nb: vscode.NotebookDocument | undefined, index: number): { text: string; isError: boolean } {
  if (!nb || index >= nb.cellCount) return { text: "", isError: false };
  const cell = nb.cellAt(index);
  let text = "";
  let isError = false;
  for (const out of cell.outputs) {
    for (const item of out.items) {
      const s = new TextDecoder().decode(item.data);
      if (item.mime === "application/vnd.code.notebook.error") {
        isError = true;
        try {
          const e = JSON.parse(s);
          text += `${e.name ?? "Erro"}: ${e.message ?? ""}\n${(e.stack ?? "").toString()}\n`;
        } catch {
          text += s + "\n";
        }
      } else if (item.mime.startsWith("text/") || item.mime.includes("stdout") || item.mime.includes("stderr")) {
        text += s + "\n";
      }
    }
  }
  return { text: text.slice(0, 8000).trim(), isError };
}
