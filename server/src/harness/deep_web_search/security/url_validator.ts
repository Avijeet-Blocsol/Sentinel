import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * ==========================================================
 * SENTINEL DEEP RESEARCH — SSRF & URL SECURITY VALIDATOR
 * ==========================================================
 * Enforces strict network boundaries, preventing Server-Side Request
 * Forgery (SSRF), DNS rebinding, private network access, and cloud
 * metadata service exfiltration (AWS/GCP/Azure IMDS 169.254.169.254).
 */

/**
 * Checks if an IPv4 address falls within private, loopback, link-local,
 * cloud metadata, or reserved ranges.
 */
export function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IPv4 is treated as unsafe
  }

  const [b0, b1, b2, b3] = parts;

  // 0.0.0.0/8 (Current network)
  if (b0 === 0) return true;

  // 10.0.0.0/8 (Private network)
  if (b0 === 10) return true;

  // 100.64.0.0/10 (Shared Address Space / CGNAT)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;

  // 169.254.0.0/16 (Link-Local & Cloud Metadata 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;

  // 172.16.0.0/12 (Private network)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;

  // 192.0.2.0/24 (TEST-NET-1)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;

  // 192.168.0.0/16 (Private network)
  if (b0 === 192 && b1 === 168) return true;

  // 198.18.0.0/15 (Benchmarking)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;

  // 198.51.100.0/24 (TEST-NET-2)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;

  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (b0 >= 224 && b0 <= 239) return true;

  // 240.0.0.0/4 (Reserved: 240.0.0.0 - 255.255.255.254)
  if (b0 >= 240) return true;

  // 255.255.255.255 (Broadcast)
  if (b0 === 255 && b1 === 255 && b2 === 255 && b3 === 255) return true;

  return false;
}

/**
 * Checks if an IPv6 address falls within loopback, unique-local, link-local,
 * multicast, or IPv4-mapped private ranges.
 */
export function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // Loopback ::1 or unspecified ::
  if (normalized === '::1' || normalized === '::') return true;

  // Check IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:hex)
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (net.isIPv4(mapped)) {
      return isPrivateOrReservedIpv4(mapped);
    }
  }

  // Unique local addresses (fc00::/7 -> fc00:: to fdff::)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // Link-local addresses (fe80::/10 -> fe80:: to febf::)
  if (/^fe[89ab]/i.test(normalized)) return true;

  // Multicast addresses (ff00::/8)
  if (normalized.startsWith('ff')) return true;

  // Documentation / discarded / benchmarking
  if (normalized.startsWith('2001:db8:') || normalized.startsWith('2001:10:')) return true;

  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return isPrivateOrReservedIpv4(ip);
  }
  if (net.isIPv6(ip)) {
    return isPrivateOrReservedIpv6(ip);
  }
  return true; // If not valid IP format, treat as unsafe
}

export interface UrlValidationResult {
  valid: boolean;
  canonicalUrl?: string;
  error?: string;
}

/**
 * Validates and canonicalizes a URL against strict scheme, credential,
 * port, and hostname rules.
 */
export function validateAndCanonicalizeUrl(
  rawUrl: string,
  options: {
    allowlistSchemes?: string[];
    allowedPorts?: number[];
    allowPrivateForTesting?: boolean;
  } = {}
): UrlValidationResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'URL is empty or not a string' };
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch (err: unknown) {
    return { valid: false, error: `Invalid URL format: ${trimmed.slice(0, 100)}` };
  }

  // 1. Enforce scheme allowlist (http and https only)
  const allowedSchemes = options.allowlistSchemes || ['http:', 'https:'];
  if (!allowedSchemes.includes(parsed.protocol.toLowerCase())) {
    return {
      valid: false,
      error: `Disallowed URL protocol: "${parsed.protocol}". Only HTTP/HTTPS is permitted.`,
    };
  }

  // 2. Reject embedded userinfo / credentials (e.g. http://admin:pass@host)
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'URLs containing embedded credentials/userinfo are prohibited.' };
  }

  // 3. Port restrictions (prevent probing internal services e.g. 6379, 27017, 22)
  const port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
  const standardPorts = options.allowedPorts || [80, 443, 8080, 8443, 3000, 5000, 8000];
  if (!options.allowPrivateForTesting && parsed.port && !standardPorts.includes(port)) {
    return { valid: false, error: `Disallowed port: ${port}. Only standard web ports are permitted.` };
  }

  // 4. Reject dangerous hostnames directly
  const hostname = parsed.hostname.toLowerCase();
  const rawIp = hostname.replace(/^\[|\]$/g, '');
  const isIp = net.isIP(rawIp);

  // Cloud metadata IMDS (169.254.169.254) is ALWAYS blocked, even with allowPrivateForTesting
  if (rawIp.startsWith('169.254.') || hostname.includes('metadata.google.internal')) {
    return { valid: false, error: `Target resolves to cloud metadata service: "${hostname}"` };
  }

  if (options.allowPrivateForTesting) {
    // In testing mode, only loopback (127.0.0.1, localhost, ::1) is permitted
    if (isIp && !rawIp.startsWith('127.') && rawIp !== '::1') {
      if (isPrivateIp(rawIp)) {
        return { valid: false, error: `Target resolves to private or metadata IP literal: "${hostname}"` };
      }
    }
  } else {
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.lan') ||
      hostname.endsWith('.corp') ||
      hostname.endsWith('.home') ||
      hostname.endsWith('.intranet') ||
      hostname.endsWith('.invalid')
    ) {
      return { valid: false, error: `Disallowed private/internal hostname: "${hostname}"` };
    }

    // 5. If hostname is a raw IP literal (handling IPv6 brackets like [::1]), check immediately
    if (isIp) {
      if (isPrivateIp(rawIp)) {
        return { valid: false, error: `Target resolves to private or metadata IP literal: "${hostname}"` };
      }
    }
  }

  // 6. Strip tracking params and hash fragments
  const trackingParams = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'msclkid', 'ref', 'ref_', 'tag'
  ];
  for (const param of trackingParams) {
    parsed.searchParams.delete(param);
  }
  parsed.hash = '';

  const clean = parsed.toString().replace(/\/$/, '');
  return { valid: true, canonicalUrl: clean };
}

/**
 * Safely resolves all DNS records for a hostname, verifying that none
 * resolve to private, loopback, link-local, or metadata IP ranges.
 */
export async function safeResolveDns(hostname: string): Promise<{
  safe: boolean;
  addresses: string[];
  error?: string;
}> {
  // If hostname is already a valid IP literal, validate directly
  const cleanHost = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(cleanHost)) {
    if (isPrivateIp(cleanHost)) {
      return { safe: false, addresses: [cleanHost], error: `IP ${cleanHost} is in a private or reserved range` };
    }
    return { safe: true, addresses: [cleanHost] };
  }

  try {
    const results = await dns.lookup(hostname, { all: true });
    if (!results || results.length === 0) {
      return { safe: false, addresses: [], error: `DNS lookup returned zero addresses for ${hostname}` };
    }

    const addresses = results.map((r) => r.address);
    for (const addr of addresses) {
      if (isPrivateIp(addr)) {
        return {
          safe: false,
          addresses,
          error: `DNS resolution for "${hostname}" resolved to blocked IP ${addr} (private/metadata range)`,
        };
      }
    }

    return { safe: true, addresses };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { safe: false, addresses: [], error: `DNS resolution failed for ${hostname}: ${msg}` };
  }
}

/**
 * Origin Verification:
 * Validates that candidate URLs proposed by an LLM agent strictly originate
 * from verified SERP search hits to eliminate hallucinated SSRF targets.
 */
export function verifyUrlOrigin(
  candidateUrl: string,
  verifiedSearchHitUrls: string[]
): { verified: boolean; error?: string } {
  if (!verifiedSearchHitUrls || verifiedSearchHitUrls.length === 0) {
    return { verified: false, error: 'No verified search hits available to corroborate candidate URL' };
  }

  const normCandidate = candidateUrl.trim().toLowerCase().replace(/\/$/, '');
  
  // Direct match or sanitized match
  const matches = verifiedSearchHitUrls.some((hitUrl) => {
    const normHit = hitUrl.trim().toLowerCase().replace(/\/$/, '');
    if (normCandidate === normHit) return true;
    try {
      const candParsed = new URL(normCandidate);
      const hitParsed = new URL(normHit);
      // Host and path prefix must match
      return candParsed.origin === hitParsed.origin && candParsed.pathname === hitParsed.pathname;
    } catch {
      return false;
    }
  });

  if (!matches) {
    return {
      verified: false,
      error: `Candidate URL "${candidateUrl}" was not found in verified search hits`,
    };
  }

  return { verified: true };
}

/**
 * Enforces strict domain boundary matching:
 * Matches if candidateDomain === preferredDomain OR candidateDomain ends with '.' + preferredDomain.
 * Prevents "notamazon.com" or "evilamazon.com" from matching "amazon.com".
 */
export function matchesDomainBoundary(candidateDomain: string, preferredDomain: string): boolean {
  if (!candidateDomain || !preferredDomain) return false;
  const cand = candidateDomain.trim().toLowerCase();
  const pref = preferredDomain.trim().toLowerCase();
  if (cand === pref) return true;
  return cand.endsWith('.' + pref);
}
