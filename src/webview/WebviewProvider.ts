import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { Controller } from "../core/Controller";
import { WebviewToExt } from "../shared/protocol";
import { resolveLocale } from "../shared/locale";
import { log } from "../util/logger";

// Hospeda a SPA React na view da barra de atividades. Aplica uma CSP estrita e
// restringe o carregamento de recursos a dist/webview (RNF-005).
export class ForgeViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "forge.sidebar";

  constructor(private readonly context: vscode.ExtensionContext, private readonly controller: Controller) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const webview = view.webview;
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    webview.options = {
      enableScripts: true,
      localResourceRoots: [distRoot],
    };
    webview.html = this.getHtml(webview, distRoot);

    this.controller.setPoster((msg) => {
      void webview.postMessage(msg);
    });

    view.onDidDispose(() => this.controller.setPoster(() => undefined));

    webview.onDidReceiveMessage(async (raw: WebviewToExt) => {
      try {
        await this.controller.handleMessage(raw);
      } catch (err) {
        log.error("Erro ao tratar mensagem da webview", err);
      }
    });
  }

  private getHtml(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, "assets", "index.js"));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, "assets", "index.css"));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // Propaga o locale do VSCode ao webview (contexto separado, sem a API vscode): via `lang` do <html>
    // e `data-locale` no #root — disponível no BOOT, antes de qualquer mensagem (a CSP proíbe script
    // inline sem nonce, então o data-attr é o canal robusto). A camada i18n da webview lê o data-locale.
    const locale = resolveLocale(vscode.env.language);

    return `<!DOCTYPE html>
<html lang="${locale}">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${cssUri}" />
    <title>FORGE</title>
  </head>
  <body>
    <div id="root" data-locale="${locale}"></div>
    <script type="module" nonce="${nonce}" src="${jsUri}"></script>
  </body>
</html>`;
  }
}
