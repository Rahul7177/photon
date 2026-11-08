import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initial, reducer } from "../../webview-ui/src/state/store";
import { PROTOCOL_VERSION } from "../../src/shared/protocol";
import { sanitizeErrorMessage, getErrorSuggestion } from "../../webview-ui/src/components/ErrorBanner";
import type { ChatMessage, ToolCall } from "../../src/shared/types";

describe("Phase 8: Webview State, Protocol, Usability & Accessibility", () => {
  describe("8.1 Protocol Integrity, Validation & Stale Event Protection", () => {
    it("exports PROTOCOL_VERSION 1.0.0", () => {
      assert.equal(PROTOCOL_VERSION, "1.0.0");
    });

    it("safely handles unknown message types without crashing or corrupting state", () => {
      const unknownMsg: any = { type: "futureUnknownMessageType", payload: { someData: 123 } };
      const s1 = reducer(initial, unknownMsg);
      assert.deepEqual(s1, initial);
    });

    it("prevents late toolUpdate events from an idle/stale session fabricating messages into current state", () => {
      // Current session is idle with 0 messages
      assert.equal(initial.status, "idle");
      assert.equal(initial.messages.length, 0);

      // Late toolUpdate arrives from a previous session turn
      const lateUpdate: any = {
        type: "toolUpdate",
        payload: {
          messageId: "stale-turn-123",
          call: { id: "call-stale", name: "list_dir", status: "done", result: "ok" },
        },
      };

      const nextState = reducer(initial, lateUpdate);
      assert.equal(
        nextState.messages.length,
        0,
        "Must NOT synthesize a new message from a stale turn when status is idle"
      );
    });

    it("bounds message list growth and clamps max characters per message", () => {
      let state = initial;
      const massiveDelta = "A".repeat(300_000);
      const msg: ChatMessage = { id: "m-overflow", role: "assistant", content: "", createdAt: 100 };

      state = reducer(state, { type: "messageAppended", payload: msg });
      state = reducer(state, { type: "messageDelta", payload: { id: "m-overflow", delta: massiveDelta } });

      assert.ok(state.messages[0].content.length <= 250_000, "Content must be clamped to max 250,000 chars");
    });

    it("mergeMessages is idempotent under reconnect/replay", () => {
      const msg1: ChatMessage = { id: "m1", role: "user", content: "Hello", createdAt: 100 };
      const msg2: ChatMessage = { id: "m2", role: "assistant", content: "Hi there", createdAt: 200, streaming: false };

      const state1 = reducer(initial, {
        type: "sessionLoaded",
        payload: { id: "s1", title: "S1", messages: [msg1, msg2], createdAt: 100, updatedAt: 200, mode: "chat" },
      });
      assert.equal(state1.messages.length, 2);

      // Replay same session loaded
      const state2 = reducer(state1, {
        type: "sessionLoaded",
        payload: { id: "s1", title: "S1", messages: [msg1, msg2], createdAt: 100, updatedAt: 200, mode: "chat" },
      });
      assert.equal(state2.messages.length, 2);
      assert.equal(state2.messages[0].id, "m1");
      assert.equal(state2.messages[1].id, "m2");
    });
  });

  describe("8.2 Security, Error Guidance & Secrets Scrubbing", () => {
    it("sanitizes API keys, Bearer tokens and stack traces from error messages", () => {
      const raw = `Error: HTTP 401: Invalid API key sk-proj-12345678901234567890
Authorization: Bearer mySecretBearerToken12345
   at Client.fetch (/b/Coding/Photon/client.ts:45:12)
   at async run (/b/Coding/Photon/engine.ts:12:4)`;

      const clean = sanitizeErrorMessage(raw);
      assert.ok(!clean.includes("sk-proj-12345678901234567890"));
      assert.ok(!clean.includes("mySecretBearerToken12345"));
      assert.ok(!clean.includes("at Client.fetch"));
      assert.ok(clean.includes("[REDACTED]"));
    });

    it("offers actionable suggestions for quota, auth, daemon, and timeout errors", () => {
      assert.ok(getErrorSuggestion("insufficient_quota")?.includes("credit balance"));
      assert.ok(getErrorSuggestion("HTTP 401 unauthorized")?.includes("Settings → Cloud Providers"));
      assert.ok(getErrorSuggestion("connect ECONNREFUSED 127.0.0.1:11434")?.includes("ollama serve"));
      assert.ok(getErrorSuggestion("no space left on device")?.includes("Free up disk space"));
      assert.ok(getErrorSuggestion("connection stalled timeout")?.includes("Retry the prompt"));
      assert.equal(getErrorSuggestion("arbitrary generic error"), null);
    });
  });

  describe("8.2 & 8.3 Tool Cards & Status Differentiation", () => {
    it("recognizes proposed, running, done, error, denied, cancelled, and timeout statuses", () => {
      const statuses: ToolCall["status"][] = [
        "proposed",
        "running",
        "done",
        "error",
        "denied",
        "cancelled",
        "timeout",
      ];

      for (const st of statuses) {
        const call: ToolCall = { id: `c-${st}`, name: "edit_file", status: st };
        const s = reducer(initial, {
          type: "toolUpdate",
          payload: { messageId: "msg-1", call },
        });
        assert.ok(s !== undefined);
      }
    });

    it("does not clear approval when tool status is not terminal", () => {
      const pendingCall: ToolCall = { id: "call-1", name: "edit_file", status: "pending" };
      let state = reducer(initial, { type: "toolApprovalRequest", payload: { call: pendingCall } });
      assert.equal(state.pendingApproval?.id, "call-1");

      // Running status update should NOT prematurely dismiss pending approval UI
      state = reducer(state, {
        type: "toolUpdate",
        payload: { messageId: "m1", call: { id: "call-1", name: "edit_file", status: "running" } },
      });
      assert.equal(state.pendingApproval?.id, "call-1");

      // Terminal status (done) dismisses approval UI
      state = reducer(state, {
        type: "toolUpdate",
        payload: { messageId: "m1", call: { id: "call-1", name: "edit_file", status: "done" } },
      });
      assert.equal(state.pendingApproval, null);
    });
  });
});

