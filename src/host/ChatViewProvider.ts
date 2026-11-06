import * as vscode from "vscode";
import type { ViewMessage } from "../shared/protocol";
import { PhotonController } from "./PhotonController";

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "photon.chat";
  public controller: PhotonController;
  private view?: vscode.WebviewView;
  private messageSub?: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel
  ) {
    this.controller = new PhotonController(context, output);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    // Record the view resolution – useful for diagnostics without affecting performance.
    console.debug(`[ChatViewProvider] resolveWebviewView called for view type=${view.viewType}`);
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    view.webview.html = this.html(view.webview);

    this.controller.setPost((msg) => view.webview.postMessage(msg));
    // The view can be resolved more than once (container closed then reopened).
    // Drop the previous binding so listeners never stack across re-resolves.
    // Ensure any previous listener is cleaned up before attaching a new one.
    this.messageSub?.dispose();
    this.messageSub = view.webview.onDidReceiveMessage((msg: ViewMessage) => {
      void this.controller.handleMessage(msg);
    });
    view.onDidDispose(() => {
      this.messageSub?.dispose();
      this.messageSub = undefined;
      if (this.view === view) this.view = undefined;
    });
  }

  reveal(): void {
    this.view?.show?.(true);
  }

  dispose(): void {
    this.messageSub?.dispose();
    this.messageSub = undefined;
    this.view = undefined;
  }

  post(msg: ViewMessage): void {
    // Re-enter the controller as if the message came from the webview
    // (used by command palette actions).
    void this.controller.handleMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const asset = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "assets", file)
      );
    const scriptUri = `${asset("index.js")}?v=${nonce}`;
    const styleUri = `${asset("index.css")}?v=${nonce}`;
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src ${webview.cspSource} https://fonts.gstatic.com`,
      `connect-src ${webview.cspSource} https://fonts.googleapis.com https://fonts.gstatic.com`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Manrope:wght@600;700;800&family=Sora:wght@600;700;800&family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <title>Photon</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
