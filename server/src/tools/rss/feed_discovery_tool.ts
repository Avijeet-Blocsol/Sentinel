import * as cheerio from 'cheerio';
import { search, SafeSearchType } from 'duck-duck-scrape';
import { safeFetch } from '../../harness/deep_web_search/security/safe_fetch.js';
import { ProviderError } from '../../harness/rss/types.js';

export interface DiscoveredFeed {
  feedUrl: string;
  title?: string;
  type: string;
}

export interface DiscoverFeedOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  allowPrivateForTesting?: boolean;
}

/**
 * Parses HTML content looking for standard RSS/Atom auto-discovery <link> tags in <head>.
 */
export function sniffHtmlFeedLinks(htmlContent: string, baseUrl: string): DiscoveredFeed[] {
  const $ = cheerio.load(htmlContent);
  const discovered: DiscoveredFeed[] = [];

  $('link[rel="alternate"]').each((_, el) => {
    const link = $(el);
    const type = (link.attr('type') || '').toLowerCase().trim();
    const href = link.attr('href');

    if (!href) return;

    const isRss =
      type === 'application/rss+xml' ||
      type === 'application/atom+xml' ||
      type === 'application/feed+json' ||
      type === 'text/xml' ||
      type === 'application/xml';

    if (isRss) {
      try {
        const absoluteUrl = new URL(href, baseUrl).href;
        discovered.push({
          feedUrl: absoluteUrl,
          title: link.attr('title') || undefined,
          type: type || 'application/rss+xml',
        });
      } catch {
        // Invalid URL format, skip
      }
    }
  });

  return discovered;
}

/**
 * Fetches an HTML page and extracts auto-discovered feed endpoints.
 * Also probes common feed paths if no link headers exist.
 */
export async function discoverFeedFromUrl(
  pageUrl: string,
  optionsOrTimeout: number | DiscoverFeedOptions = 8000
): Promise<DiscoveredFeed[]> {
  const options: DiscoverFeedOptions =
    typeof optionsOrTimeout === 'number'
      ? { timeoutMs: optionsOrTimeout }
      : optionsOrTimeout || {};

  const timeoutMs = options.timeoutMs ?? 8000;

  if (options.signal?.aborted) {
    throw options.signal.reason || new Error('Discovery aborted');
  }

  try {
    const res = await safeFetch(pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Sentinel-RSS-Scout/1.0 (+https://sentinel.blocsol.com)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: options.signal,
      timeoutMs,
      allowPrivateForTesting: options.allowPrivateForTesting,
    });

    if (!res.ok) {
      throw new ProviderError(
        'FEED_DISCOVERY',
        res.status,
        `HTTP ${res.status} ${res.statusText || 'Error'} from ${pageUrl}`
      );
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const body = await res.text();

    // If the URL is already an XML or RSS/Atom response directly
    if (
      contentType.includes('xml') ||
      contentType.includes('rss') ||
      contentType.includes('atom') ||
      body.trim().startsWith('<?xml') ||
      body.trim().startsWith('<rss') ||
      body.trim().startsWith('<feed')
    ) {
      return [
        {
          feedUrl: res.finalUrl || pageUrl,
          title: 'Direct Feed URL',
          type: contentType || 'application/xml',
        },
      ];
    }

    // Sniff <head> for link tags
    const sniffed = sniffHtmlFeedLinks(body, res.finalUrl || pageUrl);
    if (sniffed.length > 0) return sniffed;

    // Probe common standard feed path conventions
    const candidatePaths = ['/feed', '/rss.xml', '/feed.xml', '/atom.xml'];
    for (const path of candidatePaths) {
      if (options.signal?.aborted) {
        throw options.signal.reason || new Error('Discovery aborted');
      }

      try {
        const candidateUrl = new URL(path, res.finalUrl || pageUrl).href;
        const probeRes = await safeFetch(candidateUrl, {
          method: 'HEAD',
          headers: {
            'User-Agent': 'Mozilla/5.0 Sentinel-RSS-Scout/1.0',
          },
          signal: options.signal,
          timeoutMs: Math.min(timeoutMs, 3000),
          allowPrivateForTesting: options.allowPrivateForTesting,
        });

        if (probeRes.ok) {
          const probeType = (probeRes.headers.get('content-type') || '').toLowerCase();
          if (probeType.includes('xml') || probeType.includes('rss') || probeType.includes('atom')) {
            return [
              {
                feedUrl: probeRes.finalUrl || candidateUrl,
                title: `${path} endpoint`,
                type: probeType,
              },
            ];
          }
        }
      } catch {
        // Ignore individual probe error
      }
    }

    return [];
  } catch (err: unknown) {
    if (options.signal?.aborted) {
      throw options.signal.reason || new Error('Discovery aborted');
    }
    if (err instanceof ProviderError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProviderError('FEED_DISCOVERY', undefined, msg, err);
  }
}

/**
 * Searches the web for RSS feeds when an unknown brand or entity is requested.
 */
export async function searchFeedsViaWeb(
  query: string,
  maxResults = 5,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<Array<{ url: string; title: string; snippet: string }>> {
  if (options?.signal?.aborted) {
    throw options.signal.reason || new Error('Search aborted');
  }

  const timeoutMs = options?.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options?.signal) {
    options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
  }

  try {
    const searchPromise = search(`${query} (rss OR atom OR feed OR xml)`, {
      safeSearch: SafeSearchType.MODERATE,
    });

    const searchResult = await Promise.race([
      searchPromise,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            reject(controller.signal.reason || new Error(`Web search timed out after ${timeoutMs}ms`));
          },
          { once: true }
        );
      }),
    ]);

    if (!searchResult.results || searchResult.results.length === 0) {
      return [];
    }

    return searchResult.results.slice(0, maxResults).map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.description || '',
    }));
  } catch (err: unknown) {
    if (options?.signal?.aborted) {
      throw options.signal.reason || new Error('Search aborted');
    }
    if (err instanceof ProviderError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProviderError('WEB_SEARCH', undefined, msg, err);
  } finally {
    clearTimeout(timer);
  }
}
