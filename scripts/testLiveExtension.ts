import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WORKBENCH_URL = process.env.PHOTON_WORKBENCH_URL || "http://127.0.0.1:4321";
const CDP_PORT = Number(process.env.PHOTON_CDP_PORT || 9345);
const OUT_DIR =
  process.env.PHOTON_SCREENSHOT_DIR ||
  path.join(os.tmpdir(), "photon-live-screenshots");

function findBrowserBinary(): string {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error("No Chrome or Edge binary found on system.");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class CdpSession {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  public consoleErrors: string[] = [];
  public pageExceptions: string[] = [];

  async connect(wsUrl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (ev: any) => reject(new Error(ev?.message || "WebSocket error")));
      this.ws.addEventListener("message", (ev: any) => {
        try {
          const data = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
          if (data.id && this.pending.has(data.id)) {
            const p = this.pending.get(data.id)!;
            this.pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error.message || JSON.stringify(data.error)));
            else p.resolve(data.result);
          } else if (data.method === "Runtime.exceptionThrown") {
            const text =
              data.params?.exceptionDetails?.exception?.description ||
              data.params?.exceptionDetails?.text ||
              "Unknown exception";
            this.pageExceptions.push(text);
          } else if (data.method === "Runtime.consoleAPICalled") {
            if (data.params?.type === "error") {
              const args = (data.params?.args || [])
                .map((a: any) => a.value ?? a.description ?? "")
                .join(" ");
              this.consoleErrors.push(args);
            }
          }
        } catch {}
      });
    });
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: 1366,
      height: 920,
      deviceScaleFactor: 2,
      mobile: false,
    });
  }

  send(method: string, params: Record<string, any> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = any>(expression: string): Promise<T> {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(
        `Eval exception: ${
          res.exceptionDetails.exception?.description || res.exceptionDetails.text
        }`
      );
    }
    return res?.result?.value as T;
  }

  async screenshot(filename: string): Promise<string> {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const fullPath = path.join(OUT_DIR, filename);
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(fullPath, Buffer.from(res.data, "base64"));
    console.log(`[Screenshot Saved] ${fullPath}`);
    return fullPath;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function fetchTelemetry(): Promise<any> {
  const r = await fetch(`${WORKBENCH_URL}/api/telemetry`);
  return r.json();
}

async function postViewMessage(msg: any): Promise<void> {
  await fetch(`${WORKBENCH_URL}/api/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
}

async function waitForTurnComplete(expectedUserCount: number, timeoutMs = 120000): Promise<any> {
  const start = Date.now();
  await sleep(1200);
  while (Date.now() - start < timeoutMs) {
    const t = await fetchTelemetry();
    const statusKind = t.snapshots?.status?.payload?.kind || "idle";
    const messages = t.liveSession?.messages || [];
    const userMessages = messages.filter((m: any) => m.role === "user");
    const lastMsg = messages[messages.length - 1];
    const hasAssistantAnswer =
      userMessages.length >= expectedUserCount &&
      lastMsg &&
      lastMsg.role === "assistant" &&
      typeof lastMsg.content === "string" &&
      lastMsg.content.trim().length > 5 &&
      (!lastMsg.toolCalls ||
        lastMsg.toolCalls.every((tc: any) => tc.status === "done" || tc.status === "error"));

    if (statusKind === "idle" && hasAssistantAnswer) {
      await sleep(700);
      return await fetchTelemetry();
    }
    await sleep(800);
  }
  const latest = await fetchTelemetry();
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for turn to complete. Status=${JSON.stringify(
      latest.snapshots?.status?.payload
    )}, liveSession messages=${JSON.stringify(latest.liveSession?.messages)}`
  );
}

async function submitPromptInUi(cdp: CdpSession, promptText: string): Promise<void> {
  const submitted = await cdp.eval<boolean>(`
    (function() {
      const ta = document.querySelector('.composer-input-area textarea');
      if (!ta) return false;
      ta.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(ta, ${JSON.stringify(promptText)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  if (!submitted) throw new Error("Composer textarea not found in DOM");
  await sleep(350);
  const clicked = await cdp.eval<boolean>(`
    (function() {
      const btn = document.querySelector('button.send-btn[aria-label="Send message"]');
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()
  `);
  if (!clicked) throw new Error("Send button not found or disabled");
}

async function expandAllToolSteps(cdp: CdpSession): Promise<void> {
  await cdp.eval(`
    (function() {
      const heads = document.querySelectorAll('button.turn-process-head[aria-expanded="false"]');
      heads.forEach(h => h.click());
    })()
  `);
  await sleep(300);
  await cdp.eval(`
    (function() {
      const toolHeads = document.querySelectorAll('.tool-card-head[aria-expanded="false"], .tool-card:not(.open) .tool-card-head');
      toolHeads.forEach(h => h.click());
      const list = document.querySelector('.message-list');
      if (list) list.scrollTop = list.scrollHeight;
    })()
  `);
  await sleep(350);
}

async function main() {
  // 1. Ensure workbench server is running
  let spawnedWorkbench: ChildProcess | null = null;
  try {
    await fetchTelemetry();
    console.log(`[LiveTest] Connected to existing workbench at ${WORKBENCH_URL}`);
  } catch {
    console.log(`[LiveTest] Spawning workbench server at ${WORKBENCH_URL}...`);
    spawnedWorkbench = spawn("npx", ["tsx", "scripts/liveWorkbench.ts"], {
      cwd: path.resolve(__dirname, ".."),
      shell: true,
      stdio: "ignore",
    });
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try {
        await fetchTelemetry();
        break;
      } catch {}
    }
  }

  // 2. Launch Chrome with remote debugging enabled
  const chromeBin = findBrowserBinary();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-cdp-profile-"));
  const headless = process.env.HEADLESS !== "0";
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1366,920",
    ...(headless ? ["--headless=new"] : []),
    WORKBENCH_URL,
  ];

  console.log(`[LiveTest] Launching Chrome (${path.basename(chromeBin)}) on CDP port ${CDP_PORT}...`);
  const chromeProc = spawn(chromeBin, chromeArgs, { stdio: "ignore" });

  const cdp = new CdpSession();
  try {
    // Wait for /json target list
    let wsUrl = "";
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
        const targets = (await r.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
        const page = targets.find((t) => t.type === "page" && t.url.includes("4321"));
        if (page?.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {}
    }
    if (!wsUrl) throw new Error("Failed to attach to Chrome CDP page target");

    await cdp.connect(wsUrl);
    console.log(`[LiveTest] Attached to Chrome CDP target: ${wsUrl}`);

    // Wait for React root & models hydration
    for (let i = 0; i < 25; i++) {
      await sleep(400);
      const t = await fetchTelemetry();
      if ((t.snapshots?.models?.payload?.models?.length ?? 0) > 0) break;
    }
    await sleep(1000);

    // Scenario 1: Initial Boot / Onboarding Modal
    const shots: string[] = [];
    shots.push(await cdp.screenshot("01_onboarding_modal.png"));

    // Complete onboarding and prefer the warm model already loaded in Ollama VRAM
    await postViewMessage({ type: "completeOnboarding" });
    const initTelemetry = await fetchTelemetry();
    const availableModels: string[] = (initTelemetry.snapshots?.models?.payload?.models || []).map(
      (m: any) => m.name
    );
    const warmModels: string[] = (initTelemetry.snapshots?.ollamaRuntime?.payload || []).map(
      (m: any) => m.name
    );
    const currentSelected = initTelemetry.snapshots?.models?.payload?.selected || "";
    const preferredOrder = [...warmModels, currentSelected, "gemma4:e4b", "qwen2.5-coder:7b", "qwen3.5:4b"].filter(Boolean);
    const chosenModel =
      preferredOrder.find((p) => availableModels.includes(p)) || availableModels[0] || "gemma4:e4b";
    console.log(`[LiveTest] Available Ollama models (${availableModels.length}): ${availableModels.join(", ")}`);
    console.log(`[LiveTest] Warm VRAM models: ${warmModels.join(", ") || "none"} -> Using model: ${chosenModel}`);
    await postViewMessage({ type: "setModel", payload: { model: chosenModel } });
    await postViewMessage({ type: "setMode", payload: { mode: "chat" } });
    await sleep(800);

    shots.push(await cdp.screenshot("02_home_hero_ready.png"));

    // Scenario 2: Prompt 1 — Live USD to INR conversion rate via web_search
    console.log(`[LiveTest] Sending Prompt 1: "whats the USD conversion rate to INR today?"`);
    const t1Start = Date.now();
    await submitPromptInUi(cdp, "whats the USD conversion rate to INR today?");
    const t1Telemetry = await waitForTurnComplete(1, 120000);
    const t1Elapsed = Date.now() - t1Start;
    await expandAllToolSteps(cdp);
    shots.push(await cdp.screenshot("03_prompt1_usd_to_inr.png"));

    const t1Messages = t1Telemetry.liveSession?.messages || [];
    console.log(`[LiveTest] Prompt 1 completed in ${t1Elapsed}ms. Messages in session: ${t1Messages.length}`);

    // Scenario 3: Prompt 2 — Current President of India via web_search
    console.log(`[LiveTest] Sending Prompt 2: "tell me the current president of India"`);
    const t2Start = Date.now();
    await submitPromptInUi(cdp, "tell me the current president of India");
    const t2Telemetry = await waitForTurnComplete(2, 120000);
    const t2Elapsed = Date.now() - t2Start;
    await expandAllToolSteps(cdp);
    shots.push(await cdp.screenshot("04_prompt2_president_of_india.png"));

    const t2Messages = t2Telemetry.liveSession?.messages || [];
    console.log(`[LiveTest] Prompt 2 completed in ${t2Elapsed}ms. Messages in session: ${t2Messages.length}`);

    // Scenario 4: Prompt 3 — Workspace inspection (read_file on package.json) in a fresh session
    console.log(`[LiveTest] Starting new session for Prompt 3 (workspace read_file test)...`);
    await cdp.eval(`
      (function() {
        const btn = document.querySelector('button[aria-label="Start new session"]');
        if (btn) btn.click();
      })()
    `);
    await sleep(800);
    const t3Start = Date.now();
    await submitPromptInUi(
      cdp,
      "Use read_file to read the first 20 lines of package.json and tell me the name, displayName, and version."
    );
    const t3Telemetry = await waitForTurnComplete(1, 120000);
    const t3Elapsed = Date.now() - t3Start;
    await expandAllToolSteps(cdp);
    shots.push(await cdp.screenshot("05_prompt3_workspace_read_file.png"));

    // Scenario 5: Responsive VS Code Sidebar Width (460px) & Layout Overflow Audit
    console.log(`[LiveTest] Testing 460px VS Code Sidebar layout and auditing DOM geometry...`);
    await cdp.eval(`
      (function() {
        const btn = document.getElementById('wb-toggle-width');
        if (btn) btn.click();
      })()
    `);
    await sleep(500);
    const layoutAudit = await cdp.eval<{
      frameWidth: number;
      frameScrollWidth: number;
      hasHorizontalOverflow: boolean;
      headerVisible: boolean;
      composerVisible: boolean;
    }>(`
      (function() {
        const root = document.getElementById('root');
        const header = document.querySelector('.header');
        const composer = document.querySelector('.composer-card');
        return {
          frameWidth: root ? root.clientWidth : 0,
          frameScrollWidth: root ? root.scrollWidth : 0,
          hasHorizontalOverflow: root ? root.scrollWidth > root.clientWidth + 2 : false,
          headerVisible: Boolean(header && header.getBoundingClientRect().height > 0),
          composerVisible: Boolean(composer && composer.getBoundingClientRect().height > 0),
        };
      })()
    `);
    shots.push(await cdp.screenshot("06_sidebar_460px_responsive.png"));

    // Scenario 6: Settings & Providers Modal Inspection
    console.log(`[LiveTest] Opening Settings & Providers modal...`);
    await cdp.eval(`
      (function() {
        const widthBtn = document.getElementById('wb-toggle-width');
        if (widthBtn && widthBtn.classList.contains('active')) widthBtn.click();
        const settingsBtn = document.querySelector('button[aria-label="Settings and Providers"]');
        if (settingsBtn) settingsBtn.click();
      })()
    `);
    await sleep(600);
    shots.push(await cdp.screenshot("07_settings_panel.png"));

    // Write structured summary report
    const summary = {
      timestamp: new Date().toISOString(),
      modelTested: chosenModel,
      availableModelsCount: availableModels.length,
      consoleErrors: cdp.consoleErrors,
      pageExceptions: cdp.pageExceptions,
      layoutAudit,
      turns: {
        webSearchPrompts: {
          elapsedPrompt1Ms: t1Elapsed,
          elapsedPrompt2Ms: t2Elapsed,
          messages: t2Messages.map((m: any) => ({
            role: m.role,
            content: m.content,
            toolCalls: (m.toolCalls || []).map((tc: any) => ({
              name: tc.name,
              args: tc.args,
              status: tc.status,
              resultPreview: (tc.result || "").slice(0, 300),
            })),
          })),
        },
        workspaceReadFilePrompt: {
          elapsedPrompt3Ms: t3Elapsed,
          messages: (t3Telemetry.liveSession?.messages || []).map((m: any) => ({
            role: m.role,
            content: m.content,
            toolCalls: (m.toolCalls || []).map((tc: any) => ({
              name: tc.name,
              args: tc.args,
              status: tc.status,
              resultPreview: (tc.result || "").slice(0, 300),
            })),
          })),
        },
      },
      screenshots: shots,
    };

    const reportJsonPath = path.join(OUT_DIR, "live_test_report.json");
    fs.writeFileSync(reportJsonPath, JSON.stringify(summary, null, 2), "utf8");
    console.log(`[LiveTest] Full JSON report written to ${reportJsonPath}`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    cdp.close();
    try {
      chromeProc.kill();
    } catch {}
    if (spawnedWorkbench) {
      try {
        spawnedWorkbench.kill();
      } catch {}
    }
  }
}

main().catch((err) => {
  console.error("[LiveTest] Fatal error:", err);
  process.exit(1);
});
