import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchWithRetry,
  sseData,
  streamSse,
  tryJson,
} from "../../src/core/llm/sse";

describe("LLM Providers & SSE Event Stream Framing", () => {
  describe("sseData & tryJson", () => {
    it("extracts data payload from SSE lines", () => {
      assert.equal(sseData('data: {"text":"hello"}'), '{"text":"hello"}');
      assert.equal(sseData("data:   trimmed"), "trimmed");
    });

    it("filters out the [DONE] SSE terminator", () => {
      assert.equal(sseData("data: [DONE]"), undefined);
    });

    it("accepts bare NDJSON lines for Ollama", () => {
      assert.equal(sseData('{"response":"token"}'), '{"response":"token"}');
    });

    it("ignores SSE comments and event metadata lines", () => {
      assert.equal(sseData(": keep-alive ping"), undefined);
      assert.equal(sseData("event: message_start"), undefined);
      assert.equal(sseData("id: 12345"), undefined);
    });

    it("tryJson parses valid JSON and returns undefined on malformed payloads", () => {
      assert.deepEqual(tryJson('{"valid": true}'), { valid: true });
      assert.equal(tryJson("{invalid: json}"), undefined);
      assert.equal(tryJson(""), undefined);
    });
  });

  describe("streamSse Framing", () => {
    function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i < chunks.length) {
            controller.enqueue(encoder.encode(chunks[i++]));
          } else {
            controller.close();
          }
        },
      });
    }

    it("yields full event payloads dispatched on blank lines", async () => {
      const chunks = [
        'data: {"id": 1}\n\n',
        'data: {"id": 2}\n\n',
        "data: [DONE]\n\n",
      ];
      const stream = makeStream(chunks);
      const results: string[] = [];
      for await (const payload of streamSse(stream)) {
        results.push(payload);
      }

      assert.equal(results.length, 2);
      assert.equal(results[0], '{"id": 1}');
      assert.equal(results[1], '{"id": 2}');
    });

    it("reassembles large JSON frames split across multiple data lines", async () => {
      const chunks = [
        'data: {"line1": "start",\n',
        'data: "line2": "end"}\n\n',
      ];
      const stream = makeStream(chunks);
      const results: string[] = [];
      for await (const payload of streamSse(stream)) {
        results.push(payload);
      }

      assert.equal(results.length, 1);
      assert.equal(results[0], '{"line1": "start",\n"line2": "end"}');
      assert.deepEqual(tryJson(results[0]), { line1: "start", line2: "end" });
    });

    it("flushes final payload even if trailing blank line is missing", async () => {
      const chunks = ['data: {"final": true}'];
      const stream = makeStream(chunks);
      const results: string[] = [];
      for await (const payload of streamSse(stream)) {
        results.push(payload);
      }

      assert.equal(results.length, 1);
      assert.equal(results[0], '{"final": true}');
    });
  });

  describe("fetchWithRetry", () => {
    it("returns immediately on 200 OK without retries", async () => {
      let fetchCalls = 0;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          fetchCalls++;
          return new Response("OK", { status: 200 });
        }) as any;

        const res = await fetchWithRetry("https://api.example.com", { method: "POST" });
        assert.equal(res.status, 200);
        assert.equal(fetchCalls, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("does not retry on fatal client error 400", async () => {
      let fetchCalls = 0;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          fetchCalls++;
          return new Response("Bad Request", { status: 400 });
        }) as any;

        const res = await fetchWithRetry("https://api.example.com", { method: "POST" });
        assert.equal(res.status, 400);
        assert.equal(fetchCalls, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("retries on 429 rate limit and succeeds on second attempt", async () => {
      let fetchCalls = 0;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          fetchCalls++;
          if (fetchCalls === 1) {
            return new Response("Rate limited", { status: 429 });
          }
          return new Response("Success", { status: 200 });
        }) as any;

        const res = await fetchWithRetry(
          "https://api.example.com",
          { method: "POST" },
          { retries: 2 }
        );
        assert.equal(res.status, 200);
        assert.equal(fetchCalls, 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("aborts immediately when AbortSignal is cancelled", async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        fetchWithRetry(
          "https://api.example.com",
          { method: "POST" },
          { signal: controller.signal }
        ),
        (err: any) => err.name === "AbortError"
      );
    });
  });

  describe("Wire Model Stripping across Providers", () => {
    it("OpenAICompatProvider strips provider prefix on wire request body", async () => {
      let sentBody: any = null;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
          sentBody = JSON.parse(init?.body as string);
          return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }) as any;

        const { OpenAICompatProvider } = await import("../../src/core/llm/providers/openaiCompatProvider");
        const prov = new OpenAICompatProvider({
          id: "nvidia",
          label: "NVIDIA NIM",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "nvapi-test",
          enabled: true,
          models: [{ id: "meta/llama-3.1-70b-instruct", name: "nvidia:meta/llama-3.1-70b-instruct", contextLength: 32768, toolTrained: true, tier: "large" }],
        });

        const chunks: any[] = [];
        for await (const chunk of prov.chatStream({
          model: "nvidia:meta/llama-3.1-70b-instruct",
          messages: [{ role: "user", content: "hi" }],
        })) {
          chunks.push(chunk);
        }

        assert.ok(chunks.length > 0);
        assert.equal(sentBody.model, "meta/llama-3.1-70b-instruct", "Must strip 'nvidia:' prefix for upstream API");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("AnthropicProvider strips 'claude:' prefix for wire requests", async () => {
      let sentBody: any = null;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
          sentBody = JSON.parse(init?.body as string);
          return new Response('event: message_delta\ndata: {"delta":{"text":"hello"}}\n\n', {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }) as any;

        const { AnthropicProvider } = await import("../../src/core/llm/providers/anthropicProvider");
        const prov = new AnthropicProvider({
          apiKey: "sk-ant-test",
          enabled: true,
          models: [{ id: "claude-3-5-sonnet-latest", name: "claude:claude-3-5-sonnet-latest", contextLength: 200000, toolTrained: true, tier: "large" }],
        });

        const chunks: any[] = [];
        for await (const chunk of prov.chatStream({
          model: "claude:claude-3-5-sonnet-latest",
          messages: [{ role: "user", content: "hi" }],
        })) {
          chunks.push(chunk);
        }

        assert.equal(sentBody.model, "claude-3-5-sonnet-latest", "Must strip 'claude:' prefix for Anthropic API");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

