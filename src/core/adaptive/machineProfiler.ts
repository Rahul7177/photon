import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { MachineProfile } from "../../shared/types";

const execAsync = promisify(exec);

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

function classifyMachine(
  totalRamBytes: number,
  vramBytes?: number
): MachineProfile["tier"] {
  const gb = totalRamBytes / 1024 ** 3;
  const vramGb = (vramBytes ?? 0) / 1024 ** 3;
  if (vramGb >= 12 || gb >= 32) return "high";
  if (vramGb >= 6 || gb >= 16) return "mid";
  return "low";
}

async function detectGpu(
  platform: NodeJS.Platform
): Promise<MachineProfile["gpu"]> {
  try {
    // nvidia-smi works on any OS where the driver is installed and reports
    // exact VRAM — always prefer it when present.
    const nvidia = await detectNvidiaGpu().catch(() => undefined);
    if (nvidia) return nvidia;

    if (platform === "win32") {
      return await detectWindowsGpu();
    } else if (platform === "darwin") {
      const { stdout } = await execAsync(
        "system_profiler SPDisplaysDataType 2>/dev/null",
        { timeout: 5000 }
      );
      const nameMatch = stdout.match(/Chipset Model:\s*(.+)/);
      const vramMatch = stdout.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
      if (nameMatch) {
        let vramBytes: number | undefined;
        if (vramMatch) {
          const n = parseInt(vramMatch[1], 10);
          vramBytes = vramMatch[2].toUpperCase() === "GB" ? n * 1024 ** 3 : n * 1024 ** 2;
        }
        return { name: nameMatch[1].trim(), vramBytes, vendor: guessVendor(nameMatch[1]) };
      }
    }
  } catch {
    // Ignore — GPU detection is a nicety, not a requirement.
  }
  return undefined;
}

async function detectNvidiaGpu(): Promise<MachineProfile["gpu"] | undefined> {
  const { stdout } = await execAsync(
    "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits",
    { timeout: 5000 }
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
    { timeout: 6000 }
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
  return { name, vramBytes, vendor: guessVendor(name) };
}

function guessVendor(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.includes("nvidia") || n.includes("geforce") || n.includes("rtx") || n.includes("gtx")) return "nvidia";
  if (n.includes("amd") || n.includes("radeon")) return "amd";
  if (n.includes("intel") || n.includes("arc")) return "intel";
  if (n.includes("apple")) return "apple";
  return undefined;
}
