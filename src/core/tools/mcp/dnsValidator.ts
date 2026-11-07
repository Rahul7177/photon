import * as dns from "node:dns/promises";

export type DnsLookupFn = (
  hostname: string,
  options?: { all?: boolean }
) => Promise<Array<{ address: string; family: number }>>;

/**
 * Checks whether an IPv4 address string falls within private, loopback,
 * link-local (cloud metadata), multicast, or reserved ranges.
 */
export function isBlockedIPv4(ip: string): boolean {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return true; // malformed treated as blocked

  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return true;

  const [b0, b1] = nums;

  // 0.0.0.0/8 (Current network)
  if (b0 === 0) return true;
  // 10.0.0.0/8 (Private)
  if (b0 === 10) return true;
  // 100.64.0.0/10 (Shared / Carrier-grade NAT)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;
  // 169.254.0.0/16 (Link-local / Cloud metadata: 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;
  // 172.16.0.0/12 (Private)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (b0 === 192 && b1 === 0 && nums[2] === 0) return true;
  // 192.0.2.0/24 (Documentation / TEST-NET-1)
  if (b0 === 192 && b1 === 0 && nums[2] === 2) return true;
  // 192.168.0.0/16 (Private)
  if (b0 === 192 && b1 === 168) return true;
  // 198.18.0.0/15 (Benchmarking)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  // 198.51.100.0/24 (Documentation / TEST-NET-2)
  if (b0 === 198 && b1 === 51 && nums[2] === 100) return true;
  // 203.0.113.0/24 (Documentation / TEST-NET-3)
  if (b0 === 203 && b1 === 0 && nums[2] === 113) return true;
  // 224.0.0.0/4 (Multicast)
  if (b0 >= 224 && b0 <= 239) return true;
  // 240.0.0.0/4 (Reserved / Future use)
  if (b0 >= 240) return true;

  return false;
}

/**
 * Checks whether an IPv6 address string falls within loopback, unspecified,
 * unique local (private), link-local, multicast, or IPv4-mapped private ranges.
 */
export function isBlockedIPv6(ip: string): boolean {
  const norm = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");

  // :: (Unspecified) and ::1 (Loopback)
  if (norm === "::" || norm === "::1" || norm === "0:0:0:0:0:0:0:0" || norm === "0:0:0:0:0:0:0:1") {
    return true;
  }

  // fc00::/7 (Unique Local Address - Private network)
  if (/^f[cd][0-9a-f]{2}:/i.test(norm)) return true;

  // fe80::/10 (Link-Local)
  if (/^fe[89ab][0-9a-f]:/i.test(norm)) return true;

  // ff00::/8 (Multicast)
  if (/^ff[0-9a-f]{2}:/i.test(norm)) return true;

  // IPv4-mapped IPv6 address (::ffff:192.0.2.128)
  const mapped = norm.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) {
    return isBlockedIPv4(mapped[1]);
  }

  return false;
}

/**
 * Validates an IP string (v4 or v6) against prohibited/private destination ranges.
 */
export function isPrivateOrProhibitedIp(ip: string): boolean {
  if (ip.includes(":")) {
    return isBlockedIPv6(ip);
  }
  return isBlockedIPv4(ip);
}

/**
 * Static hostname inspection without network call.
 */
export function isSafeRemoteHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");

  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".invalid") ||
    h.endsWith(".test")
  ) {
    return false;
  }

  // Check if literal IPv4 or IPv6
  if (/^[0-9.]+$/.test(h)) {
    return !isBlockedIPv4(h);
  }
  if (h.includes(":")) {
    return !isBlockedIPv6(h);
  }

  return true;
}

export interface EndpointValidationResult {
  ok: boolean;
  reason?: string;
  resolvedIps?: string[];
}

/**
 * Complete remote endpoint validation:
 * 1. Checks URL scheme (HTTPS required unless allowLocalNetwork)
 * 2. Checks against embedded credentials
 * 3. Checks static hostname strings
 * 4. Resolves DNS at connection time to defeat DNS rebinding attacks
 */
export async function validateRemoteEndpoint(
  rawUrl: string,
  allowLocalNetwork = false,
  customLookup?: DnsLookupFn
): Promise<EndpointValidationResult> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Invalid MCP URL format: "${rawUrl}".` };
  }

  if (u.protocol !== "https:" && !allowLocalNetwork) {
    return { ok: false, reason: `Blocked MCP url "${rawUrl}" — HTTPS is required for remote servers.` };
  }

  if (u.username || u.password) {
    return { ok: false, reason: "Blocked MCP URL containing embedded user credentials." };
  }

  const hostname = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");

  if (!allowLocalNetwork && !isSafeRemoteHostname(hostname)) {
    return {
      ok: false,
      reason: `Blocked MCP hostname "${hostname}" targeting a local/private network address.`,
    };
  }

  if (allowLocalNetwork) {
    return { ok: true, resolvedIps: [hostname] };
  }

  // If already a raw IP literal and passed static check:
  if (/^[0-9.]+$/.test(hostname) || hostname.includes(":")) {
    return { ok: true, resolvedIps: [hostname] };
  }

  // DNS resolution check at connection time to prevent DNS rebinding
  try {
    const lookup = customLookup || (dns.lookup as unknown as DnsLookupFn);
    const records = await lookup(hostname, { all: true });
    if (!records || records.length === 0) {
      return { ok: false, reason: `Could not resolve hostname "${hostname}".` };
    }

    const resolvedIps = records.map((r) => r.address);
    for (const ip of resolvedIps) {
      if (isPrivateOrProhibitedIp(ip)) {
        return {
          ok: false,
          reason: `DNS rebinding protection blocked connection: host "${hostname}" resolved to prohibited private/local address "${ip}".`,
          resolvedIps,
        };
      }
    }

    return { ok: true, resolvedIps };
  } catch (err) {
    return {
      ok: false,
      reason: `DNS lookup failed for "${hostname}": ${(err as Error).message}`,
    };
  }
}

