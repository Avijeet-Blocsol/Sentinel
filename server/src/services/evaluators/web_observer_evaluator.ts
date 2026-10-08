/**
 * Strands Sentinel - Web Observer Evaluator
 * Safely inspects webpage URLs via Tier-1 Cheerio static fetch and Tier-2 Playwright
 * headless fallback for SPAs/dynamic hydration. Delegates complex semantic/visual/inventory checks
 * to the AgenticConditionEvaluator with content-hash diff caching to avoid redundant LLM calls.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { SubSentinel, Rule } from '@sentinel/shared';
import { safeFetch } from '../../harness/deep_web_search/security/safe_fetch.js';
import { attachSsrfRouteGuard } from '../../tools/deep_web_search/scrapper_tool.js';
import { validateAndCanonicalizeUrl } from '../../harness/deep_web_search/security/url_validator.js';
import { globalAgenticEvaluator, AgenticConditionEvaluator } from './agentic_evaluator.js';
import type { SubSentinelEvaluationResult, SubSentinelEvaluator } from './types.js';

export class WebObserverEvaluator implements SubSentinelEvaluator {
  private readonly agenticEvaluator: AgenticConditionEvaluator;
  private readonly fetchFn: typeof safeFetch;

  constructor(options?: {
    agenticEvaluator?: AgenticConditionEvaluator;
    fetchFn?: typeof safeFetch;
  }) {
    this.agenticEvaluator = options?.agenticEvaluator || globalAgenticEvaluator;
    this.fetchFn = options?.fetchFn || safeFetch;
  }
  /**
   * Headless Playwright fallback for single-page applications (SPAs)
   * or dynamic client-side hydration when Cheerio returns empty/skeleton DOMs.
   */
  private async fetchWithPlaywright(targetUrl: string, selector?: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return '';

    let pw: any = null;
    let browser: any = null;
    let onAbort: (() => void) | undefined;

    try {
      pw = await import('playwright');
    } catch {
      return '';
    }

    try {
      if (signal?.aborted) return '';

      browser = await pw.chromium.launch({ headless: true });

      if (signal) {
        onAbort = () => {
          if (browser) browser.close().catch(() => {});
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          await browser.close().catch(() => {});
          return '';
        }
      }

      const page = await browser.newPage();
      await attachSsrfRouteGuard(page);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // Give client-side JS a brief moment to hydrate
      await page.waitForTimeout(1000);

      let text = '';
      if (selector) {
        try {
          await page.waitForSelector(selector, { timeout: 3000 });
          text = await page.$eval(selector, (el: any) => {
            return (
              el.getAttribute('content') ||
              el.getAttribute('value') ||
              el.getAttribute('data-price') ||
              el.getAttribute('aria-label') ||
              el.innerText ||
              el.textContent ||
              ''
            );
          });
        } catch {
          // Targeted selector timed out in browser, fall through to body
        }
      }

      if (!text) {
        text = await page.evaluate(() => {
          const doc = (globalThis as any).document;
          if (!doc) return '';
          doc.querySelectorAll('script, style, noscript, svg, iframe').forEach((el: any) => el.remove());
          return doc.body?.innerText || doc.body?.textContent || '';
        });
      }

      return (text || '').replace(/\s+/g, ' ').trim().slice(0, 3000);
    } catch {
      return '';
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  async evaluate(subSentinel: SubSentinel, rule?: Rule, signal?: AbortSignal): Promise<SubSentinelEvaluationResult> {
    try {
      if (signal?.aborted) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: 'Evaluation timed out or was cancelled.',
          error: 'EVALUATION_TIMEOUT',
        };
      }

      let targetUrl = subSentinel.target_source || '';
      let selector: string | undefined;
      let expectedCondition = rule?.natural_language_intent || '';

      try {
        const parsed = JSON.parse(subSentinel.threshold);
        if (parsed.url) targetUrl = parsed.url;
        if (parsed.selector) selector = parsed.selector;
        if (parsed.expectedText) expectedCondition = `Ensure text matches: ${parsed.expectedText}`;
        if (parsed.checkInStock) expectedCondition = `Determine if the product is in stock and available for purchase`;
      } catch {
        // Plain threshold
      }

      const targetValidation = validateAndCanonicalizeUrl(targetUrl);
      if (!targetValidation.valid || !targetValidation.canonicalUrl) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Invalid target URL for WebObserver: "${targetUrl}". ${targetValidation.error || 'Only safe HTTP/HTTPS URLs are permitted.'}`,
          error: 'INVALID_URL',
        };
      }
      targetUrl = targetValidation.canonicalUrl;

      // 1. Tier 1: Fast Cheerio Static Fetch with SSRF Safety
      let tierUsed: 'CHEERIO_STATIC' | 'PLAYWRIGHT_HEADLESS' = 'CHEERIO_STATIC';
      let extractedSnippet = '';

      try {
        const res = await this.fetchFn(targetUrl, {
          signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });

        if (res.ok) {
          const rawHtml = await res.text();
          const $ = cheerio.load(rawHtml);

          // Strip noise
          $('script, style, noscript, svg, iframe').remove();

          if (selector) {
            const el = $(selector);
            extractedSnippet =
              el.attr('content') ||
              el.attr('value') ||
              el.attr('data-price') ||
              el.attr('aria-label') ||
              el.text();
            extractedSnippet = (extractedSnippet || '').replace(/\s+/g, ' ').trim();
          } else {
            extractedSnippet = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 3000);
          }
        }
      } catch {
        // Static fetch failed, try Playwright fallback
      }

      // 2. Tier 2: Playwright Dynamic SPA Fallback
      // If Cheerio returned an empty snippet, an unhydrated shell, or selector wasn't found in raw HTML
      const isUnhydratedSpa =
        !extractedSnippet ||
        extractedSnippet.length < 30 ||
        (selector && !extractedSnippet);

      if (isUnhydratedSpa) {
        if (signal?.aborted) {
          return {
            isSatisfied: false,
            observedValue: null,
            details: 'Evaluation timed out or was cancelled before dynamic SPA fallback.',
            error: 'EVALUATION_TIMEOUT',
          };
        }
        const dynamicSnippet = await this.fetchWithPlaywright(targetUrl, selector, signal);
        if (dynamicSnippet) {
          extractedSnippet = dynamicSnippet;
          tierUsed = 'PLAYWRIGHT_HEADLESS';
        }
      }

      if (selector && !extractedSnippet) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Configured selector "${selector}" not found on ${targetUrl} (neither in static HTML nor dynamic render).`,
          error: 'SELECTOR_NOT_FOUND',
        };
      }

      if (!extractedSnippet) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Unable to extract content from ${targetUrl} (both static and browser inspections returned empty body).`,
          error: 'EMPTY_CONTENT',
        };
      }

      // 3. Composite Content-Hash Diff Caching to Prevent Redundant LLM Invocations
      const currentContentHash = createHash('sha256')
        .update(`${targetUrl}::${selector || ''}::${expectedCondition}::${extractedSnippet}`)
        .digest('hex');

      if (subSentinel.state_payload) {
        try {
          const priorState = JSON.parse(subSentinel.state_payload);
          if (
            priorState?.extraMetadata?.contentHash === currentContentHash &&
            !subSentinel.is_satisfied
          ) {
            return {
              isSatisfied: false,
              observedValue: 0,
              unit: 'WEB_OBSERVATION',
              details: `Page content unchanged since last evaluation (DOM hash match); skipped LLM evaluation.`,
              extraMetadata: {
                targetUrl,
                selector,
                tierUsed,
                contentHash: currentContentHash,
                cached: true,
              },
            };
          }
        } catch {
          // Ignore parse failure
        }
      }

      // 4. Delegate Semantic Evaluation to Agentic AI
      const agenticResult = await this.agenticEvaluator.evaluate(
        {
          conditionToEvaluate: expectedCondition || `Verify status of target element at ${targetUrl}`,
          targetSource: targetUrl,
          observedContext: {
            url: targetUrl,
            selector,
            extractedText: extractedSnippet,
            tierUsed,
          },
        },
        signal
      );

      if (agenticResult.status === 'ERROR' || agenticResult.error) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Agentic evaluation failed: ${agenticResult.error || agenticResult.reasoning}`,
          error: agenticResult.error || 'AGENTIC_EVALUATION_ERROR',
          extraMetadata: {
            agenticResult,
            targetUrl,
            selector,
            tierUsed,
            contentHash: currentContentHash,
          },
        };
      }

      return {
        isSatisfied: agenticResult.conditionSatisfied,
        observedValue: agenticResult.observedEvidence.extractedValue ?? (agenticResult.conditionSatisfied ? 1 : 0),
        unit: 'WEB_OBSERVATION',
        details: `${agenticResult.reasoning} Evidence: "${agenticResult.observedEvidence.relevantSnippet.slice(0, 150)}"`,
        extraMetadata: {
          agenticResult,
          targetUrl,
          selector,
          tierUsed,
          contentHash: currentContentHash,
        },
      };
    } catch (err: any) {
      return {
        isSatisfied: false,
        observedValue: null,
        details: `Web observer evaluation failure: ${err?.message || String(err)}`,
        error: err?.message || 'UNKNOWN_ERROR',
      };
    }
  }
}
