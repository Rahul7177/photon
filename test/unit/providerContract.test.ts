import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAICompatProvider } from "../../src/core/llm/providers/openaiCompatProvider";
import { AnthropicProvider } from "../../src/core/llm/providers/anthropicProvider";
import { GeminiProvider } from "../../src/core/llm/providers/geminiProvider";
import { OllamaProvider } from "../../src/core/llm/providers/ollamaProvider";
import { ProviderManager } from "../../src/core/llm/providerManager";
import {
  LLMProviderError,
  classifyHttpError,
  redactSecrets,
  parseRetryAfter,
} from "../../src/core/llm/errors";
import {
  normalizeAnthropicMessages,
  normalizeGeminiMessages,
} from "../../src/core/llm/normalizeMessages";
import {
  getModelPricing,
  setUserModelPricing,
  clearUserModelPricing,
} from "../../src/core/telemetry/cloudUsage";
import type { LLMChatRequest } from "../../src/core/llm/types";

describe("Phase 7.1: Shared Provider Contract & Adapter Integrity", () => {
  describe("Secret Redaction & Safe Error Mapping", () => {
    it("redacts raw Bearer tokens, explicit API keys, headers, and query parameters", () => {
      const explicitKey = "sk-proj-superSecretApiKey123456789";
      const rawText = `Request to https://api.openai.com/v1/chat?api_key=secretKey123 failed.
Header Authorization: Bearer ${explicitKey}
x-goog-api-key: AIzaSyD-sampleGeminiKey1234567890
Error details: invalid key ${explicitKey} or token nvapi-123456789012345678`;

      const redacted = redactSecrets(rawText, [explicitKey, "secretKey123"]);

      assert.ok(!redacted.includes(explicitKey), "Must not contain raw OpenAI API key");
      assert.ok(!redacted.includes("secretKey123"), "Must not contain raw query API key");
      assert.ok(!redacted.includes("AIzaSyD-sampleGeminiKey1234567890"), "Must not contain Gemini key");
      assert.ok(!redacted.includes("nvapi-123456789012345678"), "Must not contain NVAPI key");
      assert.ok(redacted.includes("[REDACTED]"), "Must insert [REDACTED]");
    });

    it("distinguishes auth (401), forbidden (403), not_found (404), invalid_request (400), server_error (500)", () => {
      const authErr = classifyHttpError("OpenAI", 401, '{"error":{"message":"Incorrect API key provided: sk-12345"}}', undefined, ["sk-12345"]);
      assert.equal(authErr.code, "authentication_failed");
      assert.equal(authErr.status, 401);
      assert.equal(authErr.retryable, false);
      assert.ok(!authErr.message.includes("sk-12345"));

      const forbiddenErr = classifyHttpError("Anthropic", 403, "Forbidden");
      assert.equal(forbiddenErr.code, "permission_denied");
      assert.equal(forbiddenErr.retryable, false);

      const notFoundErr = classifyHttpError("OpenAI", 404, "Model 'gpt-nonexistent' does not exist");
      assert.equal(notFoundErr.code, "not_found");
      assert.equal(notFoundErr.retryable, false);

      const badReqErr = classifyHttpError("Gemini", 400, "Invalid schema argument");
      assert.equal(badReqErr.code, "invalid_request");
      assert.equal(badReqErr.retryable, false);

      const serverErr = classifyHttpError("OpenAI", 503, "Service unavailable");
      assert.equal(serverErr.code, "server_error");
      assert.equal(serverErr.retryable, true);
    });

    it("distinguishes 429 quota exhaustion from 429 transient rate limits", () => {
      const quotaErr = classifyHttpError(
        "OpenAI",
        429,
        '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","code":"insufficient_quota"}}'
      );
      assert.equal(quotaErr.code, "quota_exhausted");
      assert.equal(quotaErr.retryable, false, "Quota exhaustion must NOT be retryable");

      const rateLimitHeaders = new Headers({ "Retry-After": "15" });
      const rateLimitErr = classifyHttpError(
        "Anthropic",
        429,
        '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your daily rate limit."}}',
        rateLimitHeaders
      );
      assert.equal(rateLimitErr.code, "rate_limit");
      assert.equal(rateLimitErr.retryable, true, "Standard rate limits should be retryable");
      assert.equal(rateLimitErr.retryAfterSeconds, 15);
    });
  });

  describe("Provider-Specific Message Constraint Normalization", () => {
    it("Anthropic: extracts system prompt, merges consecutive turns, and ensures starting with user", () => {
      const raw: LLMChatRequest["messages"] = [
        { role: "system", content: "You are an expert coder." },
        { role: "assistant", content: "Initial greeting" }, // Anthropic rejects starting with assistant!
        { role: "user", content: "Hello" },
        { role: "user", content: "Second user message" }, // Anthropic rejects consecutive user messages!
        { role: "tool", content: "Tool output text", tool_call_id: "call_abc" }, // Tool results must be in user turn
      ];

      const normalized = normalizeAnthropicMessages(raw);
      assert.equal(normalized.system, "You are an expert coder.");
      assert.ok(normalized.messages.length > 0);
      assert.equal(normalized.messages[0].role, "user", "Anthropic messages must start with user");

      // Verify alternating roles
      for (let i = 1; i < normalized.messages.length; i++) {
        assert.notEqual(
          normalized.messages[i].role,
          normalized.messages[i - 1].role,
          `Turn ${i} and ${i - 1} must alternate roles`
        );
      }
    });

    it("Gemini: converts assistant to model, merges consecutive turns, and extracts systemInstruction", () => {
      const raw: LLMChatRequest["messages"] = [
        { role: "system", content: "System guidelines." },
        { role: "user", content: "First question" },
        { role: "user", content: "Follow-up question" },
        { role: "assistant", content: "Assistant response" },
        { role: "tool", content: "Execution result", name: "list_dir" },
      ];

      const normalized = normalizeGeminiMessages(raw);
      assert.equal(normalized.system, "System guidelines.");

      // Check alternating user/model
      for (let i = 1; i < normalized.contents.length; i++) {
        assert.notEqual(
          normalized.contents[i].role,
          normalized.contents[i - 1].role,
          "Gemini contents must strictly alternate user and model"
        );
      }
      assert.ok(normalized.contents.every((c) => c.parts.length > 0), "Gemini parts must not be empty");
    });
  });

  describe("OpenAI-Compatible Provider Contract", () => {
    it("serializes chat request, handles streaming deltas, accumulates tool calls, and returns usage", async () => {
      let capturedBody: any = null;
      let capturedHeaders: any = null;
      const originalFetch = globalThis.fetch;

      try {
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
          capturedHeaders = init?.headers;
          capturedBody = JSON.parse(init?.body as string);

          const sseChunks = [
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_content":"Thinking about files..."}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.ts\\"}"}}]}}]}\n\n',
            'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":120,"completion_tokens":45,"prompt_tokens_details":{"cached_tokens":30}}}\n\n',
            "data: [DONE]\n\n",
          ];

          return new Response(sseChunks.join(""), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }) as any;

        const provider = new OpenAICompatProvider({
          id: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-openaiTestKey12345678",
          enabled: true,
          models: [{ id: "gpt-4o", name: "openai:gpt-4o", contextLength: 128000, toolTrained: true, tier: "large" }],
        });

        const chunks: any[] = [];
        for await (const chunk of provider.chatStream({
          model: "openai:gpt-4o",
          messages: [{ role: "user", content: "Read test.ts" }],
          options: { temperature: 0.2, num_predict: 200 },
        })) {
          chunks.push(chunk);
        }

        assert.equal(capturedBody.model, "gpt-4o", "Prefix 'openai:' must be stripped on wire");
        assert.equal(capturedBody.temperature, 0.2);
        assert.equal(capturedBody.max_tokens, 200);

        // Verify yielded chunks
        const textChunk = chunks.find((c) => c.message?.content === "Hello");
        assert.ok(textChunk, "Must yield text content chunk");

        const thinkChunk = chunks.find((c) => c.message?.thinking === "Thinking about files...");
        assert.ok(thinkChunk, "Must yield reasoning/thinking chunk");

        const toolCallChunk = chunks.find((c) => c.message?.tool_calls?.length > 0);
        assert.ok(toolCallChunk, "Must yield reassembled tool calls");
        assert.equal(toolCallChunk.message.tool_calls[0].function.name, "read_file");
        assert.deepEqual(toolCallChunk.message.tool_calls[0].function.arguments, { path: "test.ts" });

        const terminal = chunks[chunks.length - 1];
        assert.equal(terminal.done, true);
        assert.equal(terminal.done_reason, "tool_calls");
        assert.equal(terminal.prompt_eval_count, 120);
        assert.equal(terminal.eval_count, 45);
        assert.equal(terminal.cached_tokens, 30);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Anthropic Provider Contract", () => {
    it("handles Claude SSE events, partial JSON streaming, usage metadata, and stop reasons", async () => {
      let capturedBody: any = null;
      const originalFetch = globalThis.fetch;

      try {
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(init?.body as string);

          const ssePayload = [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":85,"cache_read_input_tokens":50,"output_tokens":0}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan: list files"}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"list_dir"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"dir\\": \\".\\"}"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":32}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join("");

          return new Response(ssePayload, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }) as any;

        const provider = new AnthropicProvider({
          apiKey: "sk-ant-testKey12345",
          enabled: true,
          models: [{ id: "claude-3-5-sonnet-latest", name: "claude:claude-3-5-sonnet-latest", contextLength: 200000, toolTrained: true, tier: "large" }],
        });

        const chunks: any[] = [];
        for await (const chunk of provider.chatStream({
          model: "claude:claude-3-5-sonnet-latest",
          messages: [{ role: "user", content: "list files" }],
        })) {
          chunks.push(chunk);
        }

        assert.equal(capturedBody.model, "claude-3-5-sonnet-latest");
        const thinkChunk = chunks.find((c) => c.message?.thinking === "Plan: list files");
        assert.ok(thinkChunk, "Anthropic thinking block yielded");

        const toolChunk = chunks.find((c) => c.message?.tool_calls?.length > 0);
        assert.ok(toolChunk, "Anthropic tool call yielded");
        assert.equal(toolChunk.message.tool_calls[0].id, "toolu_01");
        assert.equal(toolChunk.message.tool_calls[0].function.name, "list_dir");
        assert.deepEqual(toolChunk.message.tool_calls[0].function.arguments, { dir: "." });

        const terminal = chunks[chunks.length - 1];
        assert.equal(terminal.done, true);
        assert.equal(terminal.done_reason, "tool_use");
        assert.equal(terminal.prompt_eval_count, 135); // 85 + 50
        assert.equal(terminal.eval_count, 32);
        assert.equal(terminal.cached_tokens, 50);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Gemini Provider Contract", () => {
    it("handles Gemini SSE candidates, functionCalls, thought parts, and token metadata", async () => {
      let capturedBody: any = null;
      const originalFetch = globalThis.fetch;

      try {
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
          capturedBody = JSON.parse(init?.body as string);

          const ssePayload = [
            'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Analyzing code..."},{"functionCall":{"name":"search","args":{"query":"test"}}}]}}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":25,"cachedContentTokenCount":10}}\n\n',
            'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
          ].join("");

          return new Response(ssePayload, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }) as any;

        const provider = new GeminiProvider({
          apiKey: "AIzaSyD-geminiTestKey12345",
          enabled: true,
          models: [{ id: "gemini-2.0-flash", name: "gemini:gemini-2.0-flash", contextLength: 1000000, toolTrained: true, tier: "large" }],
        });

        const chunks: any[] = [];
        for await (const chunk of provider.chatStream({
          model: "gemini:gemini-2.0-flash",
          messages: [{ role: "user", content: "search code" }],
        })) {
          chunks.push(chunk);
        }

        const thinkChunk = chunks.find((c) => c.message?.thinking === "Analyzing code...");
        assert.ok(thinkChunk, "Gemini thought part yielded");

        const toolChunk = chunks.find((c) => c.message?.tool_calls?.length > 0);
        assert.ok(toolChunk, "Gemini tool call yielded");
        assert.equal(toolChunk.message.tool_calls[0].function.name, "search");
        assert.deepEqual(toolChunk.message.tool_calls[0].function.arguments, { query: "test" });

        const terminal = chunks[chunks.length - 1];
        assert.equal(terminal.done, true);
        assert.equal(terminal.done_reason, "STOP");
        assert.equal(terminal.prompt_eval_count, 50);
        assert.equal(terminal.eval_count, 25);
        assert.equal(terminal.cached_tokens, 10);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Ollama Provider Network Failure Classification", () => {
    it("maps connection refused errors to typed LLMProviderError network_error", async () => {
      const mockClient: any = {
        chatStream: async function* () {
          throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
        },
      };

      const provider = new OllamaProvider(mockClient);
      await assert.rejects(
        async () => {
          for await (const _ of provider.chatStream({
            model: "qwen2.5-coder:7b",
            messages: [{ role: "user", content: "hi" }],
          })) {
            // iterate
          }
        },
        (err: any) => {
          assert.ok(err instanceof LLMProviderError);
          assert.equal(err.code, "network_error");
          assert.equal(err.provider, "ollama");
          assert.equal(err.retryable, true);
          return true;
        }
      );
    });
  });

  describe("ProviderManager Configuration Durability & Turn Isolation", () => {
    it("setProviders with empty list preserves existing working providers", () => {
      const mockProvider: any = { id: "ollama", label: "Ollama", enabled: true, isConfigured: () => true };
      const manager = new ProviderManager([mockProvider]);

      assert.equal(manager.active().length, 1);
      // Attempt refresh that returns empty
      manager.setProviders([]);
      assert.equal(manager.active().length, 1, "Working providers must not be wiped out by empty list");
    });

    it("switching providers during an active turn does not mutate in-flight generator", async () => {
      let turn1Step = 0;
      const providerA: any = {
        id: "provA",
        label: "Provider A",
        enabled: true,
        isConfigured: () => true,
        chatStream: async function* () {
          turn1Step = 1;
          yield { message: { role: "assistant", content: "A1" }, done: false };
          // Yield control to let provider set change
          await new Promise((r) => setTimeout(r, 10));
          turn1Step = 2;
          yield { message: { role: "assistant", content: "A2" }, done: true };
        },
      };

      const providerB: any = {
        id: "provB",
        label: "Provider B",
        enabled: true,
        isConfigured: () => true,
        chatStream: async function* () {
          yield { message: { role: "assistant", content: "B" }, done: true };
        },
      };

      const manager = new ProviderManager([providerA]);
      const stream = manager.chatStream({ model: "provA:test", messages: [] });

      const first = await stream.next();
      assert.equal(first.value.message.content, "A1");

      // Provider set is updated during turn
      manager.setProviders([providerB]);

      // Stream continues with original provider A instance
      const second = await stream.next();
      assert.equal(second.value.message.content, "A2");
      assert.equal(turn1Step, 2);
    });
  });

  describe("Pricing & Metadata Classification", () => {
    it("marks catalog model pricing as current, user override as user-configured, and fallback as estimated", () => {
      // 1. Built-in catalog model
      const gpt4oPricing = getModelPricing("openai:gpt-4o");
      assert.equal(gpt4oPricing.source, "current");
      assert.equal(gpt4oPricing.inputPerMillion, 2.5);

      // 2. Unknown custom model falls back to estimated
      const unknownPricing = getModelPricing("custom:unknown-model-xyz");
      assert.equal(unknownPricing.source, "estimated");

      // 3. User override takes priority and marks user-configured
      try {
        setUserModelPricing("custom:unknown-model-xyz", {
          inputPerMillion: 0.5,
          outputPerMillion: 1.5,
        });

        const overridden = getModelPricing("custom:unknown-model-xyz");
        assert.equal(overridden.source, "user-configured");
        assert.equal(overridden.inputPerMillion, 0.5);
        assert.equal(overridden.outputPerMillion, 1.5);
      } finally {
        clearUserModelPricing("custom:unknown-model-xyz");
      }
    });
  });
});

