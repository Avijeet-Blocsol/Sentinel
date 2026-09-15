import * as cheerio from 'cheerio';
import { Agent } from '@strands-agents/sdk';
import type {
  TelegramChannelThreshold,
  DisambiguationCandidate,
  SentinelOperator,
} from '@sentinel/shared';
import { getAgentDefaultModel } from '../../agent/sentinel_agent.js';
import { TelegramPublicClient, TelegramClientError } from './client.js';
import {
  ProviderError,
  type TelegramResearchTask,
  type TelegramResearchOutcome,
  type TelegramTelemetryEvent,
  type TelegramHarnessConfig,
  type TelegramParsedMessage,
  type TelegramDossier,
  type SimulationVerdict,
} from './types.js';

/**
 * ==========================================================
 * TELEGRAM CHANNEL RESEARCH PIPELINE
 * ==========================================================
 * Orchestrates channel resolution, public verification,
 * sample post extraction, and keyword + semantic simulation.
 */

export interface ParsedTelegramQuery {
  handle?: string;
  keywords: string[];
  matchMode: 'ANY' | 'ALL' | 'EXACT';
  explicitMatchMode: boolean;
  matchModeConflictDetected?: string;
  minViews?: number;
  mediaOnly: boolean;
  semanticFilter?: string;
  expectedOperator: SentinelOperator;
}

export function parseTelegramQuery(task: TelegramResearchTask): ParsedTelegramQuery {
  const query = task.query;

  // 1. Resolve channel handle from task parameter or query patterns
  let handle = task.channelHandle;
  if (!handle) {
    const atMatch = query.match(/@([a-zA-Z0-9_]{3,64})/);
    if (atMatch) {
      handle = atMatch[1];
    } else {
      const linkMatch = query.match(/t\.me\/(?:s\/)?([a-zA-Z0-9_]{3,64})/i);
      if (linkMatch) {
        handle = linkMatch[1];
      }
    }
  }

  // 2. Resolve keywords
  let keywords = task.keywords ? [...task.keywords] : [];
  if (keywords.length === 0) {
    const quoted = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim());
    if (quoted.length > 0) {
      keywords = quoted;
    } else {
      const tokens = query
        .replace(/@\w+/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(
          /\b(alert|watch|monitor|channel|telegram|when|posts|notify|me|for|the|any|new)\b/gi,
          ''
        )
        .split(/\s+/)
        .map((t) => t.replace(/[^a-zA-Z0-9$]/g, '').trim())
        .filter((t) => t.length >= 2);

      if (tokens.length > 0) {
        keywords = [tokens[0]];
      }
    }
  }

  if (keywords.length === 0) {
    keywords = ['update'];
  }

  // 3. Resolve Match Mode: Explicit task.matchMode takes precedence
  let matchMode: 'ANY' | 'ALL' | 'EXACT' = 'ANY';
  let explicitMatchMode = false;
  let matchModeConflictDetected: string | undefined;

  let queryInferredMode: 'ANY' | 'ALL' | 'EXACT' = 'ANY';
  if (/\b(all keywords|all of|contains all)\b/i.test(query)) {
    queryInferredMode = 'ALL';
  } else if (/\b(exact phrase|exact match|exactly)\b/i.test(query)) {
    queryInferredMode = 'EXACT';
  }

  if (task.matchMode) {
    matchMode = task.matchMode;
    explicitMatchMode = true;
    if (task.matchMode !== queryInferredMode && queryInferredMode !== 'ANY') {
      matchModeConflictDetected = `Explicit matchMode "${task.matchMode}" takes precedence over query wording suggesting "${queryInferredMode}"`;
    }
  } else {
    matchMode = queryInferredMode;
  }

  // 4. Resolve Min Views
  let minViews = task.minViews;
  if (minViews === undefined) {
    const viewsMatch = query.match(/(\d+[\d,]*)\s*(?:views|impressions)/i);
    if (viewsMatch) {
      minViews = parseInt(viewsMatch[1].replace(/,/g, ''), 10);
    }
  }

  // 5. Resolve Media Only
  const mediaOnly =
    task.mediaOnly ??
    /\b(media only|with photos|with images|has media|with video)\b/i.test(query);

  // 6. Semantic Filter
  const semanticFilter = task.semanticFilter;

  // 7. Expected Operator: derive from presence of semanticFilter or explicit input
  let expectedOperator: SentinelOperator = 'KEYWORD_MATCH';
  if (task.expectedOperator) {
    expectedOperator = task.expectedOperator;
  } else if (semanticFilter) {
    expectedOperator = 'SEMANTIC_MATCH';
  }

  return {
    handle,
    keywords,
    matchMode,
    explicitMatchMode,
    matchModeConflictDetected,
    minViews,
    mediaOnly,
    semanticFilter,
    expectedOperator,
  };
}

/**
 * Checks if a message text matches the given keywords under the specified mode.
 * Uses strict word boundaries (\b) to avoid substring false positives.
 */
export function matchesKeywords(
  text: string,
  keywords: string[],
  mode: 'ANY' | 'ALL' | 'EXACT'
): boolean {
  if (!text || keywords.length === 0) return false;

  if (mode === 'EXACT') {
    const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  }

  const regexes = keywords.map(
    (k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  );

  if (mode === 'ALL') {
    return regexes.every((rx) => rx.test(text));
  }

  return regexes.some((rx) => rx.test(text));
}

/**
 * Evaluates semantic filter against message texts using Bedrock in bounded batches.
 * Fails closed with ProviderError if LLM throws or returns malformed output.
 */
export async function evaluateTelegramSemanticFilter(
  messages: TelegramParsedMessage[],
  semanticFilter: string,
  model?: any,
  signal?: AbortSignal
): Promise<boolean[]> {
  if (messages.length === 0) return [];
  if (signal?.aborted) {
    throw signal.reason || new Error('Semantic evaluation aborted');
  }

  let defaultModel;
  try {
    defaultModel = model || getAgentDefaultModel();
  } catch (err: unknown) {
    throw new ProviderError(
      'BEDROCK',
      undefined,
      `Semantic evaluation failed: could not initialize model (${
        err instanceof Error ? err.message : String(err)
      })`,
      err
    );
  }

  const evaluator = new Agent({
    model: defaultModel,
    systemPrompt:
      'You are a strict semantic gate evaluator for Telegram broadcast messages. Given a natural language semantic filter intent and an array of message texts, determine whether each message satisfies the criteria. Return ONLY a valid JSON object matching: {"matches": [true, false, ...]}.',
  });

  const BATCH_SIZE = 10;
  const allMatches: boolean[] = [];

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    if (signal?.aborted) {
      throw signal.reason || new Error('Semantic evaluation aborted');
    }

    const batch = messages.slice(i, i + BATCH_SIZE);
    const samples = batch.map((m, idx) => ({
      index: i + idx,
      messageId: m.messageId,
      text: m.text.slice(0, 500),
    }));

    try {
      const response = await evaluator.invoke(
        `Semantic Filter Criteria: "${semanticFilter}"\nMessages to evaluate:\n${JSON.stringify(
          samples,
          null,
          2
        )}`,
        { cancelSignal: signal }
      );

      if (signal?.aborted) {
        throw signal.reason || new Error('Semantic evaluation aborted');
      }

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
          `Semantic evaluation failed: model returned malformed output (no JSON found in "${text.slice(
            0,
            80
          )}")`
        );
      }

      let parsed: any;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (jsonErr) {
        throw new ProviderError(
          'BEDROCK',
          undefined,
          `Semantic evaluation failed: invalid JSON in model response (${
            jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
          })`
        );
      }

      if (!Array.isArray(parsed?.matches)) {
        throw new ProviderError(
          'BEDROCK',
          undefined,
          'Semantic evaluation failed: response JSON missing "matches" boolean array'
        );
      }

      if (parsed.matches.length !== batch.length) {
        throw new ProviderError(
          'BEDROCK',
          undefined,
          `Semantic evaluation failed: batch length mismatch (expected ${batch.length} matches, received ${parsed.matches.length})`
        );
      }

      for (let j = 0; j < batch.length; j++) {
        const item = parsed.matches[j];
        if (typeof item !== 'boolean') {
          throw new ProviderError(
            'BEDROCK',
            undefined,
            `Semantic evaluation failed: matches array contains non-boolean value (${JSON.stringify(item)}) at index ${j}`
          );
        }
        allMatches.push(item);
      }
    } catch (err: unknown) {
      if (signal?.aborted) {
        throw signal.reason || new Error('Semantic evaluation aborted');
      }
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        'BEDROCK',
        undefined,
        `Semantic evaluation invocation failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err
      );
    }
  }

  return allMatches;
}

/**
 * Searches DuckDuckGo for public Telegram channels with cancellation signal and explicit timeout.
 * Employs native abortable fetch so in-flight network requests are strictly cancelled upon signal abort.
 */
export async function searchChannelsViaWeb(
  query: string,
  limit = 5,
  signal?: AbortSignal,
  timeoutMs = 6000
): Promise<Array<{ handle: string; title: string; snippet: string }>> {
  if (signal?.aborted) {
    throw signal.reason || new Error('Search cancelled before execution');
  }

  const cleanedQuery = query
    .replace(/\b(watch|monitor|alert|channel|telegram)\b/gi, '')
    .trim();
  const searchQuery = `site:t.me/s/ ${cleanedQuery}`;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error(`DuckDuckGo search timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let mergedSignal: AbortSignal;
  if (signal) {
    if (typeof AbortSignal.any === 'function') {
      mergedSignal = AbortSignal.any([signal, timeoutController.signal]);
    } else {
      const bridge = new AbortController();
      signal.addEventListener('abort', () => bridge.abort(signal.reason), { once: true });
      timeoutController.signal.addEventListener(
        'abort',
        () => bridge.abort(timeoutController.signal.reason),
        { once: true }
      );
      mergedSignal = bridge.signal;
    }
  } else {
    mergedSignal = timeoutController.signal;
  }

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
    const res = await fetch(url, {
      signal: mergedSignal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo search HTTP ${res.status}`);
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const candidates: Array<{ handle: string; title: string; snippet: string }> = [];
    const seenHandles = new Set<string>();

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

      const match =
        finalUrl.match(/t\.me\/s\/([a-zA-Z0-9_]{3,64})/i) ||
        finalUrl.match(/t\.me\/([a-zA-Z0-9_]{3,64})/i);
      if (match) {
        const handle = match[1].toLowerCase();
        if (!seenHandles.has(handle) && handle !== 's' && handle !== 'joinchat') {
          seenHandles.add(handle);
          const title =
            titleEl.text().replace(/\s*[–-]\s*Telegram.*$/i, '').trim() || `@${handle}`;
          const snippet = snippetEl.text().trim();
          candidates.push({ handle, title, snippet });
        }
      }
      if (candidates.length >= limit) return false;
    });

    return candidates;
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw signal.reason || new Error('Search aborted by caller');
    }
    if (timeoutController.signal.aborted) {
      throw new ProviderError('DUCKDUCKGO', undefined, `Search timed out after ${timeoutMs}ms`);
    }
    throw new ProviderError(
      'DUCKDUCKGO',
      undefined,
      `Web search provider failure: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Executes the Telegram Open Channel research pipeline as an AsyncGenerator.
 */
export async function* runTelegramPipeline(
  task: TelegramResearchTask,
  config: TelegramHarnessConfig = {},
  signal?: AbortSignal,
  executionId?: string
): AsyncGenerator<TelegramTelemetryEvent, TelegramResearchOutcome, unknown> {
  const taskId = task.id;
  const client = new TelegramPublicClient();

  if (signal?.aborted) {
    throw signal.reason || new Error('Task aborted prior to start');
  }

  // 1. Initial Telemetry
  yield {
    taskId,
    executionId,
    step: 'TELEGRAM_START',
    message: `Starting discovery for Telegram intent: "${task.query}"`,
    data: { query: task.query },
    timestamp: Date.now(),
  };

  const parsed = parseTelegramQuery(task);

  if (parsed.matchModeConflictDetected) {
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_WARNING',
      message: parsed.matchModeConflictDetected,
      data: { matchMode: parsed.matchMode },
      timestamp: Date.now(),
    };
  }

  // 2. Channel Resolution
  let targetHandle = parsed.handle;

  yield {
    taskId,
    executionId,
    step: 'RESOLVING_CHANNEL',
    message: targetHandle
      ? `Resolving channel handle: @${targetHandle}`
      : `Searching for public Telegram channels matching "${task.query}"`,
    data: { handle: targetHandle },
    timestamp: Date.now(),
  };

  if (signal?.aborted) {
    throw signal.reason || new Error('Aborted during channel resolution');
  }

  // If handle is missing, search via Web search
  if (!targetHandle) {
    let webCandidates: Array<{ handle: string; title: string; snippet: string }> = [];
    try {
      webCandidates = await searchChannelsViaWeb(
        task.query,
        config.maxCandidates ?? 5,
        signal,
        config.timeoutMs ? Math.min(config.timeoutMs, 6000) : 6000
      );
    } catch (err: unknown) {
      if (signal?.aborted) throw signal.reason || err;
      if (err instanceof ProviderError) {
        return {
          status: 'ERROR',
          taskId,
          executionId,
          query: task.query,
          error: err.message,
          provider: err.provider,
          details: { error: String(err) },
        };
      }
      throw err;
    }

    if (webCandidates.length === 0) {
      return {
        status: 'NOT_FOUND',
        taskId,
        executionId,
        query: task.query,
        reason: 'Could not find any public Telegram channels matching the query.',
        suggestion:
          'Please specify the channel handle directly using "@channel_name" or provide a "t.me/s/channel" link.',
      };
    }

    if (webCandidates.length > 1) {
      const disambiguationCandidates: DisambiguationCandidate[] = webCandidates.map((c) => ({
        id: c.handle,
        title: c.title,
        currentValue: `@${c.handle}`,
        context: c.snippet,
        metadata: { handle: c.handle, source: 'DUCKDUCKGO' },
      }));

      return {
        status: 'MULTIPLE_OPTIONS',
        taskId,
        executionId,
        query: task.query,
        message: `Found multiple public Telegram channels matching "${task.query}". Please select one:`,
        candidates: disambiguationCandidates,
      };
    }

    targetHandle = webCandidates[0].handle;
  }

  if (signal?.aborted) {
    throw signal.reason || new Error('Aborted before fetching channel');
  }

  // 3. Fetch Channel Public SSR Preview & Validate
  let fetchResult;
  try {
    fetchResult = await client.fetchChannel(targetHandle, { signal });
  } catch (err: unknown) {
    if (signal?.aborted) throw signal.reason || err;

    if (err instanceof TelegramClientError) {
      // Differentiate genuine NOT_FOUND from network/rate-limit/server errors
      if (
        err.code === 'RATE_LIMITED' ||
        err.code === 'SERVER_ERROR' ||
        err.code === 'NETWORK_ERROR' ||
        err.code === 'HTTP_ERROR' ||
        err.code === 'MALFORMED_PAGE'
      ) {
        return {
          status: 'ERROR',
          taskId,
          executionId,
          query: task.query,
          error: err.message,
          provider: 'TELEGRAM',
          details: { code: err.code, statusCode: err.statusCode },
        };
      }

      return {
        status: 'NOT_FOUND',
        taskId,
        executionId,
        query: task.query,
        reason: err.message,
        suggestion:
          err.code === 'USER_OR_GROUP_PROFILE'
            ? 'Make sure the target is a broadcast channel, not a private group or personal user.'
            : err.code === 'PRIVATE_INVITE_ONLY'
            ? 'Sentinel can only monitor open public channels with a public t.me/s feed.'
            : 'Please double-check the channel handle spelling and try again.',
      };
    }

    throw err;
  }

  if (signal?.aborted) {
    throw signal.reason || new Error('Aborted after fetching channel');
  }

  yield {
    taskId,
    executionId,
    step: 'CHANNEL_RESOLVED',
    message: `Verified public channel "${fetchResult.metadata.title}" (@${fetchResult.metadata.handle}) with ${
      fetchResult.metadata.subscribersDisplay || 'active'
    } subscribers`,
    data: { metadata: fetchResult.metadata },
    timestamp: Date.now(),
  };

  // 4. Ingest Sample Posts & Simulate Keyword Filters
  yield {
    taskId,
    executionId,
    step: 'FETCHING_SAMPLE_POSTS',
    message: `Ingested ${fetchResult.messages.length} recent broadcast messages from @${fetchResult.metadata.handle}`,
    data: { totalMessages: fetchResult.messages.length },
    timestamp: Date.now(),
  };

  yield {
    taskId,
    executionId,
    step: 'SIMULATING_FILTER',
    message: `Simulating criteria (Keywords: [${parsed.keywords.join(', ')}], Mode: ${
      parsed.matchMode
    }) against sample posts`,
    data: {
      keywords: parsed.keywords,
      matchMode: parsed.matchMode,
      minViews: parsed.minViews,
      mediaOnly: parsed.mediaOnly,
    },
    timestamp: Date.now(),
  };

  // Filter evaluation against sample posts (already sorted newest-first by client)
  const keywordMatchedPosts: TelegramParsedMessage[] = [];
  for (const post of fetchResult.messages) {
    if (parsed.mediaOnly && !post.hasMedia) continue;
    if (parsed.minViews && (post.views ?? 0) < parsed.minViews) continue;

    if (matchesKeywords(post.text, parsed.keywords, parsed.matchMode)) {
      keywordMatchedPosts.push(post);
    }
  }

  // 5. Evaluate Semantic Filter if present
  let finalMatchedPosts = keywordMatchedPosts;
  let sampleSemanticMatchedCount: number | undefined;

  if (parsed.semanticFilter) {
    yield {
      taskId,
      executionId,
      step: 'SIMULATING_SEMANTIC_FILTER',
      message: `Evaluating semantic filter "${parsed.semanticFilter}" across ${keywordMatchedPosts.length} keyword-matched sample posts...`,
      data: {
        semanticFilter: parsed.semanticFilter,
        candidateCount: keywordMatchedPosts.length,
      },
      timestamp: Date.now(),
    };

    if (signal?.aborted) {
      throw signal.reason || new Error('Aborted before semantic evaluation');
    }

    try {
      const semanticFlags = config.semanticEvaluator
        ? await config.semanticEvaluator(keywordMatchedPosts, parsed.semanticFilter, signal)
        : await evaluateTelegramSemanticFilter(
            keywordMatchedPosts,
            parsed.semanticFilter,
            undefined,
            signal
          );

      finalMatchedPosts = keywordMatchedPosts.filter((_, idx) => semanticFlags[idx]);
      sampleSemanticMatchedCount = finalMatchedPosts.length;
    } catch (err: unknown) {
      if (signal?.aborted) throw signal.reason || err;
      if (err instanceof ProviderError) {
        return {
          status: 'ERROR',
          taskId,
          executionId,
          query: task.query,
          error: err.message,
          provider: err.provider,
          details: { error: String(err) },
        };
      }
      return {
        status: 'ERROR',
        taskId,
        executionId,
        query: task.query,
        error: `Semantic filter evaluation error: ${
          err instanceof Error ? err.message : String(err)
        }`,
        provider: 'BEDROCK',
      };
    }
  }

  // 6. Construct Dossier & Contract
  const contract: TelegramChannelThreshold = {
    channelHandle: `@${fetchResult.metadata.handle}`,
    keywords: parsed.keywords,
    matchMode: parsed.matchMode,
    minViews: parsed.minViews,
    mediaOnly: parsed.mediaOnly,
    semanticFilter: parsed.semanticFilter,
  };

  const totalRecentAnalyzed = fetchResult.messages.length;
  const sampleMatchRate =
    totalRecentAnalyzed > 0 ? finalMatchedPosts.length / totalRecentAnalyzed : 0;
  const simulationVerdict: SimulationVerdict =
    finalMatchedPosts.length > 0
      ? 'ACTIVE_MATCHES_FOUND'
      : 'NO_HISTORICAL_MATCHES_RULE_ARMED';

  const dossier: TelegramDossier = {
    channel: fetchResult.metadata,
    recentMessages: fetchResult.messages.slice(0, 10), // Top 10 newest
    matchedSampleCount: finalMatchedPosts.length,
    sampleMatchedPosts: finalMatchedPosts.slice(0, 3), // Top 3 newest matches
    sampleSemanticMatchedCount,
    sampleMatchRate,
    simulationVerdict,
    expectedOperator: parsed.expectedOperator,
    contract,
    verificationDetails:
      simulationVerdict === 'ACTIVE_MATCHES_FOUND'
        ? `${fetchResult.metadata.title} (@${fetchResult.metadata.handle}) is active with ${totalRecentAnalyzed} recent posts. ${finalMatchedPosts.length} post(s) matched user filter (${Math.round(sampleMatchRate * 100)}% sample match rate).`
        : `${fetchResult.metadata.title} (@${fetchResult.metadata.handle}) is verified active with ${totalRecentAnalyzed} recent posts. 0 sample posts matched current criteria, but the monitoring rule is valid and armed for incoming broadcasts.`,
  };

  yield {
    taskId,
    executionId,
    step: 'DISCOVERY_COMPLETE',
    message: `Successfully validated @${fetchResult.metadata.handle}. ${dossier.verificationDetails}`,
    data: {
      handle: fetchResult.metadata.handle,
      matchedCount: finalMatchedPosts.length,
      simulationVerdict,
    },
    timestamp: Date.now(),
  };

  const currentDisplayValue =
    finalMatchedPosts.length > 0
      ? `Sample match: "${finalMatchedPosts[0].text.slice(0, 60)}..." (${
          finalMatchedPosts[0].viewsDisplay || '0 views'
        })`
      : `Channel active (@${fetchResult.metadata.handle}). Monitoring armed for future broadcasts.`;

  return {
    status: 'EXACT_MATCH',
    taskId,
    executionId,
    query: task.query,
    contract,
    dossier,
    currentDisplayValue,
    verificationDetails: dossier.verificationDetails,
    confidence: fetchResult.metadata.isVerified ? 0.98 : 0.92,
  };
}
