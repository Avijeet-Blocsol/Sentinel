import { validateAndCanonicalizeUrl, safeResolveDns } from './url_validator.js';
import net from 'node:net';
import { Agent as UndiciAgent } from 'undici';

/**
 * ==========================================================
 * SENTINEL DEEP RESEARCH — SSRF-SAFE HTTP CLIENT
 * ==========================================================
 * High-security fetch wrapper enforcing:
 * - Scheme, credential, and port validation
 * - Safe DNS pre-flight checking (rejection of private/cloud metadata IPs)
 * - Strict redirect interception (every redirect hop is re-validated)
 * - Composite per-request timeout covering both connection and body read
 */

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  allowPrivateForTesting?: boolean; // Only for local unit tests against localhost
}

export interface SafeFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  finalUrl: string;
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
}

export async function safeFetch(
  targetUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResponse> {
  const timeoutMs = options.timeoutMs ?? 9000;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxResponseBytes = options.maxResponseBytes ?? 5 * 1024 * 1024; // 5 MB default
  let currentUrl = targetUrl;
  let redirectCount = 0;
  let dispatcher: UndiciAgent | undefined;

  // Composite signal controller for the overall request + body read
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`safeFetch timed out after ${timeoutMs}ms for ${targetUrl}`));
  }, timeoutMs);
  timer.unref?.();

  let responseHandled = false;
  let onAbort: (() => void) | undefined;
  const cleanupTimer = () => {
    clearTimeout(timer);
    if (options.signal && onAbort) {
      options.signal.removeEventListener('abort', onAbort);
      onAbort = undefined;
    }
  };

  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      onAbort = () => controller.abort(options.signal?.reason);
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    while (redirectCount <= maxRedirects) {
      if (controller.signal.aborted) {
        throw controller.signal.reason || new Error('Request aborted');
      }

      // 1. Validate & canonicalize URL
      const urlValidation = validateAndCanonicalizeUrl(currentUrl, {
        allowPrivateForTesting: options.allowPrivateForTesting,
      });
      if (!urlValidation.valid) {
        throw new Error(`[SSRF Guard] Blocked unsafe URL: ${urlValidation.error}`);
      }
      currentUrl = urlValidation.canonicalUrl!;
      const parsed = new URL(currentUrl);

      // 2. Pre-flight DNS & IP check (unless explicitly testing on localhost)
      if (!options.allowPrivateForTesting) {
        const dnsCheck = await safeResolveDns(parsed.hostname);
        if (!dnsCheck.safe) {
          throw new Error(`[SSRF Guard] Blocked host "${parsed.hostname}": ${dnsCheck.error}`);
        }
        dispatcher = new UndiciAgent({
          connect: {
            lookup: (_hostname: string, _options: unknown, callback: (error: Error | null, address?: string, family?: number) => void) => {
              const address = dnsCheck.addresses[0];
              callback(null, address, net.isIP(address) === 6 ? 6 : 4);
            },
          },
        } as any);
      }

      // 3. Fetch with manual redirect control
      const response = await (fetch as any)(currentUrl, {
        method: options.method || 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
          ...(options.headers || {}),
        },
        body: options.body,
        signal: controller.signal,
        redirect: 'manual',
        ...(dispatcher ? { dispatcher } : {}),
      });

      // 4. Handle redirects safely
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`HTTP ${response.status} redirect received without Location header`);
        }
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new Error(`Exceeded maximum allowed redirects (${maxRedirects})`);
        }
        try { await response.body?.cancel(); } catch {}
        // Resolve relative redirects
        currentUrl = new URL(location, currentUrl).toString();
        await dispatcher?.close();
        dispatcher = undefined;
        continue;
      }

      // 5. Successful or terminal status - wrap body readers with timeout & size cap protection
      responseHandled = true;

      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const cl = parseInt(contentLengthHeader, 10);
        if (!isNaN(cl) && cl > maxResponseBytes) {
          throw new Error(`[SSRF Guard] Response body size ${cl} bytes exceeds limit of ${maxResponseBytes} bytes`);
        }
      }

      const readLimitedBody = async (): Promise<string> => {
        try {
          if (!response.body) {
            return await response.text();
          }

          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                totalBytes += value.length;
                if (totalBytes > maxResponseBytes) {
                  try {
                    await reader.cancel();
                  } catch {}
                  throw new Error(`[SSRF Guard] Response body size exceeded limit of ${maxResponseBytes} bytes`);
                }
                chunks.push(value);
              }
            }
          } catch (err) {
            if (controller.signal.aborted) {
              throw controller.signal.reason || new Error(`Response body read timed out after ${timeoutMs}ms`);
            }
            throw err;
          }

          const merged = new Uint8Array(totalBytes);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
          }
          return new TextDecoder('utf-8').decode(merged);
        } finally {
          cleanupTimer();
          void dispatcher?.close();
          dispatcher = undefined;
        }
      };

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        finalUrl: currentUrl,
        text: async () => {
          return await readLimitedBody();
        },
        json: async <T = unknown>() => {
          const raw = await readLimitedBody();
          return JSON.parse(raw) as T;
        },
      };
    }

    throw new Error(`Exceeded maximum allowed redirects (${maxRedirects})`);
  } catch (err: unknown) {
    if (dispatcher) await dispatcher.close().catch(() => undefined);
    cleanupTimer();
    throw err;
  } finally {
    if (!responseHandled) {
      cleanupTimer();
    }
  }
}
