import * as vscode from "vscode";
import { Controller } from "./core/Controller";
import { ForgeViewProvider } from "./webview/WebviewProvider";
import { setHostLocale, hostT } from "./i18n";
import { resolveLocale } from "./shared/locale";
import { log } from "./util/logger";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.init(context);
  // Fixa o locale do host a partir do idioma do VSCode, ANTES de qualquer string user-facing. Uma camada
  // própria (não vscode.l10n) porque o produto é pt-BR-first — ver src/i18n/hostMessages.ts.
  setHostLocale(resolveLocale(vscode.env.language));
  log.info("Ativando FORGE…");

  const controller = new Controller(context);
  const provider = new ForgeViewProvider(context, controller);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ForgeViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const focusView = () => vscode.commands.executeCommand("forge.sidebar.focus");

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.focus", focusView),
    vscode.commands.registerCommand("forge.newTask", async () => {
      await focusView();
    }),
    vscode.commands.registerCommand("forge.openOnRight", async () => {
      // Revela a Barra Lateral Secundária (direita) e foca o painel do FORGE.
      // Obs.: na 1ª vez é preciso mover o FORGE para a barra direita (arrastar ou
      // "View: Move View"); depois este comando sempre o traz à direita.
      await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      await focusView();
    }),
    vscode.commands.registerCommand("forge.activateLicense", focusView),
    vscode.commands.registerCommand("forge.setupProvider", focusView),
    vscode.commands.registerCommand("forge.reindexSkills", async () => {
      await controller.reindexSkills();
      await controller.postState();
      void vscode.window.showInformationMessage(hostT("dialog.skillsReindexed"));
    }),
    vscode.commands.registerCommand("forge.reindexCodebase", async () => {
      await controller.reindexCodebase();
    }),
    vscode.commands.registerCommand("forge.runActiveFile", async () => {
      await controller.runActiveFile();
    }),
    vscode.commands.registerCommand("forge.reviewChanges", async () => {
      await focusView();
      await controller.reviewChanges();
    }),
    vscode.commands.registerCommand("forge.runTests", async () => {
      await focusView();
      await controller.runTests();
    }),
    vscode.commands.registerCommand("forge.signOut", async () => {
      await controller.signOut();
      void vscode.window.showInformationMessage(hostT("dialog.signedOut"));
    }),
    vscode.commands.registerCommand("forge.showOutput", () => log.show()),
    vscode.commands.registerCommand("forge.exportDiagnostics", async () => {
      await controller.exportDiagnostics();
    }),
    vscode.commands.registerCommand("forge.setupObservability", async () => {
      await controller.setupObservability();
    }),
    vscode.commands.registerCommand("forge.setMaxOutput", async () => {
      await controller.pickMaxOutput();
    }),
    // Ações que saíram da barra do composer (composer enxuto), acessíveis pela paleta:
    vscode.commands.registerCommand("forge.prepareEnv", async () => {
      await focusView();
      await controller.prepareEnv();
    }),
    vscode.commands.registerCommand("forge.pickRole", async () => {
      await focusView();
      await controller.pickProjectRole();
    }),
    vscode.commands.registerCommand("forge.inspectIndex", async () => {
      await focusView(); // Índice/Perfil abrem um modal no webview — revela a view e manda abrir.
      controller.openWebviewPanel("inspect");
    }),
    vscode.commands.registerCommand("forge.openProfile", async () => {
      await focusView();
      controller.openWebviewPanel("profile");
    })
  );

  try {
    await controller.initialize();
    await controller.postState();
  } catch (err) {
    log.error("Falha na inicialização do FORGE", err);
  }

  log.info("FORGE ativado.");
}

export function deactivate(): void {
  log.info("FORGE desativado.");
}
