import type {
  StockThreshold,
  TechnicalIndicator,
  CandlestickPattern,
  SentinelOperator,
  DisambiguationCandidate,
} from '@sentinel/shared';
import {
  FinnhubClient,
  YahooFinanceClient,
  IndicatorEngine,
  ProviderError,
  evaluateStockCondition,
  resolveSemanticEntity,
  type FinanceTelemetryEvent,
  type OHLCV,
} from '../finance_common/index.js';
import type {
  StockResearchTask,
  StockResearchOutcome,
  StockHarnessConfig,
} from './types.js';
import {
  extractSemanticQueryFields,
  type StockSemanticFields,
} from '../../agent/structured_query_agent.js';

const STOCK_ALIASES: Record<string, string> = {
  apple: 'AAPL',
  tesla: 'TSLA',
  microsoft: 'MSFT',
  nvidia: 'NVDA',
  amazon: 'AMZN',
  google: 'GOOGL',
  alphabet: 'GOOGL',
  meta: 'META',
  facebook: 'META',
  netflix: 'NFLX',
  amd: 'AMD',
  intel: 'INTC',
  berkshire: 'BRK.B',
  palantir: 'PLTR',
  coinbase: 'COIN',
};

const STOCK_STOP_WORDS = new Set([
  'alert', 'notify', 'me', 'when', 'if', 'stock', 'stocks', 'shares', 'equity', 'market',
  'price', 'crosses', 'drops', 'falls', 'rises', 'breaks', 'above', 'below', 'dips',
  'under', 'over', 'at', 'hits', 'reaches', 'target', 'value', 'monitor', 'track',
  'buy', 'sell', 'holding', 'portfolio', 'quote', 'chart', 'indicator', 'day', 'hour',
  'daily', 'weekly', 'the', 'a', 'an', 'is', 'to', 'for', 'my', 'current', 'latest',
  'check', 'watch', 'watching', 'trading', 'session', 'close', 'open'
]);

function getEasterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function getNthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) break;
    if (d.getUTCDay() === weekday) {
      count++;
      if (count === n) return day;
    }
  }
  return -1;
}

function getLastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  let lastDay = -1;
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) break;
    if (d.getUTCDay() === weekday) {
      lastDay = day;
    }
  }
  return lastDay;
}

function isObservedFixedHoliday(year: number, month: number, day: number, targetMonth: number, targetDay: number): boolean {
  const targetDate = new Date(Date.UTC(year, targetMonth - 1, targetDay));
  const targetDayOfWeek = targetDate.getUTCDay(); // 0 = Sun, 6 = Sat
  let observedDay = targetDay;
  let observedMonth = targetMonth;

  if (targetDayOfWeek === 6) {
    // Saturday -> observed on Friday before
    const prevDate = new Date(Date.UTC(year, targetMonth - 1, targetDay - 1));
    observedMonth = prevDate.getUTCMonth() + 1;
    observedDay = prevDate.getUTCDate();
  } else if (targetDayOfWeek === 0) {
    // Sunday -> observed on Monday after
    const nextDate = new Date(Date.UTC(year, targetMonth - 1, targetDay + 1));
    observedMonth = nextDate.getUTCMonth() + 1;
    observedDay = nextDate.getUTCDate();
  }

  return month === observedMonth && day === observedDay;
}

export function isNYSEHoliday(year: number, month: number, day: number): string | null {
  if (isObservedFixedHoliday(year, month, day, 1, 1)) return "New Year's Day";
  if (month === 1 && day === getNthWeekdayOfMonth(year, 1, 1, 3)) return "Martin Luther King, Jr. Day";
  if (month === 2 && day === getNthWeekdayOfMonth(year, 2, 1, 3)) return "Presidents' Day";

  const easter = getEasterSunday(year);
  const easterDate = new Date(Date.UTC(year, easter.month - 1, easter.day));
  const goodFridayDate = new Date(easterDate.getTime() - 2 * 86400000);
  if (month === goodFridayDate.getUTCMonth() + 1 && day === goodFridayDate.getUTCDate()) {
    return "Good Friday";
  }

  if (month === 5 && day === getLastWeekdayOfMonth(year, 5, 1)) return "Memorial Day";
  if (isObservedFixedHoliday(year, month, day, 6, 19)) return "Juneteenth";
  if (isObservedFixedHoliday(year, month, day, 7, 4)) return "Independence Day";
  if (month === 9 && day === getNthWeekdayOfMonth(year, 9, 1, 1)) return "Labor Day";
  if (month === 11 && day === getNthWeekdayOfMonth(year, 11, 4, 4)) return "Thanksgiving Day";
  if (isObservedFixedHoliday(year, month, day, 12, 25)) return "Christmas Day";

  return null;
}

export function detectMarketSession(now: Date = new Date()): {
  session: 'REGULAR' | 'PRE_MARKET' | 'AFTER_HOURS' | 'WEEKEND_CLOSED' | 'HOLIDAY_CLOSED';
  description: string;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  const year = parseInt(map.year, 10);
  const month = parseInt(map.month, 10);
  const day = parseInt(map.day, 10);
  const dayOfWeek = weekdayMap[map.weekday] ?? 0;
  const hours = parseInt(map.hour, 10);
  const minutes = parseInt(map.minute, 10);
  const totalMins = hours * 60 + minutes;

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return { session: 'WEEKEND_CLOSED', description: 'US markets closed for weekend' };
  }

  const holidayName = isNYSEHoliday(year, month, day);
  if (holidayName) {
    return { session: 'HOLIDAY_CLOSED', description: `US markets closed for holiday (${holidayName})` };
  }

  if (totalMins >= 570 && totalMins < 960) {
    return { session: 'REGULAR', description: 'US regular trading session' };
  }
  if (totalMins >= 240 && totalMins < 570) {
    return { session: 'PRE_MARKET', description: 'US pre-market session' };
  }
  return { session: 'AFTER_HOURS', description: 'US after-hours session' };
}

export interface ParsedStockQuery {
  rawSymbol: string;
  targetType: 'PRICE' | 'INDICATOR' | 'CANDLESTICK';
  indicator?: TechnicalIndicator;
  candlestickPattern?: CandlestickPattern;
  timeframe: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';
  period?: number;
  operator: SentinelOperator;
  targetValue?: number;
  marketHoursOnly?: boolean;
  isObservationOnly?: boolean;
  warnings: string[];
}

export function parseStockQuery(task: StockResearchTask): ParsedStockQuery {
  const rawQuery = task.query || '';
  const query = rawQuery.toLowerCase();
  const warnings: string[] = [];

  // 1. Resolve Symbol (Explicit field takes strict precedence)
  let rawSymbol = (task.ticker || '').trim().toUpperCase();
  if (!rawSymbol) {
    for (const [alias, mapped] of Object.entries(STOCK_ALIASES)) {
      const regex = new RegExp(`\\b${alias}\\b`, 'i');
      if (regex.test(query)) {
        rawSymbol = mapped;
        break;
      }
    }
  }

  if (!rawSymbol) {
    const upperMatches = rawQuery.match(/\b([A-Z]{1,5})\b/g);
    if (upperMatches) {
      for (const m of upperMatches) {
        if (!STOCK_STOP_WORDS.has(m.toLowerCase()) && !/^\d+$/.test(m)) {
          rawSymbol = m;
          break;
        }
      }
    }
  }

  if (!rawSymbol) {
    const tokens = query
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 2 && !STOCK_STOP_WORDS.has(t) && !/^\d+$/.test(t) && /[a-z]/i.test(t));
    if (tokens.length > 0) {
      rawSymbol = tokens[0].toUpperCase();
    }
  }

  // 2. Resolve Timeframe (Explicit task field takes strict precedence)
  let inferredTimeframe: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | undefined;
  if (/\b(4h|4 hour|4-hour)\b/.test(query)) inferredTimeframe = '4h';
  else if (/\b(1h|1 hour|1-hour|hourly)\b/.test(query)) inferredTimeframe = '1h';
  else if (/\b(1d|1 day|1-day|daily)\b/.test(query)) inferredTimeframe = '1d';
  else if (/\b(1w|1 week|weekly)\b/.test(query)) inferredTimeframe = '1w';
  else if (/\b(30m|30 min|30-minute)\b/.test(query)) inferredTimeframe = '30m';
  else if (/\b(15m|15 min|15-minute)\b/.test(query)) inferredTimeframe = '15m';
  else if (/\b(5m|5 min|5-minute)\b/.test(query)) inferredTimeframe = '5m';
  else if (/\b(1m|1 min|1-minute)\b/.test(query)) inferredTimeframe = '1m';

  let timeframe: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';
  if (task.timeframe) {
    timeframe = task.timeframe;
    if (inferredTimeframe && inferredTimeframe !== task.timeframe) {
      warnings.push(`Query text implies timeframe "${inferredTimeframe}" but explicit timeframe "${task.timeframe}" takes precedence.`);
    }
  } else {
    timeframe = inferredTimeframe || '1d';
  }

  // 3. Resolve Target Type & Indicators (Explicit task fields take strict precedence)
  let targetType: 'PRICE' | 'INDICATOR' | 'CANDLESTICK';
  let indicator = task.indicator;
  let candlestickPattern = task.candlestickPattern;
  let period = task.period;

  let inferredIndicator: TechnicalIndicator | undefined;
  let inferredPattern: CandlestickPattern | undefined;
  let inferredPeriod: number | undefined;

  if (/\brsi\b/.test(query)) {
    inferredIndicator = 'RSI';
    inferredPeriod = 14;
  } else if (/\b(macd)\b/.test(query)) {
    inferredIndicator = 'MACD';
  } else if (/\b(sma|simple moving average)\b/.test(query)) {
    inferredIndicator = 'SMA';
    const periodMatch = query.match(/(\d+)\s*(?:day|period|ma|sma)/);
    inferredPeriod = periodMatch ? parseInt(periodMatch[1], 10) : 50;
  } else if (/\b(ema|exponential moving average)\b/.test(query)) {
    inferredIndicator = 'EMA';
    const periodMatch = query.match(/(\d+)\s*(?:day|period|ma|ema)/);
    inferredPeriod = periodMatch ? parseInt(periodMatch[1], 10) : 50;
  } else if (/\b(volume|vol)\b/.test(query)) {
    inferredIndicator = 'VOLUME';
  } else if (/\b(vwap)\b/.test(query)) {
    inferredIndicator = 'VWAP';
  } else if (/\b(engulfing|bullish engulfing)\b/.test(query)) {
    inferredPattern = 'BULLISH_ENGULFING';
  } else if (/\b(hammer|bullish hammer)\b/.test(query)) {
    inferredPattern = 'BULLISH_HAMMER';
  } else if (/\b(morning star)\b/.test(query)) {
    inferredPattern = 'MORNING_STAR';
  }

  if (task.targetType) {
    targetType = task.targetType;
    if (task.targetType === 'INDICATOR') {
      indicator = task.indicator || inferredIndicator;
      period = task.period || inferredPeriod;
    } else if (task.targetType === 'CANDLESTICK') {
      candlestickPattern = task.candlestickPattern || inferredPattern;
    }
  } else {
    if (inferredIndicator) {
      targetType = 'INDICATOR';
      indicator = inferredIndicator;
      period = task.period || inferredPeriod;
    } else if (inferredPattern) {
      targetType = 'CANDLESTICK';
      candlestickPattern = inferredPattern;
    } else {
      targetType = 'PRICE';
    }
  }

  // 4. Resolve Operator (Explicit expectedOperator takes strict precedence)
  let inferredOperator: SentinelOperator | undefined;
  if (/\b(drops below|falls below|less than|under|dips below)\b/.test(query)) {
    inferredOperator = 'LESS_THAN';
  } else if (/\b(closes above)\b/.test(query)) {
    inferredOperator = 'CLOSES_ABOVE';
  } else if (/\b(closes below)\b/.test(query)) {
    inferredOperator = 'CLOSES_BELOW';
  } else if (/\b(crosses above|breaks above|surpasses)\b/.test(query)) {
    inferredOperator = 'CROSSES_ABOVE';
  } else if (/\b(crosses below|breaks below)\b/.test(query)) {
    inferredOperator = 'CROSSES_BELOW';
  } else if (/\b(touches|hits|reaches)\b/.test(query)) {
    inferredOperator = 'TOUCHES';
  } else if (/\b(above|over|exceeds|greater than)\b/.test(query)) {
    inferredOperator = 'GREATER_THAN';
  }

  let operator: SentinelOperator;
  if (task.expectedOperator) {
    operator = task.expectedOperator;
    if (inferredOperator && inferredOperator !== task.expectedOperator) {
      warnings.push(`Query text implies operator "${inferredOperator}" but explicit expectedOperator "${task.expectedOperator}" takes precedence.`);
    }
  } else {
    operator = inferredOperator || 'GREATER_THAN';
  }

  // 5. Target Value (Explicit targetValue takes strict precedence, do not default to live price)
  let targetValue = task.targetValue;
  if (targetValue === undefined) {
    const numMatch = query.match(/(?:below|above|over|under|at|\$)\s*([\d,]+(?:\.\d+)?)/);
    if (numMatch) {
      targetValue = parseFloat(numMatch[1].replace(/,/g, ''));
    } else if (indicator === 'RSI' && /\boversold\b/.test(query)) {
      targetValue = 30;
      if (!task.expectedOperator) operator = 'LESS_THAN';
    } else if (indicator === 'RSI' && /\boverbought\b/.test(query)) {
      targetValue = 70;
      if (!task.expectedOperator) operator = 'GREATER_THAN';
    }
  }

  // 5b. Distinguish observation-only inquiries (e.g. "What is current AAPL price?") from alerting queries
  const isObservationOnly = !task.expectedOperator && !inferredOperator && targetValue === undefined;

  // 6. Resolve Market Hours constraint
  let marketHoursOnly = true;
  if (task.marketHoursOnly !== undefined) {
    marketHoursOnly = task.marketHoursOnly;
  } else if (/\b(after hours|after-hours|extended hours|pre-market|premarket|pre market|24\/7|any time|outside market hours)\b/i.test(query)) {
    marketHoursOnly = false;
  }

  return {
    rawSymbol,
    targetType,
    indicator,
    candlestickPattern,
    timeframe,
    period,
    operator,
    targetValue,
    marketHoursOnly,
    isObservationOnly,
    warnings,
  };
}

/**
 * Semantically enriches a free-form stock query with Strands before applying
 * the existing deterministic parser and provider validation. Explicit task
 * fields always win over model-proposed fields.
 */
export async function parseStockQueryWithAgent(
  task: StockResearchTask,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<ParsedStockQuery> {
  const semantic = await extractSemanticQueryFields<StockSemanticFields>('STOCK', task.query, options);
  if (!semantic) return parseStockQuery(task);

  const enriched: StockResearchTask = { ...task };
  const validIndicators = new Set<TechnicalIndicator>([
    'SMA', 'EMA', 'WMA', 'WEMA', 'RSI', 'MACD', 'BOLLINGER_BANDS', 'BOLLINGER',
    'KELTNER_CHANNELS', 'STOCHASTIC', 'STOCHASTIC_RSI', 'CCI', 'ATR', 'ADX', 'ROC',
    'AWESOME_OSCILLATOR', 'TRIX', 'WILLIAMS_R', 'VOLUME', 'OBV', 'MFI', 'VWAP',
    'PSAR', 'ICHIMOKU_CLOUD', 'PRICE',
  ]);
  const validPatterns = new Set<CandlestickPattern>([
    'BULLISH_ENGULFING', 'BULLISH_HAMMER', 'BULLISH_INVERTED_HAMMER', 'BULLISH_HARAMI',
    'BULLISH_HARAMI_CROSS', 'BULLISH_MARUBOZU', 'MORNING_STAR', 'MORNING_DOJI_STAR',
    'DRAGONFLY_DOJI', 'BEARISH_ENGULFING', 'BEARISH_HAMMER', 'BEARISH_INVERTED_HAMMER',
    'BEARISH_HARAMI', 'BEARISH_HARAMI_CROSS', 'BEARISH_MARUBOZU', 'EVENING_STAR',
    'EVENING_DOJI_STAR', 'GRAVESTONE_DOJI', 'DARK_CLOUD_COVER', 'SHOOTING_STAR', 'DOJI',
  ]);
  const validTimeframes = new Set<NonNullable<StockResearchTask['timeframe']>>([
    '1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w',
  ]);
  const validOperators = new Set<SentinelOperator>([
    'GREATER_THAN', 'LESS_THAN', 'CROSSES_ABOVE', 'CROSSES_BELOW', 'TOUCHES',
    'CLOSES_ABOVE', 'CLOSES_BELOW', 'EQUALS', 'PERCENT_CHANGE',
  ]);

  if (!enriched.ticker && typeof semantic.ticker === 'string' && semantic.ticker.trim()) {
    enriched.ticker = semantic.ticker.trim().toUpperCase();
  }
  if (!enriched.targetType && (semantic.targetType === 'PRICE' || semantic.targetType === 'INDICATOR' || semantic.targetType === 'CANDLESTICK')) {
    enriched.targetType = semantic.targetType;
  }
  if (!enriched.indicator && typeof semantic.indicator === 'string' && validIndicators.has(semantic.indicator as TechnicalIndicator)) {
    enriched.indicator = semantic.indicator as TechnicalIndicator;
  }
  if (!enriched.candlestickPattern && typeof semantic.candlestickPattern === 'string' && validPatterns.has(semantic.candlestickPattern as CandlestickPattern)) {
    enriched.candlestickPattern = semantic.candlestickPattern as CandlestickPattern;
  }
  if (!enriched.timeframe && typeof semantic.timeframe === 'string' && validTimeframes.has(semantic.timeframe as NonNullable<StockResearchTask['timeframe']>)) {
    enriched.timeframe = semantic.timeframe as NonNullable<StockResearchTask['timeframe']>;
  }
  if (!enriched.expectedOperator && typeof semantic.expectedOperator === 'string' && validOperators.has(semantic.expectedOperator as SentinelOperator)) {
    enriched.expectedOperator = semantic.expectedOperator as SentinelOperator;
  }
  if (enriched.period === undefined && Number.isInteger(semantic.period) && Number(semantic.period) > 0 && Number(semantic.period) <= 1000) {
    enriched.period = Number(semantic.period);
  }
  if (enriched.targetValue === undefined && typeof semantic.targetValue === 'number' && Number.isFinite(semantic.targetValue)) {
    enriched.targetValue = semantic.targetValue;
  }
  if (enriched.marketHoursOnly === undefined && typeof semantic.marketHoursOnly === 'boolean') {
    enriched.marketHoursOnly = semantic.marketHoursOnly;
  }
  if (!enriched.currency && typeof semantic.currency === 'string' && /^[A-Za-z]{3,8}$/.test(semantic.currency)) {
    enriched.currency = semantic.currency.toUpperCase();
  }

  return parseStockQuery(enriched);
}

export function getTimeframeGranularity(timeframe: string): {
  finnhubResolution: string;
  yahooInterval: string;
  expectedStepMs: number;
} {
  switch (timeframe) {
    case '1m': return { finnhubResolution: '1', yahooInterval: '1m', expectedStepMs: 60_000 };
    case '5m': return { finnhubResolution: '5', yahooInterval: '5m', expectedStepMs: 300_000 };
    case '15m': return { finnhubResolution: '15', yahooInterval: '15m', expectedStepMs: 900_000 };
    case '30m': return { finnhubResolution: '30', yahooInterval: '30m', expectedStepMs: 1_800_000 };
    case '1h': return { finnhubResolution: '60', yahooInterval: '1h', expectedStepMs: 3_600_000 };
    case '4h': return { finnhubResolution: '60', yahooInterval: '4h', expectedStepMs: 14_400_000 };
    case '1w': return { finnhubResolution: 'W', yahooInterval: '1w', expectedStepMs: 604_800_000 };
    case '1d':
    default:
      return { finnhubResolution: 'D', yahooInterval: '1d', expectedStepMs: 86_400_000 };
  }
}

export interface RunStockPipelineOptions {
  config?: StockHarnessConfig;
  signal?: AbortSignal;
  executionId?: string;
}

export async function* runStockPipeline(
  task: StockResearchTask,
  optionsOrConfig: StockHarnessConfig | RunStockPipelineOptions = {},
  legacySignal?: AbortSignal
): AsyncGenerator<FinanceTelemetryEvent, StockResearchOutcome, unknown> {
  const isOptionsObj =
    optionsOrConfig &&
    typeof optionsOrConfig === 'object' &&
    ('config' in optionsOrConfig || 'executionId' in optionsOrConfig || 'signal' in optionsOrConfig);

  const config: StockHarnessConfig = isOptionsObj
    ? (optionsOrConfig as RunStockPipelineOptions).config ?? {}
    : (optionsOrConfig as StockHarnessConfig);

  const signal: AbortSignal | undefined = isOptionsObj
    ? (optionsOrConfig as RunStockPipelineOptions).signal
    : legacySignal;

  const executionId: string | undefined = isOptionsObj
    ? (optionsOrConfig as RunStockPipelineOptions).executionId
    : undefined;

  const taskId = task.id;
  const preferProvider = config.preferProvider ?? 'FINNHUB';
  const maxCandidates = config.maxCandidates ?? 5;
  const finnhub = new FinnhubClient();
  const yahoo = new YahooFinanceClient();

  yield {
    taskId,
    executionId,
    step: 'FINANCE_START',
    message: `Initiating stock discovery for query: "${task.query}"`,
    timestamp: Date.now(),
  };

  if (signal?.aborted) throw new Error('Research cancelled by user');

  const parsed = await parseStockQueryWithAgent(task, {
    signal,
    timeoutMs: Math.min(5000, Math.max(1000, config.timeoutMs ?? 5000)),
  });

  // Emit warning events for any text conflicts with explicit structured inputs
  for (const warning of parsed.warnings) {
    yield {
      taskId,
      executionId,
      step: 'RESOLVING_ENTITY',
      message: `Parameter precedence warning: ${warning}`,
      data: { warning },
      timestamp: Date.now(),
    };
  }

  // 1. Semantic resolution fallback if no rawSymbol identified
  if (!parsed.rawSymbol) {
    yield {
      taskId,
      executionId,
      step: 'RESOLVING_ENTITY',
      message: `Heuristic entity extraction inconclusive. Attempting semantic entity resolution...`,
      timestamp: Date.now(),
    };

    const semanticTicker = await resolveSemanticEntity(task.query, 'STOCK', { signal });
    if (semanticTicker) {
      parsed.rawSymbol = semanticTicker;
      yield {
        taskId,
        executionId,
        step: 'RESOLVING_ENTITY',
        message: `Semantic resolution identified equity symbol: ${semanticTicker}`,
        timestamp: Date.now(),
      };
    }
  }

  if (!parsed.rawSymbol) {
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `No stock ticker or company name detected in query: "${task.query}"`,
      timestamp: Date.now(),
    };

    return {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: 'No recognizable equity ticker symbol or company name was provided.',
      suggestion: 'Please specify an equity symbol (e.g. AAPL, NVDA, MSFT) or company name.',
    };
  }

  yield {
    taskId,
    executionId,
    step: 'RESOLVING_ENTITY',
    message: `Searching market registries for stock symbol or company "${parsed.rawSymbol}" (preferred: ${preferProvider})...`,
    data: { parsed },
    timestamp: Date.now(),
  };

  // 2. Symbol Search / Disambiguation with preferProvider respected
  let matchingSymbols: Array<{ symbol: string; name: string; exchange: string }> = [];
  let primarySearchError: unknown = null;
  let fallbackSearchError: unknown = null;

  if (preferProvider === 'YAHOO') {
    try {
      const yhResults = await yahoo.searchSymbols(parsed.rawSymbol, { signal });
      matchingSymbols = yhResults.map((r) => ({
        symbol: r.symbol,
        name: r.name,
        exchange: r.exchange,
      }));
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
      primarySearchError = err;
    }

    if (matchingSymbols.length === 0 && finnhub.isConfigured()) {
      try {
        const fhResults = await finnhub.searchSymbols(parsed.rawSymbol, { signal });
        matchingSymbols = fhResults.map((r) => ({
          symbol: r.symbol,
          name: r.description,
          exchange: 'US',
        }));
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
        fallbackSearchError = err;
      }
    }
  } else {
    // Default preferProvider === 'FINNHUB'
    if (finnhub.isConfigured()) {
      try {
        const fhResults = await finnhub.searchSymbols(parsed.rawSymbol, { signal });
        matchingSymbols = fhResults.map((r) => ({
          symbol: r.symbol,
          name: r.description,
          exchange: 'US',
        }));
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
        primarySearchError = err;
      }
    }

    if (matchingSymbols.length === 0) {
      try {
        const yhResults = await yahoo.searchSymbols(parsed.rawSymbol, { signal });
        matchingSymbols = yhResults.map((r) => ({
          symbol: r.symbol,
          name: r.name,
          exchange: r.exchange,
        }));
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
        fallbackSearchError = err;
      }
    }
  }

  // If search produced 0 matches and a provider error occurred, do NOT hide the provider error!
  if (matchingSymbols.length === 0) {
    const isProviderErr = primarySearchError instanceof ProviderError || fallbackSearchError instanceof ProviderError;
    if (isProviderErr) {
      const activeErr = primarySearchError instanceof ProviderError ? primarySearchError : (fallbackSearchError as ProviderError);
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Provider failure searching symbol for "${parsed.rawSymbol}": ${activeErr.message}`,
        timestamp: Date.now(),
      };

      return {
        status: 'ERROR',
        taskId,
        query: task.query,
        error: activeErr.message,
        provider: activeErr.provider,
        details: {
          symbol: parsed.rawSymbol,
          primaryError: (primarySearchError as Error | null)?.message,
          fallbackError: (fallbackSearchError as Error | null)?.message,
        },
      };
    }
  }

  if (signal?.aborted) throw new Error('Research cancelled by user');

  // Safe Symbol Selection: Exact match vs Disambiguation vs Not Found
  const cleanTargetSymbol = parsed.rawSymbol.toUpperCase();
  const exactSymbolMatch = matchingSymbols.find((m) => m.symbol.toUpperCase() === cleanTargetSymbol);
  const aliasTicker = STOCK_ALIASES[task.query.toLowerCase()] || STOCK_ALIASES[parsed.rawSymbol.toLowerCase()];
  const exactAliasMatch = aliasTicker ? matchingSymbols.find((m) => m.symbol.toUpperCase() === aliasTicker) : undefined;
  const highConfidenceMatch = exactSymbolMatch || exactAliasMatch;

  if (matchingSymbols.length > 1 && !highConfidenceMatch) {
    const candidates: DisambiguationCandidate[] = matchingSymbols.slice(0, maxCandidates).map((m) => ({
      id: m.symbol,
      title: `${m.name} (${m.symbol})`,
      currentValue: 'Active Listing',
      context: `Exchange: ${m.exchange}`,
      metadata: { symbol: m.symbol, exchange: m.exchange },
    }));

    const outcome: StockResearchOutcome = {
      status: 'MULTIPLE_OPTIONS',
      taskId,
      query: task.query,
      message: `Multiple stock listings found matching "${parsed.rawSymbol}". Please confirm the target ticker:`,
      candidates,
    };

    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_COMPLETE',
      message: `Multiple stock tickers matched (${candidates.length} candidates). Requesting user selection.`,
      timestamp: Date.now(),
    };

    return outcome;
  }

  let selectedTicker: string;
  let companyName: string;
  let exchange: string;

  if (highConfidenceMatch) {
    selectedTicker = highConfidenceMatch.symbol;
    companyName = highConfidenceMatch.name;
    exchange = highConfidenceMatch.exchange;
  } else if (matchingSymbols.length === 1) {
    selectedTicker = matchingSymbols[0].symbol;
    companyName = matchingSymbols[0].name;
    exchange = matchingSymbols[0].exchange;
  } else {
    // 0 search matches: only allow raw symbol if explicitly specified as task.ticker or known alias
    const isExplicitOrAlias = Boolean(task.ticker) || Boolean(aliasTicker);
    if (!isExplicitOrAlias && !/^[A-Z]{1,5}$/.test(parsed.rawSymbol)) {
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `No verified equity found matching "${parsed.rawSymbol}".`,
        timestamp: Date.now(),
      };
      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: `No verified equity found matching "${parsed.rawSymbol}".`,
        suggestion: `Please check the equity symbol (e.g. AAPL, MSFT, TSLA).`,
      };
    }
    selectedTicker = aliasTicker || parsed.rawSymbol;
    companyName = selectedTicker;
    exchange = 'US';
  }

  // 3. Live Quote Retrieval respecting preferProvider
  let provider: 'FINNHUB' | 'YAHOO' = preferProvider;
  let livePrice = 0;
  let prevClose = 0;
  let quoteHigh: number | undefined;
  let quoteLow: number | undefined;
  let quoteCurrency = task.currency || 'USD';
  let detectedExchange = exchange;

  let finnhubQuoteError: unknown = null;
  let yahooQuoteError: unknown = null;

  const attemptFinnhubQuote = async () => {
    if (!finnhub.isConfigured()) return false;
    try {
      const fhQuote = await finnhub.getQuote(selectedTicker, { signal });
      if (fhQuote && Number.isFinite(fhQuote.currentPrice) && fhQuote.currentPrice > 0) {
        livePrice = fhQuote.currentPrice;
        prevClose = fhQuote.previousClose;
        quoteHigh = fhQuote.high;
        quoteLow = fhQuote.low;
        if (fhQuote.currency && !task.currency) quoteCurrency = fhQuote.currency;
        provider = 'FINNHUB';
        return true;
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
      finnhubQuoteError = err;
    }
    return false;
  };

  const attemptYahooQuote = async () => {
    try {
      const yhQuote = await yahoo.getQuote(selectedTicker, { signal });
      if (yhQuote && Number.isFinite(yhQuote.currentPrice) && yhQuote.currentPrice > 0) {
        livePrice = yhQuote.currentPrice;
        prevClose = yhQuote.previousClose;
        if (yhQuote.currency && !task.currency) quoteCurrency = yhQuote.currency;
        if (yhQuote.exchange) detectedExchange = yhQuote.exchange;
        provider = 'YAHOO';
        return true;
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
      yahooQuoteError = err;
    }
    return false;
  };

  if (preferProvider === 'YAHOO') {
    const success = await attemptYahooQuote();
    if (!success) await attemptFinnhubQuote();
  } else {
    const success = await attemptFinnhubQuote();
    if (!success) await attemptYahooQuote();
  }

  if (livePrice <= 0) {
    const primaryError: unknown = preferProvider === 'YAHOO' ? yahooQuoteError : finnhubQuoteError;
    const fallbackError: unknown = preferProvider === 'YAHOO' ? finnhubQuoteError : yahooQuoteError;
    const isProviderErr = primaryError instanceof ProviderError || fallbackError instanceof ProviderError;

    if (isProviderErr) {
      const activeErr = primaryError instanceof ProviderError ? primaryError : (fallbackError as ProviderError);
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Provider failure fetching live quote for "${selectedTicker}": ${activeErr.message}`,
        timestamp: Date.now(),
      };

      return {
        status: 'ERROR',
        taskId,
        query: task.query,
        error: activeErr.message,
        provider: activeErr.provider,
        details: {
          ticker: selectedTicker,
          primaryError: (primaryError as Error | null)?.message,
          fallbackError: (fallbackError as Error | null)?.message,
        },
      };
    }

    const outcome: StockResearchOutcome = {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: `Could not retrieve live market quotes for stock ticker "${selectedTicker}".`,
      suggestion: `Please check the ticker symbol (e.g. "AAPL", "MSFT", "TSLA").`,
    };

    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Failed to fetch live quote for "${selectedTicker}".`,
      timestamp: Date.now(),
    };

    return outcome;
  }

  yield {
    taskId,
    executionId,
    step: 'ENTITY_RESOLVED',
    message: `Resolved ${companyName} (${selectedTicker}) at $${livePrice.toFixed(2)} via ${provider}`,
    data: { ticker: selectedTicker, price: livePrice, provider },
    timestamp: Date.now(),
  };

  // 4. Timeframe-to-Provider Candle Fetching & Validation
  const timeframeMeta = getTimeframeGranularity(parsed.timeframe);
  let indicatorDisplay = `Live Spot Price: $${livePrice.toFixed(2)}`;
  let candles: OHLCV[] = [];
  let observedNumericValue: number | null = livePrice;
  let previousNumericValue: number | undefined;
  let indicatorSeries: number[] | undefined;
  let candlestickMatched = false;

  const isHistoricalPriceOperator =
    parsed.operator === 'CROSSES_ABOVE' ||
    parsed.operator === 'CROSSES_BELOW' ||
    parsed.operator === 'CLOSES_ABOVE' ||
    parsed.operator === 'CLOSES_BELOW' ||
    parsed.operator === 'PERCENT_CHANGE';

  const needsCandles =
    parsed.targetType === 'INDICATOR' ||
    parsed.targetType === 'CANDLESTICK' ||
    isHistoricalPriceOperator;

  if (needsCandles) {
    let requiredCandles = 2;
    if (parsed.targetType === 'INDICATOR') {
      const p = parsed.period || 14;
      if (parsed.indicator === 'RSI') requiredCandles = p + 10;
      else if (parsed.indicator === 'SMA') requiredCandles = p;
      else if (parsed.indicator === 'EMA') requiredCandles = p * 2;
      else if (parsed.indicator === 'MACD') requiredCandles = 35;
      else requiredCandles = 10;
    } else if (parsed.targetType === 'CANDLESTICK') {
      requiredCandles = 5;
    }

    yield {
      taskId,
      executionId,
      step: 'CALCULATING_INDICATOR',
      message: `Fetching historical ${parsed.timeframe} candles to evaluate ${parsed.targetType === 'PRICE' ? parsed.operator : parsed.indicator || parsed.candlestickPattern} (requires >= ${requiredCandles} candles)...`,
      timestamp: Date.now(),
    };

    let finnhubCandleError: unknown = null;
    let yahooCandleError: unknown = null;

    // Attempt candle fetching with provider preference
    const fetchYahooCandles = async () => {
      try {
        return await yahoo.getCandles(selectedTicker, timeframeMeta.yahooInterval, '3mo', { signal });
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
        yahooCandleError = err;
        return [];
      }
    };

    const fetchFinnhubCandles = async () => {
      if (!finnhub.isConfigured()) return [];
      try {
        return await finnhub.getCandles(selectedTicker, timeframeMeta.finnhubResolution, requiredCandles, { signal });
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
        finnhubCandleError = err;
        return [];
      }
    };

    if (preferProvider === 'FINNHUB') {
      candles = await fetchFinnhubCandles();
      if (candles.length === 0) candles = await fetchYahooCandles();
    } else {
      candles = await fetchYahooCandles();
      if (candles.length === 0) candles = await fetchFinnhubCandles();
    }

    // Strictly validate finite numbers for all candles
    candles = candles.filter((c) =>
      Number.isFinite(c.timestamp) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      Number.isFinite(c.volume)
    );

    // Fail closed if candles are missing or insufficient
    if (candles.length < requiredCandles) {
      if (candles.length === 0) {
        const primaryErr: unknown = preferProvider === 'FINNHUB' ? finnhubCandleError : yahooCandleError;
        const fallbackErr: unknown = preferProvider === 'FINNHUB' ? yahooCandleError : finnhubCandleError;
        const isProviderErr = primaryErr instanceof ProviderError || fallbackErr instanceof ProviderError;

        if (isProviderErr) {
          const activeErr = primaryErr instanceof ProviderError ? primaryErr : (fallbackErr as ProviderError);
          yield {
            taskId,
            executionId,
            step: 'DISCOVERY_ERROR',
            message: `Provider failure fetching historical candles for "${selectedTicker}": ${activeErr.message}`,
            timestamp: Date.now(),
          };

          return {
            status: 'ERROR',
            taskId,
            query: task.query,
            error: activeErr.message,
            provider: activeErr.provider,
            details: {
              ticker: selectedTicker,
              primaryError: (primaryErr as Error | null)?.message,
              fallbackError: (fallbackErr as Error | null)?.message,
            },
          };
        }
      }

      const failReason = `Insufficient historical candle data: required at least ${requiredCandles} candles on timeframe "${parsed.timeframe}", but only ${candles.length} were returned.`;
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: failReason,
        timestamp: Date.now(),
      };

      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: failReason,
        suggestion: `Historical candles for ${parsed.timeframe} are limited. Try a higher timeframe (e.g. "1d") or a shorter indicator period.`,
      };
    }

    // Indicator calculation
    if (parsed.targetType === 'INDICATOR' && parsed.indicator) {
      const calc = IndicatorEngine.calculateIndicator(parsed.indicator, candles, {
        period: parsed.period,
      });

      if (!calc || calc.value === null || calc.value === undefined || !Number.isFinite(calc.value)) {
        const failReason = `Mathematical calculation failed for indicator ${parsed.indicator} on available candle data.`;
        yield {
          taskId,
          executionId,
          step: 'DISCOVERY_ERROR',
          message: failReason,
          timestamp: Date.now(),
        };

        return {
          status: 'NOT_FOUND',
          taskId,
          query: task.query,
          reason: failReason,
        };
      }

      observedNumericValue = calc.value;
      previousNumericValue = calc.previousValue;
      indicatorSeries = calc.series;
      indicatorDisplay = calc.formatted;
    } else if (parsed.targetType === 'CANDLESTICK' && parsed.candlestickPattern) {
      const patternRes = IndicatorEngine.checkCandlestickPattern(
        parsed.candlestickPattern,
        candles
      );
      candlestickMatched = patternRes.isMatched;
      indicatorDisplay = patternRes.formatted;
      observedNumericValue = candlestickMatched ? 1 : 0;
    }
  }

  // 5. Condition Evaluation against requested Operator & Target Value
  const conditionEvaluation = evaluateStockCondition({
    targetType: parsed.targetType,
    operator: parsed.operator,
    observedValue: observedNumericValue,
    previousObservedValue: previousNumericValue,
    indicatorName: parsed.indicator,
    indicatorSeries,
    targetValue: parsed.targetValue,
    candlestickMatched,
    candles: candles.length > 0 ? candles : undefined,
    high: quoteHigh,
    low: quoteLow,
    isObservationOnly: parsed.isObservationOnly,
  });

  if (isHistoricalPriceOperator) {
    if (parsed.targetType === 'PRICE' || parsed.operator === 'PERCENT_CHANGE') {
      observedNumericValue = conditionEvaluation.observedValue;
      indicatorDisplay = conditionEvaluation.evaluationDetails;
    } else {
      indicatorDisplay = `${indicatorDisplay} | ${conditionEvaluation.evaluationDetails}`;
    }
  }

  // If the requested stock condition is unsatisfied, fail closed with NOT_FOUND
  if (!conditionEvaluation.conditionSatisfied) {
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Stock condition unsatisfied: ${conditionEvaluation.evaluationDetails}`,
      data: { conditionEvaluation },
      timestamp: Date.now(),
    };

    return {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: `Condition unsatisfied: ${conditionEvaluation.evaluationDetails}`,
      suggestion: `Observed value is ${observedNumericValue !== null ? observedNumericValue.toLocaleString() : 'unavailable'}, which does not satisfy ${parsed.operator} ${parsed.targetValue !== undefined ? parsed.targetValue : ''}.`,
    };
  }

  // 6. Synthesize Deterministic Contract (Do NOT default targetValue to livePrice)
  const contractCurrency = task.currency || quoteCurrency || 'USD';
  const contractExchange = detectedExchange || exchange || 'US';
  const contractMarketHoursOnly = parsed.marketHoursOnly ?? true;

  const contract: StockThreshold = {
    ticker: selectedTicker,
    exchange: contractExchange,
    currency: contractCurrency,
    provider,
    marketHoursOnly: contractMarketHoursOnly,
    targetType: parsed.targetType,
    indicator: parsed.indicator,
    candlestickPattern: parsed.candlestickPattern,
    period: parsed.period,
    timeframe: parsed.timeframe,
    targetValue: parsed.targetValue, // Preserves undefined if user asked for current price without threshold
    operator: parsed.operator,
    observedValue: observedNumericValue ?? livePrice,
    conditionSatisfied: conditionEvaluation.conditionSatisfied,
    evaluationDetails: conditionEvaluation.evaluationDetails,
    conditionEvaluation,
  };

  const sessionInfo = detectMarketSession();
  const currencyPrefix = contractCurrency === 'USD' ? '$' : contractCurrency === 'EUR' ? '€' : contractCurrency === 'GBP' ? '£' : `${contractCurrency} `;
  const outcome: StockResearchOutcome = {
    status: 'EXACT_MATCH',
    taskId,
    query: task.query,
    contract,
    currentDisplayValue: `${currencyPrefix}${livePrice.toFixed(2)}`,
    verificationDetails: `${indicatorDisplay} (${companyName} on ${contractExchange} via ${provider}) [${sessionInfo.description}]`,
    confidence: 0.98,
  };

  yield {
    taskId,
    executionId,
    step: 'DISCOVERY_COMPLETE',
    message: `Stock research complete: condition verified and deterministic contract synthesized for ${selectedTicker}.`,
    data: { outcomeStatus: outcome.status, contract },
    timestamp: Date.now(),
  };

  return outcome;
}
