import type { Attachment } from "../../src/shared/types";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const TEXT_EXT = /\.(txt|md|markdown|json|ya?ml|csv|log|ini|toml|xml|html?|css|jsx?|tsx?|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|sh|sql|swift|kt|dart)$/i;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;

export interface AttachmentResult {
  attachment?: Attachment;
  error?: string;
}

/** Read a picked File into an Attachment (base64 image or extracted text). */
export async function readFileToAttachment(file: File): Promise<AttachmentResult> {
  const isImage = IMAGE_TYPES.includes(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name);
  const isText = file.type.startsWith("text/") || TEXT_EXT.test(file.name) || file.type === "application/json";

  if (isImage) {
    if (file.size > MAX_IMAGE_BYTES) return { error: `${file.name} is too large (max 6 MB).` };
    const dataUrl = await readAs(file, "dataURL");
    const base64 = dataUrl.split(",")[1] ?? "";
    return {
      attachment: {
        id: crypto.randomUUID(),
        kind: "image",
        name: file.name,
        mime: file.type || "image/png",
        size: file.size,
        dataBase64: base64,
      },
    };
  }

  if (isText) {
    if (file.size > MAX_TEXT_BYTES) return { error: `${file.name} is too large (max 200 KB of text).` };
    const text = await readAs(file, "text");
    return {
      attachment: {
        id: crypto.randomUUID(),
        kind: "text",
        name: file.name,
        mime: file.type || "text/plain",
        size: file.size,
        text,
      },
    };
  }

  return { error: `${file.name}: unsupported type. Attach an image or a text/code file.` };
}

function readAs(file: File, kind: "dataURL" | "text"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    if (kind === "dataURL") reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
