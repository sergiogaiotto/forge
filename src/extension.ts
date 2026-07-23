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
  context.subscriptions.push({ dispose: () => void controller.dispose() });

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
    vscode.commands.registerCommand("forge.setupProvider", async () => {
      await focusView();
      controller.openWebviewPanel("provider");
    }),
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
    vscode.commands.registerCommand("forge.prepareNotebook", async () => {
      await focusView();
      await controller.prepareNotebookKernel();
    }),
    vscode.commands.registerCommand("forge.activateVenv", async () => {
      await controller.activateVenv();
    }),
    vscode.commands.registerCommand("forge.diagnosePythonEnv", async () => {
      await focusView();
      await controller.diagnosePythonEnv();
    }),
    vscode.commands.registerCommand("forge.generateReadme", async () => {
      await focusView();
      await controller.generateReadme();
    }),
    vscode.commands.registerCommand("forge.createEnvExample", async () => {
      await controller.createEnvExample();
    }),
    vscode.commands.registerCommand("forge.updateGitignore", async () => {
      await controller.updateGitignore();
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
    }),
    vscode.commands.registerCommand("forge.openSqlLab", async () => {
      await focusView();
      await controller.runDataCommandFromPalette("sql-lab");
    }),
    vscode.commands.registerCommand("forge.importSqlSchema", async () => {
      await focusView();
      await controller.runDataCommandFromPalette("importar-schema");
    }),
    vscode.commands.registerCommand("forge.validateSql", async () => {
      await focusView();
      await controller.runDataCommandFromPalette("validar-sql");
    }),
    vscode.commands.registerCommand("forge.explainSql", async () => {
      await focusView();
      await controller.runDataCommandFromPalette("plano-sql");
    }),
    vscode.commands.registerCommand("forge.analyzeSql", async () => {
      await focusView();
      await controller.runDataCommandFromPalette("analisar-sql");
    }),
    vscode.commands.registerCommand("forge.compareSql", async () => {
      await focusView();
      await controller.runDataCommandFromPalette("comparar-sql");
    }),
    vscode.commands.registerCommand("forge.tuneSql", async () => {
      await focusView();
      await controller.runDataCommandFromPalette("tunar-sql");
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
