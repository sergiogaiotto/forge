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
import { SkillValidator } from "../skills/SkillValidator";
import { getModelMeta, resolveMaxOutput } from "../api/modelCatalog";
import { buildVenvSetupCommand, findVenvPython, resolveTestCommand } from "../util/pythonEnv";
import { redactSecrets } from "../util/redact";
import { deriveBudget } from "./ContextBudget";
import { PreviewService } from "./PreviewService";
import { SkillMeta, SkillValidatorSpec } from "../skills/types";
import {
  CharterKey,
  CHARTER_KEYS,
  CharterSections,
  DEFAULT_REASONING_EFFORT,
  effectiveTimeoutSeconds,
  ExtToWebview,
  ForgeState,
  LicenseView,
  ProjectArchitecture,
  ProjectLanguage,
  ProviderSetup,
  ProviderView,
  ReasoningEffort,
  SkillView,
  supportsReasoningEffort,
  WebviewToExt,
} from "../shared/protocol";
import { EmailIdentity, isEmail, osLogin, resolveEmailIdentity } from "../util/identity";
import { log } from "../util/logger";
import { exec } from "node:child_process";
import { buildAcceptanceTestsRequest, buildBasePrompt, buildCharterSystemPrompt, buildProjectPrompt, buildReviewPrompt, buildTddPrompt } from "./systemPrompt";
import { appendRule, CHARTER_SECTIONS, collectRules, defaultProfileSkeleton, getSection, PROFILE_RELPATH, renderProfileBlock, setSection } from "../util/projectProfile";
import { DetectedStack, detectStack, renderStackBlock, STACK_PROBE_FILES } from "../util/stackDetect";
import { validatorsFromStack } from "../skills/stackValidators";
import { Role, resolveRole, roleGuidance, roleLabel, setRole, stripFrontmatter } from "../util/roleDefaults";
import { Observability } from "../obs/Observability";
import { LangfuseDirectSink } from "../obs/LangfuseDirectSink";
import { Runner } from "./Runner";
import { RunService } from "./RunService";
import { Task } from "./Task";

const GS_PROVIDER = "forge.provider";
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
  private skills: SkillMeta[] = [];
  private sessionToken: SessionToken | undefined;
  private licenseKey: string | undefined;
  private history: ChatMessage[] = [];
  private pendingAttachments: { id: string; label: string; kind: "workspace" | "upload" | "selection" | "search"; content: string }[] = [];
  private attachmentSeq = 0;
  private currentTask: Task | undefined;
  private readonly runService: RunService;
  private readonly previewService: PreviewService;
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();

  private poster: ((msg: ExtToWebview) => void) | undefined;

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
    this.obs = new Observability(
      () => this.config.observability(),
      new LangfuseDirectSink(() => this.config.observability(), () => this.secrets.get(SecretsStore.KEY_LANGFUSE_SECRET), this.egress),
      { onError: (m) => log.warn(m) }
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
    this.post({ type: "notice", level: "info", message: `Papel definido: ${pick.label}.` });
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

  // Abre o wizard: manda ao webview o conteúdo atual de cada seção do charter.
  async openCharter(): Promise<void> {
    this.post({ type: "charter/state", sections: this.charterSectionsFrom(await this.readCharterDoc()) });
  }

  // Pede ao modelo para REDIGIR uma seção a partir do rascunho do dev + contexto (stack + outras seções).
  // Geração ONE-SHOT (texto puro, sem blocos de arquivo); registra trace como as demais gerações.
  async draftCharterSection(section: CharterKey, brief: string): Promise<void> {
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
    // Tetos defensivos como no resto do FORGE: o brief (textarea, pode ter texto colado) e cada bloco
    // de contexto são limitados para não estourar a janela/custo do modelo.
    const others = CHARTER_SECTIONS.filter((s) => s.key !== section)
      .map((s) => {
        const body = getSection(doc, s.header);
        return body ? renderProfileBlock(`${s.header}\n${body}`, 1500) : "";
      })
      .filter((s) => s.trim());
    const label = CHARTER_SECTIONS.find((s) => s.key === section)?.label ?? section;
    const cappedBrief = brief.trim().slice(0, 4000);
    const userMsg = [
      "Contexto do projeto:",
      [renderProfileBlock(renderStackBlock(stack), 1500), ...others].filter((s) => s.trim()).join("\n\n") || "(sem contexto adicional detectado)",
      "",
      `Rascunho/instrução do dev para a seção "${label}":`,
      cappedBrief || "(vazio — proponha do zero, coerente com o contexto acima)",
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
    let error: string | undefined;
    try {
      const provider = createProvider(runtime, this.egress);
      const headers = this.buildTraceHeaders([], runtime.modelId, runtime.type, runtime.reasoningEffort, "charter");
      for await (const chunk of provider.createMessage(buildCharterSystemPrompt(section), [{ role: "user", content: userMsg }], {
        timeoutMs: runtime.timeoutSeconds * 1000,
        extraHeaders: headers,
      })) {
        if (chunk.kind === "text") text += chunk.text;
        else if (chunk.kind === "error") {
          error = chunk.message;
          break;
        }
      }
      if (error) this.post({ type: "charter/error", section, message: error });
      else this.post({ type: "charter/drafted", section, text: text.trim() });
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
      this.post({ type: "charter/error", section, message: error });
    } finally {
      this.obs.record({ type: "generation.end", taskId, durationMs: Date.now() - started, model: runtime.modelId, input: userMsg, output: text, proposals: 0, error });
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
      case "provider/openSettings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "forge");
        break;
      case "embeddings/test":
        await this.testEmbeddings();
        break;
      case "chat/send":
        await this.startTask(msg.text, msg.tdd ? "tdd" : "normal");
        break;
      case "project/start":
        await this.startTask(msg.text, "project", { language: msg.language, architecture: msg.architecture });
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
        await this.applyProposal(msg.proposalId);
        break;
      case "proposal/applyAndRun":
        await this.applyAndRun(msg.proposalId);
        break;
      case "proposal/applyAndPreview":
        await this.applyAndPreview(msg.proposalId);
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
        await this.draftCharterSection(msg.section, msg.brief);
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

  private async runtimeProviderConfig(): Promise<ProviderRuntimeConfig | undefined> {
    const p = this.context.globalState.get<ProviderPersisted>(GS_PROVIDER);
    if (!p) return undefined;
    const apiKey = (await this.secrets.get(SecretsStore.providerApiKey("default"))) ?? "not-needed";
    // Teto de saída REAL do modelo (catálogo), sobrescrevível por config. Sem isto, toda geração caía
    // no DEFAULT_MAX_TOKENS fixo (16384), ignorando a janela de 128k do gpt-oss-120b.
    const meta = getModelMeta(p.type, p.modelId);
    const maxTokens = resolveMaxOutput(this.config.provider().maxOutput, meta);
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

  async testProvider(setup: ProviderSetup): Promise<void> {
    const cfg: ProviderRuntimeConfig = {
      type: setup.type,
      modelId: setup.modelId,
      baseUrl: setup.baseUrl,
      authHeader: setup.authHeader,
      apiKey: setup.apiKey || "not-needed",
      timeoutSeconds: Math.min(setup.timeoutSeconds || 30, 30),
      // Envia o teto REAL do catálogo (não um valor mínimo): assim, se o gateway recusar esse max_tokens
      // por exceder o --max-model-len servido, o 400 aparece já no "Testar conexão", não na 1ª geração.
      // O prompt "responda apenas ok" faz o modelo parar cedo, então não gera o teto inteiro.
      maxTokens: resolveMaxOutput(this.config.provider().maxOutput, getModelMeta(setup.type, setup.modelId)),
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
    project?: { language: ProjectLanguage; architecture: ProjectArchitecture }
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

    let retrievedContext = await this.gatherContext(text);
    if (this.pendingAttachments.length > 0) {
      const att = this.pendingAttachments.map((a) => `### Anexo: ${a.label}\n\`\`\`\n${a.content}\n\`\`\``).join("\n\n");
      retrievedContext = `Anexos fornecidos pelo usuário:\n${att}\n\n${retrievedContext}`;
      this.pendingAttachments = [];
      this.postAttachments(); // limpa os chips (anexos são consumidos no envio)
    }
    const basePrompt =
      mode === "project" && project
        ? buildProjectPrompt(this.workspaceName(), project.language, project.architecture)
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
      emit: (e) => this.obs.record(e),
      obsMeta: {
        mode,
        model: runtime.modelId,
        provider: runtime.type,
        sessionId: this.sessionId,
        userId: this.resolveIdentity().email ?? "",
        org: this.context.globalState.get<{ org?: string }>(GS_LICENSE_META)?.org,
      },
      post: (m) => this.post(m),
    });
    this.currentTask = task;

    // Registra o turno do usuário; o turno do assistente é anexado após a conclusão.
    this.history.push({ role: "user", content: text });
    await task.run();
    // Mantém o histórico limitado.
    if (this.history.length > 20) this.history = this.history.slice(-20);
  }

  private workspaceName(): string {
    return vscode.workspace.workspaceFolders?.[0]?.name ?? "workspace";
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

  async applyProposal(proposalId: string): Promise<boolean> {
    const entry = this.currentTask?.getProposal(proposalId);
    if (!entry) {
      this.post({ type: "notice", level: "warn", message: "Proposta não encontrada (expirada)." });
      return false;
    }
    if (this.config.gateBlocksApply() && !entry.gateOk) {
      this.post({
        type: "notice",
        level: "error",
        message: "Quality gate reprovado: corrija os problemas apontados pelos validadores antes de aplicar.",
      });
      return false;
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
        this.obs.record({ type: "proposal.applied", filePath: entry.proposal.filePath });
      }
      return ok;
    }

    const abs = path.join(ws, entry.proposal.filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, entry.proposal.modified, "utf8");
    this.history.push({ role: "assistant", content: `Apliquei a alteração em ${entry.proposal.filePath}.` });
    this.post({ type: "proposal/applied", proposalId });
    this.obs.record({ type: "proposal.applied", filePath: entry.proposal.filePath });
    const docUri = vscode.Uri.file(abs);
    await vscode.window.showTextDocument(docUri, { preview: false });
    return true;
  }

  // Aplica uma proposta de célula no notebook ao vivo e registra o índice final
  // (para execução por célula). Retorna false se algo impedir a aplicação.
  private async applyCellProposal(
    proposalId: string,
    entry: { proposal: import("../shared/protocol").DiffProposal; cellIndex?: number }
  ): Promise<boolean> {
    const ws = this.workspaceRoot();
    const abs = path.join(ws!, entry.proposal.filePath);
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
  async applyAndRun(proposalId: string): Promise<void> {
    const entry = this.currentTask?.getProposal(proposalId);
    const applied = await this.applyProposal(proposalId);
    if (applied && entry && !entry.proposal.cell) {
      await this.runService.runFile(entry.proposal.filePath, proposalId);
    }
  }

  // Grava o arquivo E abre o preview — num único handler, garantindo a ordem (o preview lê o arquivo
  // só depois de gravado), diferente de postar apply + preview/open como mensagens concorrentes.
  async applyAndPreview(proposalId: string): Promise<void> {
    const entry = this.currentTask?.getProposal(proposalId);
    const applied = await this.applyProposal(proposalId);
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
    // Roda pytest pelo interpretador do venv do projeto (python -m pytest), não pelo PATH global —
    // elimina o "ModuleNotFoundError: No module named pytest" quando o venv não está ativado no shell.
    const venvPython = findVenvPython(ws, process.platform === "win32", existsSync, process.env.VIRTUAL_ENV);
    const command = resolveTestCommand(testCfg.command, venvPython);
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

  // "Preparar ambiente": cria o venv do projeto e instala as dependências (requirements.txt/pyproject).
  // Ataca a raiz do "No module named pytest" — o ambiente não estava preparado. Streaming pelo spawn
  // (cmd.exe/sh), então o encadeamento `&&` funciona mesmo com o terminal em PowerShell.
  async prepareEnv(): Promise<void> {
    const ws = this.workspaceRoot();
    if (!ws) {
      this.post({ type: "notice", level: "error", message: "Abra uma pasta no VSCode para preparar o ambiente." });
      return;
    }
    const hasReq = existsSync(path.join(ws, "requirements.txt"));
    const hasPyproject = existsSync(path.join(ws, "pyproject.toml"));
    if (!hasReq && !hasPyproject) {
      this.post({
        type: "notice",
        level: "warn",
        message: "Preparar ambiente: nenhum requirements.txt ou pyproject.toml na raiz (suporte a projetos Python por ora).",
      });
      return;
    }
    // requirements.txt tem prioridade. Só usa `pip install -e .` se o pyproject for INSTALÁVEL
    // ([build-system] ou [project]); um pyproject só-de-ferramentas (ruff/pytest/black) quebraria o
    // `-e .` — nesse caso apenas cria o venv (não falha no cenário que deveria resolver).
    let install: "requirements" | "editable" | "none";
    if (hasReq) {
      install = "requirements";
    } else {
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
    }
    const isWin = process.platform === "win32";
    const venvPython = findVenvPython(ws, isWin, existsSync, process.env.VIRTUAL_ENV);
    const command = buildVenvSetupCommand({ isWindows: isWin, venvPython, install });
    await this.runService.runCommand("ambiente", command);
  }

  // ---- revisão de código (in-network) ----------------------------------------

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
      emit: (e) => this.obs.record(e),
      obsMeta: {
        mode: "review",
        model: runtime.modelId,
        provider: runtime.type,
        sessionId: this.sessionId,
        userId: this.resolveIdentity().email ?? "",
        org: this.context.globalState.get<{ org?: string }>(GS_LICENSE_META)?.org,
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
