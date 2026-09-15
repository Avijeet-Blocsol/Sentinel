/**
 * Strands Sentinel - Prediction Market Sub-Sentinel Evaluator
 * Deterministic evaluation of Polymarket CLOB midpoints and probabilities.
 */

import {
  type SubSentinel,
  type Rule,
  type PredictionMarketThreshold,
  PredictionMarketThresholdSchema,
} from '@sentinel/shared';
import {
  PolymarketClient,
  type PolymarketMarket,
  evaluatePredictionMarketCondition,
} from '../../harness/finance_common/index.js';
import type { SubSentinelEvaluationResult, SubSentinelEvaluator } from './types.js';

export class PredictionMarketEvaluator implements SubSentinelEvaluator {
  private polymarket: PolymarketClient;

  constructor(polymarket?: PolymarketClient) {
    this.polymarket = polymarket || new PolymarketClient();
  }

  async evaluate(
    subSentinel: SubSentinel,
    _rule?: Rule,
    signal?: AbortSignal
  ): Promise<SubSentinelEvaluationResult> {
    try {
      const parsedJson = JSON.parse(subSentinel.threshold);
      const parsedThreshold = PredictionMarketThresholdSchema.safeParse(parsedJson);
      if (!parsedThreshold.success) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Invalid prediction market threshold schema: ${parsedThreshold.error.message}`,
          error: parsedThreshold.error.message,
        };
      }

      const threshold: PredictionMarketThreshold = parsedThreshold.data;
      const operator = subSentinel.operator || threshold.operator || 'GREATER_THAN';

      let market: PolymarketMarket | null = null;
      let outcomeIndex = -1;

      // 1. Fetch market metadata with allowClosed enabled to detect closed/resolved state
      if (threshold.conditionId) {
        try {
          market = await this.polymarket.getMarketByConditionId(threshold.conditionId, {
            signal,
            allowClosed: true,
          });
        } catch {
          // Fall back to direct CLOB if market lookup fails
        }
      }

      // 2. Validate outcome exists in market outcomes (Finding 12)
      if (market && Array.isArray(market.outcomes) && market.outcomes.length > 0) {
        const target = threshold.outcome.trim().toLowerCase();
        outcomeIndex = market.outcomes.findIndex((o) => o.trim().toLowerCase() === target);

        if (outcomeIndex === -1 && (target === 'yes' || target === 'no')) {
          outcomeIndex = market.outcomes.findIndex(
            (o) => o.trim().toUpperCase() === target.toUpperCase()
          );
        }

        if (outcomeIndex === -1) {
          return {
            isSatisfied: false,
            observedValue: null,
            details: `Configured outcome "${threshold.outcome}" not found in market outcomes: [${market.outcomes.join(', ')}]`,
            error: 'INVALID_OUTCOME',
          };
        }
      }

      // 3. Check closed/resolved market state (Finding 12)
      const marketClosed = Boolean(market?.closed);
      if (marketClosed) {
        return {
          isSatisfied: false,
          observedValue: null,
          unit: 'PROBABILITY',
          details: `Market is closed/resolved for condition ${threshold.conditionId} (${market?.question || threshold.marketTitle})`,
          error: 'MARKET_CLOSED',
          extraMetadata: {
            conditionId: threshold.conditionId,
            clobTokenId: threshold.clobTokenId,
            outcome: threshold.outcome,
            marketTitle: threshold.marketTitle,
            marketClosed: true,
          },
        };
      }

      // 4. Resolve effective CLOB token ID
      let effectiveClobTokenId = threshold.clobTokenId;
      if (
        !effectiveClobTokenId &&
        market &&
        Array.isArray(market.clobTokenIds) &&
        outcomeIndex >= 0 &&
        outcomeIndex < market.clobTokenIds.length
      ) {
        effectiveClobTokenId = market.clobTokenIds[outcomeIndex];
      }

      let observedProbability: number | null = null;
      const priceType = threshold.priceType || 'MIDPOINT';

      // 5. Honor priceType: MIDPOINT vs LAST_TRADE vs GAMMA_PRICE (Finding 12)
      if (priceType === 'LAST_TRADE' && effectiveClobTokenId) {
        try {
          observedProbability = await this.polymarket.getLastTradePrice(effectiveClobTokenId, { signal });
        } catch {
          // Fall back
        }
      } else if (priceType === 'MIDPOINT' && effectiveClobTokenId) {
        try {
          observedProbability = await this.polymarket.getMidpointPrice(effectiveClobTokenId, { signal });
        } catch {
          // Fall back
        }
      }

      // If priceType is GAMMA_PRICE or CLOB endpoints returned null, fall back to Gamma outcomePrices
      if (observedProbability === null && market && Array.isArray(market.outcomePrices)) {
        const idx = outcomeIndex >= 0 ? outcomeIndex : (threshold.outcome.toUpperCase() === 'NO' ? 1 : 0);
        if (idx >= 0 && idx < market.outcomePrices.length) {
          observedProbability = market.outcomePrices[idx];
        }
      }

      if (observedProbability === null) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Unable to fetch live probability for market condition ${threshold.conditionId} (${threshold.outcome})`,
          error: 'DATA_UNAVAILABLE',
        };
      }

      const evaluation = evaluatePredictionMarketCondition({
        outcome: threshold.outcome?.toUpperCase() === 'NO' ? 'NO' : 'YES',
        operator,
        observedProbability,
        targetProbability: threshold.targetProbability,
      });

      return {
        isSatisfied: evaluation.conditionSatisfied,
        observedValue: evaluation.observedValue,
        unit: 'PROBABILITY',
        details: evaluation.evaluationDetails,
        extraMetadata: {
          conditionId: threshold.conditionId,
          clobTokenId: effectiveClobTokenId,
          outcome: threshold.outcome,
          marketTitle: threshold.marketTitle,
          marketClosed: false,
          priceType,
        },
      };
    } catch (err: any) {
      return {
        isSatisfied: false,
        observedValue: null,
        details: `Prediction market evaluation failure: ${err?.message || String(err)}`,
        error: err?.message || 'UNKNOWN_ERROR',
      };
    }
  }
}
