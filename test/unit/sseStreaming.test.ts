import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchWithRetry,
  streamSse,
  sseData,
  tryJson,
  DEFAULT_IDLE_TIMEOUT_MS,
} from "../../src/core/llm/sse";
import { parseRetryAfter } from "../../src/core/llm/errors";

describe("Phase 7.2: SSE Streaming, Watchdog, Framing & Retry Integrity", () => {
  function makeByteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]);
        } else {
          controller.close();
        }
      },
    });
  }

  describe("Framing, CRLF, Comments, Metadata & UTF-8 Multi-byte Chunk Splitting", () => {
    it("correctly decodes multi-byte UTF-8 characters split across chunk boundaries", async () => {
      // "🚀 Rocket 文字" has 4-byte emoji 🚀 (F0 9F 9A 80) and 3-byte Kanji 文 (E6 96 87)
      const encoder = new TextEncoder();
      const fullText = 'data: {"char":"🚀 Rocket 文字"}\n\n';
      const fullBytes = encoder.encode(fullText);

      // Split right in the middle of the 4-byte emoji 🚀 (after byte 18: F0 9F | 9A 80)
      const splitIndex = 18;
      const chunk1 = fullBytes.slice(0, splitIndex);
      const chunk2 = fullBytes.slice(splitIndex);

      const stream = makeByteStream([chunk1, chunk2]);
      const payloads: string[] = [];
      for await (const p of streamSse(stream)) {
        payloads.push(p);
      }

      assert.equal(payloads.length, 1);
      const parsed = tryJson<{ char: string }>(payloads[0]);
      assert.equal(parsed?.char, "🚀 Rocket 文字", "Multi-byte UTF-8 split across chunks must assemble correctly");
    });

    it("handles CRLF (\\r\\n) and mixed line endings seamlessly", async () => {
      const encoder = new TextEncoder();
      const raw =
        'data: {"id":1}\r\n\r\n' +
        'data: {"id":2}\n\n' +
        'data: {"id":3}\r\n\n';
      const stream = makeByteStream([encoder.encode(raw)]);
      const payloads: string[] = [];
      for await (const p of streamSse(stream)) {
        payloads.push(p);
      }

      assert.equal(payloads.length, 3);
      assert.deepEqual(tryJson(payloads[0]), { id: 1 });
      assert.deepEqual(tryJson(payloads[1]), { id: 2 });
      assert.deepEqual(tryJson(payloads[2]), { id: 3 });
    });

    it("ignores comments, id:, event:, retry: metadata lines and [DONE] terminator", async () => {
      const encoder = new TextEncoder();
      const raw = [
        ": ping comment\n",
        "id: evt_001\n",
        "event: custom_event\n",
        "retry: 1000\n",
        'data: {"valid":true}\n\n',
        ": another comment\n",
        "data: [DONE]\n\n",
      ].join("");

      const stream = makeByteStream([encoder.encode(raw)]);
      const payloads: string[] = [];
      for await (const p of streamSse(stream)) {
        payloads.push(p);
      }

      assert.equal(payloads.length, 1);
      assert.deepEqual(tryJson(payloads[0]), { valid: true });
    });

    it("flushes final frames even without trailing newline or blank line", async () => {
      const encoder = new TextEncoder();
      const raw = 'data: {"trailing":true}';
      const stream = makeByteStream([encoder.encode(raw)]);
      const payloads: string[] = [];
      for await (const p of streamSse(stream)) {
        payloads.push(p);
      }

      assert.equal(payloads.length, 1);
      assert.deepEqual(tryJson(payloads[0]), { trailing: true });
    });

    it("reassembles multi-line data payloads joined with \\n", async () => {
      const encoder = new TextEncoder();
      const raw =
        'data: {"part1":\n' +
        'data: "hello",\n' +
        'data: "part2":"world"}\n\n';
      const stream = makeByteStream([encoder.encode(raw)]);
      const payloads: string[] = [];
      for await (const p of streamSse(stream)) {
        payloads.push(p);
      }

      assert.equal(payloads.length, 1);
      assert.deepEqual(tryJson(payloads[0]), { part1: "hello", part2: "world" });
    });
  });

  describe("Watchdog, Resource Limits & Reader Cancellation", () => {
    it("aborts and cancels reader when idle timeout is exceeded", async () => {
      let cancelled = false;
      const hungStream = new ReadableStream<Uint8Array>({
        pull() {
          // Never produce anything — simulate hung connection
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      });

      await assert.rejects(
        async () => {
          for await (const _ of streamSse(hungStream, undefined, { idleTimeoutMs: 50 })) {
            // iterate
          }
        },
        (err: any) => {
          assert.ok(err.message.includes("stalled"));
          return true;
        }
      );

      assert.equal(cancelled, true, "Reader must be cancelled on idle timeout");
    });

    it("cancels reader immediately when user AbortSignal triggers", async () => {
      let cancelled = false;
      const controller = new AbortController();
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      });

      setTimeout(() => controller.abort(), 20);

      await assert.rejects(
        async () => {
          for await (const _ of streamSse(stream, controller.signal, { idleTimeoutMs: 10000 })) {
            // iterate
          }
        },
        (err: any) => err.name === "AbortError"
      );

      assert.equal(cancelled, true, "Reader must be cancelled on caller abort");
    });

    it("bounds total response byte limit and cancels reader when exceeded", async () => {
      let cancelled = false;
      const bigChunk = new Uint8Array(2000);
      const stream = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          ctrl.enqueue(bigChunk);
        },
        cancel() {
          cancelled = true;
        },
      });

      await assert.rejects(
        async () => {
          for await (const _ of streamSse(stream, undefined, { maxResponseBytes: 1500 })) {
            // iterate
          }
        },
        (err: any) => {
          assert.ok(err.message.includes("budget"));
          return true;
        }
      );

      assert.equal(cancelled, true, "Reader must be cancelled on byte overflow");
    });
  });

  describe("Retry Policy, Retry-After Parsing & Quota Exhaustion Guard", () => {
    it("parses Retry-After header as integer seconds and HTTP-date", () => {
      assert.equal(parseRetryAfter("30"), 30);
      assert.equal(parseRetryAfter("0"), 0);
      assert.equal(parseRetryAfter(""), undefined);
      assert.equal(parseRetryAfter(null), undefined);

      // HTTP-date future
      const futureDate = new Date(Date.now() + 45000).toUTCString();
      const parsedSec = parseRetryAfter(futureDate);
      assert.ok(parsedSec !== undefined && parsedSec >= 40 && parsedSec <= 46);

      // HTTP-date past
      const pastDate = new Date(Date.now() - 10000).toUTCString();
      assert.equal(parseRetryAfter(pastDate), 0);
    });

    it("does NOT retry on 429 quota exhaustion (insufficient_quota / billing)", async () => {
      let fetchCalls = 0;
      const originalFetch = globalThis.fetch;

      try {
        globalThis.fetch = (async () => {
          fetchCalls++;
          return new Response(
            '{"error":{"message":"You exceeded your current quota.","code":"insufficient_quota"}}',
            { status: 429 }
          );
        }) as any;

        const res = await fetchWithRetry("https://api.openai.com/v1/chat", { method: "POST" }, { retries: 2 });
        assert.equal(res.status, 429);
        assert.equal(fetchCalls, 1, "Must fail immediately without retrying quota exhaustion");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("retries on transient rate limit (429 without quota keywords) and 503 gateway errors", async () => {
      let fetchCalls = 0;
      const originalFetch = globalThis.fetch;

      try {
        globalThis.fetch = (async () => {
          fetchCalls++;
          if (fetchCalls === 1) {
            return new Response("Service unavailable", { status: 503 });
          }
          if (fetchCalls === 2) {
            return new Response("Rate limited (requests per minute)", {
              status: 429,
              headers: { "Retry-After": "0" },
            });
          }
          return new Response("OK", { status: 200 });
        }) as any;

        const res = await fetchWithRetry("https://api.example.com", { method: "POST" }, { retries: 3 });
        assert.equal(res.status, 200);
        assert.equal(fetchCalls, 3);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

