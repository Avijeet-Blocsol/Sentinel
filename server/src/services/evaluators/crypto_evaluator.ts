/**
 * Strands Sentinel - Crypto Sub-Sentinel Evaluator
 * Deterministic evaluation of cryptocurrency prices, technical indicators, and candlestick patterns.
 */

import {
  type SubSentinel,
  type Rule,
  type CryptoThreshold,
  CryptoThresholdSchema,
} from '@sentinel/shared';
import {
  CoinbaseClient,
  DexScreenerClient,
  IndicatorEngine,
  evaluateCryptoCondition,
  type OHLCV,
} from '../../harness/finance_common/index.js';
import type { SubSentinelEvaluationResult, SubSentinelEvaluator } from './types.js';

export class CryptoEvaluator implements SubSentinelEvaluator {
  private coinbase = new CoinbaseClient();
  private dexscreener = new DexScreenerClient();

  async evaluate(
    subSentinel: SubSentinel,
    _rule?: Rule,
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

      const parsedJson = JSON.parse(subSentinel.threshold) as Record<string, unknown>;
      // Accept the pre-v2 persisted field name while writing/returning only
      // the canonical targetValue contract. This keeps existing sentinels
      // evaluable after the schema migration instead of silently turning a
      // numeric threshold into an observation-only condition.
      if (parsedJson.targetValue === undefined && typeof parsedJson.targetPrice === 'number') {
        parsedJson.targetValue = parsedJson.targetPrice;
      }
      const parsedThreshold = CryptoThresholdSchema.safeParse(parsedJson);
      if (!parsedThreshold.success) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Invalid crypto threshold schema: ${parsedThreshold.error.message}`,
          error: parsedThreshold.error.message,
        };
      }

      const threshold: CryptoThreshold = parsedThreshold.data;
      const assetSymbol = threshold.assetSymbol.toUpperCase();
      const operator = subSentinel.operator || threshold.operator || 'GREATER_THAN';

      let observedPrice: number | null = null;
      let high24h: number | undefined;
      let low24h: number | undefined;
      let candles: OHLCV[] = [];

      // 1. Venue resolution: strict isolation between DEXSCREENER and COINBASE
      if (threshold.venue === 'DEXSCREENER') {
        if (threshold.dexContractAddress) {
          try {
            const pairs = await this.dexscreener.searchPairs(assetSymbol, {
              contractAddress: threshold.dexContractAddress,
              network: threshold.dexNetwork,
              maxCandidates: 1,
            });
            if (pairs.length > 0 && pairs[0].priceUsd) {
              observedPrice = parseFloat(pairs[0].priceUsd);
            }
          } catch {
            // Attempt fallback search
          }
        }

        if (observedPrice === null) {
          try {
            const pairs = await this.dexscreener.searchPairs(assetSymbol, {
              symbol: assetSymbol,
              contractAddress: threshold.dexContractAddress,
              network: threshold.dexNetwork,
              maxCandidates: 5,
            });
            // Filter for pairs with minimum liquidity ($25,000) and 24h volume ($5,000) to avoid honeypot traps
            const validPair = pairs.find(
              (p) => (p.liquidityUsd ?? 0) >= 25000 && (p.volume24h ?? 0) >= 5000
            ) || pairs[0];

            if (validPair && validPair.priceUsd) {
              observedPrice = parseFloat(validPair.priceUsd);
            }
          } catch {
            // No live quote available
          }
        }

        // Strict isolation: Never fall back to Coinbase when venue is DEXSCREENER (Finding 11)
        if (observedPrice === null) {
          return {
            isSatisfied: false,
            observedValue: null,
            details: `Unable to fetch DEX quote for ${assetSymbol} on DexScreener`,
            error: 'DEX_PAIR_UNAVAILABLE',
          };
        }
      } else {
        // COINBASE venue
        try {
          const product = await this.coinbase.resolveProduct(assetSymbol);
          if (product) {
            const spot = await this.coinbase.getSpotPrice(product.id, { signal });
            if (spot) {
              observedPrice = spot.price;
              high24h = spot.high24h;
              low24h = spot.low24h;
            }
          }
        } catch {
          // Coinbase error, try DexScreener fallback for non-DEX venue if Coinbase unlisted
        }

        if (observedPrice === null) {
          try {
            const pairs = await this.dexscreener.searchPairs(assetSymbol, {
              symbol: assetSymbol,
              maxCandidates: 5,
            });
            // Filter for pairs with minimum liquidity ($25,000) and 24h volume ($5,000) to avoid honeypot traps
            const validPair = pairs.find(
              (p) => (p.liquidityUsd ?? 0) >= 25000 && (p.volume24h ?? 0) >= 5000
            ) || pairs[0];

            if (validPair && validPair.priceUsd) {
              observedPrice = parseFloat(validPair.priceUsd);
            }
          } catch {
            // No live quote available
          }
        }
      }

      // 2. Fetch candles if indicator, candlestick pattern, or cross operator requested
      let indicatorSeries: number[] | undefined;
      let indicatorValue: number | undefined;
      let candlestickMatched: boolean | undefined;

      const needsCandles =
        threshold.targetType === 'INDICATOR' ||
        threshold.targetType === 'CANDLESTICK' ||
        operator.includes('CROSS') ||
        operator.includes('CLOSES');

      if (needsCandles) {
        const granularityMap: Record<string, number> = {
          '1m': 60,
          '5m': 300,
          '15m': 900,
          '30m': 1800,
          '1h': 3600,
          '4h': 21600, // Coinbase supports 6h natively (21600s)
          '6h': 21600,
          '1d': 86400,
          '1w': 604800,
        };
        const granularity = granularityMap[threshold.timeframe || '1h'] || 3600;

        if (threshold.venue !== 'DEXSCREENER') {
          try {
            const product = await this.coinbase.resolveProduct(assetSymbol);
            if (product) {
              candles = await this.coinbase.getCandles(product.id, granularity, { signal });
            }
          } catch {
            candles = [];
          }
        }

        if (candles.length > 0 && observedPrice === null) {
          observedPrice = candles[candles.length - 1].close;
        }

        if (threshold.targetType === 'INDICATOR' && threshold.indicator) {
          const calc = IndicatorEngine.calculateIndicator(threshold.indicator, candles, {
            period: threshold.period,
            fastPeriod: threshold.fastPeriod,
            slowPeriod: threshold.slowPeriod,
            signalPeriod: threshold.signalPeriod,
          });
          if (calc) {
            indicatorValue = calc.value;
            indicatorSeries = calc.series;
          }
        } else if (threshold.targetType === 'CANDLESTICK' && threshold.candlestickPattern) {
          const patternResult = IndicatorEngine.checkCandlestickPattern(
            threshold.candlestickPattern,
            candles
          );
          candlestickMatched = patternResult.isMatched;
        }
      }

      if (observedPrice === null && indicatorValue === undefined && !candlestickMatched) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Unable to fetch live cryptocurrency quote or candle data for ${assetSymbol}`,
          error: 'DATA_UNAVAILABLE',
        };
      }

      // Extract prior tick value from state_payload to ensure CROSSES_ABOVE / CROSSES_BELOW
      // compares against immediate prior tick (t_-1)
      let tickPreviousValue: number | undefined;
      if (subSentinel.state_payload) {
        try {
          const parsed = JSON.parse(subSentinel.state_payload);
          if (typeof parsed.currentValue === 'number' && Number.isFinite(parsed.currentValue)) {
            tickPreviousValue = parsed.currentValue;
          }
        } catch {
          // Ignore parse failure
        }
      }

      const evaluation = evaluateCryptoCondition({
        targetType: threshold.targetType,
        operator,
        observedValue:
          threshold.targetType === 'INDICATOR' ? (indicatorValue ?? null) : observedPrice,
        previousObservedValue: tickPreviousValue,
        indicatorName: threshold.indicator,
        indicatorSeries,
        targetValue: threshold.targetValue,
        candlestickMatched,
        candles,
        high24h,
        low24h,
      });

      return {
        isSatisfied: evaluation.conditionSatisfied,
        observedValue: evaluation.observedValue,
        previousValue: tickPreviousValue,
        unit: threshold.currency || 'USD',
        details: evaluation.evaluationDetails,
        extraMetadata: {
          assetSymbol,
          venue: threshold.venue,
          targetType: threshold.targetType,
          indicator: threshold.indicator,
          candlestickPattern: threshold.candlestickPattern,
        },
      };
    } catch (err: any) {
      return {
        isSatisfied: false,
        observedValue: null,
        details: `Crypto evaluation failure: ${err?.message || String(err)}`,
        error: err?.message || 'UNKNOWN_ERROR',
      };
    }
  }
}
