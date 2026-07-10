import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createProvider } from "../api/ProviderFactory";
import { DEFAULT_TIMEOUT_SECONDS, PROVIDER_PRESETS } from "../api/presets";
import { buildAuthHeaders, ProviderRuntimeConfig } from "../api/types";
import { ChatMessage } from "../api/types";
import { probeServedContextWindow } from "../util/servedWindow";
import { ManagedConfig } from "../config/ManagedConfig";
import { LicenseClient } from "../license/LicenseClient";
import { LicenseVerifier } from "../license/LicenseVerifier";
import { SessionToken } from "../license/types";
import { McpAuditor } from "../mcp/McpAuditor";
import { McpManager } from "../mcp/McpManager";
import { McpRegistry } from "../mcp/McpRegistry";
import { ToolApprovalGate } from "../mcp/ToolApprovalGate";
import { PermissionAuditor, PermissionService } from "../security/permissions";
import { CodebaseIndex } from "../rag/CodebaseIndex";
import { EgressEnforcer } from "../net/EgressEnforcer";
import { SecretsStore } from "../secrets/SecretsStore";
import { ContextAssembler } from "../skills/ContextAssembler";
import { SkillLoader, SkillRoot } from "../skills/SkillLoader";
import { DEFAULT_SELECTOR_CONFIG, SkillSelector } from "../skills/SkillSelector";
import { planTemplateFiles, toIdentifierSlug } from "../skills/templates";
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
import { contractGateDecision, contractUnverified, GateCheckResult, isTscSyntaxError, mypyUnavailable, normGatePath, parseCompileallErrors, parseGofmtErrors, parseGoBuildErrors, parseMypyErrors, parseTscErrors, ProjectGateSummary, requiresContractConfirmation, summarizeGate, syntheticInitDirs, tscErrorsToMap, tscUnavailable } from "./projectGate";
import { buildGateTsconfig, findWorkspaceTscJs } from "../util/nodeEnv";
import { normRepairPath, selectRepairTargets } from "./projectRepair";
import { parseFileBlocks } from "../util/fileBlocks";
import { buildFewShotTurn } from "../util/fewShot";
import { runFileCheck } from "../util/execCheck";
import { summarizeSmoke } from "../util/smoke";
import { findLayerViolations, LAYER_RULE } from "../util/layerCheck";
import { DbtIndex, mdSafe, renderImpactCard, renderSchemaContext } from "../dbt/artifacts";
import { dbtIndexStale, DbtProjectLocation, findDbtProject, loadDbtIndex, LoadedDbtIndex } from "../dbt/loader";
import { analyzeSqlProposal, sqlEvidenceForReview } from "../sql/engine";
import { renderFindings } from "../sql/antipatterns";
import { classifySql } from "../sql/classify";
import { stripJinja } from "../sql/jinja";
import { renderLineage, selectLineage } from "../sql/lineage";
import { WarehouseService } from "../warehouse/WarehouseService";
import { decideSqlRun } from "../warehouse/governance";
import { renderResultCard, sanitizeWarehouseOutput } from "../warehouse/sqlRunners";
import { columnsInventorySql, mergeIndexes, parseInventoryCsv, parseSnapshot, serializeSnapshot, snapshotToIndex, WarehouseSnapshot } from "../warehouse/schemaSnapshot";
import { compareProfiles, parseParityArgs, parseProfileCsv, profileSql, renderParityCard } from "../warehouse/parity";
import { renderFinopsCard, topQueriesSql } from "../warehouse/finops";
import { renderPiiCard, scanIndexForPii } from "../util/piiScan";
import { SqlRunResult, WarehouseConnection } from "../warehouse/types";
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
import { GatewayRelaySink } from "../obs/GatewayRelaySink";
import { RoutingObsSink } from "../obs/RoutingObsSink";
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
  // Permission model UNIFICADO (Fase 4): decisões de permissão de TODAS as superfícies (MCP, escrita
  // SQL, override de gate, contrato) passam por um trail único + evento obs `permission.decision`.
  private readonly permissionAuditor = new PermissionAuditor();
  private readonly permissions: PermissionService;
  private readonly mcp: McpManager;
  private readonly rag: CodebaseIndex;
  private readonly obs: Observability;

  private readonly sessionId = crypto.randomUUID(); // id de sessão p/ correlação no Langfuse
  private readonly diag: LocalDiagnosticsLog; // log de diagnóstico LOCAL (P3) — sempre-ligado, redigido
  private skills: SkillMeta[] = [];
  private sessionToken: SessionToken | undefined;
  // Fase F: sessão do Modo Projeto — o blueprint aprovado e o status por arquivo (orquestração).
  private projectSession: { language: ProjectLanguage; architecture: ProjectArchitecture; ui?: ProjectUI; framework?: ProjectFramework; brief: string; files: BlueprintFileView[] } | null = null;
  // Última geração fechou o gate como PARCIAL num projeto Python (compilou, mas o mypy não verificou o
  // contrato cross-file) → "Aplicar tudo" exige confirmação explícita (forceBlocked). Ver runProjectGate.
  // Suprimido quando há OUTRO bloqueio duro (o dev resolve/força esse primeiro) — semântica de CONFIRMAÇÃO.
  private gateContractUnverified = false;
  // A verdade CRUA para a POLÍTICA (forge.gate.blockUnverifiedContract): contrato não verificado em
  // Python, SEM carve-out por outros bloqueios e contando advisory/falha do gate (nada rodou = nada
  // verificado). Guarda o "Aplicar tudo", o "Forçar bloqueados" E o apply por-arquivo. Ver runProjectGate.
  private gateContractUnverifiedHard = false;
  // Argumentos do último runProjectGate — permitem RE-RODAR o gate sobre as propostas existentes
  // ("Re-verificar contrato" pós-"Preparar ambiente") sem regenerar o projeto via LLM.
  private lastGateRun: { language: ProjectLanguage; architecture: ProjectArchitecture; complete: boolean } | null = null;
  // Cache da janela de contexto SERVIDA pelo gateway, por (type::baseUrl::modelId). Auto-detectada uma vez
  // via GET /v1/models quando a config maxContextWindow é 0. Presença = já probado (valor 0 = sem detecção;
  // não re-proba). Ver util/servedWindow.ts e ensureServedWindow.
  private servedWindowCache = new Map<string, number>();
  private licenseKey: string | undefined;
  private history: ChatMessage[] = [];
  private pendingAttachments: { id: string; label: string; kind: "workspace" | "upload" | "selection" | "search"; content: string }[] = [];
  private attachmentSeq = 0;
  private currentTask: Task | undefined;
  // Usage REAL acumulado da sessão (todas as gerações, incl. continuações) — /contexto e /tokens.
  private sessionUsage = { input: 0, output: 0 };
  // Grounding dbt (dados, Onda 1): índice dos artefatos (target/manifest.json [+ catalog.json]),
  // recarregado por mtime (um `dbt compile` do dev atualiza sem reindexação manual). null = sem
  // projeto dbt ou sem artefatos (fail-open: as camadas que o consomem simplesmente não opinam).
  private dbtLoaded: LoadedDbtIndex | null = null;
  private dbtProbed = false; // já VARREMOS o workspace atrás de dbt_project.yml? (só isso — nunca "desisti do manifest")
  // Localização do projeto dbt encontrada no probe — mantida mesmo quando o manifest ainda não existe
  // ou uma recarga falhou (TOCTOU com `dbt compile` em andamento): a próxima chamada RE-TENTA a partir
  // dela (um fs.stat barato), em vez de degradar o grounding para o resto da sessão (revisão adversarial).
  private dbtLocation: DbtProjectLocation | null = null;
  private dbtInflight: Promise<DbtIndex | undefined> | null = null; // single-flight (propostas chegam em paralelo)
  // Onda 3: serviço de warehouse (CLI tradicional + MCP) e snapshots de schema vivo por conexão —
  // persistidos no globalStorage e fundidos ao índice dbt no grounding (getGroundingIndex).
  private warehouseSvc: WarehouseService | null = null;
  private whSnapshots = new Map<string, DbtIndex>();
  private whSnapshotsLoaded = false;
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
    this.approvalGate = new ToolApprovalGate(
      (req) =>
        new Promise<boolean>((resolve) => {
          this.pendingApprovals.set(req.requestId, resolve);
          this.post({ type: "mcp/approvalRequest", ...req });
        }),
      // Toda decisão do gate MCP (inclusive auto-approve, antes só log) entra no trail unificado. O
      // closure lê this.permissions em TEMPO DE DECISÃO — a ordem de construção do ctor não importa.
      (rec) =>
        this.permissions.note(
          { kind: "mcp.tool", action: `MCP ${rec.server}.${rec.tool}`, subject: `${rec.server}.${rec.tool}`, scope: rec.scope === "readwrite" ? "write" : "read", detail: rec.argsPreview },
          rec.outcome,
          rec.outcome === "auto" ? "auto" : "webview"
        ),
      (m) => log.info(m)
    );
    this.mcp = new McpManager(this.registry, this.egress, this.approvalGate, this.auditor, this.secrets);
    this.rag = new CodebaseIndex(
      this.egress,
      () => this.config.rag(),
      () => this.workspaceRoot(),
      () => this.context.globalStorageUri.fsPath, // persistência do índice (Fase 3): reusa vetores entre sessões
      (msg) => this.post({ type: "notice", level: "warn", message: msg }) // aviso VISÍVEL de teto atingido
    );
    this.rag.setOnChange(() => void this.postState()); // atualiza o indicador de RAG ao vivo
    // Diagnóstico LOCAL (P3): log estruturado sempre-ligado em globalStorage/logs, redigido, independente
    // do opt-in do Langfuse. Recebe o MESMO ObsEvent via o tee em Observability (antes do gate de egress).
    this.diag = new LocalDiagnosticsLog(
      path.join(this.context.globalStorageUri.fsPath, "logs"),
      () => this.sessionId,
      { enabled: () => this.config.diagnostics().enabled, now: () => new Date().toISOString() }
    );
    // Observabilidade com sink roteável: "direct" (chaves do dev) ou "gateway" (relay governado —
    // secret server-side, autenticado pelo token de sessão). O modo vem de forge.observability.mode.
    const directSink = new LangfuseDirectSink(
      () => this.config.observability(),
      () => this.secrets.get(SecretsStore.KEY_LANGFUSE_SECRET),
      this.egress
    );
    const relaySink = new GatewayRelaySink(
      () => this.config.gatewayUrl(),
      () => this.sessionToken?.token,
      this.egress,
      { warn: (m) => log.warn(m) }
    );
    this.obs = new Observability(
      () => this.config.observability(),
      new RoutingObsSink(() => this.config.observability().mode, directSink, relaySink),
      { onError: (m) => log.warn(m) },
      this.diag
    );
    // Permission model unificado: trail central + evento obs por decisão + diálogo nativo injetado
    // (o modal não depende do estado do webview — lição do item 1).
    this.permissions = new PermissionService(
      this.permissionAuditor,
      (rec) => this.obs.record({ type: "permission.decision", kind: rec.kind, action: rec.action, scope: rec.scope, outcome: rec.outcome, via: rec.via, subject: rec.subject }),
      async (message, detail, confirmLabel) => vscode.window.showWarningMessage(message, { modal: true, detail }, confirmLabel)
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

  // Remove temp dirs órfãos deixados por um host encerrado antes do finally: `.forge/val-*` (validação)
  // e `.forge/wh-*` (warehouse — o wrapper Oracle contém a senha em claro, então limpar é questão de
  // segurança, não só higiene). Restaura o auto-limpeza que o os.tmpdir dava de graça. Best-effort.
  private async sweepValidatorTemp(): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) return;
    const dir = path.join(ws, ".forge");
    try {
      const entries = await fs.readdir(dir);
      await Promise.all(
        entries
          .filter((e) => e.startsWith("val-") || e.startsWith("wh-"))
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
    this.gateContractUnverified = false; // nova geração: zera o estado; o gate repõe o valor correto ao rodar
    this.gateContractUnverifiedHard = false;
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
    // Contrato cross-file NÃO verificado: por padrão exige confirmação explícita (`forceBlocked` =
    // "Aplicar sem verificar contrato") antes de gravar tudo — evita selar como "pronto" um projeto com
    // drift de contrato (import/atributo fantasma). Com a política do admin
    // `forge.gate.blockUnverifiedContract`, vira BLOQUEIO sem escape: o force NÃO fura — nem pelo
    // "Forçar bloqueados" (a política usa o flag CRU, sem o carve-out por outros bloqueios da confirmação).
    const policyOn = this.config.blockUnverifiedContract();
    const contractUnv = policyOn ? this.gateContractUnverifiedHard : this.gateContractUnverified;
    const decision = contractGateDecision(contractUnv, policyOn, !!opts?.forceBlocked);
    if (decision === "block") {
      this.permissions.note({ kind: "contract.unverified", action: "Aplicar tudo com contrato cross-file não verificado", scope: "write" }, "blocked", "policy");
      this.post({ type: "notice", level: "warn", message: 'Bloqueado por política do admin (forge.gate.blockUnverifiedContract): o contrato cross-file precisa ser VERIFICADO antes de aplicar tudo. Rode "Preparar ambiente" (cria o venv) e depois "Re-verificar contrato" (o gate instala o mypy no venv e verifica as MESMAS propostas, sem regenerar).' });
      log.info("Aplicar tudo bloqueado: contrato cross-file não verificado + política blockUnverifiedContract");
      return;
    }
    if (decision === "confirm") {
      // Diálogo NATIVO via PermissionService (não depende do estado do webview — se a política foi
      // desligada depois do gate ter postado contractBlocked, o botão não está renderizado; o diálogo
      // garante o caminho). A decisão entra no trail unificado + Langfuse.
      const ok = await this.permissions.confirm(
        { kind: "contract.unverified", action: "O contrato cross-file NÃO foi verificado (o mypy não rodou — sem venv/mypy). Aplicar tudo assim mesmo?", scope: "write", detail: 'Para verificar de fato: "Preparar ambiente" e depois "Re-verificar contrato". Aplicar sem verificação fica registrado no diagnóstico.' },
        { confirmLabel: "Aplicar sem verificar contrato" }
      );
      if (!ok) return;
    }
    if (decision === "proceed" && contractUnv && opts?.forceBlocked) {
      // A confirmação veio do BOTÃO do webview ("Aplicar sem verificar contrato") — registra a decisão
      // no trail unificado (antes, esse caminho não deixava rastro de permissão).
      this.permissions.note({ kind: "contract.unverified", action: "Aplicar tudo com contrato cross-file não verificado", scope: "write" }, "approved", "webview");
    }
    this.gateContractUnverified = false; // seguimos para aplicar (verificado, ou confirmado) → limpa o estado
    this.gateContractUnverifiedHard = false;
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
    const appliedPaths: string[] = [];
    for (const p of sorted) {
      const ok = await this.applyProposal(p.id, { force: opts?.forceBlocked });
      if (ok) {
        applied++;
        appliedPaths.push(p.filePath);
        if (this.projectSession) {
          const f = this.projectSession.files.find((x) => norm(x.path) === norm(p.filePath));
          if (f) f.status = "applied";
        }
      } else {
        blocked++;
      }
    }
    // Estrutura de pacotes: materializa os __init__.py REAIS que faltam (CR-7). O gate só cria
    // sintéticos numa árvore temp; sem estes no workspace, um layout src/ multi-diretório pode falhar
    // no empacotamento (setuptools find), no pytest e em ferramentas sem suporte a namespace packages.
    if (this.projectSession?.language === "python" && appliedPaths.length) {
      const n = await this.ensurePythonPackageInits(appliedPaths);
      if (n > 0) {
        this.post({ type: "notice", level: "info", message: `Estrutura de pacotes: criei ${n} arquivo(s) __init__.py ausente(s) para os imports do projeto resolverem.` });
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

  // Garante os __init__.py REAIS dos pacotes Python (o gate só semeia sintéticos numa árvore temp).
  // Reusa syntheticInitDirs (mesma regra do gate: sobe a cadeia de ancestrais de cada .py, pula nomes
  // inválidos de pacote e dirs que já têm __init__.py entre os aplicados). Idempotente: não sobrescreve
  // um __init__.py existente. Best-effort: uma falha de escrita não bloqueia o apply. CR-7 da auditoria.
  private async ensurePythonPackageInits(appliedRelPaths: string[]): Promise<number> {
    const root = this.workspaceRoot();
    if (!root) return 0;
    let created = 0;
    for (const dir of syntheticInitDirs(appliedRelPaths.map(normGatePath), "python")) {
      const abs = safeWorkspacePath(root, `${dir}/__init__.py`);
      if (!abs || existsSync(abs)) continue;
      try {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, "", "utf8");
        created++;
      } catch {
        /* best-effort: não bloqueia o apply */
      }
    }
    return created;
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
      case "impact/request":
        await this.reportImpact(msg.target);
        break;
      case "data/command":
        await this.dispatchDataCommand(msg.cmd, msg.args);
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
      case "project/regate":
        await this.reRunProjectGate();
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
      case "context/listWorkspaceFiles":
        await this.listWorkspaceFiles();
        break;
      case "context/addWorkspaceFile":
        await this.addWorkspaceFileAttachment(msg.path, msg.kind);
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
  private resolveOutputTokens(type: ProviderRuntimeConfig["type"], baseUrl: string | undefined, modelId: string, sessionMaxOutput: number): number {
    const meta = getModelMeta(type, modelId);
    const cfg = this.config.provider();
    const requested = sessionMaxOutput > 0 ? sessionMaxOutput : cfg.maxOutput; // sessão vence a config do admin
    return clampOutputToServed(resolveMaxOutput(requested, meta), meta, this.effectiveContextWindow(type, baseUrl, modelId), OUTPUT_INPUT_RESERVE);
  }

  // Chave de cache da janela servida — por (type::baseUrl::modelId): gateways diferentes servem janelas diferentes.
  private servedWindowKey(type: string, baseUrl: string | undefined, modelId: string): string {
    return `${type}::${baseUrl ?? ""}::${modelId}`;
  }

  // Janela de contexto EFETIVA para o orçamento (deriveBudget/clampOutputToServed): a config do admin
  // (forge.provider.maxContextWindow) VENCE quando > 0; senão a auto-detectada do gateway (cache); senão 0
  // = usar o nominal do catálogo (comportamento atual — drop-in seguro quando não há detecção).
  private effectiveContextWindow(type: string, baseUrl: string | undefined, modelId: string): number {
    const configured = this.config.provider().maxContextWindow;
    if (configured > 0) return configured;
    return this.servedWindowCache.get(this.servedWindowKey(type, baseUrl, modelId)) ?? 0;
  }

  // Auto-detecta a janela SERVIDA pelo gateway (uma vez, cacheada por config). Só openai-compatible (o
  // vLLM/HubGPU expõe max_model_len em /v1/models; OpenAI/Anthropic não reduzem a janela) e só quando o
  // admin NÃO fixou maxContextWindow. Fail-open: falha → cacheia 0 (não re-proba) → o catálogo é usado.
  // Reconcilia p/ NÃO estourar (HTTP 400) se o servidor servir --max-model-len menor que a capacidade do modelo.
  private async ensureServedWindow(cfg: { type: ProviderRuntimeConfig["type"]; baseUrl?: string; modelId: string; apiKey?: string; authHeader?: string }): Promise<void> {
    if (cfg.type !== "openai-compatible") return;
    if (this.config.provider().maxContextWindow > 0) return; // admin fixou → não precisa detectar
    const key = this.servedWindowKey(cfg.type, cfg.baseUrl, cfg.modelId);
    if (this.servedWindowCache.has(key)) return; // já probado (sucesso ou falha)
    const headers = buildAuthHeaders({ type: cfg.type, modelId: cfg.modelId, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, authHeader: cfg.authHeader, timeoutSeconds: 0 });
    const served = await probeServedContextWindow(cfg.baseUrl, cfg.modelId, headers, this.egress, 4000 /* ms: probe curto, cacheado */);
    this.servedWindowCache.set(key, served ?? 0);
    const nominal = getModelMeta(cfg.type, cfg.modelId).contextWindow;
    if (served && served > 0 && served < nominal) {
      log.info(`Janela servida detectada: ${served} tokens (catálogo ${nominal}) — reconciliando o orçamento para evitar HTTP 400.`);
    }
  }

  private async runtimeProviderConfig(): Promise<ProviderRuntimeConfig | undefined> {
    const p = this.context.globalState.get<ProviderPersisted>(GS_PROVIDER);
    if (!p) return undefined;
    const apiKey = (await this.secrets.get(SecretsStore.providerApiKey("default"))) ?? "not-needed";
    // Auto-detecta a janela realmente servida pelo gateway (uma vez, cacheada) — reconcilia o orçamento
    // com o --max-model-len do servidor, evitando HTTP 400 quando ele serve menos que a capacidade do modelo.
    await this.ensureServedWindow({ type: p.type, baseUrl: p.baseUrl, modelId: p.modelId, apiKey, authHeader: p.authHeader });
    const servedContextWindow = this.effectiveContextWindow(p.type, p.baseUrl, p.modelId);
    // Teto de saída REAL do modelo (catálogo), sobrescrevível por config. Sem isto, toda geração caía
    // no DEFAULT_MAX_TOKENS fixo (16384), ignorando a janela de 128k do gpt-oss-120b.
    const meta = getModelMeta(p.type, p.modelId);
    const maxTokens = this.resolveOutputTokens(p.type, p.baseUrl, p.modelId, p.maxOutput ?? 0);
    if (!meta.supportsReasoningEffort) {
      // Provedores sem esforço (Anthropic/OpenAI/Llama): preserva o timeout do onboarding e não
      // envia reasoning_effort.
      return { ...p, apiKey, maxTokens, servedContextWindow, reasoningEffort: undefined };
    }
    const reasoningEffort = p.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    // gpt-oss: o esforço eleva o piso de timeout (esforços maiores levam mais tempo), mas um override
    // maior do onboarding é respeitado — evita cortar respostas longas (arquivo completo) no meio.
    return { ...p, apiKey, maxTokens, servedContextWindow, reasoningEffort, timeoutSeconds: Math.max(p.timeoutSeconds, effectiveTimeoutSeconds(reasoningEffort)) };
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
    // Detecta a janela servida do provider EM TESTE antes de montar o teto (o "Testar conexão" reflete
    // fielmente o que a geração real usaria — incl. o clamp contra o --max-model-len servido).
    await this.ensureServedWindow({ type: setup.type, baseUrl: setup.baseUrl, modelId: setup.modelId, apiKey: setup.apiKey, authHeader: setup.authHeader });
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
      maxTokens: this.resolveOutputTokens(setup.type, setup.baseUrl, setup.modelId, 0),
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
      runtime.servedContextWindow ?? 0 // janela EFETIVA (config do admin OU auto-detectada do gateway)
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
      // Motor SQL determinístico (dados, Onda 1): analisa propostas .sql in-process (anti-padrões +
      // segurança + schema dbt) no mesmo canal dos validadores de skill. Cobre chat, TDD e Modo Projeto.
      sqlAnalyzer: async (relPath, content) =>
        analyzeSqlProposal(relPath, content, { mode: this.config.sqlGate(), index: await this.getGroundingIndex() }),
      // Modo Projeto: à medida que cada bloco de arquivo FECHA no streaming, marca "gerado" um a um,
      // em vez de tudo em lote no fim. A reconciliação final (complete/failed) segue autoritativa.
      onFileClosed:
        mode === "project" && this.projectSession ? (filePath) => this.markProjectFileComplete(filePath) : undefined,
    });
    this.currentTask = task;
    // Nova geração substitui as propostas — o veredito de contrato do fluxo ANTERIOR não pode vazar
    // para as propostas novas (o gate desta geração repõe os valores corretos ao rodar).
    this.gateContractUnverified = false;
    this.gateContractUnverifiedHard = false;

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
        // P2 (templates/nível 3): materializa o scaffold DETERMINÍSTICO das skills ativadas (os .tmpl
        // declarados no frontmatter) como forge-file — ANTES do gate, para que herdem a checagem, e em
        // GAP-FILL (nunca sobrescreve o que o LLM gerou). Fora do LLM (determinístico). Ver materializeSkillTemplates.
        await this.materializeSkillTemplates(activated, {
          projectName: this.workspaceName(),
          projectSlug: toIdentifierSlug(this.workspaceName()), // identificador seguro p/ chaves/nomes (YAML/dbt)
          language: project.language,
          architecture: project.architecture,
        });
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

  // P2 (nível 3 / templates): materializa como forge-file o SCAFFOLD determinístico declarado no frontmatter
  // das skills ATIVADAS (`templates: [{src, dest}]`) — fora do LLM. loadAsset confina o `src` ao dir da skill;
  // planTemplateFiles interpola ({{projectName|language|architecture}}) e decide GAP-FILL (nunca sobrescreve o
  // que o LLM propôs, comparando os dests normalizados). Cada proposta materializada herda o gate (via
  // registerManualProposal, gateOk otimista + validação enfileirada). Fail-open: um asset ausente/erro só pula
  // aquele template, nunca derruba a geração. Respeita forge.skills.templates.
  private async materializeSkillTemplates(activated: { meta: SkillMeta; body: string }[], vars: Record<string, string>): Promise<void> {
    if (!this.config.skillTemplates()) return;
    const task = this.currentTask;
    if (!task) return;
    const specs = activated.flatMap((a) => a.meta.templates.map((spec) => ({ skill: a.meta.name, meta: a.meta, spec })));
    if (specs.length === 0) return;

    // TODO o corpo é fail-open: qualquer erro (I/O, proposta) só loga e segue — um scaffold nunca derruba a
    // geração (mesma filosofia do runProjectGate). O único efeito é não materializar o(s) template(s).
    try {
      const ws = this.workspaceRoot();
      // Dests JÁ propostos (LLM) — normalizados como no gate; base do gap-fill (vs. propostas em memória).
      const existingDests = new Set([...task.proposals.values()].map((e) => normGatePath(e.proposal.filePath)));

      // Carrega o conteúdo cru de cada template (I/O confinado pelo loadAsset). Um asset que falha é pulado.
      const loaded: { spec: (typeof specs)[number]["spec"]; raw: string }[] = [];
      for (const s of specs) {
        try {
          const buf = await this.loader.loadAsset(s.meta, s.spec.src);
          loaded.push({ spec: s.spec, raw: buf.toString("utf8") });
        } catch (e) {
          log.warn(`Templates: não consegui carregar o asset "${s.spec.src}" da skill "${s.skill}" — pulando`, e);
        }
      }

      // Colisão ciente do FS: case-insensitive em Windows/macOS (casa o existsSync do gap-fill de disco), case-
      // sensitive no Linux (Foo.yml ≠ foo.yml são arquivos distintos).
      const caseFold = process.platform === "win32" || process.platform === "darwin";
      const plan = planTemplateFiles(loaded, vars, existingDests, normGatePath, caseFold);
      const materialized: string[] = [];
      for (const p of plan) {
        if (p.status !== "materialize") {
          log.info(`Templates: "${p.dest}" já existe entre as propostas — pulado (gap-fill, não sobrescreve o LLM)`);
          continue;
        }
        // GAP-FILL vs. DISCO: nunca sobrescreve um arquivo que JÁ existe no workspace (ex.: o .gitignore do
        // usuário, com regras de segredos). O gap-fill em memória só vê as propostas do LLM; sem esta checagem,
        // um dest ausente das propostas mas presente no disco viraria proposta de SUBSTITUIÇÃO. Materializa só o
        // que está de fato AUSENTE. (Achado da revisão adversarial — perda silenciosa de arquivo do usuário.)
        const abs = ws ? safeWorkspacePath(ws, p.dest) : null;
        if (abs && existsSync(abs)) {
          log.info(`Templates: "${p.dest}" já existe no disco — não sobrescrevo (gap-fill)`);
          continue;
        }
        const proposal = await task.registerManualProposal(p.dest, p.content);
        this.post({ type: "stream/proposal", taskId: task.taskId, proposal });
        materialized.push(p.dest);
      }
      if (materialized.length > 0) {
        this.post({ type: "notice", level: "info", message: `Scaffold determinístico: ${materialized.length} arquivo(s) NOVOS materializados de skills ativadas — ${materialized.join(", ")}. Herdaram o gate.` });
        log.info(`Templates: materializados ${materialized.length} de skills ativadas — ${materialized.join(", ")}`);
      }
    } catch (e) {
      log.warn("Templates: materialização falhou — seguindo sem scaffold (fail-open)", e);
    }
  }

  // "Re-verificar contrato": re-roda o gate sobre as propostas EXISTENTES — o caminho legítimo pós-
  // "Preparar ambiente" (o venv novo permite ao ensureGateMypy instalar o mypy e verificar de fato),
  // sem regenerar o projeto via LLM (que descartaria exatamente o artefato que o dev revisou).
  async reRunProjectGate(): Promise<void> {
    if (!this.currentTask || !this.lastGateRun || this.currentTask.proposals.size === 0) {
      this.post({ type: "notice", level: "warn", message: "Nada para re-verificar — gere o projeto primeiro." });
      return;
    }
    this.post({ type: "notice", level: "info", message: "Re-rodando a verificação sobre as propostas existentes…" });
    const g = this.lastGateRun;
    await this.runProjectGate(g.language, g.architecture, g.complete);
  }

  // Gate workspace-wide do Modo Projeto (Onda 1). Materializa TODAS as propostas juntas numa árvore temp
  // (contida via safeWorkspacePath), semeia `__init__.py` sintéticos e roda compileall + mypy sobre o
  // CONJUNTO — pegando o drift de contrato que a validação por-arquivo (isolada) não vê. O resultado por
  // arquivo alimenta `entry.gateOk`; `applyProposal` já recusa `!gateOk` quando gateBlocksApply().
  // Degradação segura: se as ferramentas não rodam (sem python/mypy), o gate é CONSULTIVO — não bloqueia.
  private async runProjectGate(language: ProjectLanguage, architecture: ProjectArchitecture, complete: boolean): Promise<ProjectGateSummary | null> {
    const task = this.currentTask;
    // P4: Python (compileall/mypy), TypeScript (tsc) e Go (gofmt + go build). Java roda SÓ a arquitetura
    // (o gate de compilação javac é follow-up: sem JDK validável no ambiente de dev, não se escreve às cegas).
    if (!task || (language !== "python" && language !== "typescript" && language !== "go" && language !== "java")) return null;
    // Espera as validações por-arquivo em voo antes de tocar em gateOk (senão uma advisory tardia
    // reescreveria o veredito do gate de volta para true — corrida real).
    await task.settleValidations();

    // Exclui células (.ipynb) e PARCIAIS (truncados): o parcial é conhecidamente incompleto e já tem
    // tratamento honesto próprio (pulado no "Aplicar tudo" + aviso no cartão) — um SyntaxError por corte
    // não deve virar bloqueio de gate, e materializá-lo poluiria a resolução do conjunto.
    const props = [...task.proposals.values()].filter((e) => !e.proposal.cell && !e.proposal.partial);
    const codeRe = language === "typescript" ? /\.[tj]sx?$/i : language === "go" ? /\.go$/i : language === "java" ? /\.java$/i : /\.py$/i;
    const hasCode = props.some((e) => codeRe.test(e.proposal.filePath));
    if (!hasCode) return null; // nada compilável na linguagem do projeto — gate não se aplica
    // Guarda os args para o "Re-verificar contrato" (re-rodar o gate sobre as MESMAS propostas depois
    // de "Preparar ambiente", sem regenerar via LLM).
    this.lastGateRun = { language, architecture, complete };

    const gateStart = Date.now(); // P3: span do gate (compileall/mypy/arquitetura/DoD/segurança)
    let root: string | undefined;
    try {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-gate-"));
      // Materializa a árvore (cada path CONTIDO na raiz temp) + __init__.py sintéticos (só Python).
      // Compartilhado com o smoke test (runProjectSmoke) — ver writeProjectTree.
      await this.writeProjectTree(root, props, language);

      const timeoutMs = 120_000;
      const outputCap = 32_000; // teto amplo: um projeto MUITO drifado emite muitos erros; não truncar a atribuição
      const checks: GateCheckResult[] = [];
      const securityMode = this.config.securityGate();
      let tscTypeAdvisories: string[] = []; // avisos de TIPO do tsc (advisory) — só TypeScript
      let goBuildAdvisories: string[] = []; // avisos do go build/vet (advisory) — só Go
      let py: string | undefined; // interpretador do gate Python (só no ramo Python; usado no security scan)

      if (language === "python") {
        py = await this.resolveGatePython();
        // Onda 1.5: garante o mypy no venv ANTES de checar — sem ele o gate só teria compileall (sintaxe) e
        // ficaria "parcial", deixando passar o drift de contrato (o ImportError fantasma que derruba o app).
        await this.ensureGateMypy(py);
        // Garante o bandit no venv (best-effort, como o mypy) para o gate de segurança morder out-of-the-box.
        if (securityMode !== "off") await this.ensureGateBandit(py);

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
      } else if (language === "typescript") {
        // TypeScript (P4): tsc --noEmit sobre a árvore. Decisão (A): SINTAXE (TS1xxx) bloqueia; TIPO (TS2xxx+)
        // é advisory — sem node_modules no temp o tsc é ruidoso (deps/tipos ausentes → cascata). tsc ausente
        // → consultivo. A ARQUITETURA (abaixo) roda igual, agora sobre imports TS.
        const ts = await this.runTsChecks(root, timeoutMs, outputCap);
        checks.push(...ts.checks);
        tscTypeAdvisories = ts.advisories;
      } else if (language === "go") {
        // Go (P4): gofmt (SINTAXE) bloqueia — parse-only, offline, sem deps, ZERO risco de falso-bloqueio por
        // dep de terceiros ausente; go build/vet (compilação/drift) é advisory — sem o module cache o compilador
        // erra em toda dep de terceiros (egress deny-by-default). Decisão (A), igual ao TS. A ARQUITETURA
        // (abaixo) roda igual, agora sobre imports Go (casamento por diretório/pacote).
        const g = await this.runGoChecks(root, timeoutMs, outputCap);
        checks.push(...g.checks);
        goBuildAdvisories = g.advisories;
      } else {
        // Java (P4): SÓ a ARQUITETURA (abaixo) — o gate de compilação javac é follow-up. Sem um JDK validável
        // no ambiente de dev, não se escreve o classificador de erros do javac às cegas (o falso-bloqueio do gate
        // Go só foi pego por repro AO VIVO). `checks` fica vazio → o toolchain é consultivo; a regra de camadas
        // (por pacote declarado) roda igual e pode bloquear. DoD/segurança/smoke/reconcile seguem Python-only.
      }

      const gate = summarizeGate(checks); // toolchain (compileall/mypy | tsc-sintaxe) → advisory/resumo honestos

      // Gate de ARQUITETURA (P2): a REGRA DE OURO — a camada interna (domínio/entidades/model) não pode
      // importar a externa (adapters/infra/repository). O mypy não pega (importar na direção errada tipa e
      // compila). PURO sobre o conteúdo das propostas (roda até sem Python). Fica SEPARADO do toolchain:
      // BLOQUEIA o Aplicar, mas (1) FORA do summarizeGate — para não poluir advisory/parcial quando só ele
      // roda; e (2) FORA do auto-reparo de type-drift — cujo prompt "reuse o contrato" empurraria a
      // re-violar. O dev corrige a DIREÇÃO do import (inverter a dependência / usar uma port).
      const violations = findLayerViolations(
        props.map((e) => ({ path: normGatePath(e.proposal.filePath), content: e.proposal.modified })),
        architecture,
        language
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
      // bandit é Python-only (usa o `py` resolvido). Em TypeScript a segurança não roda por ora (follow-up).
      const security = language === "python" && securityMode !== "off" ? await this.runSecurityScan(py!, root, securityMode) : null;
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
      if (gate.fileErrors.length) fileParts.push(`${gate.fileErrors.length} ${language === "go" ? "de sintaxe (gofmt)" : "de compilação/contrato"}`);
      if (architectureErrors.length) fileParts.push(`${architectureErrors.length} de arquitetura (regra de camadas)`);
      if (securityErrors.length) fileParts.push(`${securityErrors.length} de segurança (bandit ALTO)`);
      // Avisos de TIPO do tsc / do go build (advisory): mostram a CONTAGEM no resumo (o veredito completo exige
      // as deps). Os erros de SINTAXE (TS1xxx / gofmt), esses, entram em gate.fileErrors (bloqueiam) e pintam
      // os cartões. Só um dos sufixos é não-vazio (a linguagem é uma só).
      const tscSuffix = tscTypeAdvisories.length ? ` · tsc: ${tscTypeAdvisories.length} aviso(s) de tipo (advisory — instale as deps e rode o tsc para o veredito completo)` : "";
      const goSuffix = goBuildAdvisories.length ? ` · go build: ${goBuildAdvisories.length} aviso(s) (advisory — rode go build ./... com as dependências para o veredito completo)` : "";
      const langSuffix = tscSuffix + goSuffix;
      // O resumo-base do summarizeGate é redigido para o toolchain Python (compileall/mypy). Em Go, reescreve
      // com os nomes das ferramentas certas (gofmt/go build) para os casos SEM bloqueio (advisory/parcial/verde);
      // os casos COM bloqueio já têm texto próprio abaixo.
      const goBaseSummary = gate.advisory
        ? "Gate consultivo: go/gofmt indisponíveis no ambiente — nada foi bloqueado (o projeto pode não compilar)."
        : gate.fileErrors.length > 0
          ? `Gate reprovou: ${gate.fileErrors.length} arquivo(s) com erro de sintaxe (gofmt). O "Aplicar" deles está bloqueado até corrigir.`
          : gate.projectErrors.length > 0
            ? "Gate rodou mas não consegui localizar a falha por arquivo (veja os detalhes) — nada foi bloqueado."
            : "Gate Go: sem erro de sintaxe (gofmt); a compilação completa (go build) rodou como advisory — sem as dependências não é veredito.";
      // Java roda SÓ a arquitetura (sem toolchain → gate.advisory=true); o resumo honesto diz isso.
      const javaBaseSummary =
        "Gate Java: arquitetura (regra de camadas) verificada — a compilação (javac) não roda neste ambiente e fica de fora; nada bloqueado por camadas.";
      const baseSummary = language === "go" ? goBaseSummary : language === "java" ? javaBaseSummary : gate.summary;
      const summary =
        (dodBlocksAll
          ? `Definição de pronto: o projeto está incompleto (${dodErrors.length} requisito(s) faltando) — Aplicar bloqueado até fechar.${totalBlocked > 0 ? ` Também ${totalBlocked} arquivo(s) com erro (${fileParts.join(" · ")}).` : ""}`
          : totalBlocked > 0
            ? `Gate reprovou: ${totalBlocked} arquivo(s) bloqueados${fileParts.length ? ` — ${fileParts.join(" · ")}` : ""}. Corrija antes de aplicar.`
            : securityAdvisories.length
              ? `${baseSummary} · segurança: ${securityAdvisories.length} aviso(s) do bandit (não bloqueiam).`
              : baseSummary) + langSuffix;
      if (tscTypeAdvisories.length) log.info(`Gate TS: ${tscTypeAdvisories.length} aviso(s) de tipo (advisory) — ${tscTypeAdvisories.slice(0, 5).join(" | ")}`);
      if (goBuildAdvisories.length) log.info(`Gate Go: ${goBuildAdvisories.length} aviso(s) do go build (advisory) — ${goBuildAdvisories.slice(0, 5).join(" | ")}`);
      // A UI pinta os cartões de compilação/arquitetura/segurança (por-arquivo) e mostra DoD + avisos de
      // segurança como project-level; o auto-reparo (que consome o gate RETORNADO) recebe só os fileErrors.
      const securityView = securityAdvisories.length > 12 ? [...securityAdvisories.slice(0, 12), `… e mais ${securityAdvisories.length - 12} aviso(s) — veja o log de diagnóstico.`] : securityAdvisories;
      // Contrato cross-file NÃO verificado (Python compilou mas o mypy não rodou): "Aplicar tudo" passa a
      // exigir confirmação. NÃO conta se já há bloqueio duro (o dev corrige/força esse primeiro) — a
      // supressão vale SÓ para a semântica de confirmação; a POLÍTICA usa o flag CRU abaixo (senão
      // qualquer outro bloqueio + "Forçar bloqueados" viraria bypass da política).
      this.gateContractUnverified = requiresContractConfirmation(language, gate.partial) && totalBlocked === 0 && !dodBlocksAll;
      this.gateContractUnverifiedHard = contractUnverified(language, gate.partial, gate.advisory);
      // contractBlocked: a política do admin transforma a confirmação em bloqueio — a UI troca o botão
      // "Aplicar sem verificar contrato" pelo caminho de verificação real (Preparar ambiente → Re-verificar).
      const contractBlocked = this.gateContractUnverifiedHard && this.config.blockUnverifiedContract();
      this.post({ type: "project/gate", advisory: gate.advisory, partial: gate.partial, requiresContractConfirm: this.gateContractUnverified, contractBlocked, summary, files: [...gate.fileErrors, ...architectureErrors, ...securityErrors], projectErrors: gate.projectErrors, dod: dodErrors, security: securityView });
      log.info(`Gate do projeto: ${summary} (rodou: ${gate.ran.join(", ") || "nada"}${architectureErrors.length ? ", camadas" : ""}${dodBlocksAll ? ", definição-de-pronto" : ""}${security ? ", segurança" : ""}; pulou: ${gate.skipped.join(", ") || "nada"})`);
      return { ...gate, summary, architectureErrors, dodErrors, securityErrors, securityAdvisories };
    } catch (e) {
      // Falha do PRÓPRIO gate (temp/exec) nunca deve travar a entrega — degrada para consultivo. MAS
      // para a POLÍTICA, gate que não rodou = contrato não verificado (senão quebrar o gate seria o
      // bypass): o flag CRU fica ligado em Python e o "Re-verificar contrato" permite re-tentar.
      log.warn("Gate do projeto falhou ao executar — seguindo consultivo", e);
      this.gateContractUnverified = false; // não trava o Aplicar por CONFIRMAÇÃO (retrocompat)
      this.gateContractUnverifiedHard = contractUnverified(language, false, true);
      const contractBlocked = this.gateContractUnverifiedHard && this.config.blockUnverifiedContract();
      this.post({ type: "project/gate", advisory: true, partial: false, requiresContractConfirm: false, contractBlocked, summary: contractBlocked ? "Não consegui rodar o gate de compilação — e a política do admin exige contrato verificado. Prepare o ambiente e re-verifique." : "Não consegui rodar o gate de compilação (ambiente) — nada foi bloqueado.", files: [], projectErrors: [], dod: [], security: [] });
      return null;
    } finally {
      if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
      this.obs.record({ type: "phase.timing", taskId: task.taskId, phase: "gate", durationMs: Date.now() - gateStart });
    }
  }

  // Materializa as propostas de arquivo numa árvore temp (cada path CONTIDO na raiz via safeWorkspacePath)
  // e semeia os __init__.py sintéticos para os imports cross-file resolverem. COMPARTILHADO pelo gate
  // estático (compileall/mypy) e pelo smoke test (pytest). Retorna os caminhos relativos materializados.
  private async writeProjectTree(root: string, props: { proposal: { filePath: string; modified: string } }[], language: ProjectLanguage = "python"): Promise<string[]> {
    const relPaths: string[] = [];
    for (const e of props) {
      const abs = safeWorkspacePath(root, e.proposal.filePath);
      if (!abs) continue;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, e.proposal.modified, "utf8");
      relPaths.push(normGatePath(e.proposal.filePath));
    }
    for (const dir of syntheticInitDirs(relPaths, language)) {
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

  // Resolve o tsc para o gate TypeScript (P4): o typescript do WORKSPACE (node_modules/typescript/lib/tsc.js),
  // rodado via `node <tsc.js>` — o execFile (sem shell) não invoca um .cmd de forma confiável no Windows, e
  // `node` é um .exe do PATH. Fallback: `tsc` do PATH (global). Nenhum → undefined (gate consultivo). Só
  // sondagem barata; NÃO instala nada (não poluímos o projeto do dev).
  private async resolveGateTsc(): Promise<{ cmd: string; baseArgs: string[] } | undefined> {
    const tscJs = findWorkspaceTscJs(this.workspaceRoot(), existsSync);
    if (tscJs) {
      const probe = await runFileCheck({ id: "probe", label: "tsc", gate: false }, "node", [tscJs, "--version"], { timeoutMs: 15_000 });
      if (probe.status === "ok") return { cmd: "node", baseArgs: [tscJs] };
    }
    const globalTsc = process.platform === "win32" ? "tsc.cmd" : "tsc";
    const probe = await runFileCheck({ id: "probe", label: "tsc", gate: false }, globalTsc, ["--version"], { timeoutMs: 15_000 });
    if (probe.status === "ok") return { cmd: globalTsc, baseArgs: [] };
    return undefined;
  }

  // Gate TypeScript (P4): materializa um tsconfig mínimo na árvore temp e roda `tsc --noEmit`. Classifica: erro
  // de SINTAXE (TS1xxx) BLOQUEIA (o arquivo nem parseia); erro de TIPO (TS2xxx+) é ADVISORY — sem node_modules
  // no temp o tsc é ruidoso (deps/tipos ausentes → cascata), então type-drift vira aviso, não bloqueio (decisão
  // (A)). tsc ausente/inconclusivo → check "skipped" (consultivo, como o mypy). O ruído de import BARE já é
  // filtrado em parseTscErrors; o de import RELATIVO (drift interno) é mantido.
  private async runTsChecks(root: string, timeoutMs: number, outputCap: number): Promise<{ checks: GateCheckResult[]; advisories: string[] }> {
    const tsc = await this.resolveGateTsc();
    if (!tsc) {
      return { checks: [{ result: { id: "gate:tsc", label: "tsc", status: "skipped", gate: true, output: "", reason: "tsc não encontrado (instale typescript no workspace) — gate consultivo" }, errors: new Map() }], advisories: [] };
    }
    await fs.writeFile(path.join(root, "tsconfig.gate.json"), buildGateTsconfig(), "utf8");
    const raw = await runFileCheck(
      { id: "gate:tsc", label: "tsc", gate: true },
      tsc.cmd,
      [...tsc.baseArgs, "--noEmit", "--pretty", "false", "-p", "tsconfig.gate.json"],
      { cwd: root, timeoutMs, outputCap }
    );
    if (tscUnavailable(raw)) {
      return { checks: [{ result: { ...raw, status: "skipped", reason: "tsc não pôde rodar — gate consultivo" }, errors: new Map() }], advisories: [] };
    }
    const errors = parseTscErrors(raw.output, root);
    const syntax = errors.filter((e) => isTscSyntaxError(e.code));
    const types = errors.filter((e) => !isTscSyntaxError(e.code));
    // Bloqueia SÓ em SINTAXE: sobrescreve o status para "ok" quando só há erro de tipo (advisory).
    return {
      checks: [{ result: { ...raw, label: "tsc (sintaxe)", status: syntax.length > 0 ? "failed" : "ok" }, errors: tscErrorsToMap(syntax) }],
      advisories: types.map((e) => `${e.path}:${e.line} — [${e.code}] ${e.message}`),
    };
  }

  // Resolve o ferramental Go para o gate (P4): sonda `go version` e `gofmt`. `go`/`gofmt` são .exe REAIS no
  // Windows (sem a armadilha do .cmd/EINVAL que derrubava o gate TS). undefined → nenhum go (gate consultivo);
  // gofmt ausente (raríssimo — vem junto do go) → sem o gate de sintaxe, só o advisory. Só sondagem barata.
  private async resolveGateGo(): Promise<{ go: string; gofmt?: string } | undefined> {
    const goProbe = await runFileCheck({ id: "probe", label: "go", gate: false }, "go", ["version"], { timeoutMs: 15_000 });
    if (goProbe.status !== "ok") return undefined; // ENOENT/timeout → sem go
    // `gofmt -h` imprime o uso e sai != 0 (→ "failed"); ENOENT (não instalado) → "skipped". Presente iff != skipped.
    const gofmtProbe = await runFileCheck({ id: "probe", label: "gofmt", gate: false }, "gofmt", ["-h"], { timeoutMs: 15_000 });
    return { go: "go", gofmt: gofmtProbe.status === "skipped" ? undefined : "gofmt" };
  }

  // Gate Go (P4): gofmt (SINTAXE, bloqueia) + go build (compilação/drift, advisory). O gofmt só PARSEIA — todo
  // erro dele é sintaxe pura e NUNCA falso-bloqueia por dep ausente (offline, dep-free). O go build roda OFFLINE
  // (GOPROXY=off), com o ruído de deps de terceiros filtrado (parseGoBuildErrors), e NUNCA bloqueia (decisão
  // (A), como o tipo no tsc). go ausente → check skipped (consultivo, como o mypy/tsc).
  private async runGoChecks(root: string, timeoutMs: number, outputCap: number): Promise<{ checks: GateCheckResult[]; advisories: string[] }> {
    const go = await this.resolveGateGo();
    if (!go) {
      return { checks: [{ result: { id: "gate:gofmt", label: "gofmt", status: "skipped", gate: true, output: "", reason: "go/gofmt não encontrado (instale o Go) — gate consultivo" }, errors: new Map() }], advisories: [] };
    }
    // 1) SINTAXE (bloqueia): gofmt -l -e . — parse-only, offline, dep-free. `-l` faz o stdout listar só NOMES
    // de arquivo (ignorados pelo parser); os erros de sintaxe saem no stderr. Sem gofmt → só o advisory roda.
    let fmtCheck: GateCheckResult;
    if (go.gofmt) {
      const fmt = await runFileCheck({ id: "gate:gofmt", label: "gofmt (sintaxe)", gate: true }, go.gofmt, ["-l", "-e", "."], { cwd: root, timeoutMs, outputCap });
      const fmtErrors = fmt.status === "failed" ? parseGofmtErrors(fmt.output, root) : new Map<string, string[]>();
      // gofmt que "reprovou" SEM erro atribuível é anomalia de ambiente (I/O), não sintaxe → consultivo em vez
      // de bloqueio amplo (mesmo espírito do mypy-abort). Um erro de sintaxe REAL sempre traz `arquivo:linha`.
      fmtCheck =
        fmt.status === "failed" && fmtErrors.size === 0
          ? { result: { ...fmt, status: "skipped", reason: "gofmt não pôde analisar (I/O) — gate consultivo" }, errors: new Map() }
          : { result: { ...fmt, status: fmtErrors.size > 0 ? "failed" : "ok" }, errors: fmtErrors };
    } else {
      fmtCheck = { result: { id: "gate:gofmt", label: "gofmt", status: "skipped", gate: true, output: "", reason: "gofmt não encontrado — gate de sintaxe consultivo" }, errors: new Map() };
    }
    // 2) COMPILAÇÃO/DRIFT (advisory): go build ./... offline; o ruído de deps de terceiros é filtrado.
    const advisories = await this.runGoBuildAdvisory(go.go, root, timeoutMs, outputCap);
    return { checks: [fmtCheck], advisories };
  }

  // Advisory de compilação/drift do Go: `go build ./...` OFFLINE (GOPROXY=off — nunca baixa deps; respeita o
  // egress deny-by-default), com um go.mod garantido na raiz (o GERADO, se houver; senão um mínimo sintético).
  // O ruído de deps de terceiros ausentes é filtrado; o que sobra (símbolo indefinido, import/var não usados —
  // em Go são ERRO de compilação) é drift REAL, mostrado como aviso. NUNCA bloqueia. Falha → advisory vazio.
  private async runGoBuildAdvisory(go: string, root: string, timeoutMs: number, outputCap: number): Promise<string[]> {
    try {
      // go build ./... exige um módulo: usa o go.mod GERADO se veio na árvore; senão sintetiza um mínimo (o
      // módulo sintético não resolve os imports internos com prefixo do módulo real, mas o advisory tolera).
      if (!existsSync(path.join(root, "go.mod"))) {
        await fs.writeFile(path.join(root, "go.mod"), "module forgegate\n\ngo 1.21\n", "utf8");
      }
      // OFFLINE e determinístico: GOPROXY=off (sem rede), GOFLAGS=-mod=mod (não exige go.sum), GOWORK=off (ignora
      // um go.work ancestral), GOTOOLCHAIN=local (não baixa uma toolchain se o go.mod pedir versão maior),
      // CGO_ENABLED=0 (nunca invoca o compilador C: fecha o vetor de exec por cgo/#cgo em código gerado e evita
      // o ruído "gcc not found" no Windows). O go build NÃO executa o código (só compila — distinto do smoke).
      const env = { ...process.env, GOPROXY: "off", GOFLAGS: "-mod=mod", GOWORK: "off", GOTOOLCHAIN: "local", GO111MODULE: "on", CGO_ENABLED: "0" };
      const build = await runFileCheck({ id: "gate:gobuild", label: "go build", gate: false }, go, ["build", "./..."], { cwd: root, timeoutMs, outputCap, env });
      if (build.status !== "failed") return []; // ok (compilou) ou skipped (inconclusivo) → sem advisory
      return parseGoBuildErrors(build.output, root).map((e) => `${e.path}:${e.line} — ${e.message}`);
    } catch (e) {
      log.warn("Gate Go: advisory do go build falhou — seguindo sem aviso", e);
      return [];
    }
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
    const budget = deriveBudget(getModelMeta(runtime.type, runtime.modelId), runtime.maxTokens ?? 0, runtime.servedContextWindow ?? 0);
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

  // ---- grounding dbt (dados) ---------------------------------------------------------------------

  // Índice dos artefatos dbt do workspace, com recarga por mtime. undefined = sem grounding.
  // Single-flight: chamadas concorrentes (várias propostas validando em paralelo) compartilham a mesma
  // Promise em vez de recarregar em duplicidade ou verem "sem grounding" durante o probe.
  private getDbtIndex(): Promise<DbtIndex | undefined> {
    if (this.dbtInflight) return this.dbtInflight;
    this.dbtInflight = this.getDbtIndexInner().finally(() => {
      this.dbtInflight = null;
    });
    return this.dbtInflight;
  }

  private async getDbtIndexInner(): Promise<DbtIndex | undefined> {
    const ws = this.workspaceRoot();
    if (!ws) return undefined;
    try {
      if (this.dbtLoaded && !(await dbtIndexStale(this.dbtLoaded))) return this.dbtLoaded.index;
      if (!this.dbtProbed) {
        this.dbtProbed = true; // significa só "já varri o workspace atrás de dbt_project.yml"
        this.dbtLocation = await findDbtProject(ws);
      }
      if (!this.dbtLocation) return undefined; // não há projeto dbt — nada a fazer nesta sessão
      // (Re)carrega da localização conhecida: cobre o primeiro load, a recarga por staleness E o
      // "rode dbt parse e tente de novo" (manifest criado DEPOIS do probe). Custo: um fs.stat.
      const before = this.dbtLoaded?.index;
      this.dbtLoaded = await loadDbtIndex(this.dbtLocation, (m, e) => log.warn(m, e));
      if (this.dbtLoaded && this.dbtLoaded.index !== before) {
        log.info(`dbt: grounding ativo — ${this.dbtLoaded.index.size()} tabelas do manifest (${this.dbtLoaded.location.targetDir}).`);
      }
      return this.dbtLoaded?.index;
    } catch (err) {
      log.warn("dbt: grounding indisponível (fail-open).", err);
      return undefined;
    }
  }

  // ---- warehouse (Onda 3/4) ------------------------------------------------------------------------

  private warehouse(): WarehouseService {
    if (!this.warehouseSvc) {
      this.warehouseSvc = new WarehouseService(this.secrets, () => this.config.warehouse(), () => this.workspaceRoot(), (action, subject, sqlPreview) =>
        this.permissions.confirm({ kind: "sql.write", action, subject, scope: "write", detail: sqlPreview }, { confirmLabel: "Executar escrita" })
      );
    }
    return this.warehouseSvc;
  }

  // Índice de GROUNDING: manifest dbt + snapshots de warehouse vivos, fundidos — alimenta prompt,
  // gate semântico, /auditoria-pii e paridade. Snapshot persiste no globalStorage entre sessões.
  private async getGroundingIndex(): Promise<DbtIndex | undefined> {
    if (!this.whSnapshotsLoaded) {
      this.whSnapshotsLoaded = true;
      try {
        const dir = this.context.globalStorageUri.fsPath;
        for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
          if (!/^wh-schema-.+\.json$/.test(f)) continue;
          const snap = parseSnapshot(await fs.readFile(path.join(dir, f), "utf8"));
          if (snap) this.whSnapshots.set(snap.connectionId, snapshotToIndex(snap));
        }
      } catch (err) {
        log.warn("warehouse: snapshots não carregados (fail-open).", err);
      }
    }
    const dbt = await this.getDbtIndex();
    const all = [...(dbt ? [dbt] : []), ...this.whSnapshots.values()];
    if (all.length === 0) return undefined;
    return all.length === 1 ? all[0] : mergeIndexes(all);
  }

  // Executa SQL numa conexão respeitando a governança do MOTOR nos DOIS caminhos: CLI tradicional
  // (WarehouseService) e MCP (catálogo do admin — que ainda passa pelo ToolApprovalGate próprio).
  // `internal` (metadados/agregados: schema-db, paridade, custo) pula a máscara LGPD (corromperia os
  // números — count de 8 dígitos virava ▇) e eleva o cap de linhas.
  private async runOnConnection(conn: WarehouseConnection, sql: string, internal?: { skipMask?: boolean; rowCapOverride?: number }): Promise<SqlRunResult | { refused: string }> {
    if (conn.mcp) {
      const decision = decideSqlRun(sql, conn);
      if (decision.verdict === "blocked") return { refused: `⛔ ${decision.reason}` };
      if (decision.verdict === "confirm") {
        // Permission model unificado: mesma confirmação do caminho CLI (antes era um modal DUPLICADO
        // aqui) — decisão registrada no trail + Langfuse.
        const ok = await this.permissions.confirm(
          { kind: "sql.write", action: `conexão "${conn.id}" (MCP): ${decision.reason}`, subject: conn.id, scope: "write", detail: sql },
          { confirmLabel: "Executar escrita" }
        );
        if (!ok) return { refused: "Execução cancelada pelo dev (escrita não confirmada)." };
      }
      const started = Date.now();
      const r = await this.mcp.callTool(conn.mcp.server, conn.mcp.tool, { [conn.mcp.sqlArg]: sql });
      // MESMO pós-processamento do caminho CLI: cap de linhas + máscara LGPD (o ramo MCP deixava PII
      // crua no chat apesar do rodapé "valores mascarados" — achado da revisão adversarial).
      const { output, truncated } = sanitizeWarehouseOutput(r.content, internal?.rowCapOverride ?? this.config.warehouse().rowCap, internal?.skipMask);
      return { ok: r.ok, exitCode: r.ok ? 0 : 1, output, truncated, durationMs: Date.now() - started, command: `mcp:${conn.mcp.server}/${conn.mcp.tool}` };
    }
    return this.warehouse().runSql(conn.id, sql, internal);
  }

  private dataCard(markdown: string): void {
    this.post({ type: "data/card", markdown });
  }

  // Despacho dos comandos de dados da paleta (Ondas 3/4). Tudo fail-open: erro vira card explicativo.
  async dispatchDataCommand(cmd: string, args?: string): Promise<void> {
    try {
      switch (cmd) {
        case "conexoes": {
          const conns = this.warehouse().connections();
          if (conns.length === 0) {
            this.dataCard("### Conexões\n\nNenhuma conexão configurada. O admin (ou você) declara em `forge.warehouse.connections` — ex.: Oracle 19c/26ai/Exadata/ADW (`kind: oracle`, SQLcl/sqlplus), PostgreSQL (`psql`), BigQuery (`bq`), DuckDB local, S3/OCI Object Storage. Senhas ficam no SecretStorage (pedidas no primeiro uso).");
            return;
          }
          const lines: string[] = ["### Conexões", "", "| id | tipo | destino | acesso | teste |", "|---|---|---|---|---|"];
          for (const c of conns.slice(0, 8)) {
            const r = await this.warehouse().testConnection(c);
            const status = "refused" in r ? `⚠ ${r.refused.slice(0, 80)}` : r.ok ? "✅ ok" : `❌ ${r.output.slice(0, 60)}`;
            lines.push(`| \`${c.id}\` | ${c.kind}${c.mcp ? " (mcp)" : ""} | ${(c.connect ?? "-").replace(/:[^@/:]+@/, ":***@")} | ${c.readonly === false ? "leitura+escrita" : "somente leitura"} | ${status} |`);
          }
          lines.push("", "_Escrita exige `readonly:false` NA CONEXÃO + confirmação por execução; DROP/TRUNCATE nunca executam._");
          this.dataCard(lines.join("\n"));
          return;
        }
        case "executar-sql": {
          const editor = vscode.window.activeTextEditor;
          if (!editor || !/\.sql$/i.test(editor.document.fileName)) {
            this.dataCard("### Executar SQL\n\nAbra um arquivo `.sql` no editor (a seleção, se houver, é o que executa) e rode `/executar-sql [conexão]`.");
            return;
          }
          const sql = editor.selection && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : editor.document.getText();
          const conn = this.warehouse().resolve(args?.trim() || undefined);
          if (!conn) {
            this.dataCard(`### Executar SQL\n\nConexão ${args?.trim() ? `\`${args.trim()}\` não existe` : "não configurada"} — veja \`/conexoes\`.`);
            return;
          }
          const r = await this.runOnConnection(conn, sql);
          if ("refused" in r) {
            this.dataCard(`### Executar SQL · \`${conn.id}\`\n\n${r.refused}`);
            return;
          }
          this.dataCard(renderResultCard(`Resultado · \`${conn.id}\``, r.command, r.output, { ok: r.ok, truncated: r.truncated, durationMs: r.durationMs, rowCap: this.config.warehouse().rowCap }));
          // auto-cura: erro real do warehouse vira ANEXO — a próxima mensagem do dev já carrega o contexto
          if (!r.ok) this.addAttachment(`erro ${conn.id}`, "search", `Erro ao executar no warehouse ${conn.id}:\n${r.output}`);
          return;
        }
        case "custo": {
          const editor = vscode.window.activeTextEditor;
          const conn = this.warehouse().resolve(args?.trim() || undefined);
          if (!conn) {
            this.dataCard("### Custo\n\nNenhuma conexão configurada — veja `/conexoes`.");
            return;
          }
          if (editor && /\.sql$/i.test(editor.document.fileName)) {
            // prévia de custo da CONSULTA ativa (dry-run/EXPLAIN) — antes de rodar
            const sql = editor.selection && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : editor.document.getText();
            const r = await this.warehouse().costPreview(conn.id, sql);
            this.dataCard("refused" in r ? `### Custo (prévia) · \`${conn.id}\`\n\n${r.refused}` : renderResultCard(`Custo da consulta (prévia, sem executar) · \`${conn.id}\``, r.command, r.output, { ok: r.ok, truncated: r.truncated, durationMs: r.durationMs, rowCap: 500 }));
            return;
          }
          // sem .sql ativo: relatório FinOps (top consultas por custo, últimos 7 dias)
          const sql = topQueriesSql(conn.kind, conn.schemas?.[0]);
          if (typeof sql !== "string") {
            this.dataCard(`### Custo · \`${conn.id}\`\n\n${sql.error}`);
            return;
          }
          const r = await this.runOnConnection(conn, sql);
          this.dataCard("refused" in r ? `### Custo · \`${conn.id}\`\n\n${r.refused}` : renderFinopsCard(conn.id, conn.kind, r.output));
          return;
        }
        case "schema-db": {
          const conn = this.warehouse().resolve(args?.trim() || undefined);
          if (!conn) {
            this.dataCard("### Schema do warehouse\n\nNenhuma conexão configurada — veja `/conexoes`.");
            return;
          }
          const inv = columnsInventorySql(conn.kind, conn.schemas ?? []);
          if (typeof inv !== "string") {
            this.dataCard(`### Schema do warehouse · \`${conn.id}\`\n\n${inv.error}`);
            return;
          }
          const r = await this.runOnConnection(conn, inv, { skipMask: true, rowCapOverride: 50000 });
          if ("refused" in r || !r.ok) {
            this.dataCard(`### Schema do warehouse · \`${conn.id}\`\n\n${"refused" in r ? r.refused : "Falha no inventário:\n```\n" + r.output.slice(0, 1200) + "\n```"}`);
            return;
          }
          const rows = parseInventoryCsv(r.output);
          const snap: WarehouseSnapshot = { connectionId: conn.id, kind: conn.kind, takenAt: new Date().toISOString(), rows };
          const index = snapshotToIndex(snap);
          this.whSnapshots.set(conn.id, index);
          try {
            await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
            await fs.writeFile(path.join(this.context.globalStorageUri.fsPath, `wh-schema-${conn.id}.json`), serializeSnapshot(snap), "utf8");
          } catch (err) {
            log.warn("warehouse: snapshot não persistido (segue em memória).", err);
          }
          this.dataCard(`### Schema do warehouse · \`${conn.id}\`\n\n✅ **${index.size()} tabelas** indexadas (${rows.length} colunas). O schema real agora entra no prompt e no gate semântico — tabela/coluna fantasma vira achado.\n\n_⚠ O snapshot da amostra foi capado em ${this.config.warehouse().rowCap} linhas? Não — inventário usa o cap de 50k colunas do SQL. Rode de novo após DDLs relevantes._`);
          return;
        }
        case "paridade": {
          const parsed = parseParityArgs(args ?? "");
          if ("error" in parsed) {
            this.dataCard(`### Paridade de dados\n\n${parsed.error}`);
            return;
          }
          const index = await this.getGroundingIndex();
          const side = async (s: { conn?: string; table: string }) => {
            const conn = this.warehouse().resolve(s.conn || undefined);
            if (!conn) return { error: `Conexão ${s.conn ? `\`${s.conn}\`` : "default"} não existe.` };
            const cols = index?.findTable(s.table)?.columns.map((c) => c.name) ?? [];
            const r = await this.runOnConnection(conn, profileSql(conn.kind, s.table, cols), { skipMask: true, rowCapOverride: 5000 });
            if ("refused" in r) return { error: r.refused };
            if (!r.ok) return { error: `Perfil de \`${s.table}\` falhou:\n\`\`\`\n${r.output.slice(0, 800)}\n\`\`\`` };
            return { profile: parseProfileCsv(r.output) };
          };
          const [l, rgt] = [await side(parsed.left), await side(parsed.right)];
          if ("error" in l || "error" in rgt) {
            this.dataCard(`### Paridade de dados\n\n${("error" in l ? l.error : "") || ""}${"error" in rgt ? "\n" + rgt.error : ""}`);
            return;
          }
          this.dataCard(renderParityCard(parsed.left.table, parsed.right.table, compareProfiles(l.profile, rgt.profile)));
          return;
        }
        case "auditoria-pii": {
          const index = await this.getGroundingIndex();
          const findings = index ? scanIndexForPii(index) : [];
          this.dataCard(renderPiiCard(findings, index?.size() ?? 0));
          return;
        }
        default:
          this.dataCard(`Comando de dados desconhecido: \`${cmd}\`.`);
      }
    } catch (err) {
      log.warn(`Comando de dados /${cmd} falhou (fail-open).`, err);
      this.dataCard(`### /${cmd}\n\nFalhou: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // /impacto [modelo]: raio de explosão determinístico via lineage do manifest (host-computado, sem
  // LLM) + lineage de coluna do arquivo do modelo quando legível. O cartão volta como impact/report.
  async reportImpact(target?: string): Promise<void> {
    const index = await this.getDbtIndex();
    if (!index || index.size() === 0) {
      this.post({
        type: "impact/report",
        markdown:
          "### Raio de explosão\n\nSem grounding dbt: não encontrei `target/manifest.json` no workspace. Rode `dbt parse` (ou `dbt compile`) no projeto dbt e tente de novo — o FORGE lê o lineage real do manifest.",
      });
      return;
    }
    // alvo: argumento explícito > arquivo ativo no editor
    let node = target?.trim() ? index.findModelByName(target.trim()) : undefined;
    let modelFile: string | undefined;
    if (!node) {
      const editor = vscode.window.activeTextEditor;
      const ws = this.workspaceRoot();
      if (!target?.trim() && editor && ws && editor.document.uri.scheme === "file") {
        const rel = path.relative(ws, editor.document.uri.fsPath).split(path.sep).join("/");
        node = index.findByPath(rel);
        if (node) modelFile = editor.document.getText();
      }
    }
    if (!node) {
      const alvo = mdSafe(target?.trim() ?? "");
      const sug = alvo ? index.suggestTable(alvo) : undefined;
      const hint = alvo
        ? `O modelo \`${alvo}\` não existe no manifest do dbt${sug ? ` — você quis dizer \`${mdSafe(sug)}\`?` : "."}`
        : "Abra o arquivo de um modelo dbt no editor (ou use `/impacto nome_do_modelo`).";
      this.post({ type: "impact/report", markdown: `### Raio de explosão\n\n${hint}` });
      return;
    }
    let card = renderImpactCard(index, node);
    // lineage de coluna do próprio modelo (Onda 2): de onde vem cada coluna de saída
    try {
      if (!modelFile && node.originalFilePath && this.workspaceRoot()) {
        const base = this.dbtLoaded?.location.projectDir ?? this.workspaceRoot()!;
        modelFile = await fs.readFile(path.join(base, node.originalFilePath), "utf8");
      }
      if (modelFile) {
        const { sql } = stripJinja(modelFile);
        const stmts = classifySql(sql);
        const sel = stmts.find((s) => s.kind === "select");
        if (sel) {
          const lin = renderLineage(selectLineage(sel));
          if (lin) card += `\n\n${lin}`;
        }
      }
    } catch {
      // lineage de coluna é bônus — o cartão de modelo já responde o essencial
    }
    this.post({ type: "impact/report", markdown: card });
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

    // Schema REAL do projeto dbt (anti-alucinação): top-K tabelas relevantes para a query, com colunas
    // e tipos do manifest/catalog — o modelo consulta em vez de "lembrar" nomes. Vazio quando nada casa.
    try {
      const index = await this.getGroundingIndex();
      if (index) {
        const schemaBlock = renderSchemaContext(index, query);
        if (schemaBlock) parts.push(schemaBlock);
      }
    } catch (err) {
      log.warn("dbt: schema no contexto falhou (fail-open).", err);
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

  // Menção "@": envia o catálogo do workspace (arquivos + pastas derivadas dos diretórios) UMA vez; o webview
  // cacheia e filtra localmente (sem round-trip por tecla). Mesmos excludes do pickWorkspaceFile. Sem
  // workspace → catálogo vazio (o picker fica inerte).
  async listWorkspaceFiles(): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) {
      this.post({ type: "context/workspaceFiles", items: [] });
      return;
    }
    const uris = await vscode.workspace.findFiles("**/*", "{**/node_modules/**,**/.git/**,**/dist/**,**/.venv/**,**/__pycache__/**}", 5000);
    const files = uris.map((u) => path.relative(ws, u.fsPath).split(path.sep).join("/")).filter(Boolean);
    const folders = new Set<string>();
    for (const f of files) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    }
    const items = [
      ...[...folders].sort().map((p) => ({ path: p, kind: "folder" as const })),
      ...files.sort().map((p) => ({ path: p, kind: "file" as const })),
    ];
    this.post({ type: "context/workspaceFiles", items });
  }

  // Menção "@": anexa por caminho. Arquivo → o CONTEÚDO (como o pickWorkspaceFile). Pasta → uma LISTAGEM leve
  // dos arquivos dela (paths, não o conteúdo de todos — evita estourar a janela). safeWorkspacePath contém o
  // caminho na raiz (defesa contra `..`); binário/erro → aviso, sem anexar.
  async addWorkspaceFileAttachment(rel: string, kind: "file" | "folder"): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) return;
    const abs = safeWorkspacePath(ws, rel);
    if (!abs) {
      this.post({ type: "notice", level: "error", message: `Caminho inválido ou fora do workspace: ${rel}` });
      return;
    }
    try {
      if (kind === "folder") {
        // A base do RelativePattern é o caminho ABSOLUTO da pasta (literal), não `${rel}` interpolado num glob:
        // uma pasta com metacaractere de glob no nome (ex.: rota dinâmica Next.js `app/[id]`) seria mal-globada
        // (`[id]` vira classe de caracteres) e listaria VAZIO — achado da revisão. Só o `**/*` é glob agora.
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(abs), "**/*"), "{**/node_modules/**,**/.git/**,**/dist/**,**/.venv/**,**/__pycache__/**}", 500);
        const list = uris.map((u) => path.relative(ws, u.fsPath).split(path.sep).join("/")).sort();
        this.addAttachment(`${rel}/ (${list.length} arquivo${list.length === 1 ? "" : "s"})`, "workspace", `Arquivos da pasta ${rel}/:\n${list.join("\n") || "(vazia)"}`);
      } else {
        this.addAttachment(rel, "workspace", await fs.readFile(abs, "utf8"));
      }
    } catch {
      this.post({ type: "notice", level: "error", message: `Não foi possível ler ${rel} (binário?).` });
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
    // Política do admin (blockUnverifiedContract): o contrato não verificado bloqueia TAMBÉM o apply
    // POR-ARQUIVO (e por consequência "Aplicar e executar/visualizar") — senão N cliques nos cartões
    // selariam exatamente o projeto que o "Aplicar tudo" recusa. Sem política: comportamento antigo
    // (cartão individual não exige confirmação de contrato).
    if (this.gateContractUnverifiedHard && this.config.blockUnverifiedContract()) {
      this.permissions.note({ kind: "contract.unverified", action: `Aplicar ${entry.proposal.filePath} com contrato não verificado`, subject: entry.proposal.filePath, scope: "write" }, "blocked", "policy");
      this.post({ type: "notice", level: "warn", message: 'Bloqueado por política do admin (forge.gate.blockUnverifiedContract): o contrato cross-file precisa ser VERIFICADO antes de aplicar arquivos do projeto. Rode "Preparar ambiente" e depois "Re-verificar contrato".' });
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
    if (forcedOverride) {
      // Override consciente do gate ("Aplicar assim mesmo, revisei" / "Forçar bloqueados") — a decisão
      // do dev (tomada no botão do webview) entra no trail unificado, além do proposal.applied {forced}.
      this.permissions.note({ kind: "proposal.force", action: `Aplicar por cima do gate reprovado: ${entry.proposal.filePath}`, subject: entry.proposal.filePath, scope: "write" }, "approved", "webview");
    }
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

    // Lente "dados" (Onda 2): achados do motor SQL determinístico sobre os .sql alterados + raio de
    // explosão do manifest dbt entram como EVIDÊNCIA no prompt — o revisor cita fatos, não opinião.
    const sqlEvidence = await this.buildSqlReviewEvidence(diff);

    const provider = createProvider(runtime, this.egress);
    const taskId = `review_${Date.now()}`;
    const task = new Task({
      taskId,
      provider,
      systemPrompt: buildReviewPrompt(),
      messages: [
        {
          role: "user",
          content:
            `Revise estas alterações do workspace (\`git diff\`):\n\n\`\`\`diff\n${diff}\n\`\`\`` +
            (sqlEvidence ? `\n\n${sqlEvidence}` : ""),
        },
      ],
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

  // Evidência determinística para a lente "dados" do revisor: para cada .sql alterado no diff (cap 6),
  // achados do motor SQL (anti-padrões/segurança/schema dbt) + raio de explosão via manifest. "" quando
  // não há .sql no diff — o revisor de código comum segue idêntico. Fail-open em tudo.
  private async buildSqlReviewEvidence(diff: string): Promise<string> {
    try {
      const ws = this.workspaceRoot();
      if (!ws) return "";
      const paths = [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+\.sql)\s*$/gim)].map((m) => m[1].trim()))].slice(0, 6);
      if (paths.length === 0) return "";
      const index = await this.getGroundingIndex();
      const sections: string[] = [];
      for (const rel of paths) {
        // Contenção no workspace: os caminhos vêm do TEXTO do diff (linhas `+++ b/…` podem ser conteúdo
        // adicionado, não cabeçalho) — nunca ler fora da raiz (achado da revisão adversarial).
        const abs = safeWorkspacePath(ws, rel);
        if (!abs) continue;
        let content: string;
        try {
          content = await fs.readFile(abs, "utf8");
        } catch {
          continue; // arquivo deletado no diff — nada a analisar
        }
        const findings = sqlEvidenceForReview(rel, content, { mode: "advisory", index });
        const node = index?.findByPath(rel);
        const impact = node ? index!.downstream(node.uniqueId) : undefined;
        const impactLine =
          impact && (impact.transitive.length > 0 || impact.tests > 0)
            ? `Impacto (manifest dbt): ${impact.transitive.length} modelo(s) downstream, ${impact.tests} teste(s)${impact.exposures.length > 0 ? `, exposures: ${impact.exposures.join(", ")}` : ""}.`
            : "";
        if (findings.length === 0 && !impactLine) continue;
        sections.push([`**${rel}**`, impactLine, findings.length > 0 ? renderFindings(findings) : ""].filter(Boolean).join("\n"));
      }
      if (sections.length === 0) return "";
      return [
        "### Evidência determinística (motor SQL do FORGE)",
        "Fatos apurados por análise estática — cite-os nos achados em vez de especular; confiança declarada por item:",
        "",
        sections.join("\n\n"),
      ].join("\n");
    } catch (err) {
      log.warn("Revisão: evidência SQL indisponível (fail-open).", err);
      return "";
    }
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
