import * as dns from "node:dns/promises";

export type DnsLookupFn = (
  hostname: string,
  options?: { all?: boolean }
) => Promise<Array<{ address: string; family: number }>>;

/**
 * Checks whether an IPv4 address string falls within private, loopback,
 * link-local (cloud metadata), multicast, or reserved ranges per RFC 6890 / IANA.
 */
export function isBlockedIPv4(ip: string): boolean {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return true; // malformed treated as blocked

  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return true;

  const [b0, b1, b2, b3] = nums;

  // 0.0.0.0/8 (Current network / "this" network)
  if (b0 === 0) return true;
  // 10.0.0.0/8 (Private - RFC 1918)
  if (b0 === 10) return true;
  // 100.64.0.0/10 (Shared / Carrier-grade NAT - RFC 6598)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  // 127.0.0.0/8 (Loopback - RFC 1122)
  if (b0 === 127) return true;
  // 169.254.0.0/16 (Link-local / Cloud metadata: 169.254.169.254 - RFC 3927)
  if (b0 === 169 && b1 === 254) return true;
  // 172.16.0.0/12 (Private - RFC 1918)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments - RFC 6890)
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;
  // 192.0.2.0/24 (Documentation / TEST-NET-1 - RFC 5737)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;
  // 192.88.99.0/24 (6to4 Relay Anycast - RFC 7526)
  if (b0 === 192 && b1 === 88 && b2 === 99) return true;
  // 192.168.0.0/16 (Private - RFC 1918)
  if (b0 === 192 && b1 === 168) return true;
  // 198.18.0.0/15 (Benchmarking - RFC 2544)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  // 198.51.100.0/24 (Documentation / TEST-NET-2 - RFC 5737)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;
  // 203.0.113.0/24 (Documentation / TEST-NET-3 - RFC 5737)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;
  // 224.0.0.0/4 (Multicast - RFC 5771)
  if (b0 >= 224 && b0 <= 239) return true;
  // 240.0.0.0/4 (Reserved / Future use - RFC 1112)
  if (b0 >= 240) return true;
  // 255.255.255.255/32 (Broadcast - RFC 919)
  if (b0 === 255 && b1 === 255 && b2 === 255 && b3 === 255) return true;

  return false;
}

/**
 * Parses an IPv6 address string into an array of 8 16-bit words.
 * Handles zone identifiers (%eth0), brackets, compression (::),
 * and IPv4-mapped suffixes (::ffff:192.0.2.1).
 */
export function parseIPv6Words(ip: string): number[] | null {
  let clean = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zone = clean.indexOf("%");
  if (zone !== -1) clean = clean.slice(0, zone);

  // Handle embedded IPv4 suffix (e.g. ::ffff:192.0.2.1 or ::192.0.2.1)
  const v4Match = clean.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const v4Parts = v4Match[2].split(".").map((x) => parseInt(x, 10));
    if (v4Parts.length !== 4 || v4Parts.some((n) => isNaN(n) || n < 0 || n > 255)) {
      return null;
    }
    const high = (v4Parts[0] << 8) | v4Parts[1];
    const low = (v4Parts[2] << 8) | v4Parts[3];
    clean = `${v4Match[1]}${high.toString(16)}:${low.toString(16)}`;
  }

  const parts = clean.split("::");
  if (parts.length > 2) return null; // multiple "::" is invalid

  let words: number[] = [];
  if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts[1] ? parts[1].split(":") : [];
    if (left.length + right.length > 7) return null;
    const zeros = 8 - left.length - right.length;
    words = [
      ...left.map((w) => parseInt(w, 16)),
      ...new Array(zeros).fill(0),
      ...right.map((w) => parseInt(w, 16)),
    ];
  } else {
    const rawWords = clean.split(":");
    if (rawWords.length !== 8) return null;
    words = rawWords.map((w) => parseInt(w, 16));
  }

  if (words.some((w) => isNaN(w) || w < 0 || w > 0xffff)) return null;
  return words;
}

/**
 * Checks whether an IPv6 address string falls within loopback, unspecified,
 * unique local (private), link-local, multicast, IPv4-mapped private ranges,
 * or documentation/reserved prefixes.
 */
export function isBlockedIPv6(ip: string): boolean {
  const words = parseIPv6Words(ip);
  if (!words) return true; // malformed treated as blocked

  // ::/128 (Unspecified)
  if (words.every((w) => w === 0)) return true;

  // ::1/128 (Loopback)
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;

  // ::ffff:0:0/96 (IPv4-mapped IPv6)
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    return isBlockedIPv4(`${b0}.${b1}.${b2}.${b3}`);
  }

  // ::/96 (IPv4-compatible IPv6 - deprecated RFC 4291)
  if (words.slice(0, 6).every((w) => w === 0) && words[7] > 1) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    return isBlockedIPv4(`${b0}.${b1}.${b2}.${b3}`);
  }

  // 64:ff9b::/96 (IPv4/IPv6 translation - RFC 6052)
  if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    return isBlockedIPv4(`${b0}.${b1}.${b2}.${b3}`);
  }

  // 100::/64 (Discard prefix - RFC 6666)
  if (words[0] === 0x0100 && words.slice(1, 4).every((w) => w === 0)) return true;

  // 2001:db8::/32 (Documentation - RFC 3849)
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;

  // 2002::/16 (6to4 - RFC 3056)
  if (words[0] === 0x2002) return true;

  // fc00::/7 (Unique Local Address - Private network - RFC 4193)
  if ((words[0] & 0xfe00) === 0xfc00) return true;

  // fe80::/10 (Link-Local unicast - RFC 4291)
  if ((words[0] & 0xffc0) === 0xfe80) return true;

  // ff00::/8 (Multicast - RFC 4291)
  if ((words[0] & 0xff00) === 0xff00) return true;

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
 * Strips trailing dots, handles brackets and known private/local TLDs.
 */
export function isSafeRemoteHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");

  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".invalid") ||
    h.endsWith(".test") ||
    h.endsWith(".corp") ||
    h.endsWith(".home") ||
    h.endsWith(".lan")
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
 * 3. Checks static hostname strings and unusual encodings
 * 4. Resolves DNS at connection time to defeat DNS rebinding attacks
 * 5. Strictly rejects mixed DNS answers containing ANY prohibited address
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

  const hostname = u.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");

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
    // Reject mixed DNS answers: if ANY resolved IP is prohibited, fail closed!
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
