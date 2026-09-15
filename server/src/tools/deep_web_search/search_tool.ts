import 'dotenv/config';
import { z } from 'zod';
import * as cheerio from 'cheerio';
import { tool } from '@strands-agents/sdk';
import type { ToolContext } from '@strands-agents/sdk';
import type { ResearchTelemetryEvent } from '../../harness/deep_web_search/types.js';

/**
 * ==========================================================
 * SENTINEL DEEP RESEARCH — RESILIENT SEARCH ENGINE
 * ==========================================================
 * Multi-provider search retrieval with Brave -> Tavily -> Cheerio DDG failover,
 * structured provider error tracking, user constraints enforcement,
 * and URL sanitization.
 */

// ==========================================================
// 1. Data Contracts & Interfaces
// ==========================================================

export interface SearchHit {
  url: string;
  domain: string;
  siteName: string;
  title: string;
  snippet: string;
}

export interface ProviderError {
  provider: 'brave' | 'tavily' | 'cheerio_ddg';
  error: string;
}

export interface SearchExecutionResult {
  hits: SearchHit[];
  providerErrors: ProviderError[];
  timedOut: boolean;
  allProvidersFailed: boolean;
}

export interface SearchExecutionOptions {
  userConstraints?: string[];
  maxResults?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// ==========================================================
// 2. URL & Domain Utilities
// ==========================================================

/**
 * Removes tracking parameters (utm_*, ref, fbclid) and standardizes URL.
 */
export function sanitizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'msclkid', 'ref', 'ref_', 'tag'
    ];
    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }
    parsed.hash = '';
    const clean = parsed.toString().replace(/\/$/, '');
    return clean;
  } catch {
    return rawUrl.trim();
  }
}

/**
 * Extracts a clean root domain from any URL string.
 */
export function extractDomain(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return rawUrl.toLowerCase().trim();
  }
}

/**
 * Extracts clean, human-readable brand/site name from a domain.
 */
export function extractSiteName(domain: string): string {
  const parts = domain.split('.');
  if (parts.length >= 3) {
    if (parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3) {
      return (parts[parts.length - 3] || parts[0]).toUpperCase();
    }
    return parts[parts.length - 2].toUpperCase();
  }
  return parts[0].toUpperCase();
}

/**
 * Creates a composite AbortSignal combining caller's cancelSignal and an execution timeout.
 */
function createCompositeSignal(callerSignal?: AbortSignal, timeoutMs = 9000): { signal: AbortSignal; cleanup: () => void; isTimedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Search request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
    isTimedOut: () => timedOut,
  };
}

// ==========================================================
// 3. Resilient Search Providers (Brave -> Tavily -> Cheerio DDG)
// ==========================================================

interface BraveSearchResultItem {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResultItem[];
  };
}

interface TavilySearchResultItem {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilySearchResponse {
  results?: TavilySearchResultItem[];
}

async function fetchBrave(query: string, apiKey: string, count: number, signal: AbortSignal) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    signal,
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Brave Search HTTP ${res.status}: ${errorBody.slice(0, 200)}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  return (data.web?.results || []).map((r) => ({
    title: String(r.title || '').trim(),
    url: String(r.url || '').trim(),
    snippet: String(r.description || '').trim(),
  }));
}

async function fetchTavily(query: string, apiKey: string, count: number, signal: AbortSignal) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: count,
      search_depth: 'basic',
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Tavily Search HTTP ${res.status}: ${errorBody.slice(0, 200)}`);
  }

  const data = (await res.json()) as TavilySearchResponse;
  return (data.results || []).map((r) => ({
    title: String(r.title || '').trim(),
    url: String(r.url || '').trim(),
    snippet: String(r.content || '').trim(),
  }));
}

async function fetchCheerioFallback(query: string, signal: AbortSignal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo HTML HTTP ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const hits: Array<{ title: string; url: string; snippet: string }> = [];

  $('.result').each((_, el) => {
    const titleEl = $(el).find('.result__title a');
    const snippetEl = $(el).find('.result__snippet');
    const rawHref = titleEl.attr('href') || '';

    let finalUrl = rawHref;
    if (rawHref.includes('uddg=')) {
      try {
        const u = new URL('https://duckduckgo.com' + rawHref);
        const target = u.searchParams.get('uddg');
        if (target) finalUrl = decodeURIComponent(target);
      } catch {
        finalUrl = rawHref;
      }
    }

    const title = titleEl.text().trim();
    const snippet = snippetEl.text().trim();

    if (finalUrl && finalUrl.startsWith('http') && title) {
      hits.push({ title, url: finalUrl, snippet });
    }
  });

  return hits;
}

// ==========================================================
// 4. Standalone Retrieval Engine (Structured Result & Error Tracking)
// ==========================================================

/**
 * Executes web search with automatic provider failover, timeout protection,
 * user constraints enforcement, and structured provider error reporting.
 */
export async function executeWebSearch(
  query: string,
  visitedUrls: Set<string> = new Set(),
  options: SearchExecutionOptions = {}
): Promise<SearchExecutionResult> {
  const maxResults = options.maxResults ?? 8;
  const timeoutMs = options.timeoutMs ?? 9000;
  const { signal, cleanup, isTimedOut } = createCompositeSignal(options.signal, timeoutMs);

  const braveKey = process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  const tavilyKey = process.env.TAVILY_SEARCH_API_KEY || process.env.TAVILY_API_KEY;

  const providerErrors: ProviderError[] = [];
  let rawResults: Array<{ title: string; url: string; snippet: string }> = [];
  let attemptedProviderCount = 0;

  try {
    // Tier 1: Try Brave
    if (braveKey && !signal.aborted) {
      attemptedProviderCount++;
      try {
        rawResults = await fetchBrave(query, braveKey, maxResults * 2, signal);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        providerErrors.push({ provider: 'brave', error: msg });
        console.warn(`[search_tool] Brave API failed (${msg}), attempting secondary provider...`);
      }
    }

    // Tier 2: Try Tavily
    if (rawResults.length === 0 && tavilyKey && !signal.aborted) {
      attemptedProviderCount++;
      try {
        rawResults = await fetchTavily(query, tavilyKey, maxResults * 2, signal);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        providerErrors.push({ provider: 'tavily', error: msg });
        console.warn(`[search_tool] Tavily API failed (${msg}), falling back to Cheerio...`);
      }
    }

    // Tier 3: Cheerio HTML fallback
    if (rawResults.length === 0 && !signal.aborted) {
      attemptedProviderCount++;
      try {
        rawResults = await fetchCheerioFallback(query, signal);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        providerErrors.push({ provider: 'cheerio_ddg', error: msg });
        console.error(`[search_tool] Cheerio search failed for query "${query}": ${msg}`);
      }
    }
  } finally {
    cleanup();
  }

  const allProvidersFailed = attemptedProviderCount > 0 && providerErrors.length === attemptedProviderCount;

  // Enforce user constraints (exclusions e.g. "exclude ebay")
  const userConstraints = (options.userConstraints || []).map((c) =>
    c.toLowerCase().replace(/^exclude\s+/i, '').trim()
  );

  const cleanHits: SearchHit[] = [];

  for (const item of rawResults) {
    if (!item.url) continue;

    const cleanUrl = sanitizeUrl(item.url);
    if (visitedUrls.has(cleanUrl)) continue;

    const domain = extractDomain(cleanUrl);

    // Hard exclusions
    if (userConstraints.some((exc) => exc && (domain.includes(exc) || item.title.toLowerCase().includes(exc)))) {
      continue;
    }

    visitedUrls.add(cleanUrl);

    cleanHits.push({
      url: cleanUrl,
      domain,
      siteName: extractSiteName(domain),
      title: item.title,
      snippet: item.snippet,
    });

    if (cleanHits.length >= maxResults) {
      break;
    }
  }

  return {
    hits: cleanHits,
    providerErrors,
    timedOut: isTimedOut(),
    allProvidersFailed,
  };
}

// ==========================================================
// 5. Official Strands SDK Tool Definition
// ==========================================================

export const webSearchTool = tool({
  name: 'web_search',
  description: 'Searches the web for websites, stores, and portals matching a specific observation query.',
  inputSchema: z.object({
    query: z
      .string()
      .min(2, 'Search query must be at least 2 characters')
      .describe('The exact search query (e.g. "Sapphire Pulse Radeon 7900 price Scan UK")'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(8)
      .describe('Maximum number of distinct candidate URLs to retrieve'),
    userConstraints: z.array(z.string()).optional().describe('Exclusion constraints or filters'),
  }),
  callback: async function* (
    input: { query: string; maxResults?: number; userConstraints?: string[] },
    context?: ToolContext
  ): AsyncGenerator<ResearchTelemetryEvent, SearchHit[], unknown> {
    const maxResults = input.maxResults ?? 8;
    const taskId = (context?.invocationState?.taskId as string) || 'task-auto';
    const toolUseId = context?.toolUse?.toolUseId;

    let visitedUrls: Set<string>;
    if (context?.invocationState?.visitedUrls instanceof Set) {
      visitedUrls = context.invocationState.visitedUrls as Set<string>;
    } else {
      visitedUrls = new Set<string>();
      if (context?.invocationState) {
        context.invocationState.visitedUrls = visitedUrls;
      }
    }

    // Combine constraints from input and invocationState
    const stateConstraints = (context?.invocationState?.userConstraints as string[]) || [];
    const constraints = [...stateConstraints, ...(input.userConstraints || [])];

    yield {
      taskId,
      step: 'SCOUTING_SERP',
      message: `Searching web sources for "${input.query}"...`,
      data: { query: input.query, toolUseId },
      timestamp: Date.now(),
    };

    const result = await executeWebSearch(input.query, visitedUrls, {
      maxResults,
      userConstraints: constraints,
      signal: context?.cancelSignal,
      timeoutMs: 9000,
    });

    yield {
      taskId,
      step: 'CANDIDATES_FOUND',
      message: `Discovered ${result.hits.length} candidate sources for evaluation.`,
      data: {
        query: input.query,
        count: result.hits.length,
        domains: result.hits.map((h) => h.domain),
        siteNames: result.hits.map((h) => h.siteName),
        providerErrors: result.providerErrors,
        toolUseId,
      },
      timestamp: Date.now(),
    };

    return result.hits;
  },
});
