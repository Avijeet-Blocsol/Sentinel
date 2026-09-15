import {
  SMA,
  EMA,
  WMA,
  WEMA,
  RSI,
  MACD,
  BollingerBands,
  ATR,
  ADX,
  CCI,
  Stochastic,
  StochasticRSI,
  ROC,
  AwesomeOscillator,
  TRIX,
  WilliamsR,
  OBV,
  MFI,
  PSAR,
  IchimokuCloud,
  KeltnerChannels,
  bullishengulfingpattern,
  bullishhammerstick,
  bullishinvertedhammerstick,
  bullishharami,
  bullishharamicross,
  bullishmarubozu,
  morningstar,
  morningdojistar,
  dragonflydoji,
  bearishengulfingpattern,
  bearishhammerstick,
  bearishinvertedhammerstick,
  bearishharami,
  bearishharamicross,
  bearishmarubozu,
  eveningstar,
  eveningdojistar,
  gravestonedoji,
  darkcloudcover,
  shootingstar,
  doji,
} from 'technicalindicators';
import type { TechnicalIndicator, CandlestickPattern } from '@sentinel/shared';
import type { OHLCV } from './types.js';

export class UnsupportedIndicatorError extends Error {
  constructor(public readonly indicator: string) {
    super(`Unsupported technical indicator: "${indicator}"`);
    this.name = 'UnsupportedIndicatorError';
  }
}

export interface IndicatorCalculationResult {
  indicator: TechnicalIndicator;
  value: number;
  previousValue?: number;
  series?: number[];
  period?: number;
  details?: Record<string, unknown>;
  formatted: string;
}

export interface CandlestickPatternResult {
  pattern: CandlestickPattern;
  isMatched: boolean;
  formatted: string;
}

export class IndicatorEngine {
  /**
   * Determines whether an indicator string is supported by this engine.
   */
  static isSupported(indicator: string): boolean {
    const supported: TechnicalIndicator[] = [
      'PRICE', 'SMA', 'EMA', 'WMA', 'WEMA', 'RSI', 'MACD',
      'BOLLINGER', 'BOLLINGER_BANDS', 'KELTNER_CHANNELS',
      'STOCHASTIC', 'STOCHASTIC_RSI', 'CCI', 'ATR', 'ADX',
      'ROC', 'AWESOME_OSCILLATOR', 'TRIX', 'WILLIAMS_R',
      'VOLUME', 'OBV', 'MFI', 'VWAP', 'PSAR', 'ICHIMOKU_CLOUD',
    ];
    return supported.includes(indicator as TechnicalIndicator);
  }

  /**
   * Determines the minimum number of OHLCV candles required for an indicator.
   */
  static getRequiredCandleCount(
    indicator: TechnicalIndicator,
    options: { period?: number; slowPeriod?: number } = {}
  ): number {
    const period = options.period || 14;
    if (indicator === 'MACD') return (options.slowPeriod || 26) + 9;
    if (indicator === 'PRICE' || indicator === 'VOLUME') return 1;
    if (indicator === 'ICHIMOKU_CLOUD') return 52;
    if (indicator === 'AWESOME_OSCILLATOR') return options.slowPeriod || 34;
    if (indicator === 'TRIX') return period * 3;
    if (indicator === 'BOLLINGER_BANDS' || indicator === 'BOLLINGER') return period;
    return period;
  }

  /**
   * Computes any of the supported technical indicators on an array of OHLCV candles.
   */
  static calculateIndicator(
    indicator: TechnicalIndicator,
    candles: OHLCV[],
    options: {
      period?: number;
      fastPeriod?: number;
      slowPeriod?: number;
      signalPeriod?: number;
    } = {}
  ): IndicatorCalculationResult | null {
    if (!candles || candles.length === 0) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const opens = candles.map((c) => c.open);
    const volumes = candles.map((c) => c.volume);
    const period = options.period || 14;

    try {
      switch (indicator) {
        case 'PRICE': {
          const currentPrice = closes[closes.length - 1];
          const previousPrice = closes.length >= 2 ? closes[closes.length - 2] : undefined;
          return {
            indicator: 'PRICE',
            value: currentPrice,
            previousValue: previousPrice,
            formatted: `Current Price: $${currentPrice.toFixed(2)}`,
          };
        }

        case 'SMA': {
          const results = SMA.calculate({ period, values: closes });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'SMA',
            period,
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `SMA (${period}): ${val.toFixed(2)}`,
          };
        }

        case 'EMA': {
          const results = EMA.calculate({ period, values: closes });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'EMA',
            period,
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `EMA (${period}): ${val.toFixed(2)}`,
          };
        }

        case 'WMA': {
          const results = WMA.calculate({ period, values: closes });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'WMA',
            period,
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `WMA (${period}): ${val.toFixed(2)}`,
          };
        }

        case 'WEMA': {
          const results = WEMA.calculate({ period, values: closes });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'WEMA',
            period,
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `WEMA (${period}): ${val.toFixed(2)}`,
          };
        }

        case 'RSI': {
          const results = RSI.calculate({ period, values: closes });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'RSI',
            period,
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `RSI (${period}): ${val.toFixed(2)}`,
          };
        }

        case 'MACD': {
          const fast = options.fastPeriod || 12;
          const slow = options.slowPeriod || 26;
          const signal = options.signalPeriod || 9;
          const results = MACD.calculate({
            values: closes,
            fastPeriod: fast,
            slowPeriod: slow,
            signalPeriod: signal,
            SimpleMAOscillator: false,
            SimpleMASignal: false,
          });
          if (results.length === 0) return null;
          const last = results[results.length - 1];
          const macdVal = last.MACD ?? 0;
          const prevMacdVal = results.length >= 2 ? (results[results.length - 2].MACD ?? 0) : undefined;
          return {
            indicator: 'MACD',
            value: macdVal,
            previousValue: prevMacdVal,
            details: {
              macd: last.MACD,
              signal: last.signal,
              histogram: last.histogram,
            },
            formatted: `MACD (${fast}, ${slow}, ${signal}): ${macdVal.toFixed(2)} [Signal: ${last.signal?.toFixed(2)}]`,
          };
        }

        case 'BOLLINGER':
        case 'BOLLINGER_BANDS': {
          const results = BollingerBands.calculate({
            period,
            values: closes,
            stdDev: 2,
          });
          if (results.length === 0) return null;
          const last = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2].middle : undefined;
          return {
            indicator: 'BOLLINGER_BANDS',
            period,
            value: last.middle,
            previousValue: prevVal,
            details: { upper: last.upper, middle: last.middle, lower: last.lower },
            formatted: `Bollinger Bands (${period}, 2): Mid ${last.middle.toFixed(2)} [Lower: ${last.lower.toFixed(2)}, Upper: ${last.upper.toFixed(2)}]`,
          };
        }

        case 'ATR': {
          const results = ATR.calculate({
            high: highs,
            low: lows,
            close: closes,
            period,
          });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'ATR',
            period,
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `ATR (${period}): ${val.toFixed(2)}`,
          };
        }

        case 'ADX': {
          const results = ADX.calculate({
            high: highs,
            low: lows,
            close: closes,
            period,
          });
          if (results.length === 0) return null;
          const last = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2].adx : undefined;
          return {
            indicator: 'ADX',
            period,
            value: last.adx,
            previousValue: prevVal,
            details: { pdi: last.pdi, mdi: last.mdi },
            formatted: `ADX (${period}): ${last.adx.toFixed(2)}`,
          };
        }

        case 'CCI': {
          const results = CCI.calculate({
            high: highs,
            low: lows,
            close: closes,
            period,
          });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'CCI',
            period,
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `CCI (${period}): ${val.toFixed(2)}`,
          };
        }

        case 'STOCHASTIC': {
          const results = Stochastic.calculate({
            high: highs,
            low: lows,
            close: closes,
            period,
            signalPeriod: options.signalPeriod || 3,
          });
          if (results.length === 0) return null;
          const last = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2].k : undefined;
          return {
            indicator: 'STOCHASTIC',
            period,
            value: last.k,
            previousValue: prevVal,
            details: { k: last.k, d: last.d },
            formatted: `Stochastic (${period}, 3): %K ${last.k.toFixed(2)}, %D ${last.d.toFixed(2)}`,
          };
        }

        case 'VOLUME': {
          const lastVol = volumes[volumes.length - 1];
          const prevVol = volumes.length >= 2 ? volumes[volumes.length - 2] : undefined;
          return {
            indicator: 'VOLUME',
            value: lastVol,
            previousValue: prevVol,
            formatted: `Current Volume: ${lastVol.toLocaleString()}`,
          };
        }

        case 'OBV': {
          const results = OBV.calculate({ close: closes, volume: volumes });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'OBV',
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `OBV: ${val.toLocaleString()}`,
          };
        }

        case 'MFI': {
          const results = MFI.calculate({
            high: highs,
            low: lows,
            close: closes,
            volume: volumes,
            period,
          });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'MFI',
            period,
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `MFI (${period}): ${val.toFixed(2)}`,
          };
        }

        case 'ROC': {
          const results = ROC.calculate({ period, values: closes });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'ROC',
            period,
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `ROC (${period}): ${val.toFixed(2)}%`,
          };
        }

        case 'VWAP': {
          // Compute cumulative typical price * volume / cumulative volume
          let cumTypVol = 0;
          let cumVol = 0;
          let prevVwap: number | undefined;
          for (let i = 0; i < candles.length; i++) {
            const typ = (highs[i] + lows[i] + closes[i]) / 3;
            cumTypVol += typ * volumes[i];
            cumVol += volumes[i];
            if (i === candles.length - 2 && cumVol > 0) {
              prevVwap = cumTypVol / cumVol;
            }
          }
          const vwap = cumVol > 0 ? cumTypVol / cumVol : closes[closes.length - 1];
          return {
            indicator: 'VWAP',
            value: vwap,
            previousValue: prevVwap,
            formatted: `VWAP: ${vwap.toFixed(2)}`,
          };
        }

        case 'KELTNER_CHANNELS': {
          const results = KeltnerChannels.calculate({
            high: highs,
            low: lows,
            close: closes,
            maPeriod: period,
            atrPeriod: period,
            multiplier: 2,
            useSMA: false,
          });
          if (results.length === 0) return null;
          const last = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2].middle : undefined;
          return {
            indicator: 'KELTNER_CHANNELS',
            period,
            value: last.middle,
            previousValue: prevVal,
            details: { upper: last.upper, middle: last.middle, lower: last.lower },
            formatted: `Keltner Channels (${period}): Mid ${last.middle.toFixed(2)} [Lower: ${last.lower.toFixed(2)}, Upper: ${last.upper.toFixed(2)}]`,
          };
        }

        case 'STOCHASTIC_RSI': {
          const results = StochasticRSI.calculate({
            values: closes,
            rsiPeriod: period,
            stochasticPeriod: period,
            kPeriod: 3,
            dPeriod: 3,
          });
          if (results.length === 0) return null;
          const last = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2].k : undefined;
          return {
            indicator: 'STOCHASTIC_RSI',
            period,
            value: last.k,
            previousValue: prevVal,
            details: { k: last.k, d: last.d },
            formatted: `StochRSI (${period}): %K ${last.k.toFixed(2)}, %D ${last.d.toFixed(2)}`,
          };
        }

        case 'AWESOME_OSCILLATOR': {
          const fast = options.fastPeriod || 5;
          const slow = options.slowPeriod || 34;
          const results = AwesomeOscillator.calculate({
            high: highs,
            low: lows,
            fastPeriod: fast,
            slowPeriod: slow,
          });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'AWESOME_OSCILLATOR',
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `Awesome Oscillator (${fast}, ${slow}): ${val.toFixed(2)}`,
          };
        }

        case 'TRIX': {
          const results = TRIX.calculate({ period, values: closes });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'TRIX',
            period,
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `TRIX (${period}): ${val.toFixed(2)}`,
          };
        }

        case 'WILLIAMS_R': {
          const results = WilliamsR.calculate({
            high: highs,
            low: lows,
            close: closes,
            period,
          });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'WILLIAMS_R',
            period,
            value: val,
            previousValue: prevVal,
            series: results,
            formatted: `Williams %R (${period}): ${val.toFixed(2)}`,
          };
        }

        case 'PSAR': {
          const results = PSAR.calculate({
            high: highs,
            low: lows,
            step: 0.02,
            max: 0.2,
          });
          if (results.length === 0) return null;
          const val = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2] : undefined;
          return {
            indicator: 'PSAR',
            value: val,
            previousValue: prevVal,
            formatted: `PSAR: ${val.toFixed(2)}`,
          };
        }

        case 'ICHIMOKU_CLOUD': {
          const results = IchimokuCloud.calculate({
            high: highs,
            low: lows,
            conversionPeriod: 9,
            basePeriod: 26,
            spanPeriod: 52,
            displacement: 26,
          });
          if (results.length === 0) return null;
          const last = results[results.length - 1];
          const prevVal = results.length >= 2 ? results[results.length - 2].base : undefined;
          return {
            indicator: 'ICHIMOKU_CLOUD',
            value: last.base,
            previousValue: prevVal,
            details: {
              conversion: last.conversion,
              base: last.base,
              spanA: last.spanA,
              spanB: last.spanB,
            },
            formatted: `Ichimoku Cloud: Base ${last.base.toFixed(2)}, Conv ${last.conversion.toFixed(2)}`,
          };
        }

        default: {
          throw new UnsupportedIndicatorError(String(indicator));
        }
      }
    } catch (err) {
      if (err instanceof UnsupportedIndicatorError) {
        throw err;
      }
      return null;
    }
  }

  /**
   * Tests whether the latest candles in the series match a requested candlestick pattern.
   */
  static checkCandlestickPattern(
    pattern: CandlestickPattern,
    candles: OHLCV[]
  ): CandlestickPatternResult {
    if (!candles || candles.length < 5) {
      return { pattern, isMatched: false, formatted: 'Insufficient candle data' };
    }

    const input = {
      open: candles.map((c) => c.open),
      high: candles.map((c) => c.high),
      close: candles.map((c) => c.close),
      low: candles.map((c) => c.low),
    };

    let isMatched = false;

    switch (pattern) {
      case 'BULLISH_ENGULFING':
        isMatched = bullishengulfingpattern(input);
        break;
      case 'BULLISH_HAMMER':
        isMatched = bullishhammerstick(input);
        break;
      case 'BULLISH_INVERTED_HAMMER':
        isMatched = bullishinvertedhammerstick(input);
        break;
      case 'BULLISH_HARAMI':
        isMatched = bullishharami(input);
        break;
      case 'BULLISH_HARAMI_CROSS':
        isMatched = bullishharamicross(input);
        break;
      case 'BULLISH_MARUBOZU':
        isMatched = bullishmarubozu(input);
        break;
      case 'MORNING_STAR':
        isMatched = morningstar(input);
        break;
      case 'MORNING_DOJI_STAR':
        isMatched = morningdojistar(input);
        break;
      case 'DRAGONFLY_DOJI':
        isMatched = dragonflydoji(input);
        break;
      case 'BEARISH_ENGULFING':
        isMatched = bearishengulfingpattern(input);
        break;
      case 'BEARISH_HAMMER':
        isMatched = bearishhammerstick(input);
        break;
      case 'BEARISH_INVERTED_HAMMER':
        isMatched = bearishinvertedhammerstick(input);
        break;
      case 'BEARISH_HARAMI':
        isMatched = bearishharami(input);
        break;
      case 'BEARISH_HARAMI_CROSS':
        isMatched = bearishharamicross(input);
        break;
      case 'BEARISH_MARUBOZU':
        isMatched = bearishmarubozu(input);
        break;
      case 'EVENING_STAR':
        isMatched = eveningstar(input);
        break;
      case 'EVENING_DOJI_STAR':
        isMatched = eveningdojistar(input);
        break;
      case 'GRAVESTONE_DOJI':
        isMatched = gravestonedoji(input);
        break;
      case 'DARK_CLOUD_COVER':
        isMatched = darkcloudcover(input);
        break;
      case 'SHOOTING_STAR':
        isMatched = shootingstar(input);
        break;
      case 'DOJI':
        isMatched = doji(input);
        break;
      default:
        isMatched = false;
    }

    return {
      pattern,
      isMatched,
      formatted: isMatched
        ? `Pattern ${pattern} detected on latest candle`
        : `Pattern ${pattern} not currently formed`,
    };
  }
}
