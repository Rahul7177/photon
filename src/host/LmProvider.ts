import * as vscode from "vscode";

function randomUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Chat Participant registration - makes Photon show up in Copilot Chat panel as @photon
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  controller: any
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant("photon", async (request, _context, stream, _token) => {
    const text = request.prompt;

    stream.progress("Sending to Photon...");

    // Send to Photon controller
    await controller.sendPrompt(text, []); // skip attachments for now in chat participant

    stream.markdown("✅ Sent to Photon sidebar");
  });

  participant.iconPath = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders?.[0]?.uri ?? context.extensionUri,
    "media",
    "photon-activity.svg"
  );

  return participant;
}