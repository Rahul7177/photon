# Photon — Zero-Friction Local LLM Lifecycle Checklist & Specification

> **Goal**: Eliminate all terminal friction for local LLM users. A user opening Photon in VS Code should never have to manually run `ollama serve`, open a terminal to run `ollama pull`, configure URLs, or switch back and forth between external apps. Photon should automatically sense installed providers, launch them with one click, recommend the optimal model for the user's specific hardware, stream model installation in real time, and handle all errors gracefully.

---

## 1. System Architecture & User Journey Flow

```
+-------------------------------------------------------------------------------------------------+
|                                     PHOTON EXTENSION HOST                                       |
|                                                                                                 |
|   +--------------------------+   +--------------------------+   +---------------------------+   |
|   |  LocalRuntimeDetector    |   |   LocalProcessManager    |   |       ModelAdvisor        |   |
|   |  - Binary & PATH scan    |   |   - Start/Stop daemon    |   |   - Hardware profiling    |   |
|   |  - HTTP ping / health    |   |   - Health watchdog      |   |   - VRAM / RAM fit check  |   |
|   |  - Port collision probe  |   |   - Live stdout/stderr   |   |   - Tier recommendations  |   |
|   +------------+-------------+   +------------+-------------+   +-------------+-------------+   |
|                |                              |                               |                 |
|                +------------------------------+-------------------------------+                 |
|                                               |                                                 |
|                                  +------------v------------+                                    |
|                                  |   PhotonController      |                                    |
|                                  |   - State bridge        |                                    |
|                                  |   - Pull streamer       |                                    |
|                                  +------------+------------+                                    |
+-----------------------------------------------|-------------------------------------------------+
                                                | Host Messages (status, progress, recommendations)
+-----------------------------------------------v-------------------------------------------------+
|                                     WEBVIEW UI (CHAT / HERO)                                    |
|                                                                                                 |
|  [Provider State: Stopped]  -->  [One-Click: "Start Ollama"]  -->  [Real-Time Progress & Logs]  |
|                                                                                                 |
|  [Hardware Recommendation]  -->  "qwen2.5-coder:7b (Fits 100% in your 8GB RTX 4060 VRAM)"     |
|                                                                                                 |
|  [One-Click Model Install]  -->  Live Progress Bar (2.4 GB / 4.7 GB · 28 MB/s · ETA: 45s)       |
+-------------------------------------------------------------------------------------------------+
```

---

## Phase 1 — Local Provider Sensing & Detection (`LocalRuntimeDetector`)

Sensors to detect which local LLM runtimes are installed, their binary paths, and their real-time daemon state.

- [x] **1.1 Multi-Platform Binary Discovery**
  - Implement `detectLocalRuntimes()` in `src/core/adaptive/runtimeDetector.ts`:
    - **Windows**:
      - Inspect `PATH` for `ollama.exe`, `llama-server.exe`, `server.exe`.
      - Check default paths: `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`, `%PROGRAMFILES%\Ollama\ollama.exe`.
      - Inspect Registry (`HKCU\Software\Ollama` or Uninstall registry keys).
      - Check LM Studio: `%LOCALAPPDATA%\LM-Studio\app-*\resources\app\bin\lms.exe`.
    - **macOS**:
      - Inspect `PATH`, `/usr/local/bin/ollama`, `/opt/homebrew/bin/ollama`.
      - Check `/Applications/Ollama.app` and `/Applications/LM Studio.app`.
    - **Linux**:
      - Inspect `PATH`, `/usr/local/bin/ollama`, `/usr/bin/ollama`.
      - Check systemd service status (`systemctl is-active ollama`).

- [x] **1.2 Provider Tri-State Health & Port Probing**
  - Probe each local provider endpoint with ultra-low timeout (400ms):
    - **Ollama**: `GET http://127.0.0.1:11434/api/version`
    - **llama.cpp**: `GET http://127.0.0.1:8080/health` (or `/props`)
    - **LM Studio**: `GET http://127.0.0.1:1234/v1/models`
    - **Custom Local / vLLM**: `GET http://127.0.0.1:8000/v1/models`
  - Assign explicit runtime state to each provider:
    - `"running"`: Responding to HTTP ping.
    - `"installed_stopped"`: Executable binary detected on disk, but port is unreachable.
    - `"not_installed"`: Executable binary not detected.
    - `"port_conflict"`: Port is occupied, but not returning the expected provider signature.

- [x] **1.3 Port Conflict Detection & Inspection**
  - When port is occupied but health ping fails, detect which PID is holding the port (`netstat` / `Get-NetTCPConnection` on Windows, `lsof -i :<port>` on Unix).
  - Inform user gracefully: `"Port 11434 is in use by PID 1234 (process_name). Would you like to terminate it or use a different port?"`.

---

## Phase 2 — One-Click Provider Process Lifecycle (`LocalProcessManager`)

Allow users to launch, monitor, and stop local providers directly from VS Code.

- [x] **2.1 Ollama One-Click Daemon Launch**
  - Implement `startProvider(id: "ollama")` in `src/host/localProcessManager.ts`:
    - Windows: Launch detached child process `ollama.exe serve` with environment variable `OLLAMA_HOST=127.0.0.1:11434`, `windowsHide: true`.
    - macOS: Run `open -a Ollama` if desktop app is found, or spawn `/usr/local/bin/ollama serve`.
    - Linux: Run `systemctl --user start ollama` or spawn `ollama serve`.
  - Maintain a reference to spawned child process PID and kill handlers on extension deactivation.

- [x] **2.2 llama.cpp Server One-Click Launch**
  - Implement `startProvider(id: "llamacpp", modelPath?: string, options?: LlamaCppSettings)`:
    - Automatically construct optimal hardware CLI flags via `ModelConfigStore.launchCommand()`:
      - `-m <path-to-gguf>`
      - `-c <context_tokens>` (hardware-safe)
      - `-ngl all` (offload all layers to GPU if VRAM allows, or calculated optimal layer count)
      - `--port 8080`
    - Spawn and manage `llama-server`.

- [x] **2.3 Startup Watchdog & Readiness Polling**
  - Upon clicking "Start Provider", broadcast state `"starting"` to webview.
  - Poll health endpoint every 500ms for up to 15 seconds.
  - When responding: broadcast state `"running"`, immediately trigger model catalog refresh, and notify user.
  - If timeout expires: inspect process exit code and stderr, report clear error.

- [x] **2.4 Process Stopping & Restarting**
  - Implement clean termination (`SIGINT` / `SIGTERM`, falling back to process kill if unresponsive after 3s).
  - Ability to restart provider if memory becomes fragmented or stuck.

- [x] **2.5 One-Click Installer Guidance for `not_installed`**
  - If Ollama is not installed:
    - Windows: Offer button **"Install via Winget"** (`winget install Ollama.Ollama` in integrated terminal) or **"Download Official Installer"** (`https://ollama.com/download/OllamaSetup.exe`).
    - macOS: Offer **"Install via Homebrew"** (`brew install ollama`) or official DMG download.
    - Linux: Offer standard terminal curl command (`curl -fsSL https://ollama.com/install.sh | sh`).

---

## Phase 3 — Hardware-Aware Model Recommendation Engine (`ModelAdvisor`)

Suggest the best models specifically tailored to the user's CPU, RAM, and GPU VRAM.

- [x] **3.1 Dynamic Hardware Tiers & Memory Fit Formulas**
  - In `src/core/adaptive/modelAdvisor.ts`, evaluate:
    - `totalRamGb`, `freeRamGb`, `ramBufferGb` (22.5% safety reserve).
    - `vramGb`, `gpuVendor`, `cpuCores`.
  - Calculate precise model footprint:
    $$\text{Memory Required} = \text{Model Weight (GB)} + \left(\frac{\text{Context Tokens}}{1024} \times \text{KV GB per 1K}\right)$$
  - Determine execution tier:
    - **100% GPU Resident**: $\text{Memory Required} \le (\text{VRAM} - 0.5\text{GB})$. Blazing fast inference (~40–90 tok/s).
    - **Hybrid GPU+RAM**: Weights fit across VRAM + RAM without touching the 22.5% OS buffer. Medium speed (~15–30 tok/s).
    - **CPU-Only**: No GPU or model too large for VRAM.

- [x] **3.2 Curated Catalog of Tested Coding Models**
  - Build verified local model recommendations with specific capabilities:
    - **Ultra-light (<4GB VRAM or <=8GB RAM)**:
      - `qwen2.5-coder:1.5b` (1.0 GB) — Fast autocompletions & small edits.
      - `qwen2.5-coder:3b` (1.9 GB) — Solid syntax and single-file code assistant.
      - `gemma4:e2b` (2.2 GB) — Compact reasoning & multimodal understanding.
    - **Sweet Spot (6–8GB VRAM or 16GB RAM)**:
      - `qwen2.5-coder:7b` (4.7 GB) — **Primary Recommendation**. State-of-the-art coding, reliable native tool calling, fast on modern consumer GPUs.
      - `gemma4:e4b` (3.5 GB) — Multimodal, fast reasoning, fits comfortably in 4–6GB VRAM.
      - `deepseek-r1:8b` (4.9 GB) — Deep reasoning and complex bug diagnosis.
    - **High-Performance (12–24GB+ VRAM or 32GB+ RAM)**:
      - `qwen2.5-coder:14b` (9.0 GB) — Near frontier-level coding accuracy.
      - `qwen2.5-coder:32b` (20.0 GB) — Full codebase architecture refactoring.
      - `command-r:35b` (21.0 GB) — 128k context agentic powerhouse.

- [x] **3.3 Explanatory Fit Badges in UI**
  - Provide human-readable badges in the UI:
    - 🟢 `Fits 100% in your RTX 4060 VRAM (~55 tok/s)`
    - 🟡 `Hybrid GPU+RAM: 8GB in VRAM, 4GB in RAM (~22 tok/s)`
    - 🔴 `Exceeds safe memory: heavy disk swap risk`

---

## Phase 4 — In-Extension One-Click Model Installation / Pull (`ModelInstaller`)

Direct model download and layer extraction inside VS Code with real-time feedback.

- [x] **4.1 Real-Time Streaming Download Metrics**
  - In `PhotonController.ts`, enhance `pullModel`:
    - Stream `POST /api/pull` with `stream: true`.
    - Track download speed (MB/s) computed over a rolling 1-second window.
    - Track completed bytes / total bytes (e.g. `2.3 GB / 4.7 GB`).
    - Calculate dynamic Estimated Time Remaining (ETA: mm:ss).
    - Status message breakdown: `"pulling manifest"`, `"downloading layer <id>"`, `"verifying sha256"`, `"writing manifest"`.

- [x] **4.2 Pre-Flight Disk Space Verification**
  - Before initiating a pull:
    - Query model estimated size from curated catalog or manifest.
    - Check available disk space on the model storage partition (`os.freemem()` / disk space probe).
    - If free disk space is less than $\text{Model Size} + 1.5\text{GB}$, stop and warn user: `"Insufficient disk space: needs 4.7 GB, only 2.1 GB available"`.

- [x] **4.3 Abort & Cancel Controller**
  - Provide an interactive "Cancel Download" button.
  - Abort the underlying `fetch` reader via `AbortController`.
  - Cleanly notify Ollama and reset webview state to idle without leaving dangling locks.

- [x] **4.4 Automatic Activation & Verification Post-Pull**
  - Once pull completes (phase `"done"`):
    - Trigger `refreshModels()`.
    - Automatically select the newly pulled model as active.
    - Profile the model (context length, tool capabilities) and show success banner: `"qwen2.5-coder:7b installed and ready to code!"`.

---

## Phase 5 — Webview UI/UX Overhaul & Real-Time Dashboard

Transform the local provider setup into an intuitive, beautiful experience.

- [x] **5.1 Replace Passive `OfflineBanner` with Interactive `LocalProviderHub`**
  - Deprecate static text banner in `webview-ui/src/components/OfflineBanner.tsx`.
  - Create interactive `LocalProviderHub.tsx`:
    - Shows detected status badge:
      - 🟡 **Ollama (Stopped)**: Large prominent button **"Start Ollama Service"** + auto-start toggle.
      - 🔴 **Ollama (Not Installed)**: Button **"Install Ollama"** with one-click terminal installation / download popup.
      - 🟢 **Ollama (Running)**: Displays currently loaded runner (`ollama ps`), VRAM used, and quick model switcher.
    - Shows live startup spinner and stdout log stream while starting up.

- [x] **5.2 Hero / Welcome Screen Quick-Start Wizard**
  - When zero models are installed or provider is offline:
    - Render a clean 3-step Quick Start Wizard directly on the welcome screen:
      1. **Provider**: `[Start Ollama (Detected)]`
      2. **Recommended Model**: Card for `qwen2.5-coder:7b` with badge `"Recommended for your 8GB RTX 4060"`.
      3. **Action**: `[One-Click Install & Start Chat]`.
    - When clicked, progress bar renders inline on the card with live bytes/speed/ETA.

- [x] **5.3 Model Selector Dropdown Enhancement**
  - In the composer footer model dropdown:
    - Section 1: **Installed Local Models** (with checkmark for currently active).
    - Section 2: **Recommended to Install** (e.g. `+ qwen2.5-coder:7b (Recommended · 4.7GB)`).
    - Clicking an uninstalled recommended model prompts: `"Install qwen2.5-coder:7b now?"` with one-click confirmation.

- [x] **5.4 Real-Time Pull Progress Bar in Composer & Header**
  - Display non-intrusive slim progress bar at the bottom of the composer or header while a model is downloading:
    - `Downloading qwen2.5-coder:7b — 64% (3.0 GB / 4.7 GB · 32 MB/s · ETA: 42s) [Cancel]`
  - User can continue browsing docs or reading chat history while the model downloads in the background.

---

## Phase 6 — Graceful Error Handling & Recovery Matrix

Edge cases must be captured and presented with clear, actionable solutions.

| Failure Scenario | Root Cause | Graceful Recovery Action |
|---|---|---|
| **Port 11434 in use** | Zombie Ollama or competing process | Detect PID via netstat; ask user: `"Port 11434 in use by PID <id>. Stop it and restart?"` with one-click button. |
| **Out of Disk Space** | Disk fills up during layer extraction | Pre-flight check before pull; if disk fails mid-download, show clean error: `"Disk full: Free up at least 3GB on drive C: to finish"`. |
| **Network Timeout / Disconnect** | Wi-Fi drop during 5GB download | Pause and show `"Download interrupted — Click Resume"`. Leverage Ollama's layer cache so already-downloaded layers are preserved. |
| **Binary Permission Denied** | Execution bit missing or admin required | On Linux/macOS: `chmod +x` suggestion; on Windows: launch with standard user privileges. |
| **OOM / Out of VRAM on Load** | User attempts to load 32B model into 4GB VRAM | Show friendly warning from `checkContextWindowOverflow`; suggest snapping context to 8k or switching to recommended 7B/3B tier. |
| **Daemon Crashes on Startup** | Driver incompatibility / CUDA missing | Capture `stderr` from daemon spawn; display formatted troubleshooting modal with `"Copy Error Details"` button. |

---

## Phase 7 — Automated Testing & Verification Suite

Ensure 100% test coverage for all new local LLM lifecycle components.

- [x] **7.1 Unit Tests for `LocalRuntimeDetector`** (`test/unit/runtimeDetector.test.ts`)
  - Test binary path resolution across Windows, macOS, and Linux mocks.
  - Test port health checks (`running`, `stopped`, `not_installed`).
  - Test port conflict detection with mocked network sockets.

- [x] **7.2 Unit Tests for `LocalProcessManager`** (`test/unit/localProcessManager.test.ts`)
  - Test start command construction for Ollama (`serve`) and llama.cpp (`llama-server -m ...`).
  - Test health check polling watchdog and timeout handling.
  - Test process termination and cleanup on shutdown.

- [x] **7.3 Unit Tests for `ModelAdvisor`** (`test/unit/modelAdvisor.test.ts`)
  - Test hardware tier categorization for 4GB, 8GB, 16GB, 24GB VRAM machines.
  - Test memory fit calculation (weights + KV cache) against RAM safety buffer.
  - Test recommendation accuracy for coding, reasoning, and multimodal models.

- [x] **7.4 Unit Tests for `ModelInstaller` & Progress Streamer** (`test/unit/modelInstaller.test.ts`)
  - Test parsing of chunked Ollama pull NDJSON responses.
  - Test calculation of percentage, download rate (MB/s), and ETA.
  - Test pre-flight disk space validation.
  - Test `AbortSignal` cancellation.

- [x] **7.5 UI Reducer & Component Tests** (`test/unit/localProviderUI.test.ts`)
  - Test state store reducer for new actions (`providerStatus`, `pullProgressDelta`, `cancelPull`).
  - Test `LocalProviderHub` rendering across all provider states (`stopped`, `starting`, `running`, `not_installed`).

- [x] **7.6 Full E2E Integration Simulation** (`test/e2e/e2e_local_lifecycle.test.ts`)
  - Complete flow: Detect stopped provider → Click Start → Provider reaches ready → Recommended model pulled with progress → Model selected → Prompt executed successfully.

---

## Implementation Priority Roadmap

```
+----------------------------------------------------------------------------------------+
| Milestone 1: Sensing & Process Control                                                 |
| - Runtime detector (detect binary & port state)                                        |
| - Process manager (one-click start/stop Ollama & llama-server)                         |
| - Wire host messages to webview                                                        |
+----------------------------------------------------------------------------------------+
                                           |
                                           v
+----------------------------------------------------------------------------------------+
| Milestone 2: Hardware-Aware Model Advisor                                              |
| - Model advisor engine (RAM/VRAM fit calculation)                                      |
| - Curated recommendations catalog                                                      |
| - UI fit badges ("Fits 100% in your GPU")                                              |
+----------------------------------------------------------------------------------------+
                                           |
                                           v
+----------------------------------------------------------------------------------------+
| Milestone 3: Real-Time In-Extension Model Installer                                    |
| - Enhanced pull streamer (MB/s, ETA, bytes progress)                                   |
| - Pre-flight disk space check & abort controller                                       |
| - Post-pull auto-activation & context profiling                                        |
+----------------------------------------------------------------------------------------+
                                           |
                                           v
+----------------------------------------------------------------------------------------+
| Milestone 4: Modern Webview UI/UX Overhaul                                             |
| - Replace OfflineBanner with interactive LocalProviderHub                              |
| - Hero welcome screen quick-start wizard (1-click to chat)                             |
| - Composer model picker "Recommended to Install" section                               |
+----------------------------------------------------------------------------------------+
                                           |
                                           v
+----------------------------------------------------------------------------------------+
| Milestone 5: Testing & Hardening                                                       |
| - Comprehensive unit & E2E tests for runtime detector, installer, process manager      |
| - Error recovery validation (port conflicts, network drops, disk full)                 |
+----------------------------------------------------------------------------------------+
```

