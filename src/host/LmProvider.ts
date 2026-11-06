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
    // Files dragged into VS Code's native Chat input arrive as #file
    // references whose value is a Uri (or Location). Read them here with the
    // same size/type policy as the sidebar picker — this is the no-Shift,
    // Copilot-style drop path (the sidebar webview can't receive plain
    // Explorer drops by platform design).
    const attachments: Attachment[] = [];
    const skipped: string[] = [];
    for (const ref of request.references ?? []) {
      const value = (ref as any).value;
      const refName = (ref as any).name ?? "attachment";

      if (typeof value === "string") {
        attachments.push({
          id: randomUUID(),
          kind: "text",
          name: refName,
          mime: "text/plain",
          size: Buffer.byteLength(value),
          text: value,
        });
        continue;
      }
      // Handle image attachments
      if (value instanceof Uint8Array) {
        attachments.push({
          id: randomUUID(),
          kind: "image",
          name: refName,
          mime: "image/png",
          size: value.byteLength,
          dataBase64: Buffer.from(value).toString("base64"),
        });
        continue;
      }
      const uri: vscode.Uri | undefined =
        value instanceof vscode.Uri
          ? value
          : value instanceof vscode.Location
            ? value.uri
            : (value as any)?.uri instanceof vscode.Uri
              ? (value as any).uri
              : undefined;
      if (!uri) continue;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
          skipped.push(`${uri.path.split("/").pop() ?? "folder"} (folders can't attach — drop files)`);
          continue;
        }
        const base = uri.path.split("/").pop() || refName;
        const ext = (base.split(".").pop() ?? "").toLowerCase();
        const isImage = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);
        const isText = /^(txt|md|markdown|json|ya?ml|csv|log|ini|toml|xml|html?|css|jsx?|tsx?|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|sh|sql|swift|kt|dart)$/i.test(ext);
        if (isImage && stat.size <= 6 * 1024 * 1024) {
          const data = await vscode.workspace.fs.readFile(uri);
          attachments.push({
            id: randomUUID(), kind: "image", name: base,
            mime: `image/${ext === "jpg" ? "jpeg" : ext}`, size: stat.size,
            dataBase64: Buffer.from(data).toString("base64"),
          });
        } else if (isText && stat.size <= 200 * 1024) {
          const data = await vscode.workspace.fs.readFile(uri);
          attachments.push({
            id: randomUUID(), kind: "text", name: base,
            mime: ext === "json" ? "application/json" : "text/plain", size: stat.size,
            text: Buffer.from(data).toString("utf8"),
          });
        } else {
          skipped.push(`${base} (unsupported type or too large)`);
        }
      } catch (e) {
        skipped.push(`${uri.path.split("/").pop() ?? "file"} (${(e as Error).message})`);
      }
    }

    // Use markdown for progress since stream.progress API varies
    stream.markdown("Sending to Photon...");

    try {
      // Send to Photon controller with attachments
      await controller.sendPrompt(text, attachments);
      stream.markdown(
        skipped.length
          ? `Sent to Photon sidebar (${attachments.length} attached, skipped: ${skipped.join("; ")})`
          : "Sent to Photon sidebar"
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      stream.markdown(`Error: ${message}`);
    }
  });

  participant.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
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