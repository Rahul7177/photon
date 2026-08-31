import * as vscode from "vscode";
import type { Attachment } from "../shared/types";
import { PhotonController } from "./PhotonController";

/**
 * Chat Participant registration - makes Photon show up in Copilot Chat panel as @photon
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  controller: PhotonController
): vscode.Disposable {
  function randomUUID(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  const participant = vscode.chat.createChatParticipant("photon", async (request, _context, stream, _token) => {
    const text = request.prompt;
    const attachments: Attachment[] = request.references?.map((ref) => {
      const value = (ref as any).value;
      const name = (ref as any).name ?? "attachment";

      if (typeof value === "string") {
        return {
          id: randomUUID(),
          kind: "text",
          name,
          mime: "text/plain",
          size: Buffer.byteLength(value),
          text: value,
        } as Attachment;
      }
      // Handle image attachments
      if (value instanceof Uint8Array) {
        return {
          id: randomUUID(),
          kind: "image",
          name,
          mime: "image/png",
          size: value.byteLength,
          dataBase64: Buffer.from(value).toString("base64"),
        } as Attachment;
      }
      return null;
    }).filter((a): a is Attachment => a !== null) ?? [];

    // Use markdown for progress since stream.progress API varies
    stream.markdown("🔄 Sending to Photon...");

    try {
      // Send to Photon controller with attachments
      await controller.sendPrompt(text, attachments);
      stream.markdown("✅ Sent to Photon sidebar");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      stream.markdown(`❌ Error: ${message}`);
    }
  });

  participant.iconPath = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders?.[0]?.uri ?? context.extensionUri,
    "media",
    "photon-activity.svg"
  );

  return participant;
}

function randomUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}