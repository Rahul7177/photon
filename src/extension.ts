import * as vscode from "vscode";
import { ChatViewProvider } from "./host/ChatViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Photon");
  context.subscriptions.push(output);

  const provider = new ChatViewProvider(context.extensionUri, context, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("photon.openChat", () => {
      void vscode.commands.executeCommand("photon.chat.focus");
      provider.reveal();
    }),
    vscode.commands.registerCommand("photon.newSession", () => {
      provider.post({ type: "newSession" });
    }),
    vscode.commands.registerCommand("photon.refreshModels", () => {
      provider.post({ type: "refreshModels" });
    }),
    vscode.commands.registerCommand("photon.runDiagnostics", () => {
      void provider.controller.runDiagnostics();
    })
  );

  output.appendLine("Photon activated.");
}

export function deactivate(): void {
  // nothing to clean up beyond disposables
}
