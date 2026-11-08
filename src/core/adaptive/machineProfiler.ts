import * as os from "node:os";
import * as fs from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { HardwareMetrics, MachineProfile } from "../../shared/types";

const execAsync = promisify(exec);

let cachedGpu: MachineProfile["gpu"] | undefined;
let cachedGpuTime = 0;
const GPU_CACHE_TTL = 30_000;

let lastHardwareSample: HardwareMetrics | undefined;
let lastHardwareSampleTime = 0;
const SAMPLE_TTL = 1000;

/**
 * Profile the host machine. RAM/CPU come from `os`; GPU is best-effort via a
 * platform command and is allowed to fail silently (returns undefined).
 */
export async function profileMachine(): Promise<MachineProfile> {
  const totalRamBytes = os.totalmem();
  const freeRamBytes = os.freemem();
  const cpus = os.cpus();
  const cpuCores = cpus.length;
  const cpuModel = cpus[0]?.model?.trim() ?? "unknown";
  const platform = os.platform();
  const arch = os.arch();

  const gpu = await detectGpu(platform).catch(() => undefined);

  return {
    totalRamBytes,
    freeRamBytes,
    cpuCores,
    cpuModel,
    platform,
    arch,
    gpu,
    tier: classifyMachine(totalRamBytes, gpu?.vramBytes),
  };
}

/**
 * Sample live GPU compute utilization, real GPU VRAM used/total/free, GPU temperature,
 * and system RAM used/total/free in real time.
 */
export async function sampleHardwareMetrics(
  fallbackGpu?: MachineProfile["gpu"]
): Promise<HardwareMetrics> {
  const now = Date.now();
  if (lastHardwareSample && now - lastHardwareSampleTime < SAMPLE_TTL) {
    return { ...lastHardwareSample };
  }

  const ramTotalBytes = os.totalmem();
  const ramFreeBytes = os.freemem();
  const ramUsedBytes = Math.max(0, ramTotalBytes - ramFreeBytes);
  const ramUsedPercent =
    ramTotalBytes > 0 ? Math.round((ramUsedBytes / ramTotalBytes) * 100) : 0;

  let gpuName = fallbackGpu?.name;
  let gpuUtilPercent: number | undefined;
  let vramUsedBytes: number | undefined;
  let vramTotalBytes = fallbackGpu?.vramBytes;
  let vramFreeBytes: number | undefined;
  let gpuTempC: number | undefined;

  try {
    const { stdout } = await execAsync(
      "nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.free,memory.total,temperature.gpu --format=csv,noheader,nounits",
      { timeout: 2500, windowsHide: true }
    );
    const line = stdout.trim().split("\n")[0];
    if (line) {
      const parts = line.split(",").map((s) => s.trim());
      if (parts[0]) gpuName = parts[0];
      const util = parseFloat(parts[1]);
      if (Number.isFinite(util)) gpuUtilPercent = Math.round(util);
      const usedMb = parseFloat(parts[2]);
      if (Number.isFinite(usedMb)) vramUsedBytes = Math.round(usedMb * 1024 ** 2);
      const freeMb = parseFloat(parts[3]);
      if (Number.isFinite(freeMb)) vramFreeBytes = Math.round(freeMb * 1024 ** 2);
      const totalMb = parseFloat(parts[4]);
      if (Number.isFinite(totalMb)) vramTotalBytes = Math.round(totalMb * 1024 ** 2);
      const temp = parseFloat(parts[5]);
      if (Number.isFinite(temp)) gpuTempC = Math.round(temp);
    }
  } catch {
    // Non-NVIDIA or nvidia-smi unavailable — fall back gracefully to fallbackGpu + RAM metrics
  }

  const sample: HardwareMetrics = {
    gpuName,
    gpuUtilPercent,
    vramUsedBytes,
    vramTotalBytes,
    vramFreeBytes,
    gpuTempC,
    ramUsedBytes,
    ramTotalBytes,
    ramFreeBytes,
    ramUsedPercent,
    updatedAt: now,
  };
  lastHardwareSample = sample;
  lastHardwareSampleTime = now;
  return sample;
}

export function classifyMachine(
  totalRamBytes: number,
  vramBytes?: number
): MachineProfile["tier"] {
  const gb = totalRamBytes / 1024 ** 3;
  const vramGb = (vramBytes ?? 0) / 1024 ** 3;
  if (vramGb >= 12 || gb >= 32) return "high";
  if (vramGb >= 6 || gb >= 16) return "mid";
  return "low";
}

export async function detectGpu(
  platform: NodeJS.Platform
): Promise<MachineProfile["gpu"]> {
  const now = Date.now();
  if (cachedGpu && now - cachedGpuTime < GPU_CACHE_TTL) {
    return cachedGpu;
  }

  try {
    // nvidia-smi works on any OS where the driver is installed and reports
    // exact VRAM — always prefer it when present.
    const nvidia = await detectNvidiaGpu().catch(() => undefined);
    if (nvidia) {
      cachedGpu = nvidia;
      cachedGpuTime = now;
      return nvidia;
    }

    let detected: MachineProfile["gpu"] | undefined;
    if (platform === "win32") {
      detected = await detectWindowsGpu();
    } else if (platform === "darwin") {
      detected = await detectDarwinGpu();
    } else if (platform === "linux") {
      detected = await detectLinuxGpu();
    }

    if (detected) {
      cachedGpu = detected;
      cachedGpuTime = now;
      return detected;
    }
  } catch {
    // Ignore — GPU detection is a nicety, not a requirement.
  }
  return undefined;
}

async function detectNvidiaGpu(): Promise<MachineProfile["gpu"] | undefined> {
  const { stdout } = await execAsync(
    "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits",
    { timeout: 5000, windowsHide: true }
  );
  const line = stdout.trim().split("\n")[0];
  if (!line) return undefined;
  const [name, memMb] = line.split(",").map((s) => s.trim());
  return {
    name,
    vramBytes: memMb && /^\d+$/.test(memMb) ? parseInt(memMb, 10) * 1024 ** 2 : undefined,
    vendor: "nvidia",
  };
}

async function detectDarwinGpu(): Promise<MachineProfile["gpu"] | undefined> {
  const { stdout } = await execAsync(
    "system_profiler SPDisplaysDataType 2>/dev/null",
    { timeout: 5000 }
  );
  const nameMatch = stdout.match(/Chipset Model:\s*(.+)/);
  const vramMatch = stdout.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    const vendor = guessVendor(name);
    let vramBytes: number | undefined;
    let isUnifiedMemory = false;

    if (vramMatch) {
      const n = parseInt(vramMatch[1], 10);
      vramBytes = vramMatch[2].toUpperCase() === "GB" ? n * 1024 ** 3 : n * 1024 ** 2;
    } else if (vendor === "apple") {
      // Apple Silicon unified memory: ~65% of total system RAM is addressable by GPU
      isUnifiedMemory = true;
      vramBytes = Math.floor(os.totalmem() * 0.65);
    }
    return { name, vramBytes, vendor, isUnifiedMemory };
  }
  return undefined;
}

/**
 * Windows GPU detection. Win32_VideoController.AdapterRAM is a 32-bit value
 * that saturates at ~4 GB — a 24-GB RTX 4090 reports 4095 MB, which made
 * classifyMachine call high-end GPUs "mid" and shrink planned context windows.
 * The registry's HardwareInformation.qpMemorySize is a QWORD with the real
 * byte count; AdapterRAM is only the fallback for the display NAME.
 */
async function detectWindowsGpu(): Promise<MachineProfile["gpu"] | undefined> {
  const { stdout } = await execAsync(
    'powershell -NoProfile -Command "' +
      "$k = Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.PSChildName -match '^0{4}$' }; " +
      "$vram = ($k | ForEach-Object { (Get-ItemProperty -Path $_.PSPath -Name 'HardwareInformation.qpMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qpMemorySize' } | " +
      "Measure-Object -Maximum).Maximum; " +
      "(Get-CimInstance Win32_VideoController | Select-Object -First 1 Name | ConvertTo-Json -Compress); " +
      "\"VRAM=$vram\"" +
      '"',
    { timeout: 6000, windowsHide: true }
  );

  let name: string | undefined;
  const nameLine = stdout.split("\n").find((l) => l.trim().startsWith("{") || l.includes('"Name"'));
  if (nameLine) {
    try {
      const parsed = JSON.parse(nameLine.trim());
      name = typeof parsed === "string" ? parsed : parsed?.Name;
    } catch {
      /* name line unparsed — fall through */
    }
  }
  if (!name) return undefined;

  let vramBytes: number | undefined;
  const vramMatch = stdout.match(/VRAM=(\d+)/);
  if (vramMatch) {
    const qword = parseInt(vramMatch[1], 10);
    // Sanity check: real VRAM sizes are between 256 MB and 128 GB.
    if (Number.isFinite(qword) && qword > 256 * 1024 ** 2 && qword <= 128 * 1024 ** 3) {
      vramBytes = qword;
    }
  }

  const vendor = guessVendor(name);
  const isIntegrated = (vramBytes === undefined || vramBytes <= 512 * 1024 ** 2) && (vendor === "intel" || /integrated|uhd|iris/i.test(name));
  const sharedMemoryBytes = isIntegrated ? Math.floor(os.totalmem() * 0.5) : undefined;

  return { name, vramBytes, vendor, isIntegrated, sharedMemoryBytes };
}

async function detectLinuxGpu(): Promise<MachineProfile["gpu"] | undefined> {
  // 1. Check /sys/class/drm for dedicated VRAM info (instant without child process)
  try {
    const cards = fs.readdirSync("/sys/class/drm");
    for (const card of cards) {
      if (/^card\d+$/.test(card)) {
        const vramPath = `/sys/class/drm/${card}/device/mem_info_vram_total`;
        if (fs.existsSync(vramPath)) {
          const raw = fs.readFileSync(vramPath, "utf8").trim();
          const bytes = parseInt(raw, 10);
          if (Number.isFinite(bytes) && bytes > 256 * 1024 ** 2) {
            return { name: `Linux DRM (${card})`, vramBytes: bytes, vendor: "amd" };
          }
        }
      }
    }
  } catch {
    /* /sys/class/drm unavailable or permission restricted */
  }

  // 2. Check lspci
  try {
    const { stdout } = await execAsync("lspci -nn | grep -E -i 'vga|3d|display'", { timeout: 3000 });
    const line = stdout.trim().split("\n")[0];
    if (line) {
      const vendor = guessVendor(line);
      return { name: line.replace(/^[0-9a-f:.]+\s+/, "").trim(), vendor };
    }
  } catch {
    /* lspci unavailable */
  }

  return undefined;
}

export function guessVendor(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.includes("nvidia") || n.includes("geforce") || n.includes("rtx") || n.includes("gtx")) return "nvidia";
  if (n.includes("amd") || n.includes("radeon")) return "amd";
  if (n.includes("intel") || n.includes("arc")) return "intel";
  if (n.includes("apple")) return "apple";
  return undefined;
}
