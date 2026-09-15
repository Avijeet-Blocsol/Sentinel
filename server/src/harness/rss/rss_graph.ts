import type {
  RssFeedThreshold,
  DisambiguationCandidate,
} from '@sentinel/shared';
import { parseRawFeed } from './feed_parser.js';
import {
  resolveFromRegistry,
  detectGithubReleaseFeed,
  detectSubredditFeed,
  type CuratedFeedEntry,
} from './feed_registry.js';
import { discoverFeedFromUrl, searchFeedsViaWeb } from './tools/feed_discovery_tool.js';
import {
  validateAndCanonicalizeUrl,
  safeResolveDns,
} from '../deep_web_search/security/url_validator.js';
import { safeFetch } from '../deep_web_search/security/safe_fetch.js';
import {
  type RssResearchTask,
  type RssResearchOutcome,
  type RssHarnessConfig,
  type RssTelemetryEvent,
  type RssFeedDossier,
  type NormalizedRssItem,
  ProviderError,
} from './types.js';
import { getAgentDefaultModel } from '../../agent/sentinel_agent.js';
import { Agent } from '@strands-agents/sdk';

/**
 * Extracts candidate filter keywords from natural language prompts.
 */
export function extractKeywordsFromQuery(query: string): string[] {
  // 1. Quoted terms
  const quoted = query.match(/"([^"]+)"|'([^']+)'/g);
  if (quoted && quoted.length > 0) {
    return quoted.map((q) => q.replace(/['"]/g, '').trim()).filter(Boolean);
  }

  // 2. Terms following target trigger prepositions
  const match = query.match(
    /\b(?:about|regarding|mentions|announces|releasing|releases|keyword|contains|tag)\s+([^,.;]+)/i
  );
  if (match) {
    const parts = match[1]
      .split(/\b(?:and|or)\b|,/i)
      .map((t) => t.trim())
      .filter((t) => t.length > 1 && !/^(the|a|an|updates|news|feed|blog)$/i.test(t));
    if (parts.length > 0) return parts;
  }

  return [];
}

/**
 * Simulates a keyword filter against historical items in a feed using strict word boundaries.
 * Prevents substring false positives (e.g. "art" matching "article") and ignores empty keywords.
 */
export function simulateKeywordFilter(
  items: NormalizedRssItem[],
  keywords: string[],
  matchMode: 'ANY' | 'ALL' | 'EXACT' = 'ANY'
): number {
  if (!keywords || keywords.length === 0 || keywords.includes('*')) {
    return items.length;
  }

  const cleanKeywords = keywords
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k !== '*');

  if (cleanKeywords.length === 0) {
    return 0;
  }

  return items.filter((item) => {
    const corpus = `${item.title} ${item.contentSnippet} ${(item.categories || []).join(' ')}`.toLowerCase();

    if (matchMode === 'EXACT') {
      const phrase = cleanKeywords
        .map((kw) => kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+');
      const regex = new RegExp(`\\b${phrase}\\b`, 'i');
      return regex.test(corpus);
    }

    const regexes = cleanKeywords.map((kw) => {
      return new RegExp(`\\b${kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    });

    if (matchMode === 'ALL') {
      return regexes.every((regex) => regex.test(corpus));
    }

    // Default 'ANY'
    return regexes.some((regex) => regex.test(corpus));
  }).length;
}

/**
 * Matches an article author against an authorFilter string.
 */
export function matchAuthor(author: string | undefined, authorFilter: string): boolean {
  if (!author || !authorFilter) return false;
  const cleanFilter = authorFilter.trim().toLowerCase();
  const cleanAuthor = author.trim().toLowerCase();
  return cleanAuthor.includes(cleanFilter);
}

/**
 * Evaluates semantic filter against feed items using Bedrock/LLM in bounded batches.
 * Fails closed with ProviderError if the LLM throws, returns malformed output, or is unparseable.
 */
export async function evaluateSemanticFilter(
  items: NormalizedRssItem[],
  semanticFilter: string,
  model?: any,
  signal?: AbortSignal
): Promise<boolean[]> {
  if (items.length === 0) return [];
  if (signal?.aborted) {
    throw signal.reason || new Error('Semantic evaluation aborted');
  }

  const defaultModel = model || getAgentDefaultModel();
  const evaluator = new Agent({
    model: defaultModel,
    systemPrompt:
      'You are a semantic filter evaluator for RSS news and articles. Given a semantic filter intent and an article title/snippet, determine if the article satisfies the filter. Return JSON with an array of booleans indicating whether each article matches: {"matches": [true, false, ...]}.',
  });

  const BATCH_SIZE = 10;
  const allMatches: boolean[] = [];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    if (signal?.aborted) {
      throw signal.reason || new Error('Semantic evaluation aborted');
    }

    const batch = items.slice(i, i + BATCH_SIZE);
    const samples = batch.map((it, idx) => ({
      index: i + idx,
      title: it.title,
      snippet: it.contentSnippet,
    }));

    try {
      const response = await evaluator.invoke(
        `Semantic Filter Criteria: "${semanticFilter}"\nArticles to evaluate:\n${JSON.stringify(samples, null, 2)}`
      );

      const msg = (response as any)?.lastMessage || (response as any)?.message;
      const text: string =
        typeof msg?.content === 'string'
          ? msg.content
          : Array.isArray(msg?.content)
          ? msg.content.map((b: any) => b.text || '').join('')
          : typeof (response as any)?.toString === 'function'
          ? (response as any).toString()
          : '';

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new ProviderError(
          'BEDROCK',
          undefined,
          `Semantic evaluation failed: model returned malformed output (no JSON found in "${text.slice(0, 80)}")`
        );
      }

      let parsed: any;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (jsonErr) {
        throw new ProviderError(
          'BEDROCK',
          undefined,
          `Semantic evaluation failed: invalid JSON in model response (${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)})`
        );
      }

      if (!Array.isArray(parsed?.matches) || parsed.matches.length !== batch.length) {
        throw new ProviderError(
          'BEDROCK',
          undefined,
          `Semantic evaluation failed: matches array length (${parsed?.matches?.length}) does not match batch length (${batch.length})`
        );
      }

      for (let j = 0; j < batch.length; j++) {
        const val = parsed.matches[j];
        if (typeof val !== 'boolean') {
          throw new ProviderError(
            'BEDROCK',
            undefined,
            `Semantic evaluation failed: matches[${j}] is not a strict boolean (received ${typeof val})`
          );
        }
        allMatches.push(val);
      }
    } catch (err: unknown) {
      if (signal?.aborted) {
        throw signal.reason || err;
      }
      if (err instanceof ProviderError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError('BEDROCK', undefined, `Semantic evaluation failed: ${msg}`, err);
    }
  }

  return allMatches;
}

/**
 * Executes the complete RSS feed discovery, inspection, and filter simulation graph.
 */
export async function* runRssPipeline(
  task: RssResearchTask,
  config: RssHarnessConfig = {},
  signal?: AbortSignal,
  executionId?: string
): AsyncGenerator<RssTelemetryEvent, RssResearchOutcome, unknown> {
  const taskId = task.id;
  const timeoutMs = config.timeoutMs ?? 10000;
  const maxCandidates = config.maxCandidates ?? 5;

  yield {
    taskId,
    executionId,
    step: 'RSS_START',
    message: `Initiating RSS feed reconnaissance for query: "${task.query}"`,
    timestamp: Date.now(),
  };

  if (signal?.aborted) throw new Error('Research cancelled by user');

  // Validate expectedOperator: Reject unsupported operators for RSS feeds
  if (task.expectedOperator) {
    const supportedOperators = ['KEYWORD_MATCH', 'SEMANTIC_MATCH', 'EQUALS'];
    if (!supportedOperators.includes(task.expectedOperator)) {
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Unsupported expectedOperator "${task.expectedOperator}" for RSS feed monitoring.`,
        data: { expectedOperator: task.expectedOperator },
        timestamp: Date.now(),
      };

      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: `Unsupported operator "${task.expectedOperator}" for RSS feeds. Document streams only support KEYWORD_MATCH, SEMANTIC_MATCH, and EQUALS.`,
        suggestion: 'Use KEYWORD_MATCH or SEMANTIC_MATCH for RSS feed reconnaissance.',
      };
    }
  }

  // Parse extracted keywords & parameters
  const activeKeywords =
    task.keywords && task.keywords.length > 0
      ? task.keywords
      : extractKeywordsFromQuery(task.query);
  const matchMode = task.matchMode || 'ANY';

  yield {
    taskId,
    executionId,
    step: 'RESOLVING_FEED',
    message: `Analyzing query intent and checking curated feed registries...`,
    data: { activeKeywords, matchMode },
    timestamp: Date.now(),
  };

  let candidateFeedUrl: string | null = task.feedUrl || null;
  let feedTitleOverride: string | null = null;
  let siteUrlOverride: string | null = null;
  let matchedRegistryEntry: CuratedFeedEntry | null = null;

  // 1. Check if direct URL was in the query text
  if (!candidateFeedUrl) {
    const directUrlMatch = task.query.match(/https?:\/\/[^\s"'>]+/i);
    if (directUrlMatch) {
      candidateFeedUrl = directUrlMatch[0];
    }
  }

  // Validate direct candidate URL with SSRF guard
  if (candidateFeedUrl) {
    const urlVal = validateAndCanonicalizeUrl(candidateFeedUrl, {
      allowPrivateForTesting: config.allowPrivateForTesting,
    });
    if (!urlVal.valid) {
      throw new Error(`[SSRF Guard] Blocked unsafe URL "${candidateFeedUrl}": ${urlVal.error}`);
    }
    if (!config.allowPrivateForTesting) {
      const parsedUrl = new URL(urlVal.canonicalUrl!);
      const dnsCheck = await safeResolveDns(parsedUrl.hostname);
      if (!dnsCheck.safe) {
        throw new Error(`[SSRF Guard] Blocked host "${parsedUrl.hostname}": ${dnsCheck.error}`);
      }
    }
    candidateFeedUrl = urlVal.canonicalUrl!;
  }

  // 2. Check specialized pattern detectors (GitHub releases, Subreddits)
  if (!candidateFeedUrl) {
    const ghFeed = detectGithubReleaseFeed(task.query);
    if (ghFeed) candidateFeedUrl = ghFeed;
  }

  if (!candidateFeedUrl) {
    const redditFeed = detectSubredditFeed(task.query);
    if (redditFeed) candidateFeedUrl = redditFeed;
  }

  // 3. Check Curated Feeds Registry
  if (!candidateFeedUrl) {
    const registryMatches = resolveFromRegistry(task.query);

    if (registryMatches.length > 1) {
      const candidates: DisambiguationCandidate[] = registryMatches.slice(0, maxCandidates).map((m) => ({
        id: m.id,
        title: m.name,
        currentValue: 'Active Feed',
        context: `${m.category.replace(/_/g, ' ')} • ${m.feedUrl}`,
        metadata: { feedUrl: m.feedUrl, siteUrl: m.siteUrl, aliases: m.aliases },
      }));

      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_COMPLETE',
        message: `Multiple curated feeds matched. Requesting user selection.`,
        data: { matchCount: candidates.length },
        timestamp: Date.now(),
      };

      return {
        status: 'MULTIPLE_OPTIONS',
        taskId,
        query: task.query,
        message: `Multiple relevant feeds found for "${task.query}". Please select the target stream:`,
        candidates,
      };
    }

    if (registryMatches.length === 1) {
      matchedRegistryEntry = registryMatches[0];
      candidateFeedUrl = matchedRegistryEntry.feedUrl;
      feedTitleOverride = matchedRegistryEntry.name;
      siteUrlOverride = matchedRegistryEntry.siteUrl;
    }
  }

  // 4. Web Search fallback for unindexed brands/blogs
  if (!candidateFeedUrl) {
    yield {
      taskId,
      executionId,
      step: 'RESOLVING_FEED',
      message: `Searching the web for RSS/Atom feeds matching "${task.query}"...`,
      timestamp: Date.now(),
    };

    let webResults: Array<{ url: string; title: string; snippet: string }> = [];
    try {
      webResults = await searchFeedsViaWeb(task.query, maxCandidates, {
        signal,
        timeoutMs,
      });
    } catch (searchErr: unknown) {
      if (signal?.aborted) throw searchErr;
      const errMsg = searchErr instanceof Error ? searchErr.message : String(searchErr);
      if (errMsg.includes('timed out') || errMsg.includes('abort')) {
        throw searchErr;
      }
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Web search discovery failed: ${errMsg}`,
        data: { error: errMsg },
        timestamp: Date.now(),
      };
      throw searchErr instanceof ProviderError
        ? searchErr
        : new ProviderError('WEB_SEARCH', undefined, errMsg, searchErr);
    }

    // Validate candidates iteratively until a valid feed or feed-containing page is found
    for (const hit of webResults) {
      if (signal?.aborted) throw new Error('Research cancelled by user');

      const urlVal = validateAndCanonicalizeUrl(hit.url, {
        allowPrivateForTesting: config.allowPrivateForTesting,
      });
      if (!urlVal.valid) continue;

      if (!config.allowPrivateForTesting) {
        try {
          const parsedHit = new URL(urlVal.canonicalUrl!);
          const dnsCheck = await safeResolveDns(parsedHit.hostname);
          if (!dnsCheck.safe) continue;
        } catch {
          continue;
        }
      }

      const hitUrl = urlVal.canonicalUrl!;
      const isDirect =
        /\.(xml|rss|atom|json)(\?|$)/i.test(hitUrl) ||
        hitUrl.includes('/rss') ||
        hitUrl.includes('/feed');

      if (isDirect) {
        candidateFeedUrl = hitUrl;
        break;
      }

      // Try sniffing HTML <link> tags from the page
      try {
        const discovered = await discoverFeedFromUrl(hitUrl, {
          timeoutMs: Math.min(timeoutMs, 4000),
          signal,
          allowPrivateForTesting: config.allowPrivateForTesting,
        });

        if (discovered.length > 0) {
          candidateFeedUrl = discovered[0].feedUrl;
          break;
        }
      } catch (hitErr: unknown) {
        if (signal?.aborted) throw hitErr;
        // Third-party candidate link could be unreachable or invalid; try next candidate
        continue;
      }
    }
  }

  if (!candidateFeedUrl) {
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Unable to locate an RSS/Atom feed for "${task.query}".`,
      timestamp: Date.now(),
    };

    return {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: `No public RSS, Atom, or JSON feed could be found for "${task.query}".`,
      suggestion: 'Try providing a direct blog URL (e.g. https://company.com/blog) or specific RSS link.',
    };
  }

  if (signal?.aborted) throw new Error('Research cancelled by user');

  // 5. If the URL is an HTML webpage rather than a direct XML endpoint, sniff <link> tags
  const isDirectFeedUrl =
    /\.(xml|rss|atom|json)(\?|$)/i.test(candidateFeedUrl) ||
    candidateFeedUrl.includes('action=getcurrent') ||
    candidateFeedUrl.includes('/rss') ||
    candidateFeedUrl.includes('/feed');

  let targetFeedUrl = candidateFeedUrl;

  if (!isDirectFeedUrl) {
    yield {
      taskId,
      executionId,
      step: 'SNIFFING_HTML',
      message: `Probing webpage ${candidateFeedUrl} for RSS/Atom <link> auto-discovery tags...`,
      data: { candidateFeedUrl },
      timestamp: Date.now(),
    };

    try {
      const discoveredFeeds = await discoverFeedFromUrl(candidateFeedUrl, {
        timeoutMs,
        signal,
        allowPrivateForTesting: config.allowPrivateForTesting,
      });
      if (discoveredFeeds.length > 0) {
        targetFeedUrl = discoveredFeeds[0].feedUrl;
        yield {
          taskId,
          executionId,
          step: 'SNIFFING_HTML',
          message: `Auto-discovered feed endpoint: ${targetFeedUrl}`,
          data: { targetFeedUrl },
          timestamp: Date.now(),
        };
      }
    } catch (sniffErr: unknown) {
      if (signal?.aborted) throw sniffErr;
      const errMsg = sniffErr instanceof Error ? sniffErr.message : String(sniffErr);
      if (errMsg.includes('timed out') || errMsg.includes('abort')) {
        throw sniffErr;
      }
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Failed to probe webpage ${candidateFeedUrl}: ${errMsg}`,
        data: { error: errMsg },
        timestamp: Date.now(),
      };
      throw sniffErr instanceof ProviderError
        ? sniffErr
        : new ProviderError('FEED_DISCOVERY', undefined, errMsg, sniffErr);
    }
  }

  if (signal?.aborted) throw new Error('Research cancelled by user');

  // 6. Fetch Feed Contents with safeFetch (SSRF protected)
  yield {
    taskId,
    executionId,
    step: 'FETCHING_FEED',
    message: `Fetching live feed payload from ${targetFeedUrl}...`,
    data: { targetFeedUrl },
    timestamp: Date.now(),
  };

  let rawFeedText = '';
  let etagHeader: string | undefined;
  let lastModifiedHeader: string | undefined;

  try {
    const res = await safeFetch(targetFeedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Sentinel-RSS-Inspector/1.0 (+https://sentinel.blocsol.com)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      signal,
      timeoutMs,
      allowPrivateForTesting: config.allowPrivateForTesting,
    });

    if (!res.ok) {
      throw new ProviderError('RSS_FETCHER', res.status, `HTTP ${res.status} ${res.statusText} from ${targetFeedUrl}`);
    }

    etagHeader = res.headers.get('etag') || undefined;
    lastModifiedHeader = res.headers.get('last-modified') || undefined;
    rawFeedText = await res.text();
  } catch (fetchErr: unknown) {
    if (signal?.aborted) {
      throw fetchErr;
    }

    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    if (errMsg.includes('timed out') || errMsg.includes('abort')) {
      throw fetchErr;
    }

    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Failed to fetch feed from ${targetFeedUrl}: ${errMsg}`,
      data: { error: errMsg },
      timestamp: Date.now(),
    };

    throw new ProviderError('RSS_FETCHER', undefined, errMsg, fetchErr);
  }

  // 7. Parse Feed
  yield {
    taskId,
    executionId,
    step: 'PARSING_FEED',
    message: `Validating feed schema and extracting articles...`,
    timestamp: Date.now(),
  };

  const parsed = parseRawFeed(rawFeedText, targetFeedUrl);
  if (parsed.items.length === 0) {
    return {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: `The feed at ${targetFeedUrl} was reached, but contained 0 articles or unsupported XML structure.`,
      suggestion: 'Verify that this feed is actively publishing entries.',
    };
  }

  // 8. Simulate Filtering on recent articles
  yield {
    taskId,
    executionId,
    step: 'SIMULATING_FILTER',
    message: `Simulating filter criteria against ${parsed.items.length} recent articles...`,
    data: {
      activeKeywords,
      matchMode,
      authorFilter: task.authorFilter,
      semanticFilter: task.semanticFilter,
    },
    timestamp: Date.now(),
  };

  // Evaluate authorFilter if declared
  if (task.authorFilter) {
    const authorMatches = parsed.items.filter((item) => matchAuthor(item.author, task.authorFilter!));
    if (authorMatches.length === 0) {
      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: `Feed at ${targetFeedUrl} was reached with ${parsed.items.length} articles, but none matched author filter "${task.authorFilter}".`,
        suggestion: 'Verify the author name or remove authorFilter.',
      };
    }
  }

  // Evaluate semanticFilter if declared
  let semanticMatches: boolean[] | undefined;
  if (task.semanticFilter) {
    yield {
      taskId,
      executionId,
      step: 'SIMULATING_FILTER',
      message: `Evaluating semantic filter "${task.semanticFilter}" across ${parsed.items.length} articles...`,
      data: { semanticFilter: task.semanticFilter, itemCount: parsed.items.length },
      timestamp: Date.now(),
    };

    try {
      if (config.semanticEvaluator) {
        semanticMatches = await config.semanticEvaluator(parsed.items, task.semanticFilter);
        if (!Array.isArray(semanticMatches)) {
          throw new ProviderError(
            'SEMANTIC_EVALUATOR',
            undefined,
            'Custom semanticEvaluator returned malformed result: expected boolean array'
          );
        }
      } else {
        const hasBedrockOrMantle = !!(
          process.env.AWS_BEDROCK_MANTLE_KEY ||
          (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
          process.env.AWS_PROFILE
        );
        if (!hasBedrockOrMantle) {
          return {
            status: 'NOT_FOUND',
            taskId,
            query: task.query,
            reason: `Semantic filter evaluation requested ("${task.semanticFilter}") but no Bedrock/LLM credentials are configured. Unsupported filter rejected.`,
            suggestion: 'Configure AWS Bedrock credentials or use keyword filtering instead.',
          };
        }
        semanticMatches = await evaluateSemanticFilter(parsed.items, task.semanticFilter, undefined, signal);
      }
    } catch (semErr: unknown) {
      if (signal?.aborted) throw semErr;
      const errMsg = semErr instanceof Error ? semErr.message : String(semErr);
      if (errMsg.includes('timed out') || errMsg.includes('abort')) {
        throw semErr;
      }
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Semantic filter evaluation failed: ${errMsg}`,
        data: { error: errMsg },
        timestamp: Date.now(),
      };
      throw semErr instanceof ProviderError
        ? semErr
        : new ProviderError('BEDROCK', undefined, errMsg, semErr);
    }
  }

  // Combined item filter simulation
  const matchedItems = parsed.items.filter((item, idx) => {
    if (activeKeywords.length > 0 && !activeKeywords.includes('*')) {
      const count = simulateKeywordFilter([item], activeKeywords, matchMode);
      if (count === 0) return false;
    }
    if (task.authorFilter && !matchAuthor(item.author, task.authorFilter)) {
      return false;
    }
    if (semanticMatches && !semanticMatches[idx]) {
      return false;
    }
    return true;
  });

  const matchedHistoricalCount = matchedItems.length;

  // If user requested specific keyword/author/semantic filters and 0 historical items matched
  const hasSpecificFilters =
    (activeKeywords.length > 0 && !activeKeywords.includes('*')) ||
    !!task.authorFilter ||
    !!task.semanticFilter;

  if (hasSpecificFilters && matchedHistoricalCount === 0) {
    return {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: `Feed at ${targetFeedUrl} contains ${parsed.items.length} articles, but none matched the combined filter criteria.`,
      suggestion: 'Broaden keywords or relax author/semantic filters.',
    };
  }

  // 9. Build Verified Contract & Dossier
  const contract: RssFeedThreshold = {
    feedUrl: targetFeedUrl,
    keywords: activeKeywords.length > 0 ? activeKeywords : ['*'],
    matchMode,
    authorFilter: task.authorFilter,
    semanticFilter: task.semanticFilter,
  };

  const dossier: RssFeedDossier = {
    title: feedTitleOverride || parsed.title,
    feedUrl: targetFeedUrl,
    siteUrl: siteUrlOverride || parsed.siteUrl,
    description: parsed.description,
    format: parsed.format,
    itemCount: parsed.items.length,
    lastBuildDate: parsed.lastBuildDate || (parsed.items[0]?.pubDate > 0 ? parsed.items[0].pubDate : undefined),
    sampleItems: parsed.items.slice(0, 3),
    suggestedTtlSeconds: matchedRegistryEntry?.suggestedTtlSeconds || parsed.suggestedTtlSeconds || 300,
    matchedHistoricalCount,
    etag: etagHeader,
    lastModified: lastModifiedHeader,
    contract,
  };

  yield {
    taskId,
    executionId,
    step: 'DISCOVERY_COMPLETE',
    message: `Successfully verified feed "${dossier.title}" (${dossier.format}) with ${dossier.itemCount} items.`,
    data: { dossier },
    timestamp: Date.now(),
  };

  const latestTitle = parsed.items[0]?.title || 'Latest article';
  const filterParts: string[] = [];
  if (activeKeywords.length > 0 && !activeKeywords.includes('*')) {
    filterParts.push(`keywords [${activeKeywords.join(', ')}]`);
  }
  if (task.authorFilter) {
    filterParts.push(`author "${task.authorFilter}"`);
  }
  if (task.semanticFilter) {
    filterParts.push(`semantic "${task.semanticFilter}"`);
  }
  const filterDesc =
    filterParts.length > 0
      ? `Filtered by ${filterParts.join(', ')} (${matchedHistoricalCount}/${parsed.items.length} recent items matched)`
      : `All items monitored (${parsed.items.length} recent)`;

  return {
    status: 'EXACT_MATCH',
    taskId,
    query: task.query,
    contract,
    dossier,
    currentDisplayValue: `${dossier.title} • Latest: "${latestTitle}"`,
    verificationDetails: `${parsed.format} stream verified. ${filterDesc}. Suggested polling interval: ${dossier.suggestedTtlSeconds}s.`,
    confidence: 0.98,
  };
}
