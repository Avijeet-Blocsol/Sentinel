/**
 * Strands Sentinel - RSS Feed Sub-Sentinel Evaluator
 * Two-tier evaluation of RSS feeds:
 * 1. Deterministic word-boundary regex & author filtering with HTTP 304 conditional GET caching.
 * 2. Agentic semantic verification (via Strands Agents SDK) when semanticFilter is specified.
 */

import { randomUUID } from 'node:crypto';
import {
  type SubSentinel,
  type Rule,
  type RssFeedThreshold,
  RssFeedThresholdSchema,
} from '@sentinel/shared';
import { parseRawFeed } from '../../harness/rss/feed_parser.js';
import type { NormalizedRssItem } from '../../harness/rss/types.js';
import { seenEventRepository } from '../../db/index.js';
import type { SubSentinelEvaluationResult, SubSentinelEvaluator } from './types.js';
import {
  globalAgenticEvaluator,
  AgenticConditionEvaluator,
} from './agentic_evaluator.js';
import { safeFetch } from '../../harness/deep_web_search/security/safe_fetch.js';

interface HttpCacheEntry {
  etag?: string;
  lastModified?: string;
}

export class RssEvaluator implements SubSentinelEvaluator {
  private httpCache = new Map<string, HttpCacheEntry>();
  private readonly agenticEvaluator: AgenticConditionEvaluator;
  private readonly fetchFn: (url: string, options?: any) => Promise<any>;

  constructor(options?: {
    agenticEvaluator?: AgenticConditionEvaluator;
    fetchFn?: (url: string, options?: any) => Promise<any>;
  }) {
    this.agenticEvaluator = options?.agenticEvaluator || globalAgenticEvaluator;
    this.fetchFn = options?.fetchFn || safeFetch;
  }

  /**
   * Clears HTTP 304 conditional cache for testing or manual cache busting
   */
  public clearCache(subSentinelId?: string): void {
    if (subSentinelId) {
      this.httpCache.delete(subSentinelId);
    } else {
      this.httpCache.clear();
    }
  }

  async evaluate(
    subSentinel: SubSentinel,
    rule?: Rule,
    signal?: AbortSignal
  ): Promise<SubSentinelEvaluationResult> {
    try {
      if (signal?.aborted) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: 'Evaluation timed out or was cancelled.',
          error: 'EVALUATION_TIMEOUT',
        };
      }

      const parsedJson = JSON.parse(subSentinel.threshold);
      const parsedThreshold = RssFeedThresholdSchema.safeParse(parsedJson);
      if (!parsedThreshold.success) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Invalid RSS threshold schema: ${parsedThreshold.error.message}`,
          error: parsedThreshold.error.message,
        };
      }

      const threshold: RssFeedThreshold = parsedThreshold.data;
      const feedUrl = threshold.feedUrl;

      // 1. Fetch feed raw content with conditional HTTP headers (ETag / Last-Modified) & timeout
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 9000);
      const onAbort = () => controller.abort();
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const cached = this.httpCache.get(subSentinel.id);
      const requestHeaders: Record<string, string> = {
        'User-Agent': 'StrandsSentinel/1.0 (RSS Observer)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      };
      if (cached?.etag) {
        requestHeaders['If-None-Match'] = cached.etag;
      }
      if (cached?.lastModified) {
        requestHeaders['If-Modified-Since'] = cached.lastModified;
      }

      let responseText = '';
      let pendingEtag: string | null = null;
      let pendingLastModified: string | null = null;

      try {
        const res = await this.fetchFn(feedUrl, {
          signal: controller.signal,
          headers: requestHeaders,
        });
        clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener('abort', onAbort);

        // HTTP 304 Not Modified: Payload has not changed on remote server
        if (res.status === 304) {
          return {
            isSatisfied: false,
            observedValue: 0,
            unit: 'ARTICLES',
            details: 'HTTP 304 Not Modified: Feed payload unchanged since previous check.',
            extraMetadata: {
              feedUrl,
              httpStatus: 304,
              cached: true,
              etag: cached?.etag,
              lastModified: cached?.lastModified,
            },
          };
        }

        if (!res.ok) {
          return {
            isSatisfied: false,
            observedValue: null,
            details: `RSS feed fetch failed with HTTP status ${res.status}: ${res.statusText}`,
            error: `HTTP_${res.status}`,
          };
        }

        // Capture ETag & Last-Modified to store ONLY after successful feed parsing
        pendingEtag = res.headers.get('etag');
        pendingLastModified = res.headers.get('last-modified');

        responseText = await res.text();
      } catch (fetchErr: any) {
        clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener('abort', onAbort);
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Network error fetching RSS feed: ${fetchErr?.message || String(fetchErr)}`,
          error: 'NETWORK_ERROR',
        };
      }

      // 2. Parse feed items with hardened multi-format parser
      const parsedFeed = parseRawFeed(responseText, feedUrl);
      const items = parsedFeed.items || [];
      if (items.length === 0) {
        return {
          isSatisfied: false,
          observedValue: 0,
          details: 'Parsed RSS feed successfully, but no items found.',
        };
      }

      // Only commit HTTP cache headers after feed parsing succeeds with valid items (Issue 9)
      if (pendingEtag || pendingLastModified) {
        this.httpCache.set(subSentinel.id, {
          etag: pendingEtag || undefined,
          lastModified: pendingLastModified || undefined,
        });
      }

      // 3. Process new unseen items (inspect up to 10 unseen items per tick to prevent over-batching and context explosion)
      const evaluatedItems: NormalizedRssItem[] = [];
      const evaluatedHashes: string[] = [];

      for (const item of items) {
        if (evaluatedItems.length >= 10) {
          break; // Defer items 11+ to subsequent evaluation ticks
        }
        const itemHash = item.id || item.link || item.title;
        const isSeen = await seenEventRepository.isEventSeen(subSentinel.id, itemHash);
        if (isSeen) {
          continue; // Skip previously processed event
        }

        evaluatedHashes.push(itemHash);

        // Author filter check (reject if authorFilter configured and author is missing or mismatches)
        if (threshold.authorFilter) {
          if (!item.author || !item.author.toLowerCase().includes(threshold.authorFilter.toLowerCase())) {
            continue;
          }
        }

        evaluatedItems.push(item);
      }

      const commitEvaluatedEvents = async () => {
        for (const hash of evaluatedHashes) {
          try {
            await seenEventRepository.recordSeenEvent(
              randomUUID(),
              subSentinel.id,
              feedUrl,
              hash
            );
          } catch {
            // Ignore duplicate record
          }
        }
      };

      if (evaluatedItems.length === 0) {
        await commitEvaluatedEvents();
        return {
          isSatisfied: false,
          observedValue: 0,
          unit: 'ARTICLES',
          details: `Evaluated ${items.length} items; no new unseen articles discovered.`,
          extraMetadata: {
            feedUrl,
            keywords: threshold.keywords,
            matchedCount: 0,
          },
        };
      }

      const cleanKeywords = (threshold.keywords || [])
        .map((k) => k.trim())
        .filter((k) => k.length > 0 && k !== '*');

      const hasKeywords = cleanKeywords.length > 0;
      const hasSemanticFilter = Boolean(threshold.semanticFilter && threshold.semanticFilter.trim().length > 0);
      const hasIntent = Boolean(rule?.natural_language_intent && rule.natural_language_intent.trim().length > 0);

      // Wildcard bypass: If no keywords or '*', no semantic filter, and no rule intent,
      // user wants notification for any new article in this feed
      if (!hasKeywords && !hasSemanticFilter && !hasIntent) {
        await commitEvaluatedEvents();
        return {
          isSatisfied: true,
          observedValue: evaluatedItems.length,
          unit: 'ARTICLES',
          details: `Found ${evaluatedItems.length} new RSS article(s): "${evaluatedItems[0].title}"`,
          extraMetadata: {
            feedUrl,
            keywords: threshold.keywords,
            matchedCount: evaluatedItems.length,
            topMatch: { title: evaluatedItems[0].title, link: evaluatedItems[0].link },
          },
        };
      }

      // 4. Delegate Evaluation to Strands Agent (replacing brittle regex keyword matching)
      let conditionToEvaluate = threshold.semanticFilter || '';
      if (!conditionToEvaluate) {
        if (hasKeywords) {
          if (threshold.matchMode === 'ALL') {
            conditionToEvaluate = `Determine whether any of these incoming articles discuss or relate to ALL of the following topics: ${cleanKeywords.join(', ')}. Evaluate with semantic comprehension (accounting for synonyms, context, and rejecting negations).`;
          } else if (threshold.matchMode === 'EXACT') {
            conditionToEvaluate = `Determine whether any of these incoming articles specifically and explicitly discuss: "${cleanKeywords.join(' ')}".`;
          } else {
            conditionToEvaluate = `Determine whether any of these incoming articles discuss or relate to: ${cleanKeywords.join(', ')}. Evaluate with semantic comprehension (accounting for synonyms, context, and rejecting negations or irrelevant mentions).`;
          }
        } else if (hasIntent) {
          conditionToEvaluate = rule!.natural_language_intent!;
        } else {
          conditionToEvaluate = 'Determine if any of these incoming articles represent significant updates or notable announcements.';
        }
      }

      const candidateContext = evaluatedItems.map((item) => ({
        title: item.title,
        link: item.link,
        author: item.author,
        pubDate: item.isoDate || item.pubDate,
        snippet: item.contentSnippet,
        categories: item.categories,
      }));

      const agenticResult = await this.agenticEvaluator.evaluate(
        {
          conditionToEvaluate,
          targetSource: `RSS Feed: ${feedUrl}`,
          observedContext: candidateContext,
          extraMetadata: {
            feedUrl,
            keywords: threshold.keywords,
            matchMode: threshold.matchMode,
            batchSize: evaluatedItems.length,
          },
        },
        signal
      );

      if (agenticResult.status === 'ERROR' || agenticResult.error) {
        return {
          isSatisfied: false,
          observedValue: null,
          unit: 'ARTICLES',
          details: `RSS agentic evaluation error: ${agenticResult.reasoning}`,
          error: agenticResult.error || 'AGENTIC_EVALUATION_ERROR',
          extraMetadata: {
            feedUrl,
            agenticResult,
          },
        };
      }

      await commitEvaluatedEvents();

      const conditionSatisfied = agenticResult.conditionSatisfied;
      const details = conditionSatisfied
        ? `[Semantic Match] ${agenticResult.reasoning} Evidence: "${(agenticResult.observedEvidence?.relevantSnippet || '').slice(0, 150)}"`
        : `[Semantic Gate Filtered] ${agenticResult.reasoning}`;

      let matchedItems: NormalizedRssItem[] = [];
      if (conditionSatisfied) {
        if (agenticResult.matchedIndices && agenticResult.matchedIndices.length > 0) {
          matchedItems = agenticResult.matchedIndices
            .filter((idx) => idx >= 0 && idx < evaluatedItems.length)
            .map((idx) => evaluatedItems[idx]);
        }

        // Correlate with evidence snippet or source link if model omitted matchedIndices
        if (matchedItems.length === 0) {
          const snippet = agenticResult.observedEvidence?.relevantSnippet?.toLowerCase() || '';
          const sourceUrl = agenticResult.observedEvidence?.sourceUrl?.toLowerCase() || '';
          const sourceTitle = agenticResult.observedEvidence?.sourceTitle?.toLowerCase() || '';

          matchedItems = evaluatedItems.filter((item) => {
            const itemTitle = (item.title || '').toLowerCase();
            const itemSnippet = (item.contentSnippet || '').toLowerCase();
            const itemLink = (item.link || '').toLowerCase();

            if (sourceUrl && itemLink === sourceUrl) return true;
            if (sourceTitle && itemTitle.includes(sourceTitle)) return true;
            if (snippet && (itemTitle.includes(snippet) || itemSnippet.includes(snippet) || snippet.includes(itemTitle))) {
              return true;
            }
            return false;
          });
        }

        // Guaranteed fallback if semantic match succeeded: at least 1 item matched
        if (matchedItems.length === 0 && evaluatedItems.length > 0) {
          matchedItems = [evaluatedItems[0]];
        }
      }

      const matchedCount = conditionSatisfied ? matchedItems.length : 0;
      const topMatchItem = matchedItems[0] || evaluatedItems[0];

      return {
        isSatisfied: conditionSatisfied,
        observedValue: matchedCount,
        unit: 'ARTICLES',
        details,
        extraMetadata: {
          feedUrl,
          keywords: threshold.keywords,
          semanticFilter: threshold.semanticFilter,
          matchedCount,
          batchSize: evaluatedItems.length,
          topMatch: topMatchItem
            ? { title: topMatchItem.title, link: topMatchItem.link }
            : undefined,
          agenticResult,
        },
      };
    } catch (err: any) {
      return {
        isSatisfied: false,
        observedValue: null,
        details: `RSS evaluation failure: ${err?.message || String(err)}`,
        error: err?.message || 'UNKNOWN_ERROR',
      };
    }
  }
}
