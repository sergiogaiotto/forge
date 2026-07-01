import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ExtToWebview, isRenderablePath } from "../shared/protocol";
import { buildPreviewHtml, escapeHtml, isWithinWorkspace } from "../util/previewHtml";

// Assets locais que, ao mudar, disparam o live reload (evita re-render por ruído de node_modules/.git).
const RELOAD_GLOB = "**/*.{html,htm,css,js,mjs,svg,png,jpg,jpeg,gif,webp,json}";

export interface PreviewServiceDeps {
  workspaceRoot: () => string | undefined;
  post: (msg: ExtToWebview) => void;
}

const RELOAD_DEBOUNCE_MS = 150;

// Renderiza artefatos estáticos (.html/.svg) gerados pelo modelo num WebviewPanel do VS Code, com CSP
// ESTRITA e recursos travados na PASTA do artefato (localResourceRoots). O HTML gerado roda ISOLADO:
// sem acesso ao filesystem do usuário nem à rede externa (default-src 'none'), coerente com o egress
// deny-by-default do FORGE. Live reload via FileSystemWatcher. Um único painel reutilizável.
export class PreviewService implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private currentAbs: string | undefined;
  private currentFolder: string | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: PreviewServiceDeps) {}

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.dispose();
    this.panel?.dispose();
  }

  async openPreview(relPath: string): Promise<void> {
    const ws = this.deps.workspaceRoot();
    if (!ws) return this.err("Abra uma pasta no VS Code para visualizar.");
    if (!isRenderablePath(relPath)) return this.err(`"${relPath}" não é um artefato visualizável (.html/.svg).`);

    // GUARDA in-network: o artefato tem de estar DENTRO do workspace. Resolvemos o realpath dos DOIS
    // lados (fecha symlinks que apontariam para fora) antes de validar a contenção.
    let wsReal = ws;
    let abs = path.resolve(ws, relPath);
    try {
      wsReal = await fs.realpath(ws);
      abs = await fs.realpath(abs);
    } catch {
      // arquivo/pasta ainda não existe no disco — segue com o caminho resolvido (o read falhará depois)
    }
    if (!isWithinWorkspace(wsReal, abs)) return this.err("O arquivo está fora do workspace.");

    const folder = path.dirname(abs);
    // localResourceRoots é imutável após a criação: recria o painel se a pasta do artefato mudou.
    if (!this.panel || this.currentFolder !== folder) {
      this.watcher?.dispose();
      this.panel?.dispose();
      this.panel = vscode.window.createWebviewPanel("forge.preview", "FORGE · Preview", vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(folder)],
        retainContextWhenHidden: true,
      });
      this.currentFolder = folder;
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.currentFolder = undefined;
        this.currentAbs = undefined;
        this.watcher?.dispose();
        this.watcher = undefined;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
      });
      // Live reload: observa os assets web da pasta do artefato (ignora ruído de node_modules/.git).
      this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), RELOAD_GLOB));
      this.watcher.onDidChange(() => this.scheduleReload());
      this.watcher.onDidCreate(() => this.scheduleReload());
    }

    this.currentAbs = abs;
    this.panel.title = `FORGE · ${path.basename(abs)}`;
    await this.render();
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.render(), RELOAD_DEBOUNCE_MS);
  }

  private async render(): Promise<void> {
    if (!this.panel || !this.currentAbs) return;
    let content: string;
    try {
      content = await fs.readFile(this.currentAbs, "utf8");
    } catch {
      this.panel.webview.html = this.errorHtml("Não foi possível ler o arquivo.");
      return;
    }
    const ext = path.extname(this.currentAbs).toLowerCase();
    const base = this.panel.webview.asWebviewUri(vscode.Uri.file(path.dirname(this.currentAbs))).toString();
    this.panel.webview.html = buildPreviewHtml(this.panel.webview.cspSource, base, ext, content);
  }

  private err(message: string): void {
    this.deps.post({ type: "notice", level: "error", message });
  }

  private errorHtml(msg: string): string {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#e0a8a8;padding:16px">${escapeHtml(msg)}</body></html>`;
  }
}
