import 'dotenv/config';
import net from 'node:net';
import { z } from 'zod';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { tool } from '@strands-agents/sdk';
import type { ToolContext } from '@strands-agents/sdk';
import {
  TargetDataKindEnum,
  type SiteDossier,
  type DeepResearchTask,
  type ScrapingTier,
  type ResearchTelemetryEvent,
  type SelectorExecutionDiagnostics,
  type TargetDataKind,
} from '../../harness/deep_web_search/types.js';
import { safeFetch } from '../../harness/deep_web_search/security/safe_fetch.js';
import { isPrivateIp, safeResolveDns, validateAndCanonicalizeUrl } from '../../harness/deep_web_search/security/url_validator.js';
import {
  extractSemanticQueryFields,
  type PageStateSemanticFields,
} from '../../agent/structured_query_agent.js';

/**
 * ==========================================================
 * SENTINEL DEEP RESEARCH — HARDENED SCRAPING & INSPECTION TOOL
 * ==========================================================
 * Provides multi-tier DOM condensation, AI selector extraction,
 * deterministic decoy/placeholder filtering, SSRF protection,
 * and sandboxed Playwright fallback.
 */

// ==========================================================
// 1. Data Contracts & Interfaces
// ==========================================================

export interface DomCandidate {
  tag: string;
  text: string;
  id?: string;
  testId?: string;
  itemprop?: string;
  classes: string[];
  suggestedSelector: string;
  contextHint?: string; // "live-candidate" | "was-price-strikethrough" | "financing-installment" | "in-stock-badge" | "json-ld-microdata"
}

export interface CondensedDomContext {
  url: string;
  domain: string;
  siteName: string;
  scrapingTierUsed: ScrapingTier;
  isAccessible: boolean;
  requiresDynamicHydration?: boolean;
  schemaMicrodata?: Record<string, unknown> | null;
  frameworkEmbeddedState?: Record<string, unknown> | null;
  condensedHtml: string;
  candidates: DomCandidate[];
  rejectionReason?: string;
}

export interface BrowserLaunchTracker {
  count: number;
  max: number;
}

export interface ScraperOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  enableHeadlessFallback?: boolean;
  targetDataKind?: TargetDataKind;
  userConstraints?: string[];
  allowPrivateForTesting?: boolean;
  browserLaunchTracker?: BrowserLaunchTracker;
}

// Lightweight interfaces for optional dynamic Playwright loading
interface PlaywrightBrowser {
  newContext: (options?: Record<string, unknown>) => Promise<PlaywrightContext>;
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
}

interface PlaywrightContext {
  newPage: () => Promise<PlaywrightPage>;
}

interface PlaywrightPage {
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<unknown>;
  waitForLoadState: (state?: 'load' | 'domcontentloaded' | 'networkidle', options?: { timeout?: number }) => Promise<unknown>;
  waitForSelector: (selector: string, options?: { state?: 'attached' | 'visible'; timeout?: number }) => Promise<unknown>;
  waitForFunction: (fn: () => boolean, options?: { timeout?: number }) => Promise<unknown>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  $eval: <T>(selector: string, fn: (el: { textContent: string | null; classList?: Iterable<string>; parentElement?: { textContent: string | null } | null }) => T) => Promise<T>;
  $$eval: <T>(selector: string, fn: (els: Array<{ textContent: string | null }>) => T) => Promise<T>;
  route: (url: string, handler: (route: { request: () => { url: () => string }; abort: (reason?: string) => Promise<void>; continue: () => Promise<void> }) => Promise<void> | void) => Promise<void>;
}

interface PlaywrightModule {
  chromium: {
    launch: (options?: Record<string, unknown>) => Promise<PlaywrightBrowser>;
  };
}

/**
 * Attaches SSRF route guard to Playwright page without blocking normal public domains.
 */
export async function attachSsrfRouteGuard(
  page: PlaywrightPage,
  allowPrivateForTesting?: boolean
): Promise<void> {
  if (allowPrivateForTesting) return;

  await page.route('**/*', async (route) => {
    try {
      const reqUrl = new URL(route.request().url());
      const rawProtocol = reqUrl.protocol.toLowerCase();
      if (rawProtocol === 'data:' || rawProtocol === 'blob:') {
        await route.continue();
        return;
      }
      if (rawProtocol !== 'http:' && rawProtocol !== 'https:') {
        await route.abort('blockedbyclient');
        return;
      }

      const validation = validateAndCanonicalizeUrl(reqUrl.toString());
      if (!validation.valid) {
        await route.abort('blockedbyclient');
        return;
      }

      const reqHostname = reqUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();

      // If it is an IP literal
      if (net.isIP(reqHostname)) {
        if (isPrivateIp(reqHostname)) {
          await route.abort('accessdenied');
          return;
        }
        await route.continue();
        return;
      }

      // Check dangerous local/internal hostnames
      if (
        reqHostname === 'localhost' ||
        reqHostname.endsWith('.localhost') ||
        reqHostname.endsWith('.local') ||
        reqHostname.endsWith('.internal') ||
        reqHostname.endsWith('.lan') ||
        reqHostname.endsWith('.corp') ||
        reqHostname.endsWith('.home') ||
        reqHostname.endsWith('.intranet') ||
        reqHostname.endsWith('.invalid')
      ) {
        await route.abort('accessdenied');
        return;
      }

      // Revalidate every browser request. A process-global boolean cache can
      // become stale and allow DNS rebinding after a hostname changes.
      const dnsCheck = await safeResolveDns(reqHostname);
      const isSafe = dnsCheck.safe;

      if (!isSafe) {
        await route.abort('accessdenied');
        return;
      }
    } catch {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}

// ==========================================================
// 2. Anti-Bot & Value Extraction Heuristics
// ==========================================================

export function isBotBlocked(html: string, statusCode?: number): boolean {
  if (statusCode === 403 || statusCode === 429 || statusCode === 503) return true;
  const lower = html.toLowerCase();
  return (
    lower.includes('cf-browser-verification') ||
    lower.includes('challenge-running') ||
    lower.includes('cloudflare turnstile') ||
    lower.includes('just a moment...') ||
    lower.includes('access denied') ||
    lower.includes('pardon our interruption') ||
    lower.includes('please verify you are a human') ||
    lower.includes('perimeterx') ||
    lower.includes('datadome')
  );
}

export function isHydrationPending(candidates: DomCandidate[], html: string): boolean {
  if (candidates.length > 0) {
    const validDataCandidates = candidates.filter((c) => {
      const lower = c.text.toLowerCase();
      const isPlaceholder =
        lower === 'loading...' ||
        lower === 'loading' ||
        lower === 'checking...' ||
        lower === 'checking availability' ||
        lower.includes('skeleton') ||
        lower === '--' ||
        lower === '$--.--' ||
        c.classes.some((cls) => /skeleton|shimmer|placeholder|loading-spinner/i.test(cls));
      return !isPlaceholder;
    });

    if (validDataCandidates.length === 0) {
      return true;
    }
  }

  const lowerHtml = html.toLowerCase();
  const hasSpaRoot =
    lowerHtml.includes('id="__next"') ||
    lowerHtml.includes('id="root"') ||
    lowerHtml.includes('id="app"') ||
    lowerHtml.includes('id="__nuxt"');

  if (hasSpaRoot && candidates.length === 0) {
    return true;
  }

  return false;
}

/**
 * Normalizes raw string data extracted by a CSS selector into a clean primitive.
 * Strict numeric enforcement: For PRICE and NUMERIC_METRIC, finite numbers are REQUIRED.
 */
export function normalizeValue(
  rawText: string,
  kind: TargetDataKind,
  allowedVocabulary?: string[]
): {
  normalized: string | number | null;
  regex: string;
  isValid: boolean;
  error?: string;
} {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    return { normalized: null, regex: '', isValid: false, error: 'Empty text value' };
  }

  switch (kind) {
    case 'PRICE': {
      // Must contain a numeric price (e.g. "$1,799.00" -> 1799.00)
      const match = trimmed.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
      const parsed = match ? parseFloat(match[0]) : NaN;
      if (isNaN(parsed) || !Number.isFinite(parsed)) {
        return {
          normalized: null,
          regex: '[\\d,]+\\.?\\d*',
          isValid: false,
          error: `Expected numeric price, received non-numeric text: "${trimmed}"`,
        };
      }
      return {
        normalized: parsed,
        regex: '[\\d,]+\\.?\\d*',
        isValid: true,
      };
    }

    case 'NUMERIC_METRIC': {
      const match = trimmed.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
      const parsed = match ? parseFloat(match[0]) : NaN;
      if (isNaN(parsed) || !Number.isFinite(parsed)) {
        return {
          normalized: null,
          regex: '-?[\\d,]+\\.?\\d*',
          isValid: false,
          error: `Expected numeric metric, received non-numeric text: "${trimmed}"`,
        };
      }
      return {
        normalized: parsed,
        regex: '-?[\\d,]+\\.?\\d*',
        isValid: true,
      };
    }

    case 'CATEGORICAL': {
      // Standardize stock and availability states or check user-specified allowed vocabulary
      const upper = trimmed.toUpperCase();
      if (/in\s*stock|available|order\s*now|buy\s*now/i.test(trimmed)) {
        return { normalized: 'IN_STOCK', regex: '(in\\s*stock|available)', isValid: true };
      }
      if (/out\s*of\s*stock|sold\s*out|backorder|pre-order|unavailable/i.test(trimmed)) {
        return { normalized: 'OUT_OF_STOCK', regex: '(out\\s*of\\s*stock|sold\\s*out)', isValid: true };
      }

      if (allowedVocabulary && allowedVocabulary.length > 0) {
        const found = allowedVocabulary.find((vocab) => vocab.toUpperCase() === upper);
        if (found) {
          return { normalized: found, regex: `^${escapeRegex(found)}$`, isValid: true };
        }
        return {
          normalized: null,
          regex: `^${escapeRegex(trimmed)}$`,
          isValid: false,
          error: `Categorical state "${trimmed}" not found in allowed vocabulary [${allowedVocabulary.join(', ')}]`,
        };
      }

      return { normalized: trimmed, regex: `^${escapeRegex(trimmed)}$`, isValid: true };
    }

    case 'TEXT_MATCH':
    case 'GENERAL_INFO':
    default:
      return { normalized: trimmed, regex: escapeRegex(trimmed), isValid: true };
  }
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shared Deterministic Candidate Evaluation:
 * Shared identically between Cheerio and Playwright paths to reject
 * decoy/strikethrough prices, installment traps, and unhydrated skeletons.
 */
export function evaluateElementCandidate(params: {
  rawText: string;
  classes?: string[];
  parentText?: string;
  targetDataKind: TargetDataKind;
  matchedCount: number;
  selector: string;
  userConstraints?: string[];
}): {
  isValid: boolean;
  isDecoy: boolean;
  isPlaceholder: boolean;
  rejectionReason?: string;
  normalizedValue: string | number | null;
  valueRegex: string | null;
} {
  const { rawText, classes = [], parentText = '', targetDataKind, selector } = params;
  const lowerText = rawText.toLowerCase();
  const lowerClasses = classes.map((c) => c.toLowerCase()).join(' ');
  const lowerParent = parentText.toLowerCase();

  // 1. Placeholder & Skeleton checks
  const isPlaceholder =
    /loading|checking|skeleton|shimmer|--|\$--/i.test(lowerText) ||
    /skeleton|shimmer|placeholder|loading-spinner/i.test(lowerClasses);

  if (isPlaceholder) {
    return {
      isValid: false,
      isDecoy: false,
      isPlaceholder: true,
      rejectionReason: `Selector matched unhydrated placeholder / skeleton text ("${rawText}")`,
      normalizedValue: null,
      valueRegex: null,
    };
  }

  // 2. Decoy / Strikethrough / Installment checks
  const isDecoy =
    /was|old|original|strike|line-through|rrp|msrp/i.test(lowerClasses + ' ' + lowerParent) ||
    /month|installment|finance|credit|paypal|klarna|per\s+mo/i.test(lowerParent);

  if (isDecoy) {
    return {
      isValid: false,
      isDecoy: true,
      isPlaceholder: false,
      rejectionReason: `Selector matched strikethrough was-price or financing installment instead of live value ("${rawText}")`,
      normalizedValue: null,
      valueRegex: null,
    };
  }

  // 3. Strict Value Normalization check
  const normResult = normalizeValue(rawText, targetDataKind);
  if (!normResult.isValid) {
    return {
      isValid: false,
      isDecoy: false,
      isPlaceholder: false,
      rejectionReason: normResult.error || `Failed to normalize value for ${targetDataKind}`,
      normalizedValue: null,
      valueRegex: null,
    };
  }

  return {
    isValid: true,
    isDecoy: false,
    isPlaceholder: false,
    normalizedValue: normResult.normalized,
    valueRegex: normResult.regex,
  };
}

/**
 * Extends deterministic candidate validation only for ambiguous categorical
 * page text. Security, placeholder, decoy, numeric, and selector checks stay
 * deterministic; Strands is used solely to understand availability language
 * such as "ships in two days" or "preorder open".
 */
async function evaluateElementCandidateWithAgent(
  params: Parameters<typeof evaluateElementCandidate>[0],
  signal?: AbortSignal
): Promise<ReturnType<typeof evaluateElementCandidate>> {
  const deterministic = evaluateElementCandidate(params);
  if (
    deterministic.isValid ||
    params.targetDataKind !== 'CATEGORICAL' ||
    deterministic.isDecoy ||
    deterministic.isPlaceholder ||
    signal?.aborted
  ) {
    return deterministic;
  }

  const semantic = await extractSemanticQueryFields<PageStateSemanticFields>('PAGE_STATE', [
    `Element text: ${params.rawText}`,
    `Parent context: ${params.parentText || ''}`,
    `CSS classes: ${(params.classes || []).join(' ')}`,
  ].join('\n'), { signal, timeoutMs: 2000 });

  if (
    semantic?.state &&
    semantic.state !== 'UNKNOWN' &&
    typeof semantic.confidence === 'number' &&
    Number.isFinite(semantic.confidence) &&
    semantic.confidence >= 0.75
  ) {
    return {
      ...deterministic,
      isValid: true,
      normalizedValue: semantic.state,
      valueRegex: null,
      rejectionReason: undefined,
    };
  }

  return deterministic;
}

/**
 * Derives durable CSS selector according to Sentinel's 3-tier hierarchy.
 */
function deriveSuggestedSelector($: cheerio.CheerioAPI, el: Element): string {
  const elem = $(el);

  // 1. Unique semantic ID
  const id = elem.attr('id');
  if (id && !/^\d+$/.test(id) && !id.includes('random') && $(`#${id}`).length === 1) {
    return `#${id}`;
  }

  // 2. Microdata attribute
  const itemprop = elem.attr('itemprop');
  if (itemprop && $(`[itemprop="${itemprop}"]`).length === 1) {
    return `[itemprop="${itemprop}"]`;
  }

  // 3. Test IDs
  const testId = elem.attr('data-testid') || elem.attr('data-qa') || elem.attr('data-cy');
  if (testId && $(`[data-testid="${testId}"]`).length === 1) {
    return `[data-testid="${testId}"]`;
  }

  // 4. Functional class hierarchy
  const rawClasses = elem.attr('class') || '';
  const classes = rawClasses
    .split(/\s+/)
    .filter((c) => c && !c.includes('css-') && !c.includes('sc-') && !/^[a-z0-9]{5,8}$/.test(c));

  if (classes.length > 0) {
    const classSel = `.${classes.slice(0, 2).join('.')}`;
    if ($(classSel).length === 1) return classSel;

    const parentClass = (elem.parent().attr('class') || '').split(/\s+/).filter(Boolean)[0];
    if (parentClass) {
      const compound = `.${parentClass} ${classSel}`;
      if ($(compound).length === 1) return compound;
    }
  }

  return `${el.tagName.toLowerCase()}${classes.length > 0 ? `.${classes[0]}` : ''}`;
}

/**
 * Extracts serialized framework state (Next.js __NEXT_DATA__, Nuxt, or Shopify JSON).
 */
export function extractEmbeddedFrameworkState($: cheerio.CheerioAPI): {
  data: Record<string, unknown> | null;
  tier: ScrapingTier | null;
  extractedPrice?: number | string;
  extractedStock?: string;
} {
  const nextDataScript = $('#__NEXT_DATA__').first();
  if (nextDataScript.length > 0) {
    try {
      const parsed = JSON.parse(nextDataScript.text());
      const pageProps = parsed?.props?.pageProps;
      if (pageProps) {
        const prod = (pageProps.product || pageProps.initialState?.product || pageProps.data?.product || pageProps) as Record<string, unknown>;
        const price = prod.price ?? prod.currentPrice ?? (prod.offers as Record<string, unknown> | undefined)?.price ?? prod.salePrice ?? prod.priceAmount;
        const stock = prod.availability ?? prod.inStock ?? prod.stockStatus;
        if (price !== undefined) {
          return {
            data: prod,
            tier: 'FRAMEWORK_EMBEDDED_STATE',
            extractedPrice: typeof price === 'number' ? price : String(price),
            extractedStock: stock !== undefined ? String(stock) : undefined,
          };
        }
      }
    } catch {}
  }

  const shopifyScript = $('script[data-product-json], script[id^="ProductJson-"], script[type="application/json"].product-json').first();
  if (shopifyScript.length > 0) {
    try {
      const parsed = JSON.parse(shopifyScript.text());
      const price = parsed.price ? (typeof parsed.price === 'number' ? parsed.price / 100 : parsed.price) : undefined;
      const available = parsed.available !== undefined ? (parsed.available ? 'In Stock' : 'Out of Stock') : undefined;
      if (price !== undefined) {
        return {
          data: parsed,
          tier: 'FRAMEWORK_EMBEDDED_STATE',
          extractedPrice: price,
          extractedStock: available,
        };
      }
    } catch {}
  }

  return { data: null, tier: null };
}

// ==========================================================
// 3. Multi-Tier DOM Condensation Engine
// ==========================================================

export async function fetchAndCondenseDom(
  url: string,
  domain: string,
  siteName: string,
  options: ScraperOptions = {}
): Promise<CondensedDomContext> {
  const timeoutMs = options.timeoutMs ?? 9000;
  const targetKind = options.targetDataKind || 'PRICE';
  const enableHeadless = options.enableHeadlessFallback ?? true;

  // --- Tier 1: Fast SSRF-Safe Static HTML Fetch (Cheerio) ---
  try {
    const res = await safeFetch(url, {
      signal: options.signal,
      timeoutMs,
      allowPrivateForTesting: options.allowPrivateForTesting,
    });

    const html = await res.text().catch(() => '');

    if (isBotBlocked(html, res.status)) {
      return {
        url,
        domain,
        siteName,
        scrapingTierUsed: 'CHEERIO_STATIC',
        isAccessible: false,
        condensedHtml: '',
        candidates: [],
        rejectionReason: 'Encountered Cloudflare or Bot-Defense challenge block',
      };
    }

    if (res.ok) {

      const $ = cheerio.load(html);

      // 1. Extract Framework State (Next.js / Shopify)
      const frameworkState = extractEmbeddedFrameworkState($);

      // 2. Extract Schema.org microdata
      let schemaData: CondensedDomContext['schemaMicrodata'] = null;
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const parsed = JSON.parse($(el).text());
          const graphList = parsed['@graph'] as Array<{ offers?: unknown }> | undefined;
          const offer = parsed.offers || (graphList && graphList.find((g) => g.offers)?.offers);
          if (offer) {
            const o = Array.isArray(offer) ? offer[0] : (offer as Record<string, unknown>);
            schemaData = {
              name: typeof parsed.name === 'string' ? parsed.name : undefined,
              price: typeof o.price === 'string' || typeof o.price === 'number' ? o.price : undefined,
              currency: typeof o.priceCurrency === 'string' ? o.priceCurrency : undefined,
              availability: typeof o.availability === 'string' ? o.availability : undefined,
            };
          }
        } catch {}
      });

      if (!schemaData && frameworkState.extractedPrice !== undefined) {
        schemaData = {
          name: typeof frameworkState.data?.title === 'string' ? (frameworkState.data.title as string) : undefined,
          price: frameworkState.extractedPrice,
          availability: frameworkState.extractedStock,
        };
      }

      // Strip boilerplate noise
      $('script, style, nav, footer, noscript, svg, iframe, header').remove();

      // 3. Target-Specific Candidate Extraction Strategies
      const candidates: DomCandidate[] = [];
      const mainContainer = $(
        'main, [role="main"], article, .product-detail, .buy-box, #product-details, .product-info, body'
      ).first();

      let targetSelectorQuery: string;
      switch (targetKind) {
        case 'PRICE':
          targetSelectorQuery =
            '[itemprop="price"], .price, .product-price, .current-price, .amount, .price-wrapper, [data-testid*="price"], [id*="price"], [class*="price"]';
          break;
        case 'CATEGORICAL':
          targetSelectorQuery =
            '.availability, .stock, .status-badge, [data-testid*="stock"], [data-testid*="availability"], .inventory, [itemprop="availability"], [class*="stock"], [class*="availability"]';
          break;
        case 'TEXT_MATCH':
          targetSelectorQuery =
            '.status, .status-indicator, [role="status"], .badge, .alert, .banner, .notice, h1, h2, h3, [data-testid*="status"], p';
          break;
        case 'GENERAL_INFO':
        default:
          targetSelectorQuery =
            'h1, h2, h3, [role="main"] p, article p, .content p, .description p, .product-info p, main p';
          break;
      }

      mainContainer
        .find(targetSelectorQuery)
        .slice(0, 10)
        .each((_, el) => {
          const text = $(el).text().trim();
          if (text.length > 0 && text.length < 120) {
            const classes = ($(el).attr('class') || '').split(/\s+/).filter(Boolean);
            const parentText = $(el).parent().text().toLowerCase();

            let contextHint = 'live-candidate';
            if (/was|old|original|strike|line-through/i.test(classes.join(' ') + parentText)) {
              contextHint = 'was-price-strikethrough';
            } else if (/month|installment|finance|credit|paypal|klarna/i.test(parentText)) {
              contextHint = 'financing-installment';
            } else if (/in\s*stock|available/i.test(text)) {
              contextHint = 'in-stock-badge';
            }

            candidates.push({
              tag: el.tagName,
              text,
              id: $(el).attr('id'),
              testId: $(el).attr('data-testid'),
              itemprop: $(el).attr('itemprop'),
              classes,
              suggestedSelector: deriveSuggestedSelector($, el),
              contextHint,
            });
          }
        });

      // Point 9: If no DOM candidates were found, but schemaMicrodata/framework state is available,
      // create a candidate so the page is not rejected.
      if (candidates.length === 0 && (schemaData?.price !== undefined || schemaData?.availability !== undefined)) {
        candidates.push({
          tag: 'script',
          text: String(schemaData.price ?? schemaData.availability),
          suggestedSelector: 'script[type="application/ld+json"]',
          classes: ['schema-microdata'],
          contextHint: 'json-ld-microdata',
        });
      }

      const needsHydration = isHydrationPending(candidates, html);

      if (!needsHydration && (candidates.length > 0 || schemaData)) {
        const condensedHtml = mainContainer.html()?.slice(0, 2000) || '';
        return {
          url,
          domain,
          siteName,
          scrapingTierUsed: frameworkState.tier || (schemaData ? 'JSON_LD_MICRODATA' : 'CHEERIO_STATIC'),
          isAccessible: true,
          schemaMicrodata: schemaData,
          condensedHtml: condensedHtml.replace(/\s+/g, ' ').slice(0, 1500),
          candidates,
        };
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // If SSRF blocked, return immediately without attempting headless fallback
    if (msg.includes('[SSRF Guard]')) {
      return {
        url,
        domain,
        siteName,
        scrapingTierUsed: 'CHEERIO_STATIC',
        isAccessible: false,
        condensedHtml: '',
        candidates: [],
        rejectionReason: msg,
      };
    }
  }

  // Point 11: Honor enableHeadlessFallback
  if (!enableHeadless) {
    return {
      url,
      domain,
      siteName,
      scrapingTierUsed: 'CHEERIO_STATIC',
      isAccessible: false,
      condensedHtml: '',
      candidates: [],
      rejectionReason: 'Static fetch failed and headless fallback is disabled by configuration',
    };
  }

  // --- Tier 2: Dynamic Playwright Fallback (Sandboxed & Isolated) ---
  let pw: PlaywrightModule | null = null;
  try {
    pw = (await import('playwright')) as unknown as PlaywrightModule;
  } catch {
    return {
      url,
      domain,
      siteName,
      scrapingTierUsed: 'CHEERIO_STATIC',
      isAccessible: false,
      condensedHtml: '',
      candidates: [],
      rejectionReason: 'Static fetch failed and Playwright is not installed for dynamic SPA fallback',
    };
  }

  let browser: PlaywrightBrowser | null = null;
  try {
    if (options.browserLaunchTracker) {
      if (options.browserLaunchTracker.count >= options.browserLaunchTracker.max) {
        return {
          url,
          domain,
          siteName,
          scrapingTierUsed: 'CHEERIO_STATIC',
          isAccessible: false,
          condensedHtml: '',
          candidates: [],
          rejectionReason: `Browser launch budget exceeded (limit: ${options.browserLaunchTracker.max})`,
        };
      }
      options.browserLaunchTracker.count++;
    }

    if (options.signal?.aborted) {
      return {
        url,
        domain,
        siteName,
        scrapingTierUsed: 'PLAYWRIGHT_HEADLESS',
        isAccessible: false,
        condensedHtml: '',
        candidates: [],
        rejectionReason: 'Operation aborted before Playwright launch',
      };
    }

    // Point 2: Launch Chromium with Sandbox ENABLED (No --no-sandbox)
    browser = await pw.chromium.launch({
      args: ['--disable-dev-shm-usage'],
    });

    if (options.signal) {
      options.signal.addEventListener('abort', () => browser?.close().catch(() => {}), { once: true });
    }

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // Point 1 & 2: Route interception to block private IP navigation in browser
    await attachSsrfRouteGuard(page, options.allowPrivateForTesting);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});

    // Active Hydration Waiter
    await page.waitForFunction(() => {
      interface DomElementLike { textContent: string | null; }
      interface DomDocumentLike { querySelector: (selector: string) => DomElementLike | null; }
      const doc = (globalThis as unknown as { document?: DomDocumentLike }).document;
      if (!doc) return false;
      const selectors = [
        '[itemprop="price"]', '.price', '.product-price', '.current-price',
        '[data-testid*="price"]', '.stock', '.availability', '[id*="price"]',
        '.status', '.badge'
      ];
      for (const sel of selectors) {
        const el = doc.querySelector(sel);
        const text = el?.textContent?.trim() || '';
        if (text.length > 0 && !/loading|checking|skeleton|shimmer/i.test(text)) {
          return true;
        }
      }
      return false;
    }, { timeout: 3000 }).catch(() => {});

    await page.waitForTimeout(400);

    const renderedCandidates = await page.evaluate(() => {
      interface DomElementLike {
        textContent: string | null;
        tagName: string;
        id?: string;
        classList: Iterable<string>;
      }
      interface DomDocumentLike {
        querySelectorAll: (selector: string) => ArrayLike<DomElementLike>;
      }
      const doc = (globalThis as unknown as { document?: DomDocumentLike }).document;
      if (!doc) return [];
      const items: DomCandidate[] = [];
      const selectors = [
        '[itemprop="price"]', '.price', '.product-price', '.current-price',
        '[data-testid*="price"]', '.stock', '.availability', '[id*="price"]',
        '.status', '.badge'
      ];
      for (const sel of selectors) {
        const elements = doc.querySelectorAll(sel);
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i];
          const text = el.textContent?.trim() || '';
          if (text.length > 0 && text.length < 80 && items.length < 6) {
            items.push({
              tag: el.tagName.toLowerCase(),
              text,
              id: el.id || undefined,
              classes: Array.from(el.classList),
              suggestedSelector: el.id ? `#${el.id}` : sel,
              contextHint: 'rendered-dom',
            });
          }
        }
      }
      return items;
    });

    await browser.close();

    return {
      url,
      domain,
      siteName,
      scrapingTierUsed: 'PLAYWRIGHT_HEADLESS',
      isAccessible: true,
      condensedHtml: '<!-- Dynamically rendered via Sandboxed Playwright -->',
      candidates: renderedCandidates,
    };
  } catch (err: unknown) {
    if (browser) await browser.close().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      domain,
      siteName,
      scrapingTierUsed: 'PLAYWRIGHT_HEADLESS',
      isAccessible: false,
      condensedHtml: '',
      candidates: [],
      rejectionReason: `Playwright inspection failed: ${message}`,
    };
  }
}

// ==========================================================
// 4. Deterministic Selector Verification Engine
// ==========================================================

export async function verifySelector(
  url: string,
  domain: string,
  siteName: string,
  selector: string,
  targetDataKind: TargetDataKind,
  options: ScraperOptions = {}
): Promise<SiteDossier> {
  const timeoutMs = options.timeoutMs ?? 9000;
  const enableHeadless = options.enableHeadlessFallback ?? true;

  // Point 9: Special handling for synthesized JSON-LD microdata selectors
  if (selector === 'script[type="application/ld+json"]') {
    try {
      const res = await safeFetch(url, {
        signal: options.signal,
        timeoutMs,
        allowPrivateForTesting: options.allowPrivateForTesting,
      });
      if (res.ok) {
        const html = await res.text();
        const $ = cheerio.load(html);
        let extractedVal: string | number | null = null;

        $('script[type="application/ld+json"]').each((_, el) => {
          try {
            const parsed = JSON.parse($(el).text());
            const offer = parsed.offers || (parsed['@graph'] && parsed['@graph'].find((g: Record<string, unknown>) => g.offers)?.offers);
            if (offer) {
              const o = Array.isArray(offer) ? offer[0] : offer;
              if (targetDataKind === 'PRICE' && o.price !== undefined) {
                extractedVal = typeof o.price === 'number' ? o.price : parseFloat(String(o.price));
              } else if (targetDataKind === 'CATEGORICAL' && o.availability) {
                extractedVal = String(o.availability).includes('InStock') ? 'IN_STOCK' : 'OUT_OF_STOCK';
              }
            }
          } catch {}
        });

        if (extractedVal !== null) {
          return {
            url,
            domain,
            siteName,
            scrapingTierUsed: 'JSON_LD_MICRODATA',
            selectorSource: 'JSON_PATH',
            isAccessible: true,
            hasLiveTargetData: true,
            selector,
            attribute: 'json',
            rawSampleValue: String(extractedVal),
            normalizedValue: extractedVal,
            valueRegex: null,
            pros: ['Verified through Schema.org microdata (JSON-LD)'],
            cons: [],
            confidenceScore: 0.95,
          };
        }
      }
    } catch {}
  }

  // --- Tier 1: Static Cheerio Verification ---
  try {
    const res = await safeFetch(url, {
      signal: options.signal,
      timeoutMs,
      allowPrivateForTesting: options.allowPrivateForTesting,
    });

    const html = await res.text().catch(() => '');

    if (isBotBlocked(html, res.status)) {
      return {
        url,
        domain,
        siteName,
        scrapingTierUsed: 'CHEERIO_STATIC',
        isAccessible: false,
        hasLiveTargetData: false,
        selector,
        attribute: 'text',
        rawSampleValue: null,
        normalizedValue: null,
        valueRegex: null,
        pros: [],
        cons: ['Encountered Cloudflare or Bot-Defense challenge block'],
        rejectionReason: 'Encountered Cloudflare or Bot-Defense challenge block',
        confidenceScore: 0.0,
      };
    }

    if (res.ok) {
      const $ = cheerio.load(html);
      const matches = $(selector);

      if (matches.length > 0) {
        const targetEl = matches.first();
        const rawText = targetEl.text().trim();
        const matchedHtml = targetEl.parent().html()?.slice(0, 250) || targetEl.html()?.slice(0, 250) || '';
        const classes = (targetEl.attr('class') || '').split(/\s+/).filter(Boolean);
        const parentText = targetEl.parent().text().toLowerCase();

        // Points 6 & 7: Evaluate element using shared deterministic validation
        const evalResult = await evaluateElementCandidateWithAgent({
          rawText,
          classes,
          parentText,
          targetDataKind,
          matchedCount: matches.length,
          selector,
        }, options.signal);

        const diagnostics: SelectorExecutionDiagnostics = {
          selector,
          matchedCount: matches.length,
          rawSampleValue: rawText,
          matchedHtmlSample: matchedHtml,
          isDecoy: evalResult.isDecoy,
          isPlaceholder: evalResult.isPlaceholder,
          rejectionReason: evalResult.rejectionReason,
        };

        if (!evalResult.isValid) {
          return {
            url,
            domain,
            siteName,
            scrapingTierUsed: 'CHEERIO_STATIC',
            isAccessible: true,
            hasLiveTargetData: false,
            selector,
            attribute: 'text',
            rawSampleValue: rawText,
            normalizedValue: null,
            valueRegex: null,
            pros: [],
            cons: [evalResult.rejectionReason || 'Validation rejected element'],
            rejectionReason: evalResult.rejectionReason,
            diagnostics,
            confidenceScore: 0.2,
          };
        }

        const pros: string[] = [];
        if (matches.length === 1) pros.push('Selector is globally unique on page (1 match)');
        if (selector.startsWith('#')) pros.push('Uses stable element ID');
        if (selector.includes('itemprop')) pros.push('Anchored to Schema.org microdata');

        return {
          url,
          domain,
          siteName,
          scrapingTierUsed: 'CHEERIO_STATIC',
          selectorSource: 'HEURISTIC_FALLBACK',
          isAccessible: true,
          hasLiveTargetData: true,
          selector,
          attribute: 'text',
          rawSampleValue: rawText,
          normalizedValue: evalResult.normalizedValue,
          valueRegex: evalResult.valueRegex,
          pros,
          cons: matches.length > 1 ? [`Warning: selector matches ${matches.length} elements, using first match`] : [],
          diagnostics,
          confidenceScore: matches.length === 1 ? 0.95 : 0.82,
        };
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('[SSRF Guard]')) {
      return {
        url,
        domain,
        siteName,
        scrapingTierUsed: 'CHEERIO_STATIC',
        isAccessible: false,
        hasLiveTargetData: false,
        selector,
        attribute: 'text',
        rawSampleValue: null,
        normalizedValue: null,
        valueRegex: null,
        pros: [],
        cons: [msg],
        rejectionReason: msg,
        confidenceScore: 0.0,
      };
    }
  }

  // Point 11: Honor enableHeadlessFallback
  if (!enableHeadless) {
    return {
      url,
      domain,
      siteName,
      scrapingTierUsed: 'CHEERIO_STATIC',
      isAccessible: true,
      hasLiveTargetData: false,
      selector,
      attribute: 'text',
      rawSampleValue: null,
      normalizedValue: null,
      valueRegex: null,
      pros: [],
      cons: ['Static verification failed and headless fallback is disabled'],
      rejectionReason: `Selector "${selector}" not found statically, headless disabled`,
      confidenceScore: 0.0,
    };
  }

  // --- Tier 2: Dynamic Playwright Fallback (Sandboxed & Shared Decoy Checks) ---
  let pw: PlaywrightModule | null = null;
  let browser: PlaywrightBrowser | null = null;
  try {
    pw = (await import('playwright')) as unknown as PlaywrightModule;
    if (options.browserLaunchTracker) {
      if (options.browserLaunchTracker.count >= options.browserLaunchTracker.max) {
        return {
          url,
          domain,
          siteName,
          scrapingTierUsed: 'CHEERIO_STATIC',
          isAccessible: false,
          hasLiveTargetData: false,
          selector: null,
          attribute: 'text',
          rawSampleValue: null,
          normalizedValue: null,
          valueRegex: null,
          pros: [],
          cons: [`Browser launch budget exceeded (limit: ${options.browserLaunchTracker.max})`],
          rejectionReason: `Browser launch budget exceeded (limit: ${options.browserLaunchTracker.max})`,
          confidenceScore: 0.0,
        };
      }
      options.browserLaunchTracker.count++;
    }

    if (options.signal?.aborted) {
      return {
        url,
        domain,
        siteName,
        scrapingTierUsed: 'PLAYWRIGHT_HEADLESS',
        isAccessible: false,
        hasLiveTargetData: false,
        selector: null,
        attribute: 'text',
        rawSampleValue: null,
        normalizedValue: null,
        valueRegex: null,
        pros: [],
        cons: ['Operation aborted before Playwright launch'],
        rejectionReason: 'Operation aborted before Playwright launch',
        confidenceScore: 0.0,
      };
    }

    // Point 2: Launch with Chromium OS sandbox enabled (No --no-sandbox)
    browser = await pw.chromium.launch({
      args: ['--disable-dev-shm-usage'],
    });

    if (options.signal) {
      options.signal.addEventListener('abort', () => browser?.close().catch(() => {}), { once: true });
    }

    const page = await browser.newPage();

    await attachSsrfRouteGuard(page, options.allowPrivateForTesting);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
    await page.waitForSelector(selector, { state: 'attached', timeout: Math.min(timeoutMs, 3500) }).catch(() => {});

    // Points 6 & 7: Extract text, classes, and parent text for identical validation in Playwright
    const evalData = await page.$eval(selector, (el) => ({
      rawText: el.textContent?.trim() || '',
      classes: el.classList ? Array.from(el.classList) : [],
      parentText: el.parentElement?.textContent?.trim() || '',
    })).catch(() => null);

    await browser.close();
    browser = null;

    if (evalData && evalData.rawText) {
      const evalResult = await evaluateElementCandidateWithAgent({
        rawText: evalData.rawText,
        classes: evalData.classes,
        parentText: evalData.parentText,
        targetDataKind,
        matchedCount: 1,
        selector,
      }, options.signal);

      const diagnostics: SelectorExecutionDiagnostics = {
        selector,
        matchedCount: 1,
        rawSampleValue: evalData.rawText,
        isDecoy: evalResult.isDecoy,
        isPlaceholder: evalResult.isPlaceholder,
        rejectionReason: evalResult.rejectionReason,
      };

      if (!evalResult.isValid) {
        return {
          url,
          domain,
          siteName,
          scrapingTierUsed: 'PLAYWRIGHT_HEADLESS',
          requiresDynamicHydration: true,
          isAccessible: true,
          hasLiveTargetData: false,
          selector,
          attribute: 'text',
          rawSampleValue: evalData.rawText,
          normalizedValue: null,
          valueRegex: null,
          pros: [],
          cons: [evalResult.rejectionReason || 'Playwright verification rejected element'],
          rejectionReason: evalResult.rejectionReason,
          diagnostics,
          confidenceScore: 0.2,
        };
      }

      return {
        url,
        domain,
        siteName,
        scrapingTierUsed: 'PLAYWRIGHT_HEADLESS',
        selectorSource: 'HEURISTIC_FALLBACK',
        requiresDynamicHydration: true,
        isAccessible: true,
        hasLiveTargetData: true,
        selector,
        attribute: 'text',
        rawSampleValue: evalData.rawText,
        normalizedValue: evalResult.normalizedValue,
        valueRegex: evalResult.valueRegex,
        pros: ['Selector verified in dynamic DOM via Sandboxed Playwright after hydration'],
        cons: ['Requires headless execution for continuous observation'],
        diagnostics,
        confidenceScore: 0.90,
      };
    }
  } catch {
    if (browser) await browser.close().catch(() => {});
  }

  const failureDiagnostics: SelectorExecutionDiagnostics = {
    selector,
    matchedCount: 0,
    rawSampleValue: null,
    rejectionReason: `Selector "${selector}" returned 0 matches on ${siteName}`,
  };

  return {
    url,
    domain,
    siteName,
    scrapingTierUsed: 'CHEERIO_STATIC',
    isAccessible: true,
    hasLiveTargetData: false,
    selector,
    attribute: 'text',
    rawSampleValue: null,
    normalizedValue: null,
    valueRegex: null,
    pros: [],
    cons: ['Selector did not resolve to any live element'],
    rejectionReason: failureDiagnostics.rejectionReason,
    diagnostics: failureDiagnostics,
    confidenceScore: 0.0,
  };
}

// ==========================================================
// 5. Official Strands SDK Tools
// ==========================================================

export const fetchDomContextTool = tool({
  name: 'fetch_dom_context',
  description: 'Fetches and condenses a webpage DOM, extracting Schema.org microdata and candidate elements for semantic AI evaluation.',
  inputSchema: z.object({
    url: z.string().url().describe('The URL of the candidate webpage'),
    domain: z.string().describe('The domain of the site (e.g. "scan.co.uk")'),
    siteName: z.string().describe('The name of the site (e.g. "SCAN")'),
  }),
  callback: async function* (
    input: { url: string; domain: string; siteName: string },
    context?: ToolContext
  ): AsyncGenerator<ResearchTelemetryEvent, CondensedDomContext, unknown> {
    const taskId = (context?.invocationState?.taskId as string) || 'task-auto';
    const toolUseId = context?.toolUse?.toolUseId;

    yield {
      taskId,
      step: 'INSPECTING_SITE',
      message: `Fetching DOM & Microdata from ${input.siteName} (${input.domain})...`,
      data: { url: input.url, toolUseId },
      timestamp: Date.now(),
    };

    const domContext = await fetchAndCondenseDom(input.url, input.domain, input.siteName, {
      signal: context?.cancelSignal,
      timeoutMs: 9000,
    });

    return domContext;
  },
});

export const verifySelectorTool = tool({
  name: 'verify_selector',
  description: 'Tests a proposed CSS selector on the live webpage to verify uniqueness, extract sample values, and compile the final SiteDossier.',
  inputSchema: z.object({
    url: z.string().url().describe('The URL of the candidate webpage'),
    domain: z.string().describe('The domain of the site (e.g. "scan.co.uk")'),
    siteName: z.string().describe('The name of the site (e.g. "SCAN")'),
    selector: z.string().describe('The proposed CSS selector to verify on the live page'),
    targetDataKind: TargetDataKindEnum.describe('Target data classification'),
  }),
  callback: async function* (
    input: {
      url: string;
      domain: string;
      siteName: string;
      selector: string;
      targetDataKind: TargetDataKind;
    },
    context?: ToolContext
  ): AsyncGenerator<ResearchTelemetryEvent, SiteDossier, unknown> {
    const taskId = (context?.invocationState?.taskId as string) || 'task-auto';
    const toolUseId = context?.toolUse?.toolUseId;

    yield {
      taskId,
      step: 'INSPECTING_SITE',
      message: `Verifying CSS selector "${input.selector}" on ${input.siteName}...`,
      data: { url: input.url, selector: input.selector, toolUseId },
      timestamp: Date.now(),
    };

    const dossier = await verifySelector(
      input.url,
      input.domain,
      input.siteName,
      input.selector,
      input.targetDataKind,
      { signal: context?.cancelSignal, timeoutMs: 9000 }
    );

    yield {
      taskId,
      step: 'SITE_INSPECTED',
      message: dossier.hasLiveTargetData
        ? `Confirmed selector "${dossier.selector}" on ${input.siteName} (Sample: ${dossier.rawSampleValue})`
        : `Selector verification failed on ${input.siteName}: ${dossier.rejectionReason}`,
      data: {
        url: input.url,
        selector: dossier.selector,
        rawSampleValue: dossier.rawSampleValue,
        confidenceScore: dossier.confidenceScore,
        toolUseId,
      },
      timestamp: Date.now(),
    };

    return dossier;
  },
});
