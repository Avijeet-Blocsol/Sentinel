import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { TechnicalIndicatorEnum, CandlestickPatternEnum } from '@sentinel/shared';
import { IndicatorEngine } from '../../harness/finance_common/indicator_engine.js';
import type { OHLCV } from '../../harness/finance_common/types.js';

export const OhlcvSchema = z.object({
  timestamp: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

/**
 * Creates a native Strands SDK tool for calculating technical indicators
 * and evaluating candlestick patterns on OHLCV series.
 */
export function createIndicatorTool() {
  return tool({
    name: 'calculate_technical_indicator',
    description:
      'Computes mathematical technical indicators (SMA, EMA, RSI, MACD, Bollinger Bands, VWAP, ATR, ADX, etc.) or checks for candlestick patterns (Bullish Engulfing, Hammer, Morning Star, etc.) on OHLCV price series.',
    inputSchema: z.object({
      candles: z.array(OhlcvSchema).min(2).describe('Chronological array of OHLCV candlestick data points'),
      indicator: TechnicalIndicatorEnum.optional().describe('Technical indicator to compute (e.g. "RSI", "SMA", "MACD")'),
      candlestickPattern: CandlestickPatternEnum.optional().describe('Candlestick pattern to evaluate (e.g. "BULLISH_ENGULFING")'),
      period: z.number().int().positive().optional().describe('Calculation period (e.g. 14 for RSI, 50 for SMA)'),
      fastPeriod: z.number().int().positive().optional().describe('Fast period for MACD'),
      slowPeriod: z.number().int().positive().optional().describe('Slow period for MACD'),
      signalPeriod: z.number().int().positive().optional().describe('Signal period for MACD'),
    }),
    callback: async (input: {
      candles: OHLCV[];
      indicator?: z.infer<typeof TechnicalIndicatorEnum>;
      candlestickPattern?: z.infer<typeof CandlestickPatternEnum>;
      period?: number;
      fastPeriod?: number;
      slowPeriod?: number;
      signalPeriod?: number;
    }) => {
      if (input.indicator) {
        const required = IndicatorEngine.getRequiredCandleCount(input.indicator, {
          period: input.period,
          slowPeriod: input.slowPeriod,
        });
        if (input.candles.length < required) {
          return {
            success: false,
            error: `Insufficient candle history: ${input.indicator} requires at least ${required} candles, but received ${input.candles.length}.`,
          };
        }

        const result = IndicatorEngine.calculateIndicator(input.indicator, input.candles, {
          period: input.period,
          fastPeriod: input.fastPeriod,
          slowPeriod: input.slowPeriod,
          signalPeriod: input.signalPeriod,
        });
        return {
          success: result !== null,
          type: 'INDICATOR',
          result,
        };
      }

      if (input.candlestickPattern) {
        const result = IndicatorEngine.checkCandlestickPattern(
          input.candlestickPattern,
          input.candles
        );
        return {
          success: true,
          type: 'CANDLESTICK',
          result,
        };
      }

      return {
        success: false,
        error: 'Must specify either indicator or candlestickPattern parameter.',
      };
    },
  });
}
