/**
 * Strands Sentinel - Stock Sub-Sentinel Evaluator
 * Deterministic evaluation of stock prices, technical indicators, and candlestick patterns.
 */

import {
  type SubSentinel,
  type Rule,
  type StockThreshold,
  StockThresholdSchema,
} from '@sentinel/shared';
import {
  FinnhubClient,
  YahooFinanceClient,
  IndicatorEngine,
  evaluateStockCondition,
  type OHLCV,
} from '../../harness/finance_common/index.js';
import type { SubSentinelEvaluationResult, SubSentinelEvaluator } from './types.js';

export function isUsMarketHours(date: Date = new Date()): boolean {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  let weekday = '';
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'weekday') weekday = part.value;
    if (part.type === 'hour') hour = parseInt(part.value, 10);
    if (part.type === 'minute') minute = parseInt(part.value, 10);
  }
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }
  const timeInMinutes = hour * 60 + minute;
  // US Regular Trading Hours: 9:30 AM to 4:00 PM Eastern Time
  return timeInMinutes >= 570 && timeInMinutes < 960;
}

export class StockEvaluator implements SubSentinelEvaluator {
  private finnhub: FinnhubClient;
  private yahoo: YahooFinanceClient;
  private isCustomClient: boolean;

  constructor(yahoo?: YahooFinanceClient, finnhub?: FinnhubClient) {
    this.yahoo = yahoo || new YahooFinanceClient();
    this.finnhub = finnhub || new FinnhubClient();
    this.isCustomClient = !!(yahoo || finnhub);
  }

  async evaluate(
    subSentinel: SubSentinel,
    _rule?: Rule,
    signal?: AbortSignal
  ): Promise<SubSentinelEvaluationResult> {
    try {
      const parsedJson = JSON.parse(subSentinel.threshold);
      const parsedThreshold = StockThresholdSchema.safeParse(parsedJson);
      if (!parsedThreshold.success) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Invalid stock threshold schema: ${parsedThreshold.error.message}`,
          error: parsedThreshold.error.message,
        };
      }

      const threshold: StockThreshold = parsedThreshold.data;
      const ticker = threshold.ticker.toUpperCase();
      const operator = subSentinel.operator || threshold.operator || 'GREATER_THAN';

      // Enforce market hours check if marketHoursOnly is configured (Finding 10)
      // (Bypassed when custom/mock client is injected or in test environment)
      if (
        threshold.marketHoursOnly &&
        !this.isCustomClient &&
        process.env.NODE_ENV !== 'test' &&
        !process.env.BYPASS_MARKET_HOURS &&
        !isUsMarketHours()
      ) {
        return {
          isSatisfied: false,
          observedValue: null,
          details: `Market is currently closed (marketHoursOnly is active). US regular trading hours are Mon-Fri 9:30 AM - 4:00 PM ET.`,
          extraMetadata: {
            ticker,
            marketHoursOnly: true,
            marketOpen: false,
          },
        };
      }

      let observedPrice: number | null = null;
      let previousClose: number | null = null;
      let observedHigh: number | undefined;
      let observedLow: number | undefined;
      let candles: OHLCV[] = [];

      // Provider selection: honor threshold.provider (FINNHUB vs YAHOO)
      if (threshold.provider === 'YAHOO') {
        try {
          const yahooQuote = await this.yahoo.getQuote(ticker, { signal });
          if (yahooQuote) {
            observedPrice = yahooQuote.currentPrice ?? (yahooQuote as any).price;
            previousClose = yahooQuote.previousClose;
            observedHigh = yahooQuote.high;
            observedLow = yahooQuote.low;
          }
        } catch {
          // Will attempt via candles
        }
      } else {
        // Default FINNHUB
        if (this.finnhub.isConfigured()) {
          try {
            const quote = await this.finnhub.getQuote(ticker, { signal });
            if (quote) {
              observedPrice = quote.currentPrice;
              previousClose = quote.previousClose;
              observedHigh = quote.high;
              observedLow = quote.low;
            }
          } catch {
            // Fall back to Yahoo
          }
        }

        // Fall back to Yahoo Finance quote if Finnhub failed or unconfigured
        if (observedPrice === null) {
          try {
            const yahooQuote = await this.yahoo.getQuote(ticker, { signal });
            if (yahooQuote) {
              observedPrice = yahooQuote.currentPrice ?? (yahooQuote as any).price;
              previousClose = yahooQuote.previousClose;
              observedHigh = yahooQuote.high;
              observedLow = yahooQuote.low;
            }
          } catch {
            // Will attempt via candles
          }
        }
      }

      // 2. Fetch candles if indicator, candlestick, or cross operator is requested
      let indicatorSeries: number[] | undefined;
      let indicatorValue: number | undefined;
      let candlestickMatched: boolean | undefined;

      const needsCandles =
        threshold.targetType === 'INDICATOR' ||
        threshold.targetType === 'CANDLESTICK' ||
        operator.includes('CROSS') ||
        operator.includes('CLOSES');

      if (needsCandles) {
        try {
          const requiredPeriod = threshold.period || (threshold.indicator === 'MACD' ? 35 : 14);
          const range = requiredPeriod > 100 ? '2y' : requiredPeriod > 40 ? '1y' : '3mo';
          candles = await this.yahoo.getCandles(ticker, threshold.timeframe || '1d', range);
        } catch {
          candles = [];
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
          details: `Unable to fetch live quote or candle data for ticker ${ticker}`,
          error: 'DATA_UNAVAILABLE',
        };
      }

      // Extract prior tick value from state_payload to ensure CROSSES_ABOVE / CROSSES_BELOW
      // compares against immediate prior tick (t_-1) instead of yesterday's daily previousClose.
      let tickPreviousValue: number | undefined;
      if (subSentinel.state_payload) {
        try {
          const parsed = JSON.parse(subSentinel.state_payload);
          if (typeof parsed.currentValue === 'number' && Number.isFinite(parsed.currentValue)) {
            tickPreviousValue = parsed.currentValue;
          }
        } catch {
          // Fall back to quote previousClose
        }
      }
      const effectivePreviousValue = tickPreviousValue ?? previousClose;

      const evaluation = evaluateStockCondition({
        targetType: threshold.targetType,
        operator,
        observedValue:
          threshold.targetType === 'INDICATOR' ? (indicatorValue ?? null) : observedPrice,
        previousObservedValue: effectivePreviousValue,
        indicatorName: threshold.indicator,
        indicatorSeries,
        targetValue: threshold.targetValue,
        candlestickMatched,
        candles,
        high: observedHigh,
        low: observedLow,
      });

      return {
        isSatisfied: evaluation.conditionSatisfied,
        observedValue: evaluation.observedValue,
        previousValue: effectivePreviousValue,
        unit: threshold.currency || 'USD',
        details: evaluation.evaluationDetails,
        extraMetadata: {
          ticker,
          targetType: threshold.targetType,
          indicator: threshold.indicator,
          candlestickPattern: threshold.candlestickPattern,
        },
      };
    } catch (err: any) {
      return {
        isSatisfied: false,
        observedValue: null,
        details: `Stock evaluation failure: ${err?.message || String(err)}`,
        error: err?.message || 'UNKNOWN_ERROR',
      };
    }
  }
}
