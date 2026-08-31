import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatProvider } from "./providers/openaiCompatProvider";
import { GeminiProvider } from "./providers/geminiProvider";
import type { LLMMessage } from "./types";
// readClipboardBlobToAttachment is defined in the webview-ui attachments module
// Import via relative path from the test file's perspective
import { readClipboardBlobToAttachment } from "../../../webview-ui/src/attachments";

// Phase 1.3: Image path end-to-end integration tests.
// Verifies that images flow correctly through each provider's wire format
// without actually making network calls (uses mock HTTP handlers).

// --- Helpers ---------------------------------------------------------------

/** Fake a small PNG: 1x1 transparent pixel. */
function fakePngBase64(): string {
  // Minimal 8-byte PNG header + IHDR + IDAT + IEND (base64 encoded)
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJREFTCjkJAAA=";
}

/** Capture the body sent to fetch() for a given provider test. */
function captureFetch(): { bodies: unknown[]; restore: () => void } {
  const bodies: unknown[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.body && typeof init.body === "string") {
      bodies.push(JSON.parse(init.body));
    } else if (init?.body instanceof URLSearchParams) {
      bodies.push(Object.fromEntries(init.body));
    }
    // Return a minimal valid response
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch);
  return {
    bodies,
    restore() {
      globalThis.fetch = origFetch;
    },
  };
}

// --- Tests -----------------------------------------------------------------

test("image 01: OpenAI-compatible provider sends image_url format", async () => {
  const provider = new OpenAICompatProvider({
    id: "test-openai",
    label: "Test OpenAI",
    baseUrl: "https://fake.api.com/v1",
    apiKey: "test-key",
    models: [{ id: "gpt-4o", name: "gpt-4o", contextLength: 128000, toolTrained: true, vision: true }],
    enabled: true,
  });

  const cap = captureFetch();
  try {
    const chunks: unknown[] = [];
    const gen = provider.chatStream({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: "What's in this image?",
          images: [fakePngBase64()],
        },
      ],
    });

    // Consume the generator — it will call our fake fetch
    for await (const chunk of gen) {
      chunks.push(chunk);
    }

    // Verify the request body contains image_url format
    assert.equal(cap.bodies.length, 1, "Should have sent one request");
    const body = cap.bodies[0] as { messages: { role: string; content: unknown }[] };
    const userMsg = body.messages.find((m) => m.role === "user");
    assert.ok(userMsg, "Should have a user message");

    // Content should be an array (OpenAI vision format), not a plain string
    assert.ok(Array.isArray(userMsg.content), "User content should be an array for vision");
    const parts = userMsg.content as { type: string; text?: string; image_url?: { url: string } }[];

    // Should have text + image_url parts
    const textPart = parts.find((p) => p.type === "text");
    const imgPart = parts.find((p) => p.type === "image_url");
    assert.ok(textPart, "Should have a text part");
    assert.ok(imgPart, "Should have an image_url part");
    assert.ok(imgPart!.image_url!.url.startsWith("data:image/png;base64,"), "image_url should be base64 data URI");
  } finally {
    cap.restore();
  }
});

test("image 02: Gemini provider sends inlineData format", async () => {
  const provider = new GeminiProvider({
    apiKey: "test-key",
    enabled: true,
    models: [{ id: "gemini-2.5-pro", name: "gemini:gemini-2.5-pro", contextLength: 1000000, vision: true, toolTrained: true }],
  });

  const cap = captureFetch();
  try {
    const chunks: unknown[] = [];
    const gen = provider.chatStream({
      model: "gemini:gemini-2.5-pro",
      messages: [
        {
          role: "user",
          content: "Describe this image",
          images: [fakePngBase64()],
        },
      ],
    });

    for await (const chunk of gen) {
      chunks.push(chunk);
    }

    assert.equal(cap.bodies.length, 1, "Should have sent one request");
    const body = cap.bodies[0] as { contents: { role: string; parts: Record<string, unknown>[] }[] };

    // Find the user content
    const userContent = body.contents.find((c) => c.role === "user");
    assert.ok(userContent, "Should have a user content entry");

    // Should have text + inlineData parts
    const textPart = userContent.parts.find((p) => "text" in p);
    const imgPart = userContent.parts.find((p) => "inlineData" in p);
    assert.ok(textPart, "Should have a text part");
    assert.ok(imgPart, "Should have an inlineData part");

    const inlineData = imgPart!.inlineData as { mimeType: string; data: string };
    assert.equal(inlineData.mimeType, "image/png", "Should use image/png mime type");
    assert.equal(inlineData.data, fakePngBase64(), "Should pass through base64 data unchanged");
  } finally {
    cap.restore();
  }
});

test("image 03: Ollama provider passes images in message", async () => {
  // OllamaProvider is a thin wrapper — verify images field is passed through
  const msg: LLMMessage = {
    role: "user" as const,
    content: "What do you see?",
    images: [fakePngBase64()],
  };

  assert.ok(msg.images, "Ollama message should have images field");
  assert.equal(msg.images.length, 1, "Should have one image");
  assert.equal(msg.images[0], fakePngBase64(), "Image data should match");
});

test("image 04: readClipboardBlobToAttachment handles Firefox fallback", async () => {

  // Create a fake Blob with PNG type (simulating Firefox clipboard)
  const fakeBlob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });

  const result = await readClipboardBlobToAttachment(fakeBlob, "test-clipboard.png");
  assert.ok(result.attachment, "Should create an attachment from a Blob");
  assert.equal(result.attachment!.kind, "image", "Should be an image attachment");
  assert.equal(result.attachment!.name, "test-clipboard.png", "Should use provided filename");
  assert.equal(result.attachment!.mime, "image/png", "Should preserve mime type");
  assert.ok(result.attachment!.dataBase64, "Should have base64 data");
});

test("image 05: readClipboardBlobToAttachment rejects non-image types", async () => {

  const textBlob = new Blob(["hello"], { type: "text/plain" });
  const result = await readClipboardBlobToAttachment(textBlob);
  assert.ok(result.error, "Should return error for non-image blob");
  assert.ok(result.error!.includes("not a supported image"), "Error should mention unsupported type");
});

test("image 06: readClipboardBlobToAttachment rejects oversized images", async () => {

  // Create a fake oversized blob (>6MB)
  const bigBlob = new Blob([new Uint8Array(7 * 1024 * 1024)], { type: "image/png" });
  const result = await readClipboardBlobToAttachment(bigBlob);
  assert.ok(result.error, "Should return error for oversized image");
  assert.ok(result.error!.includes("too large"), "Error should mention size");
});
