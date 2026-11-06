/**
 * Terminal Command Security Guardrails.
 *
 * Inspects shell commands before execution to flag dangerous or destructive actions
 * (e.g. deleting files, formatting disks, killing processes, or unauthorized network
 * exfiltration) so models cannot execute them without explicit interactive user approval,
 * regardless of whether auto-approval is toggled on.
 */

export interface CommandSecurityAnalysis {
  isDangerous: boolean;
  reason?: string;
  category?: "destructive" | "privilege" | "network" | "process";
}

const DESTRUCTIVE_PATTERNS: Array<{ regex: RegExp; reason: string; category: CommandSecurityAnalysis["category"] }> = [
  { regex: /\b(rm|del|rmdir|erase)\s+.*(-r|-f|\/s|\/q)/i, reason: "Recursive / force file deletion", category: "destructive" },
  { regex: /\b(git\s+clean\s+-[a-z]*f)/i, reason: "Untracked files removal via git clean force", category: "destructive" },
  { regex: /\b(git\s+reset\s+--hard)/i, reason: "Hard git reset discarding uncommitted changes", category: "destructive" },
  { regex: /\b(mkfs|format\s+[a-z]:|diskpart|dd\s+if=)/i, reason: "Disk formatting or raw drive write", category: "destructive" },
  { regex: /\b(sudo|runas|chmod\s+777|chown)\b/i, reason: "Privileged / permission elevation command", category: "privilege" },
  { regex: /\b(kill|pkill|taskkill)\s+.*(-f|\/f)/i, reason: "Force process termination", category: "process" },
  { regex: /\b(curl|wget|nc|ncat|netcat|invoke-webrequest)\s+.*(-d|--data|-X\s*POST|-T)\b/i, reason: "Potential outbound network data payload", category: "network" },
];

/**
 * Check if a shell command contains potentially catastrophic or high-risk actions.
 */
export function analyzeCommandSecurity(command: string): CommandSecurityAnalysis {
  const trimmed = command.trim();
  for (const { regex, reason, category } of DESTRUCTIVE_PATTERNS) {
    if (regex.test(trimmed)) {
      return { isDangerous: true, reason, category };
    }
  }
  return { isDangerous: false };
}

