import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  profileMachine,
  sampleHardwareMetrics,
  classifyMachine,
  guessVendor,
  detectGpu,
} from "../../src/core/adaptive/machineProfiler";
import {
  parseEffectiveParams,
  classifyModel,
  profileModel,
} from "../../src/core/adaptive/modelProfiler";
import {
  detectLocalRuntimes,
  candidatePaths,
  parseNetstat,
  parseLsof,
  type DetectorDeps,
} from "../../src/core/adaptive/runtimeDetector";
import type { OllamaClient } from "../../src/core/ollama/client";
import type { OllamaTagModel } from "../../src/core/ollama/types";

describe("Phase 6.3: Hardware & Model Profilers", () => {
  describe("Machine Profiler & GPU Classification Across Platforms", () => {
    it("classifies machine tiers correctly based on RAM and VRAM thresholds", () => {
      // High tier: VRAM >= 12GB or RAM >= 32GB
      assert.equal(classifyMachine(32 * 1024 ** 3, 0), "high");
      assert.equal(classifyMachine(16 * 1024 ** 3, 12 * 1024 ** 3), "high");

      // Mid tier: VRAM >= 6GB or RAM >= 16GB
      assert.equal(classifyMachine(16 * 1024 ** 3, 0), "mid");
      assert.equal(classifyMachine(8 * 1024 ** 3, 6 * 1024 ** 3), "mid");

      // Low tier: under 16GB RAM and under 6GB VRAM
      assert.equal(classifyMachine(8 * 1024 ** 3, 2 * 1024 ** 3), "low");
      assert.equal(classifyMachine(8 * 1024 ** 3, undefined), "low");
    });

    it("identifies hardware vendors accurately from GPU names", () => {
      assert.equal(guessVendor("NVIDIA GeForce RTX 4080"), "nvidia");
      assert.equal(guessVendor("AMD Radeon RX 7900 XTX"), "amd");
      assert.equal(guessVendor("Intel Iris Xe Graphics"), "intel");
      assert.equal(guessVendor("Intel Arc A770"), "intel");
      assert.equal(guessVendor("Apple M3 Max"), "apple");
      assert.equal(guessVendor("Generic Display Adapter"), undefined);
    });

    it("profiles the local machine without throwing unhandled errors", async () => {
      const profile = await profileMachine();
      assert.ok(profile.totalRamBytes > 0);
      assert.ok(profile.cpuCores > 0);
      assert.ok(["low", "mid", "high"].includes(profile.tier));
    });

    it("samples hardware metrics safely with bounded execution and debouncing", async () => {
      const s1 = await sampleHardwareMetrics();
      assert.ok(s1.ramTotalBytes > 0);
      assert.ok(s1.ramFreeBytes >= 0);
      assert.ok(s1.updatedAt > 0);

      // Fast subsequent call should debounce and reuse sample
      const s2 = await sampleHardwareMetrics();
      assert.equal(s1.updatedAt, s2.updatedAt);
    });
  });

  describe("Model Profiler & Explicit Capability Uncertainty", () => {
    it("extracts effective parameter sizes accurately from varied tag conventions", () => {
      assert.equal(parseEffectiveParams("gemma4:e2b"), 2);
      assert.equal(parseEffectiveParams("gemma4:e4b"), 4);
      assert.equal(parseEffectiveParams("qwen2.5-coder:7b"), 7);
      assert.equal(parseEffectiveParams("deepseek-coder:6.7b"), 6.7);
      assert.equal(parseEffectiveParams("llama3:70b"), 70);
      assert.equal(parseEffectiveParams("custom-model", "14.2B"), 14.2);
      assert.equal(parseEffectiveParams("small-draft", "500M"), 0.5);
    });

    it("classifies model tiers correctly from parameter counts", () => {
      assert.equal(classifyModel(3), "tiny");
      assert.equal(classifyModel(7), "small");
      assert.equal(classifyModel(14), "medium");
      assert.equal(classifyModel(70), "large");
      assert.equal(classifyModel(undefined), "small");
    });

    it("explicitly marks context and capabilities as estimated when metadata is unavailable", async () => {
      const mockClient: OllamaClient = {
        showModel: async () => {
          throw new Error("model info unavailable");
        },
      } as unknown as OllamaClient;

      const tag: OllamaTagModel = {
        name: "unknown-custom-model:latest",
        size: 4 * 1024 ** 3,
        modified_at: new Date().toISOString(),
      };

      const info = await profileModel(mockClient, tag);
      assert.equal(info.contextEstimated, true, "Missing show response must mark contextEstimated as true");
      assert.equal(info.capabilitiesEstimated, true, "Missing show response must mark capabilitiesEstimated as true");
      assert.equal(info.toolTrained, false, "Unknown models must not guess tool capability");
      assert.equal(info.vision, false, "Unknown models must not guess vision capability");
      assert.equal(info.thinking, false, "Unknown models must not guess thinking capability");
    });
  });

  describe("Runtime Detection Across Ollama, llama.cpp, and LM Studio", () => {
    it("provides candidate paths for all supported runtimes on all platforms", () => {
      const mockWinDeps: Pick<DetectorDeps, "platform" | "env" | "listDir"> = {
        platform: "win32",
        env: {
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          PROGRAMFILES: "C:\\Program Files",
          USERPROFILE: "C:\\Users\\test",
        },
        listDir: () => ["app-0.3.0"],
      };

      const ollamaWin = candidatePaths("ollama", mockWinDeps);
      assert.ok(ollamaWin.some((p) => p.includes("ollama.exe")));

      const lmstudioWin = candidatePaths("lmstudio", mockWinDeps);
      assert.ok(lmstudioWin.some((p) => p.includes("lms.exe")));

      const mockDarwinDeps: Pick<DetectorDeps, "platform" | "env" | "listDir"> = {
        platform: "darwin",
        env: { HOME: "/Users/test" },
        listDir: () => [],
      };

      const ollamaMac = candidatePaths("ollama", mockDarwinDeps);
      assert.ok(ollamaMac.some((p) => p.includes("Ollama.app") || p.includes("ollama")));

      const llamacppMac = candidatePaths("llamacpp", mockDarwinDeps);
      assert.ok(llamacppMac.some((p) => p.includes("llama-server")));
    });

    it("parses netstat and lsof port owners cleanly without throwing", () => {
      const netstatSample = `
  TCP    127.0.0.1:11434        0.0.0.0:0              LISTENING       12345
  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       67890
`;
      assert.equal(parseNetstat(netstatSample, 11434), 12345);
      assert.equal(parseNetstat(netstatSample, 8080), 67890);
      assert.equal(parseNetstat(netstatSample, 9999), undefined);

      const lsofSample = `
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
ollama  12345 user    3u  IPv4 0x1234      0t0  TCP 127.0.0.1:11434 (LISTEN)
`;
      const owner = parseLsof(lsofSample);
      assert.equal(owner?.pid, 12345);
      assert.equal(owner?.processName, "ollama");
    });
  });
});

