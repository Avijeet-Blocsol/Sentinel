/**
 * Strands Sentinel - Web Search Evaluator
 * Discovers live web search results, deduplicates them against seen_events,
 * and passes new findings to the AgenticConditionEvaluator for semantic reasoning.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SubSentinel, Rule } from '@sentinel/shared';
import { executeWebSearch } from '../../tools/deep_web_search/index.js';
import { seenEventRepository } from '../../db/index.js';
import { globalAgenticEvaluator } from './agentic_evaluator.js';
import type { SubSentinelEvaluationResult, SubSentinelEvaluator } from './types.js';

export class WebSearchEvaluator implements SubSentinelEvaluator {
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

      let query = subSentinel.target_source || '';
      let semanticCondition = rule?.natural_language_intent || '';

      try {
        const parsed = JSON.parse(subSentinel.threshold);
        if (parsed.query) query = parsed.query;
        if (parsed.semanticFilter) semanticCondition = parsed.semanticFilter;
      } catch {
        // threshold is plain string or fallback
      }

      if (!query.trim()) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: 'Empty search query specified for web search sentinel.',
          error: 'INVALID_QUERY',
        };
      }

      // 1. Execute resilient search
      const searchRes = await executeWebSearch(query, new Set(), { maxResults: 5, signal });
      const hits = searchRes.hits || [];

      if (hits.length === 0) {
        return {
          isSatisfied: false,
          observedValue: 0,
          details: `Web search returned 0 results for query: "${query}".`,
        };
      }

      // 2. Deduplicate hits against seen_events
      const unseenHits: Array<{ title: string; url: string; snippet: string; hash: string }> = [];
      for (const hit of hits) {
        const hash = createHash('sha256').update(hit.url).digest('hex');
        const isSeen = await seenEventRepository.isEventSeen(subSentinel.id, hash);
        if (!isSeen) {
          unseenHits.push({ ...hit, hash });
        }
      }

      if (unseenHits.length === 0) {
        return {
          isSatisfied: false,
          observedValue: 0,
          details: `Search returned ${hits.length} results; all have already been seen and evaluated.`,
        };
      }

      // 3. Delegate semantic condition evaluation to Agentic AI
      const condition = semanticCondition || `Check if these search results contain significant developments regarding: ${query}`;
      const agenticResult = await globalAgenticEvaluator.evaluate(
        {
          conditionToEvaluate: condition,
          targetSource: `Search: "${query}"`,
          observedContext: unseenHits,
          extraMetadata: {
            query,
            unseenHitsCount: unseenHits.length,
          },
        },
        signal
      );

      // If agentic evaluation errored or failed, DO NOT mark seen events so hits can be retried
      if (agenticResult.status === 'ERROR' || agenticResult.error) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Agentic evaluation error on web search: ${agenticResult.reasoning}`,
          error: agenticResult.error || 'AGENTIC_EVALUATION_ERROR',
          extraMetadata: {
            agenticResult,
          },
        };
      }

      // 4. Commit seen events only after successful evaluation
      for (const hit of unseenHits) {
        await seenEventRepository.recordSeenEvent(
          randomUUID(),
          subSentinel.id,
          hit.url,
          hit.hash
        );
      }

      return {
        isSatisfied: agenticResult.conditionSatisfied,
        observedValue: agenticResult.observedEvidence.extractedValue ?? unseenHits.length,
        unit: 'SEARCH_HITS',
        details: `${agenticResult.reasoning} Evidence: "${agenticResult.observedEvidence.relevantSnippet.slice(0, 150)}"`,
        extraMetadata: {
          agenticResult,
          hits: unseenHits,
        },
      };
    } catch (err: any) {
      return {
        isSatisfied: false,
        observedValue: null,
        details: `Web search evaluation failure: ${err?.message || String(err)}`,
        error: err?.message || 'UNKNOWN_ERROR',
      };
    }
  }
}
