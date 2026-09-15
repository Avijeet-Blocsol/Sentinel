/**
 * Strands Sentinel - Telegram Channel Evaluator
 * Deterministically monitors public Telegram broadcast channels (t.me/s/<channel>)
 * evaluates keyword matches, view counts, media attachments, and delegates
 * natural language filters to the AgenticConditionEvaluator.
 */

import { randomUUID, createHash } from 'node:crypto';
import type { SubSentinel, Rule } from '@sentinel/shared';
import { TelegramPublicClient, TelegramClientError } from '../../harness/telegram_channel/client.js';
import { seenEventRepository } from '../../db/index.js';
import { globalAgenticEvaluator, AgenticConditionEvaluator } from './agentic_evaluator.js';
import type { SubSentinelEvaluationResult, SubSentinelEvaluator } from './types.js';

export interface TelegramThresholdConfig {
  channelHandle?: string;
  keywords?: string[];
  matchMode?: 'ANY' | 'ALL' | 'EXACT';
  minViews?: number;
  mediaOnly?: boolean;
  semanticFilter?: string;
}

export class TelegramEvaluator implements SubSentinelEvaluator {
  private readonly client: TelegramPublicClient;
  private readonly agenticEvaluator: AgenticConditionEvaluator;

  constructor(client?: TelegramPublicClient, agenticEvaluator?: AgenticConditionEvaluator) {
    this.client = client || new TelegramPublicClient();
    this.agenticEvaluator = agenticEvaluator || globalAgenticEvaluator;
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

      let config: TelegramThresholdConfig = {};

      try {
        if (subSentinel.threshold) {
          config = JSON.parse(subSentinel.threshold);
        }
      } catch {
        // Plain string threshold
      }

      // Determine raw channel handle
      const rawHandle =
        config.channelHandle ||
        subSentinel.target_source ||
        rule?.natural_language_intent?.match(/@([a-zA-Z0-9_]{3,64})/)?.[1] ||
        '';

      if (!rawHandle) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: 'Telegram channel handle is missing from sub-sentinel threshold and target_source.',
          error: 'MISSING_HANDLE',
        };
      }

      const cleanHandle = this.client.cleanHandle(rawHandle);
      if (!cleanHandle || !/^[a-zA-Z0-9_]{3,64}$/.test(cleanHandle)) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Invalid Telegram channel handle: "${rawHandle}".`,
          error: 'INVALID_HANDLE',
        };
      }

      // 1. Fetch channel metadata and recent messages
      let fetchResult;
      try {
        fetchResult = await this.client.fetchChannel(cleanHandle);
      } catch (err: any) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Failed to fetch Telegram channel @${cleanHandle}: ${err?.message || String(err)}`,
          error: err instanceof TelegramClientError ? err.code : 'FETCH_ERROR',
        };
      }

      const messages = fetchResult.messages || [];
      if (messages.length === 0) {
        return {
          isSatisfied: false,
          observedValue: 0,
          unit: 'POSTS',
          details: `Channel @${cleanHandle} has no recent broadcast messages.`,
        };
      }

      const minViews = config.minViews;
      const mediaOnly = config.mediaOnly;

      // 2. Track newly unseen messages and filter non-semantic constraints (views, media)
      // Inspect up to 10 unseen messages per tick to prevent over-batching and context explosion (Issue 3)
      const evaluatedMessages: typeof messages = [];
      const evaluatedEventHashes: string[] = [];

      for (const message of messages) {
        if (evaluatedMessages.length >= 10) {
          break; // Defer items 11+ to subsequent evaluation ticks
        }
        const eventHash = message.postId
          ? `msg_${message.postId}`
          : createHash('sha256').update(message.link || `${message.timestamp}_${message.text}`).digest('hex');

        const isSeen = await seenEventRepository.isEventSeen(subSentinel.id, eventHash);
        if (isSeen) {
          continue; // Already processed in prior tick
        }

        evaluatedEventHashes.push(eventHash);

        // View count filter
        if (typeof minViews === 'number' && minViews > 0) {
          if ((message.views || 0) < minViews) {
            continue;
          }
        }

        // Media attachment filter
        if (mediaOnly && !message.hasMedia) {
          continue;
        }

        evaluatedMessages.push(message);
      }

      const commitEvaluatedEvents = async () => {
        for (const hash of evaluatedEventHashes) {
          try {
            await seenEventRepository.recordSeenEvent(
              randomUUID(),
              subSentinel.id,
              `@${cleanHandle}`,
              hash
            );
          } catch {
            // Idempotent commit ignore
          }
        }
      };

      if (evaluatedMessages.length === 0) {
        await commitEvaluatedEvents();
        return {
          isSatisfied: false,
          observedValue: 0,
          unit: 'POSTS',
          details: `Evaluated ${messages.length} posts in @${cleanHandle}; no new broadcast messages matching filters.`,
          extraMetadata: {
            channel: `@${cleanHandle}`,
            recentCount: messages.length,
          },
        };
      }

      const cleanKeywords = (config.keywords || [])
        .map((k) => k.trim())
        .filter((k) => k.length > 0 && k !== '*');

      const hasKeywords = cleanKeywords.length > 0;
      const hasSemanticFilter = Boolean(config.semanticFilter && config.semanticFilter.trim().length > 0);
      const hasIntent = Boolean(rule?.natural_language_intent && rule.natural_language_intent.trim().length > 0);

      // Wildcard bypass: If no keywords or '*', no semantic filter, and no rule intent,
      // user wants notification for any new post in this channel
      if (!hasKeywords && !hasSemanticFilter && !hasIntent) {
        await commitEvaluatedEvents();
        const topMessage = evaluatedMessages[0];
        const preview = topMessage.text.replace(/\s+/g, ' ').trim().slice(0, 160);
        return {
          isSatisfied: true,
          observedValue: evaluatedMessages.length,
          unit: 'POSTS',
          details: `New broadcast post in @${cleanHandle}: "${preview}"`,
          extraMetadata: {
            channel: `@${cleanHandle}`,
            postId: topMessage.postId,
            link: topMessage.link,
            views: topMessage.views,
            timestamp: topMessage.timestamp,
            unseenCount: evaluatedMessages.length,
          },
        };
      }

      // 3. Delegate Semantic Evaluation to Strands Agent (eliminating brittle regex)
      let conditionToEvaluate = config.semanticFilter || '';
      if (!conditionToEvaluate) {
        if (hasKeywords) {
          if (config.matchMode === 'ALL') {
            conditionToEvaluate = `Determine whether any of these Telegram broadcast messages discuss or relate to ALL of the following topics: ${cleanKeywords.join(', ')}. Evaluate with semantic comprehension (accounting for crypto/finance slang, abbreviations, synonyms, and rejecting false positives or negations).`;
          } else if (config.matchMode === 'EXACT') {
            conditionToEvaluate = `Determine whether any of these Telegram broadcast messages specifically and explicitly discuss: "${cleanKeywords.join(' ')}".`;
          } else {
            conditionToEvaluate = `Determine whether any of these Telegram broadcast messages discuss or relate to: ${cleanKeywords.join(', ')}. Evaluate with semantic comprehension (accounting for crypto/finance slang, abbreviations, synonyms, and rejecting false positives or negations).`;
          }
        } else if (hasIntent) {
          conditionToEvaluate = rule!.natural_language_intent!;
        } else {
          conditionToEvaluate = 'Determine if any of these Telegram broadcast messages contain a notable announcement or high-priority alert.';
        }
      }

      const candidateContext = evaluatedMessages.map((msg) => ({
        postId: msg.postId,
        text: msg.text,
        views: msg.views,
        timestamp: msg.timestamp,
        isoDate: msg.isoDate,
        hasMedia: msg.hasMedia,
        link: msg.link,
      }));

      const agenticResult = await this.agenticEvaluator.evaluate(
        {
          conditionToEvaluate,
          targetSource: `Telegram: @${cleanHandle}`,
          observedContext: candidateContext,
          extraMetadata: {
            channel: `@${cleanHandle}`,
            keywords: config.keywords,
            matchMode: config.matchMode,
            batchSize: evaluatedMessages.length,
          },
        },
        signal
      );

      if (agenticResult.status === 'ERROR' || agenticResult.error) {
        return {
          isSatisfied: false,
          observedValue: null,
          unit: 'POSTS',
          details: `Telegram agentic evaluation error: ${agenticResult.reasoning}`,
          error: agenticResult.error || 'AGENTIC_EVALUATION_ERROR',
          extraMetadata: {
            channel: `@${cleanHandle}`,
            agenticResult,
          },
        };
      }

      await commitEvaluatedEvents();

      const conditionSatisfied = agenticResult.conditionSatisfied;
      const details = conditionSatisfied
        ? `[Strands Agent Match] In @${cleanHandle}: ${agenticResult.reasoning} Evidence: "${(agenticResult.observedEvidence?.relevantSnippet || '').slice(0, 150)}"`
        : `[Strands Agent Filtered] In @${cleanHandle}: ${agenticResult.reasoning}`;

      let matchedMessages: typeof evaluatedMessages = [];
      if (conditionSatisfied) {
        if (agenticResult.matchedIndices && agenticResult.matchedIndices.length > 0) {
          matchedMessages = agenticResult.matchedIndices
            .filter((idx) => idx >= 0 && idx < evaluatedMessages.length)
            .map((idx) => evaluatedMessages[idx]);
        }

        if (matchedMessages.length === 0) {
          const snippet = agenticResult.observedEvidence?.relevantSnippet?.toLowerCase() || '';
          const sourceUrl = agenticResult.observedEvidence?.sourceUrl?.toLowerCase() || '';

          matchedMessages = evaluatedMessages.filter((msg) => {
            const msgText = (msg.text || '').toLowerCase();
            const msgLink = (msg.link || '').toLowerCase();

            if (sourceUrl && msgLink === sourceUrl) return true;
            if (snippet && (msgText.includes(snippet) || snippet.includes(msgText))) return true;
            return false;
          });
        }

        if (matchedMessages.length === 0 && evaluatedMessages.length > 0) {
          matchedMessages = [evaluatedMessages[0]];
        }
      }

      const matchedCount = conditionSatisfied ? matchedMessages.length : 0;
      const topMatchMessage = matchedMessages[0] || evaluatedMessages[0];

      return {
        isSatisfied: conditionSatisfied,
        observedValue: matchedCount,
        unit: 'POSTS',
        details,
        extraMetadata: {
          channel: `@${cleanHandle}`,
          matchedCount,
          batchSize: evaluatedMessages.length,
          topMatch: topMatchMessage
            ? {
                postId: topMatchMessage.postId,
                link: topMatchMessage.link,
                views: topMatchMessage.views,
              }
            : undefined,
          agenticResult,
        },
      };
    } catch (err: any) {
      return {
        isSatisfied: false,
        observedValue: null,
        details: `Telegram evaluation error: ${err?.message || String(err)}`,
        error: err?.message || 'UNKNOWN_ERROR',
      };
    }
  }
}

export const globalTelegramEvaluator = new TelegramEvaluator();
