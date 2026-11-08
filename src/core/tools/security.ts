/**
 * Terminal Command Security Guardrails.
 *
 * Inspects shell commands before execution to flag dangerous, destructive,
 * or obfuscated actions (e.g. recursive deletion, disk formatting, privileged execution,
 * encoded PowerShell commands, network exfiltration, or shell injection) so models
 * cannot execute them without explicit interactive user approval, regardless of auto-approval.
 */

export interface CommandSecurityAnalysis {
  isDangerous: boolean;
  reason?: string;
  category?: "destructive" | "privilege" | "network" | "process" | "obfuscation";
}

const DESTRUCTIVE_PATTERNS: Array<{
  regex: RegExp;
  reason: string;
  category: CommandSecurityAnalysis["category"];
}> = [
  // File and filesystem destruction
  { regex: /\b(rm|del|rmdir|erase)\s+.*(-r|-f|\/s|\/q)/i, reason: "Recursive / force file deletion", category: "destructive" },
  { regex: /\b(git\s+clean\s+-[a-z]*f)/i, reason: "Untracked files removal via git clean force", category: "destructive" },
  { regex: /\b(git\s+reset\s+--hard)/i, reason: "Hard git reset discarding uncommitted changes", category: "destructive" },
  { regex: /\b(git\s+push\s+.*(-f|--force))\b/i, reason: "Force push overwriting remote git history", category: "destructive" },
  { regex: /\b(mkfs|format\s+[a-z]:|diskpart|dd\s+if=)/i, reason: "Disk formatting or raw drive write", category: "destructive" },

  // Privilege escalation and system tampering
  { regex: /\b(sudo|runas|chmod\s+777|chown)\b/i, reason: "Privileged / permission elevation command", category: "privilege" },
  { regex: /\b(reg\s+(add|delete)|sc\s+(create|delete|config))\b/i, reason: "System registry or service modification", category: "privilege" },
  { regex: /\b(net\s+(user|localgroup|group))\b/i, reason: "User account management", category: "privilege" },

  // Process termination and resource exhaustion
  { regex: /\b(kill|pkill|taskkill)\s+.*(-f|\/f)/i, reason: "Force process termination", category: "process" },
  { regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "Fork bomb resource exhaustion attack", category: "process" },

  // Obfuscation and shell code injection
  { regex: /\bpowershell.*(-e|-enc|-encodedcommand)\b/i, reason: "PowerShell encoded command execution", category: "obfuscation" },
  { regex: /\b(iex|invoke-expression)\b/i, reason: "PowerShell dynamic expression evaluation", category: "obfuscation" },
  { regex: /\b(curl|wget|iwr|irm|invoke-webrequest).*\|\s*(sh|bash|zsh|powershell|pwsh|iex)\b/i, reason: "Remote script download piped directly to shell", category: "obfuscation" },
  { regex: /\b(base64\s+-d|certutil\s+-decode).*\|\s*(sh|bash|powershell|cmd)\b/i, reason: "Decoded payload piped directly to shell", category: "obfuscation" },

  // Network exfiltration and listener setup
  { regex: /\b(curl|wget|nc|ncat|netcat|invoke-webrequest)\s+.*(-d|--data|-X\s*POST|-T)\b/i, reason: "Potential outbound network data payload", category: "network" },
  { regex: /\b(nc|ncat|netcat)\s+.*(-l|-lp)\b/i, reason: "Network port listener creation", category: "network" },
];

/**
 * Check if a shell command contains potentially catastrophic, privileged, or obfuscated actions.
 */
export function analyzeCommandSecurity(command: string): CommandSecurityAnalysis {
  const trimmed = command.trim();

  // Check for caret obfuscation in Windows cmd (e.g. c^u^r^l)
  if (/\^[a-zA-Z]/.test(trimmed)) {
    return {
      isDangerous: true,
      reason: "Detected shell escape caret obfuscation",
      category: "obfuscation",
    };
  }

  for (const { regex, reason, category } of DESTRUCTIVE_PATTERNS) {
    if (regex.test(trimmed)) {
      return { isDangerous: true, reason, category };
    }
  }

  return { isDangerous: false };
}

/**
 * Standard allowlist of benign, read-only inspection commands suitable for unattended execution.
 */
const UNATTENDED_ALLOWLIST_PREFIXES = [
  "git status",
  "git diff",
  "git log",
  "git branch",
  "git rev-parse",
  "npm test",
  "npm run test",
  "node -v",
  "node --version",
  "npm -v",
  "npm --version",
  "pwd",
  "ls",
  "dir",
  "echo",
  "tsc --noemit",
  "which",
  "where",
];

export function isUnattendedCommandAllowed(command: string): boolean {
  const norm = command.trim().toLowerCase();
  const sec = analyzeCommandSecurity(norm);
  if (sec.isDangerous) return false;

  return UNATTENDED_ALLOWLIST_PREFIXES.some(
    (prefix) => norm === prefix || norm.startsWith(prefix + " ")
  );
}
