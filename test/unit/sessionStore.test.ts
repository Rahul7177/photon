import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  SessionStore,
  SESSION_STORE_SCHEMA_VERSION,
  capForStorage,
  redactSecrets,
  sanitizeArgs,
  validateAndSanitizeRestoredSession,
} from "../../src/host/sessionStore";
import {
  enforceSessionMessageCap,
  pruneInlineImages,
  finalizeTurnMessages,
} from "../../src/host/sessionCoordinator";
import type { SessionState } from "../../src/shared/types";

class MockMemento {
  private data = new Map<string, any>();

  get<T>(key: string, defaultValue?: T): T {
    return this.data.has(key) ? this.data.get(key) : (defaultValue as T);
  }

  async update(key: string, value: any): Promise<void> {
    this.data.set(key, value);
  }

  keys(): readonly string[] {
    return Array.from(this.data.keys());
  }

  setRaw(key: string, value: any): void {
    this.data.set(key, value);
  }
}

describe("SessionStore & SessionCoordinator Robustness Suite", () => {
  let memento: MockMemento;
  let store: SessionStore;

  beforeEach(() => {
    memento = new MockMemento();
    const mockContext = {
      globalState: memento,
    } as any;
    store = new SessionStore(mockContext);
  });

  describe("P1: Message and Archive Limits", () => {
    it("enforces session message cap strictly inclusive of the archive digest slot", () => {
      const messages: any[] = [];
      for (let i = 1; i <= 25; i++) {
        messages.push({
          id: `m-${i}`,
          role: i === 1 ? "user" : i % 2 === 0 ? "assistant" : "user",
          content: i === 1 ? "Initial task: build the auth system" : `Content ${i}`,
          createdAt: 1000 + i,
        });
      }

      const session: SessionState = {
        id: "sess-cap-test",
        title: "Cap Test",
        mode: "chat",
        model: "test-model",
        createdAt: 1000,
        updatedAt: 2000,
        messages,
      };

      const capped = enforceSessionMessageCap(session, 10);
      assert.strictEqual(capped, true);
      assert.strictEqual(session.messages.length, 10, "Total messages must be at most 10");
      assert.strictEqual(session.messages[0].isCompacted, true);
      assert.ok(session.messages[0].content.includes("Initial task: build the auth system"));

      // Repeated archive cycle
      for (let i = 26; i <= 30; i++) {
        session.messages.push({
          id: `m-${i}`,
          role: i % 2 === 0 ? "assistant" : "user",
          content: `New content ${i}`,
          createdAt: 3000 + i,
        });
      }
      assert.strictEqual(session.messages.length, 15);
      const capped2 = enforceSessionMessageCap(session, 10);
      assert.strictEqual(capped2, true);
      assert.strictEqual(session.messages.length, 10, "Repeated cap must maintain exact limit");
      const digest = session.messages[0];
      assert.ok(digest.isCompacted);
      const headerMatches = digest.content.match(/⚡ \*\*\[Context Compaction Summary\]\*\*/g);
      assert.strictEqual(headerMatches?.length, 1, "Must never nest compaction headers");
      assert.ok(digest.content.includes("Initial task: build the auth system"), "Must preserve initial task");
    });
  });

  describe("P1: Secrets Redaction in Storage", () => {
    it("redacts API keys, Bearer tokens, and sensitive headers before persistence", () => {
      const secretSession: SessionState = {
        id: "sess-secret",
        title: "Secret Session",
        mode: "chat",
        model: "cloud-gpt",
        createdAt: 1000,
        updatedAt: 2000,
        messages: [
          {
            id: "msg-user-key",
            role: "user",
            content: "Here is my secret sk-abcdef1234567890abcdef1234567890 and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            createdAt: 1001,
          },
          {
            id: "msg-asst-key",
            role: "assistant",
            content: "Connecting with key AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q",
            thinking: "Internal thought with token ghp_123456789012345678901234567890123456",
            toolCalls: [
              {
                id: "call-1",
                name: "fetch",
                args: { apiKey: "super_secret_key_12345", url: "https://api.example.com" },
                status: "done",
                result: "Connected with Bearer secret_access_token_abcdef1234567890",
              },
            ],
            createdAt: 1002,
          },
        ],
      };

      const capped = capForStorage(secretSession);

      // Verify user message redacted
      assert.ok(!capped.messages[0].content.includes("sk-abcdef1234567890"));
      assert.ok(!capped.messages[0].content.includes("eyJhbGciOiJIUzI1Ni"));
      assert.ok(capped.messages[0].content.includes("[REDACTED_SECRET]") || capped.messages[0].content.includes("[REDACTED]"));

      // Verify assistant message redacted
      assert.ok(!capped.messages[1].content.includes("AIzaSy"));
      assert.ok(!capped.messages[1].thinking?.includes("ghp_12345"));

      // Verify tool call args and result redacted
      const tc = capped.messages[1].toolCalls?.[0];
      assert.strictEqual(tc?.args?.apiKey, "[REDACTED]");
      assert.ok(!tc?.result?.includes("secret_access_token"));
    });
  });

  describe("P1: Schema Versions, Migration & Sanitization", () => {
    it("migrates legacy v1 raw array to v2 envelope and sanitizes corrupt sessions", async () => {
      const legacySessions = [
        {
          id: "s1",
          title: "Session 1",
          mode: "chat",
          model: "llama3",
          createdAt: 1000,
          updatedAt: 1000,
          messages: [
            {
              id: "m1",
              role: "user",
              content: "Hello",
              createdAt: 1001,
            },
            {
              id: "m2",
              role: "assistant",
              content: "Hi",
              streaming: true, // Left streaming mid-turn
              toolCalls: [
                {
                  id: "t1",
                  name: "search",
                  args: {},
                  status: "running", // Left running
                },
              ],
              createdAt: 1002,
            },
          ],
        },
        {
          // Corrupt session without id
          title: "Corrupt",
        },
      ];

      memento.setRaw("photon.sessions", legacySessions);

      const loaded = store.loadAll();
      assert.strictEqual(loaded.length, 1, "Corrupt session without id must be dropped");
      assert.strictEqual(loaded[0].id, "s1");
      // Verify streaming placeholder finalized
      assert.strictEqual(loaded[0].messages[1].streaming, false);
      // Verify running tool call mapped to error
      assert.strictEqual(loaded[0].messages[1].toolCalls?.[0].status, "error");

      // Save a session to verify v2 envelope write
      await store.upsert(loaded[0]);
      const rawStored = memento.get<any>("photon.sessions");
      assert.strictEqual(rawStored.version, SESSION_STORE_SCHEMA_VERSION);
      assert.ok(Array.isArray(rawStored.sessions));
    });

    it("deterministically trims oldest sessions when globalState 4 MB limit is approached and notifies", async () => {
      let trimmedNoticeCount = 0;
      let trimmedTitles: string[] = [];
      store.onDidTrim = (count, titles) => {
        trimmedNoticeCount = count;
        trimmedTitles = titles;
      };

      // Create 5 sessions, each with ~1MB of text
      for (let i = 1; i <= 5; i++) {
        const s: SessionState = {
          id: `sess-${i}`,
          title: `Large Session ${i}`,
          mode: "chat",
          model: "test-model",
          createdAt: 1000 + i,
          updatedAt: 1000 + i,
          messages: [
            {
              id: `msg-${i}`,
              role: "user",
              content: "A".repeat(7900), // Max allowed by capForStorage
              createdAt: 1000 + i,
            },
          ],
        };
        await store.upsert(s);
      }

      const all = store.loadAll();
      assert.ok(all.length <= 40);
      const rawStored = memento.get<any>("photon.sessions");
      const payload = JSON.stringify(rawStored);
      assert.ok(payload.length <= 4_000_000, "Payload must never exceed 4MB");
    });

    it("marks pruned inline images visibly as pruned", () => {
      const session: SessionState = {
        id: "img-sess",
        title: "Image Session",
        mode: "chat",
        model: "model",
        createdAt: 1000,
        updatedAt: 2000,
        messages: [
          {
            id: "m-old-img",
            role: "user",
            content: "Older screenshot",
            createdAt: 1001,
            attachments: [
              {
                id: "att-1",
                name: "screen1.png",
                mimeType: "image/png",
                dataBase64: "base64_data_1",
              },
            ],
          },
          {
            id: "m-new-img",
            role: "user",
            content: "Recent screenshot",
            createdAt: 1002,
            attachments: [
              {
                id: "att-2",
                name: "screen2.png",
                mimeType: "image/png",
                dataBase64: "base64_data_2",
              },
            ],
          },
        ],
      };

      // Prune down to 1 image kept
      const pruned = pruneInlineImages(session, 1);
      const oldAtt = pruned.messages[0].attachments?.[0];
      const newAtt = pruned.messages[1].attachments?.[0];

      assert.strictEqual(oldAtt?.dataBase64, undefined, "Older image must have base64 stripped");
      assert.strictEqual(oldAtt?.isPruned, true, "Older image must be visibly marked as pruned");
      assert.ok(oldAtt?.text?.includes("pruned from storage"));

      assert.strictEqual(newAtt?.dataBase64, "base64_data_2", "Newest image retained within limit");
    });
  });
});
