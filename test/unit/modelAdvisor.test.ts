import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  MODEL_CATALOG,
  assessFit,
  evaluateInstalledLocalModels,
  hardwareFromProfile,
  hardwareTier,
  memoryRequiredGb,
  recommendModels,
} from "../../src/core/adaptive/modelAdvisor";
import { scanDiskOllamaModels } from "../../src/core/adaptive/runtimeDetector";
import { matchInstalledModelName, type MachineProfile } from "../../src/shared/types";

const GB = 1024 ** 3;
function machine(o: { ram: number; vram?: number; gpu?: string; vendor?: string; cores?: number; platform?: string; arch?: string }): MachineProfile {
  return {
    totalRamBytes: o.ram * GB,
    freeRamBytes: o.ram * 0.6 * GB,
    cpuCores: o.cores ?? 8,
    cpuModel: "x",
    platform: o.platform ?? "win32",
    arch: o.arch ?? "x64",
    gpu: o.vram ? { name: o.gpu ?? "NVIDIA GeForce RTX 4060", vramBytes: o.vram * GB, vendor: o.vendor ?? "nvidia" } : undefined,
    tier: "mid",
  };
}
const model = (n: string) => MODEL_CATALOG.find((m) => m.name === n)!;

describe("hardware tiers", () => {
  it("categorizes 4/8/16/24GB VRAM machines", () => {
    assert.equal(hardwareTier(hardwareFromProfile(machine({ ram: 8, vram: 4 }))), "light");
    assert.equal(hardwareTier(hardwareFromProfile(machine({ ram: 8, vram: 8 }))), "sweet");
    assert.equal(hardwareTier(hardwareFromProfile(machine({ ram: 16, vram: 16 }))), "high");
    assert.equal(hardwareTier(hardwareFromProfile(machine({ ram: 32, vram: 24 }))), "high");
  });
  it("RAM-only machines", () => {
    assert.equal(hardwareTier(hardwareFromProfile(machine({ ram: 8 }))), "light");
    assert.equal(hardwareTier(hardwareFromProfile(machine({ ram: 16 }))), "sweet");
    assert.equal(hardwareTier(hardwareFromProfile(machine({ ram: 64 }))), "high");
  });
  it("applies 22.5% RAM buffer and treats Apple silicon as unified memory", () => {
    const hw = hardwareFromProfile(machine({ ram: 16, vram: 1, vendor: "apple", gpu: "Apple M2", platform: "darwin", arch: "arm64" }));
    assert.equal(hw.ramBufferGb, 3.6);
    assert.ok(hw.unifiedMemory);
    assert.ok(Math.abs(hw.vramGb - 10.4) < 0.01);
  });
});

describe("memory fit formula", () => {
  it("weights + ctx/1024 × KV", () => {
    assert.ok(Math.abs(memoryRequiredGb({ sizeGb: 4.7, kvGbPer1k: 0.06 }, 8192) - 5.18) < 1e-9);
  });
  it("7B fits 100% on an 8GB GPU", () => {
    const f = assessFit(model("qwen2.5-coder:7b"), hardwareFromProfile(machine({ ram: 16, vram: 8 })));
    assert.equal(f.mode, "gpu");
    assert.equal(f.badge, "green");
    assert.match(f.label, /^Fits 100% in your RTX 4060 VRAM \(~\d+ tok\/s\)$/);
    assert.equal(f.ramGb, 0);
  });
  it("14B on 8GB VRAM goes hybrid with a GPU/RAM split", () => {
    const f = assessFit(model("qwen2.5-coder:14b"), hardwareFromProfile(machine({ ram: 32, vram: 8 })));
    assert.equal(f.mode, "hybrid");
    assert.equal(f.badge, "yellow");
    assert.equal(f.gpuGb, 7.5);
    assert.ok(f.ramGb > 0);
    assert.match(f.label, /Hybrid GPU\+RAM: 7\.5GB in VRAM, \d+(\.\d)?GB in RAM/);
  });
  it("hybrid is slower than full-GPU, CPU-only slower still", () => {
    const gpu = assessFit(model("qwen2.5-coder:7b"), hardwareFromProfile(machine({ ram: 16, vram: 8 })));
    const hyb = assessFit(model("qwen2.5-coder:7b"), hardwareFromProfile(machine({ ram: 16, vram: 4 })));
    const cpu = assessFit(model("qwen2.5-coder:7b"), hardwareFromProfile(machine({ ram: 16 })));
    assert.ok(gpu.tokPerSec! > hyb.tokPerSec! && hyb.tokPerSec! > cpu.tokPerSec!);
    assert.equal(cpu.mode, "cpu");
  });
  it("32B exceeds safe memory on 4GB VRAM / 16GB RAM", () => {
    const f = assessFit(model("qwen2.5-coder:32b"), hardwareFromProfile(machine({ ram: 16, vram: 4 })));
    assert.equal(f.mode, "exceeds");
    assert.equal(f.badge, "red");
    assert.match(f.label, /heavy disk swap risk/);
  });
  it("RAM safety buffer is respected (no weights into OS reserve)", () => {
    // 8GB RAM → 6.2GB usable; 7B needs 5.18 → ok; 14B needs ~10 → exceeds
    assert.equal(assessFit(model("qwen2.5-coder:7b"), hardwareFromProfile(machine({ ram: 8 }))).mode, "cpu");
    assert.equal(assessFit(model("qwen2.5-coder:14b"), hardwareFromProfile(machine({ ram: 8 }))).mode, "exceeds");
  });
});

describe("recommendations", () => {
  const rec = (m: MachineProfile, o = {}) => recommendModels(m, o);

  it("8GB RTX 4060 → qwen2.5-coder:7b is the primary recommendation", () => {
    const r = rec(machine({ ram: 16, vram: 8 }));
    assert.equal(r.recommendedName, "qwen2.5-coder:7b");
    assert.equal(r.models[0].name, "qwen2.5-coder:7b");
    assert.match(r.headline, /Recommended for your 8GB RTX 4060, 16GB RAM/);
  });
  it("6GB GTX 1660 Ti (Max-Q) → 7B coder, with a clean GPU name", () => {
    const r = rec(machine({ ram: 16, vram: 6, gpu: "NVIDIA GeForce GTX 1660 Ti with Max-Q Design" }));
    assert.equal(r.recommendedName, "qwen2.5-coder:7b");
    assert.match(r.models[0].fit.label, /in your GTX 1660 Ti VRAM/);
  });
  it("4GB VRAM → a light model", () => {
    const r = rec(machine({ ram: 8, vram: 4, gpu: "NVIDIA GeForce GTX 1650" }));
    const pick = r.models.find((m) => m.recommended)!;
    assert.equal(pick.fit.mode, "gpu");
    assert.ok(pick.sizeGb <= 3.5, pick.name);
  });
  it("24GB VRAM → 32B coder", () => {
    const r = rec(machine({ ram: 32, vram: 24, gpu: "NVIDIA GeForce RTX 4090" }));
    assert.equal(r.recommendedName, "qwen2.5-coder:32b");
  });
  it("12GB VRAM → 14B coder", () => {
    assert.equal(rec(machine({ ram: 32, vram: 12 })).recommendedName, "qwen2.5-coder:14b");
  });
  it("CPU-only 16GB machine still gets a usable recommendation", () => {
    const r = rec(machine({ ram: 16, cores: 8 }));
    const pick = r.models.find((m) => m.recommended)!;
    assert.equal(pick.fit.mode, "cpu");
    assert.ok(pick.fit.tokPerSec! >= 6);
  });
  it("reasoning goal prefers deepseek-r1; multimodal prefers gemma4; autocomplete prefers 1.5b", () => {
    const m = machine({ ram: 16, vram: 8 });
    assert.equal(rec(m, { goal: "reasoning" }).recommendedName, "deepseek-r1:8b");
    assert.equal(rec(m, { goal: "multimodal" }).recommendedName, "gemma4:e4b");
    assert.equal(rec(m, { goal: "autocomplete" }).recommendedName, "qwen2.5-coder:1.5b");
  });
  it("flags installed models and never recommends an exceeding model", () => {
    const r = rec(machine({ ram: 8, vram: 4 }), { installed: ["Qwen2.5-Coder:3b"] });
    assert.ok(r.models.find((m) => m.name === "qwen2.5-coder:3b")!.installed);
    const pick = r.models.find((m) => m.recommended);
    assert.ok(pick && pick.fit.mode !== "exceeds");
  });
  it("handles unknown hardware (null profile) without throwing", () => {
    const r = recommendModels(null);
    assert.ok(r.models.length === MODEL_CATALOG.length);
  });
  it("ranks recommended first, exceeding models last", () => {
    const r = rec(machine({ ram: 8, vram: 4 }));
    assert.equal(r.models[0].recommended, true);
    assert.equal(r.models[r.models.length - 1].fit.mode, "exceeds");
  });
  it("matches :latest and quantized installed tags so present models are never marked uninstalled", () => {
    assert.equal(
      matchInstalledModelName("qwen2.5-coder:7b", ["qwen2.5-coder:latest"]),
      "qwen2.5-coder:latest"
    );
    assert.equal(
      matchInstalledModelName("qwen2.5-coder:7b", ["qwen2.5-coder:7b-instruct-q4_K_M"]),
      "qwen2.5-coder:7b-instruct-q4_K_M"
    );
    const r = rec(machine({ ram: 16, vram: 8 }), {
      installed: ["qwen2.5-coder:latest", "deepseek-r1:8b-llama-distill-q4_K_M"],
    });
    const qwen7b = r.models.find((m) => m.name === "qwen2.5-coder:7b")!;
    assert.equal(qwen7b.installed, true);
    assert.equal(qwen7b.installedName, "qwen2.5-coder:latest");
    const r1 = r.models.find((m) => m.name === "deepseek-r1:8b")!;
    assert.equal(r1.installed, true);
  });
  it("evaluates arbitrary installed local models and recommends the best hardware & capability fit", () => {
    const evals = evaluateInstalledLocalModels(
      [
        { name: "llama3.2:1b", provider: "ollama" },
        { name: "qwen2.5-coder:7b", provider: "ollama" },
        { name: "qwen2.5-coder:32b", provider: "ollama" },
      ],
      machine({ ram: 16, vram: 8 }),
      "coding"
    );
    assert.equal(evals.length, 3);
    assert.equal(evals[0].name, "qwen2.5-coder:7b");
    assert.equal(evals[0].recommended, true);
    assert.equal(evals[0].fit.mode, "gpu");
  });
  it("scans disk Ollama manifests when daemon is stopped", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "photon-ollama-test-"));
    try {
      const manifestDir = path.join(
        tmp,
        ".ollama",
        "models",
        "manifests",
        "registry.ollama.ai",
        "library",
        "qwen2.5-coder"
      );
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(
        path.join(manifestDir, "7b"),
        JSON.stringify({
          layers: [
            { mediaType: "application/vnd.ollama.image.model", size: 4_700_000_000 },
          ],
        }),
        "utf8"
      );
      const found = scanDiskOllamaModels(tmp, {});
      assert.equal(found.length, 1);
      assert.equal(found[0].name, "qwen2.5-coder:7b");
      assert.equal(found[0].sizeBytes, 4_700_000_000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
