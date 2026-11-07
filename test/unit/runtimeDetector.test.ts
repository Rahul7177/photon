import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RUNTIME_SPECS,
  candidatePaths,
  detectLocalRuntimes,
  findBinary,
  parseLsof,
  parseNetstat,
  portConflictMessage,
  type DetectorDeps,
} from "../../src/core/adaptive/runtimeDetector";

type Reply = { status: number; body: string } | "refuse";

function makeDeps(opts: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  files?: string[];
  dirs?: Record<string, string[]>;
  ports?: Record<number, Reply>;
  commands?: Record<string, string>;
}): Partial<DetectorDeps> {
  const files = new Set(opts.files ?? []);
  return {
    platform: opts.platform ?? "win32",
    env: opts.env ?? {},
    fileExists: (p) => files.has(p),
    listDir: (p) => opts.dirs?.[p] ?? [],
    fetchFn: async (url) => {
      const port = Number(new URL(url).port);
      const reply = opts.ports?.[port] ?? "refuse";
      if (reply === "refuse") throw new Error("ECONNREFUSED");
      return { status: reply.status, text: async () => reply.body };
    },
    run: async (cmd) => {
      for (const [k, v] of Object.entries(opts.commands ?? {})) if (cmd.includes(k)) return v;
      throw new Error("command failed: " + cmd);
    },
    timeoutMs: 50,
  };
}

const byId = (r: Awaited<ReturnType<typeof detectLocalRuntimes>>, id: string) =>
  r.find((x) => x.id === id)!;

describe("binary discovery", () => {
  it("finds ollama on Windows PATH", async () => {
    const p = "C:\\tools\\ollama.exe";
    const deps = { ...makeDeps({ env: { PATH: "C:\\x;C:\\tools" }, files: [p] }) } as DetectorDeps;
    assert.equal(await findBinary(RUNTIME_SPECS[0], deps), p);
  });

  it("finds ollama in default %LOCALAPPDATA% install", async () => {
    const p = "C:\\Users\\a\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    const r = await detectLocalRuntimes(
      makeDeps({ env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, files: [p] })
    );
    assert.equal(byId(r, "ollama").binaryPath, p);
    assert.equal(byId(r, "ollama").state, "installed_stopped");
  });

  it("finds ollama via Windows registry InstallLocation", async () => {
    const p = "D:\\Apps\\Ollama\\ollama.exe";
    const r = await detectLocalRuntimes(
      makeDeps({
        files: [p],
        commands: { "reg query": "    InstallLocation    REG_SZ    D:\\Apps\\Ollama\r\n" },
      })
    );
    assert.equal(byId(r, "ollama").binaryPath, p);
  });

  it("finds ollama via Windows registry even when preceded by unrelated InstallLocations", async () => {
    const p = "C:\\Users\\test\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    const regOutput = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GitHubDesktop",
      "    InstallLocation    REG_SZ    C:\\Users\\test\\AppData\\Local\\GitHubDesktop",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{44E83376-CE68-45EB-8FC1-393500EB558C}_is1",
      "    InstallLocation    REG_SZ    C:\\Users\\test\\AppData\\Local\\Programs\\Ollama\\",
    ].join("\r\n");

    const r = await detectLocalRuntimes(
      makeDeps({
        files: [p],
        commands: { "reg query": regOutput },
      })
    );
    assert.equal(byId(r, "ollama").binaryPath, p);
  });

  it("finds ollama via where.exe fallback on Windows", async () => {
    const p = "C:\\Custom\\Ollama\\ollama.exe";
    const r = await detectLocalRuntimes(
      makeDeps({
        files: [p],
        commands: { "where.exe": `${p}\r\n` },
      })
    );
    assert.equal(byId(r, "ollama").binaryPath, p);
  });

  it("finds LM Studio lms.exe under versioned app-* dir", () => {
    const paths = candidatePaths("lmstudio", {
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\L" },
      listDir: () => ["app-0.3.1", "other"],
    });
    assert.ok(paths.includes("C:\\L\\LM-Studio\\app-0.3.1\\resources\\app\\bin\\lms.exe"));
    assert.ok(!paths.some((p) => p.includes("other")));
  });

  it("checks macOS homebrew and app bundles", async () => {
    const r = await detectLocalRuntimes(
      makeDeps({ platform: "darwin", files: ["/opt/homebrew/bin/ollama", "/Applications/LM Studio.app"] })
    );
    assert.equal(byId(r, "ollama").binaryPath, "/opt/homebrew/bin/ollama");
    assert.equal(byId(r, "lmstudio").binaryPath, "/Applications/LM Studio.app");
  });

  it("checks Linux paths and systemd", async () => {
    let r = await detectLocalRuntimes(makeDeps({ platform: "linux", files: ["/usr/bin/ollama"] }));
    assert.equal(byId(r, "ollama").binaryPath, "/usr/bin/ollama");
    r = await detectLocalRuntimes(
      makeDeps({ platform: "linux", commands: { "systemctl is-active": "inactive\n" } })
    );
    assert.equal(byId(r, "ollama").state, "installed_stopped");
  });
});

describe("tri-state health", () => {
  it("reports running with version when Ollama answers", async () => {
    const r = await detectLocalRuntimes(
      makeDeps({ ports: { 11434: { status: 200, body: '{"version":"0.5.1"}' } } })
    );
    const o = byId(r, "ollama");
    assert.equal(o.state, "running");
    assert.equal(o.version, "0.5.1");
  });

  it("reports not_installed when nothing found", async () => {
    const r = await detectLocalRuntimes(makeDeps({}));
    assert.ok(r.every((x) => x.state === "not_installed"));
  });

  it("recognises llama.cpp and LM Studio signatures", async () => {
    const r = await detectLocalRuntimes(
      makeDeps({
        ports: {
          8080: { status: 200, body: '{"status":"ok"}' },
          1234: { status: 200, body: '{"data":[]}' },
        },
      })
    );
    assert.equal(byId(r, "llamacpp").state, "running");
    assert.equal(byId(r, "lmstudio").state, "running");
  });

  it("running wins even when no binary is on disk", async () => {
    const r = await detectLocalRuntimes(
      makeDeps({ ports: { 8000: { status: 200, body: '{"data":[{"id":"m"}]}' } } })
    );
    assert.equal(byId(r, "vllm").state, "running");
  });
});

describe("port conflicts", () => {
  it("flags port_conflict with owner PID on Windows", async () => {
    const netstat =
      "  Proto  Local Address  Foreign Address  State  PID\r\n" +
      "  TCP    127.0.0.1:11434  0.0.0.0:0  LISTENING  1234\r\n";
    const r = await detectLocalRuntimes(
      makeDeps({
        ports: { 11434: { status: 404, body: "nope" } },
        commands: { netstat, tasklist: '"node.exe","1234","Console","1","50,000 K"\r\n' },
      })
    );
    const o = byId(r, "ollama");
    assert.equal(o.state, "port_conflict");
    assert.deepEqual(o.portOwner, { pid: 1234, processName: "node.exe" });
    assert.match(o.message!, /Port 11434 is in use by PID 1234 \(node\.exe\)/);
  });

  it("flags port_conflict on Unix via lsof", async () => {
    const lsof =
      "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\npython 777 me 3u IPv4 1 0t0 TCP *:11434 (LISTEN)\n";
    const r = await detectLocalRuntimes(
      makeDeps({
        platform: "linux",
        ports: { 11434: { status: 500, body: "x" } },
        commands: { lsof },
      })
    );
    assert.deepEqual(byId(r, "ollama").portOwner, { pid: 777, processName: "python" });
  });

  it("still reports conflict if owner lookup fails", async () => {
    const r = await detectLocalRuntimes(makeDeps({ ports: { 11434: { status: 404, body: "" } } }));
    const o = byId(r, "ollama");
    assert.equal(o.state, "port_conflict");
    assert.equal(o.portOwner, undefined);
  });

  it("parsers ignore irrelevant lines", () => {
    assert.equal(parseNetstat("TCP 0.0.0.0:80 0.0.0.0:0 LISTENING 4", 11434), undefined);
    assert.equal(parseNetstat("TCP 0.0.0.0:111434 0.0.0.0:0 LISTENING 4", 11434), undefined);
    assert.equal(parseLsof(""), undefined);
    assert.match(portConflictMessage("Ollama", 1, undefined), /another process/);
  });
});

