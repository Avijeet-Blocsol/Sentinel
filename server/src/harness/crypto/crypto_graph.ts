import type {
  CryptoThreshold,
  TechnicalIndicator,
  CandlestickPattern,
  SentinelOperator,
  DisambiguationCandidate,
} from '@sentinel/shared';
import {
  CoinbaseClient,
  DexScreenerClient,
  IndicatorEngine,
  ProviderError,
  UnsupportedIndicatorError,
  evaluateCryptoCondition,
  resolveSemanticEntity,
  type FinanceTelemetryEvent,
  type OHLCV,
} from '../finance_common/index.js';
import type {
  CryptoResearchTask,
  CryptoResearchOutcome,
  CryptoHarnessConfig,
} from './types.js';

const COIN_ALIASES: Record<string, string> = {
  bitcoin: 'BTC',
  btc: 'BTC',
  ethereum: 'ETH',
  ether: 'ETH',
  eth: 'ETH',
  solana: 'SOL',
  sol: 'SOL',
  dogecoin: 'DOGE',
  doge: 'DOGE',
  cardano: 'ADA',
  ada: 'ADA',
  ripple: 'XRP',
  xrp: 'XRP',
  avalanche: 'AVAX',
  avax: 'AVAX',
  chainlink: 'LINK',
  link: 'LINK',
  polkadot: 'DOT',
  dot: 'DOT',
  near: 'NEAR',
  sui: 'SUI',
  pepe: 'PEPE',
  shiba: 'SHIB',
  shib: 'SHIB',
};

const CRYPTO_STOP_WORDS = new Set([
  'alert', 'notify', 'me', 'when', 'if', 'crypto', 'cryptocurrency', 'token', 'tokens', 'coin', 'coins',
  'price', 'crosses', 'drops', 'falls', 'rises', 'breaks', 'above', 'below', 'dips',
  'under', 'over', 'at', 'hits', 'reaches', 'target', 'value', 'monitor', 'track',
  'buy', 'sell', 'swap', 'pool', 'chart', 'indicator', 'day', 'hour', 'daily',
  'the', 'a', 'an', 'is', 'to', 'for', 'my', 'current', 'latest', 'liquidity',
  'check', 'watch', 'watching', 'trading'
]);

export interface ParsedCryptoQuery {
  assetSymbol: string;
  targetType: 'PRICE' | 'INDICATOR' | 'CANDLESTICK';
  indicator?: TechnicalIndicator;
  candlestickPattern?: CandlestickPattern;
  timeframe: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';
  period?: number;
  operator: SentinelOperator;
  targetValue?: number;
  isObservationOnly?: boolean;
  warnings: string[];
}

export function parseCryptoQuery(task: CryptoResearchTask): ParsedCryptoQuery {
  const rawQuery = task.query || '';
  const query = rawQuery.toLowerCase();
  const warnings: string[] = [];

  // 1. Resolve Symbol (Task explicit field takes strict precedence)
  let symbol = (task.assetSymbol || '').trim().toUpperCase();
  if (!symbol) {
    for (const [alias, mapped] of Object.entries(COIN_ALIASES)) {
      const regex = new RegExp(`\\b${alias}\\b`, 'i');
      if (regex.test(query)) {
        symbol = mapped;
        break;
      }
    }
  }

  // Check for explicit uppercase token in raw query, excluding stop-words and pure numbers
  if (!symbol) {
    const upperMatches = rawQuery.match(/\b([A-Z0-9]{2,8})\b/g);
    if (upperMatches) {
      for (const m of upperMatches) {
        if (!CRYPTO_STOP_WORDS.has(m.toLowerCase()) && !/^\d+$/.test(m) && /[a-z]/i.test(m)) {
          symbol = m;
          break;
        }
      }
    }
  }

  // Fallback: Extract first alphanumeric token that is NOT a stop-word and contains letters
  if (!symbol) {
    const tokens = query
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 2 && !CRYPTO_STOP_WORDS.has(t) && !/^\d+$/.test(t) && /[a-z]/i.test(t));
    if (tokens.length > 0) {
      symbol = tokens[0].toUpperCase();
    }
  }

  // 2. Resolve Timeframe (Task explicit field takes precedence)
  let timeframe = task.timeframe;
  let inferredTimeframe: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | undefined;
  if (/\b(4h|4 hour|4-hour)\b/.test(query)) inferredTimeframe = '4h';
  else if (/\b(1h|1 hour|1-hour|hourly)\b/.test(query)) inferredTimeframe = '1h';
  else if (/\b(1d|1 day|1-day|daily)\b/.test(query)) inferredTimeframe = '1d';
  else if (/\b(15m|15 min|15-minute)\b/.test(query)) inferredTimeframe = '15m';
  else if (/\b(5m|5 min|5-minute)\b/.test(query)) inferredTimeframe = '5m';

  if (timeframe) {
    if (inferredTimeframe && inferredTimeframe !== timeframe) {
      warnings.push(`Query text implies timeframe "${inferredTimeframe}" but explicit timeframe "${timeframe}" takes precedence.`);
    }
  } else {
    timeframe = inferredTimeframe || '1h';
  }

  // 3. Resolve Target Type & Indicators (Task explicit fields take precedence - Item 7)
  let targetType = task.targetType;
  let indicator = task.indicator;
  let candlestickPattern = task.candlestickPattern;
  let period = task.period;

  if (task.targetType) {
    targetType = task.targetType;
    if (task.targetType === 'INDICATOR' && !indicator) {
      if (/\brsi\b/.test(query)) {
        indicator = 'RSI';
        period = period || 14;
      } else if (/\b(macd)\b/.test(query)) {
        indicator = 'MACD';
      } else if (/\b(sma)\b/.test(query)) {
        indicator = 'SMA';
      } else if (/\b(ema)\b/.test(query)) {
        indicator = 'EMA';
      } else if (/\b(vwap)\b/.test(query)) {
        indicator = 'VWAP';
      }
    }
  } else {
    // Infer targetType from query text
    if (/\brsi\b/.test(query) || indicator === 'RSI') {
      targetType = 'INDICATOR';
      indicator = 'RSI';
      period = period || 14;
    } else if (/\b(macd)\b/.test(query) || indicator === 'MACD') {
      targetType = 'INDICATOR';
      indicator = 'MACD';
    } else if (/\b(sma|simple moving average)\b/.test(query) || indicator === 'SMA') {
      targetType = 'INDICATOR';
      indicator = 'SMA';
      const periodMatch = query.match(/(\d+)\s*(?:day|period|ma|sma)/);
      period = period || (periodMatch ? parseInt(periodMatch[1], 10) : 50);
    } else if (/\b(ema|exponential moving average)\b/.test(query) || indicator === 'EMA') {
      targetType = 'INDICATOR';
      indicator = 'EMA';
      const periodMatch = query.match(/(\d+)\s*(?:day|period|ma|ema)/);
      period = period || (periodMatch ? parseInt(periodMatch[1], 10) : 50);
    } else if (/\b(volume|vol)\b/.test(query) || indicator === 'VOLUME') {
      targetType = 'INDICATOR';
      indicator = 'VOLUME';
    } else if (/\b(vwap)\b/.test(query) || indicator === 'VWAP') {
      targetType = 'INDICATOR';
      indicator = 'VWAP';
    } else if (/\b(engulfing|bullish engulfing)\b/.test(query)) {
      targetType = 'CANDLESTICK';
      candlestickPattern = 'BULLISH_ENGULFING';
    } else if (/\b(hammer|bullish hammer)\b/.test(query)) {
      targetType = 'CANDLESTICK';
      candlestickPattern = 'BULLISH_HAMMER';
    } else if (/\b(morning star)\b/.test(query)) {
      targetType = 'CANDLESTICK';
      candlestickPattern = 'MORNING_STAR';
    } else {
      targetType = 'PRICE';
    }
  }

  // 4. Resolve Operator (Item 7: Explicit expectedOperator takes strict precedence)
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

  // 5. Target Value (Explicit targetValue takes strict precedence)
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

  const isObservationOnly = !task.expectedOperator && !inferredOperator && targetValue === undefined;

  return {
    assetSymbol: symbol,
    targetType: targetType || 'PRICE',
    indicator,
    candlestickPattern,
    timeframe: timeframe || '1h',
    period,
    operator,
    targetValue,
    isObservationOnly,
    warnings,
  };
}

/**
 * Calculates dynamic confidence score based on venue reliability, 24h volume,
 * pool liquidity, and candle history sufficiency.
 */
function calculateDynamicConfidence(params: {
  venue: 'COINBASE' | 'DEXSCREENER';
  liquidityUsd?: number;
  volume24h?: number;
  targetType: 'PRICE' | 'INDICATOR' | 'CANDLESTICK';
  verifiedCandlesCount: number;
  requiredCandles: number;
}): number {
  let score = params.venue === 'COINBASE' ? 0.95 : 0.88;

  // 1. DEX liquidity adjustments
  if (params.venue === 'DEXSCREENER') {
    const liq = params.liquidityUsd ?? 0;
    if (liq < 25000) score -= 0.15;
    else if (liq < 100000) score -= 0.05;
    else if (liq > 1000000) score += 0.03;
  }

  // 2. Volume adjustments
  const vol = params.volume24h ?? 0;
  if (vol > 10_000_000) score += 0.03;
  else if (vol < 50_000) score -= 0.05;

  // 3. Candle history sufficiency for technical calculations
  if (params.targetType === 'INDICATOR' || params.targetType === 'CANDLESTICK' || params.requiredCandles > 1) {
    if (params.verifiedCandlesCount < params.requiredCandles) {
      score -= 0.30;
    } else {
      const ratio = params.verifiedCandlesCount / Math.max(1, params.requiredCandles * 2);
      score += Math.min(0.04, (ratio - 1) * 0.02);
    }
  }

  return Math.max(0.10, Math.min(0.99, Math.round(score * 100) / 100));
}

export async function* runCryptoPipeline(
  task: CryptoResearchTask,
  configOrOptions:
    | CryptoHarnessConfig
    | { config?: CryptoHarnessConfig; signal?: AbortSignal; executionId?: string } = {},
  signalArg?: AbortSignal
): AsyncGenerator<FinanceTelemetryEvent, CryptoResearchOutcome, unknown> {
  let config: CryptoHarnessConfig = {};
  let signal: AbortSignal | undefined = signalArg;
  let executionId: string | undefined;

  if (configOrOptions) {
    if (
      'config' in configOrOptions ||
      'executionId' in configOrOptions ||
      ('signal' in configOrOptions && !('timeoutMs' in configOrOptions))
    ) {
      const opts = configOrOptions as {
        config?: CryptoHarnessConfig;
        signal?: AbortSignal;
        executionId?: string;
      };
      config = opts.config ?? {};
      signal = opts.signal ?? signalArg;
      executionId = opts.executionId;
    } else {
      config = configOrOptions as CryptoHarnessConfig;
    }
  }

  const taskId = task.id;
  const timeoutMs = config.timeoutMs ?? 10000;
  const deadline = Date.now() + timeoutMs;
  const maxCandidates = config.maxCandidates ?? 5;

  const coinbase = new CoinbaseClient();
  const dexscreener = new DexScreenerClient();

  const getClientOptions = () => ({
    signal,
    timeoutMs: Math.max(100, deadline - Date.now()),
  });

  yield {
    taskId,
    executionId,
    step: 'FINANCE_START',
    message: `Initiating crypto market research for query: "${task.query}"`,
    timestamp: Date.now(),
  };

  if (signal?.aborted) throw new Error('Research cancelled by user');

  const parsed = parseCryptoQuery(task);

  // Emit any parameter precedence warnings (Item 7)
  if (parsed.warnings && parsed.warnings.length > 0) {
    for (const warningMsg of parsed.warnings) {
      yield {
        taskId,
        executionId,
        step: 'RESOLVING_ENTITY',
        message: `Parameter precedence warning: ${warningMsg}`,
        timestamp: Date.now(),
      };
    }
  }

  if (!parsed.assetSymbol) {
    yield {
      taskId,
      executionId,
      step: 'RESOLVING_ENTITY',
      message: `Heuristic entity extraction inconclusive. Attempting semantic entity resolution...`,
      timestamp: Date.now(),
    };

    const semanticSymbol = await resolveSemanticEntity(task.query, 'CRYPTO');
    if (semanticSymbol) {
      parsed.assetSymbol = semanticSymbol;
      yield {
        taskId,
        executionId,
        step: 'RESOLVING_ENTITY',
        message: `Semantic resolution identified crypto asset: ${semanticSymbol}`,
        timestamp: Date.now(),
      };
    }
  }

  if (!parsed.assetSymbol) {
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `No cryptocurrency symbol or token name detected in query: "${task.query}"`,
      timestamp: Date.now(),
    };

    return {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: 'No recognizable cryptocurrency asset symbol or token name was provided.',
      suggestion: 'Please specify a token ticker (e.g. BTC, ETH, SOL, PEPE) or contract address.',
    };
  }

  // Item 3: Validate indicator support upfront if indicator requested
  if (parsed.targetType === 'INDICATOR' && parsed.indicator) {
    if (!IndicatorEngine.isSupported(parsed.indicator)) {
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Unsupported technical indicator: "${parsed.indicator}".`,
        timestamp: Date.now(),
      };

      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: `Unsupported technical indicator: "${parsed.indicator}".`,
        suggestion: `Please use supported indicators: SMA, EMA, RSI, MACD, Bollinger Bands, VWAP, ATR, ADX, CCI, Stochastic, etc.`,
      };
    }
  }

  yield {
    taskId,
    executionId,
    step: 'RESOLVING_ENTITY',
    message: `Resolving trading venues for asset symbol "${parsed.assetSymbol}"...`,
    data: { parsed },
    timestamp: Date.now(),
  };

  // 1. Try Coinbase first (top-tier CEX liquidity)
  let cbProduct: any = null;
  let liveQuote: any = null;
  let venue: 'COINBASE' | 'DEXSCREENER' = 'COINBASE';
  let dexPair: any = null;
  let coinbaseProviderError: string | null = null;

  try {
    cbProduct = await coinbase.resolveProduct(parsed.assetSymbol, getClientOptions());
    liveQuote = cbProduct ? await coinbase.getSpotPrice(cbProduct.id, getClientOptions()) : null;
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError' || signal?.aborted) {
      throw err;
    }
    if (err instanceof ProviderError) {
      coinbaseProviderError = err.message;
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Coinbase provider error: ${err.message}`,
        data: { error: err.message, provider: 'COINBASE' },
        timestamp: Date.now(),
      };
    } else {
      throw err;
    }
  }

  if (signal?.aborted) throw new Error('Research cancelled by user');

  // 2. If not on Coinbase, search on-chain DEX pairs via DexScreener
  if (!liveQuote) {
    yield {
      taskId,
      executionId,
      step: 'RESOLVING_ENTITY',
      message: `Asset not active on Coinbase USD. Searching on-chain DEX pairs via DexScreener...`,
      timestamp: Date.now(),
    };

    let dexPairs: any[] = [];
    try {
      // Pass verification parameters & deadline to DexScreener (Items 5, 6, 9)
      dexPairs = await dexscreener.searchPairs(parsed.assetSymbol, {
        ...getClientOptions(),
        symbol: parsed.assetSymbol,
        contractAddress: task.dexContractAddress,
        network: task.dexNetwork,
        maxCandidates,
      });
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError' || signal?.aborted) {
        throw err;
      }
      if (err instanceof ProviderError) {
        yield {
          taskId,
          executionId,
          step: 'DISCOVERY_ERROR',
          message: `DexScreener provider error: ${err.message}`,
          data: { error: err.message, provider: 'DEXSCREENER' },
          timestamp: Date.now(),
        };

        // Item 8: If provider explicitly errored, return ERROR outcome, not NOT_FOUND
        return {
          status: 'ERROR',
          taskId,
          query: task.query,
          error: `Market data provider failure: ${err.message}${coinbaseProviderError ? ` (Coinbase also failed: ${coinbaseProviderError})` : ''}`,
          provider: 'DEXSCREENER',
        };
      }
      throw err;
    }

    // Strict verification of returned pairs against requested asset (Item 6)
    const verifiedDexPairs = dexPairs.filter((p) => {
      if (task.dexContractAddress) {
        const addr = task.dexContractAddress.toLowerCase();
        if (p.baseToken.address.toLowerCase() !== addr && p.pairAddress.toLowerCase() !== addr) {
          return false;
        }
      }
      if (task.dexNetwork) {
        if (p.chainId.toLowerCase() !== task.dexNetwork.toLowerCase()) {
          return false;
        }
      }
      if (parsed.assetSymbol) {
        const sym = parsed.assetSymbol.toUpperCase();
        if (p.baseToken.symbol.toUpperCase() !== sym && p.baseToken.name.toLowerCase() !== parsed.assetSymbol.toLowerCase()) {
          return false;
        }
      }
      return true;
    });

    if (verifiedDexPairs.length > 1) {
      // Item 9: Enforce maxCandidates on disambiguation options
      const candidates: DisambiguationCandidate[] = verifiedDexPairs
        .slice(0, maxCandidates)
        .map((p) => ({
          id: p.pairAddress,
          title: `${p.baseToken.name} (${p.baseToken.symbol}) on ${p.chainId.toUpperCase()} / ${p.dexId}`,
          currentValue: `$${parseFloat(p.priceUsd).toFixed(6)}`,
          context: `Liq: $${Math.round(p.liquidityUsd || 0).toLocaleString()} • 24h Vol: $${Math.round(p.volume24h || 0).toLocaleString()}`,
          metadata: {
            pairAddress: p.pairAddress,
            chainId: p.chainId,
            dexId: p.dexId,
            baseTokenAddress: p.baseToken.address,
          },
        }));

      const outcome: CryptoResearchOutcome = {
        status: 'MULTIPLE_OPTIONS',
        taskId,
        query: task.query,
        message: `Found ${candidates.length} active liquidity pools for "${parsed.assetSymbol}". Please select the desired pair:`,
        candidates,
      };

      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_COMPLETE',
        message: `Discovered multiple candidate DEX pools. Requesting user selection.`,
        timestamp: Date.now(),
      };

      return outcome;
    } else if (verifiedDexPairs.length === 1) {
      dexPair = verifiedDexPairs[0];
      venue = 'DEXSCREENER';
      liveQuote = {
        productId: dexPair.pairAddress,
        price: parseFloat(dexPair.priceUsd),
        volume24h: dexPair.volume24h || 0,
        high24h: 0,
        low24h: 0,
        open24h: 0,
        timestamp: Date.now(),
      };
    }
  }

  // If primary provider had a provider error and no asset was found anywhere
  if ((!liveQuote || liveQuote.price <= 0) && coinbaseProviderError) {
    return {
      status: 'ERROR',
      taskId,
      query: task.query,
      error: `Primary market provider error: ${coinbaseProviderError}`,
      provider: 'COINBASE',
    };
  }

  if (!liveQuote || liveQuote.price <= 0) {
    const outcome: CryptoResearchOutcome = {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: `Could not find an active, liquid trading pair for "${parsed.assetSymbol}" on Coinbase or DexScreener.`,
      suggestion: `Please check the token ticker or specify a direct DEX contract address.`,
    };

    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Failed to resolve active market data for "${parsed.assetSymbol}".`,
      timestamp: Date.now(),
    };

    return outcome;
  }

  yield {
    taskId,
    executionId,
    step: 'ENTITY_RESOLVED',
    message: `Resolved ${parsed.assetSymbol} on ${venue} at live price $${liveQuote.price.toLocaleString()}`,
    data: { venue, price: liveQuote.price },
    timestamp: Date.now(),
  };

  if (signal?.aborted) throw new Error('Research cancelled by user');

  // 3. Technical Indicator / Candlestick Math Calibration (Items 2, 3)
  let indicatorDisplay = `Live Spot Price: $${liveQuote.price.toLocaleString()}`;
  let verifiedCandlesCount = 0;
  let requiredCandles = 1;
  let observedNumericValue: number | null = liveQuote.price;
  let candlestickMatched: boolean | undefined = undefined;
  let verifiedCandles: OHLCV[] = [];

  const isHistoricalPriceOperator =
    parsed.targetType === 'PRICE' &&
    (parsed.operator === 'CROSSES_ABOVE' ||
      parsed.operator === 'CROSSES_BELOW' ||
      parsed.operator === 'CLOSES_ABOVE' ||
      parsed.operator === 'CLOSES_BELOW' ||
      parsed.operator === 'PERCENT_CHANGE');

  if (isHistoricalPriceOperator) {
    if (venue !== 'COINBASE') {
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Historical candle data is unavailable for DEX pair on DexScreener. Historical price operator "${parsed.operator}" requires exchange OHLCV candle history.`,
        timestamp: Date.now(),
      };

      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: `Historical price operator "${parsed.operator}" requires OHLCV candle history, which is not available for DEX pair "${dexPair?.pairAddress || parsed.assetSymbol}" on DexScreener.`,
        suggestion: 'Use simple price threshold operators (GREATER_THAN, LESS_THAN) for DEX tokens, or query an asset active on Coinbase.',
      };
    }

    requiredCandles =
      parsed.operator === 'CROSSES_ABOVE' ||
      parsed.operator === 'CROSSES_BELOW' ||
      parsed.operator === 'PERCENT_CHANGE'
        ? 2
        : 1;

    yield {
      taskId,
      executionId,
      step: 'CALCULATING_INDICATOR',
      message: `Fetching historical ${parsed.timeframe} candles to evaluate price condition ${parsed.operator} (requires at least ${requiredCandles} candles)...`,
      timestamp: Date.now(),
    };

    const granularityMap: Record<string, number> = {
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600,
      '4h': 21600,
      '1d': 86400,
    };
    const granularity = granularityMap[parsed.timeframe] || 3600;

    try {
      verifiedCandles = await coinbase.getCandles(cbProduct!.id, granularity, getClientOptions());
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
      if (err instanceof ProviderError) {
        return {
          status: 'ERROR',
          taskId,
          query: task.query,
          error: `Failed to fetch candle data from Coinbase: ${err.message}`,
          provider: 'COINBASE',
        };
      }
      throw err;
    }

    verifiedCandlesCount = verifiedCandles.length;

    if (verifiedCandlesCount < requiredCandles) {
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Insufficient candle data: operator ${parsed.operator} requires at least ${requiredCandles} candles, but received ${verifiedCandlesCount} on ${venue}.`,
        timestamp: Date.now(),
      };

      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: `Insufficient historical candle data to evaluate ${parsed.operator}. Required at least ${requiredCandles} candles, but received ${verifiedCandlesCount} on ${venue}.`,
        suggestion: `Historical candles for ${parsed.timeframe} on ${venue} are limited. Try a different timeframe.`,
      };
    }
  } else if (parsed.targetType === 'INDICATOR') {
    if (!parsed.indicator) {
      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: 'Technical indicator target specified, but no indicator was recognized.',
      };
    }

    requiredCandles = IndicatorEngine.getRequiredCandleCount(parsed.indicator, {
      period: parsed.period,
    });

    yield {
      taskId,
      executionId,
      step: 'CALCULATING_INDICATOR',
      message: `Fetching historical ${parsed.timeframe} candles to calibrate ${parsed.indicator} (requires ${requiredCandles} candles)...`,
      timestamp: Date.now(),
    };

    const granularityMap: Record<string, number> = {
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600,
      '4h': 21600,
      '1d': 86400,
    };
    const granularity = granularityMap[parsed.timeframe] || 3600;

    if (venue === 'COINBASE') {
      try {
        verifiedCandles = await coinbase.getCandles(cbProduct!.id, granularity, getClientOptions());
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
        if (err instanceof ProviderError) {
          return {
            status: 'ERROR',
            taskId,
            query: task.query,
            error: `Failed to fetch candle data from Coinbase: ${err.message}`,
            provider: 'COINBASE',
          };
        }
      }
    }

    verifiedCandlesCount = verifiedCandles.length;

    // Item 2: Missing indicator data must NOT produce EXACT_MATCH
    if (verifiedCandlesCount < requiredCandles) {
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Insufficient candle data: ${parsed.indicator} requires at least ${requiredCandles} candles, but only ${verifiedCandlesCount} available on ${venue}.`,
        timestamp: Date.now(),
      };

      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: `Insufficient historical candle data to calculate ${parsed.indicator}. Required at least ${requiredCandles} candles, but received ${verifiedCandlesCount} on ${venue}.`,
        suggestion: `Historical candles for ${parsed.timeframe} on ${venue} are limited. Try a shorter calculation period or a different timeframe.`,
      };
    }

    let calcResult;
    try {
      calcResult = IndicatorEngine.calculateIndicator(parsed.indicator, verifiedCandles, {
        period: parsed.period,
      });
    } catch (err: unknown) {
      if (err instanceof UnsupportedIndicatorError) {
        return {
          status: 'NOT_FOUND',
          taskId,
          query: task.query,
          reason: err.message,
        };
      }
      throw err;
    }

    if (!calcResult) {
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Mathematical calculation failed for indicator ${parsed.indicator}.`,
        timestamp: Date.now(),
      };

      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: `Unable to compute indicator ${parsed.indicator} on available candle data.`,
      };
    }

    observedNumericValue = calcResult.value;
    indicatorDisplay = calcResult.formatted;
  } else if (parsed.targetType === 'CANDLESTICK') {
    if (!parsed.candlestickPattern) {
      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: 'Candlestick pattern target specified, but no pattern was recognized.',
      };
    }

    requiredCandles = 5;
    yield {
      taskId,
      executionId,
      step: 'CALCULATING_INDICATOR',
      message: `Evaluating candlestick pattern ${parsed.candlestickPattern}...`,
      timestamp: Date.now(),
    };

    if (venue === 'COINBASE') {
      try {
        verifiedCandles = await coinbase.getCandles(cbProduct!.id, 3600, getClientOptions());
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
        if (err instanceof ProviderError) {
          return {
            status: 'ERROR',
            taskId,
            query: task.query,
            error: `Failed to fetch candle data from Coinbase: ${err.message}`,
            provider: 'COINBASE',
          };
        }
      }
    }

    verifiedCandlesCount = verifiedCandles.length;

    // Item 2: Missing candle data for candlestick pattern
    if (verifiedCandlesCount < 5) {
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Insufficient candle data for candlestick pattern checking: required at least 5 candles, got ${verifiedCandlesCount}.`,
        timestamp: Date.now(),
      };

      return {
        status: 'NOT_FOUND',
        taskId,
        query: task.query,
        reason: `Insufficient candle data: pattern detection requires at least 5 candles, but only ${verifiedCandlesCount} were returned on ${venue}.`,
      };
    }

    const patternRes = IndicatorEngine.checkCandlestickPattern(
      parsed.candlestickPattern,
      verifiedCandles
    );
    candlestickMatched = patternRes.isMatched;
    indicatorDisplay = patternRes.formatted;
    observedNumericValue = candlestickMatched ? 1 : 0;
  }

  // 4. Evaluate Condition Against Requested Operator & Target Value (Items 1, 11)
  const conditionEvaluation = evaluateCryptoCondition({
    targetType: parsed.targetType,
    operator: parsed.operator,
    observedValue: observedNumericValue,
    targetValue: parsed.targetValue,
    candlestickMatched,
    candles: verifiedCandles,
    high24h: liveQuote.high24h,
    low24h: liveQuote.low24h,
    isObservationOnly: parsed.isObservationOnly,
  });

  if (isHistoricalPriceOperator) {
    observedNumericValue = conditionEvaluation.observedValue;
    indicatorDisplay = conditionEvaluation.evaluationDetails;
  }

  // If the requested crypto condition is unsatisfied, return NOT_FOUND (Item 1)
  if (!conditionEvaluation.conditionSatisfied) {
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Crypto condition unsatisfied: ${conditionEvaluation.evaluationDetails}`,
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

  // 5. Synthesize Deterministic Contract with Operator & Condition Evaluation (Item 11)
  const contract: CryptoThreshold = {
    assetSymbol: parsed.assetSymbol,
    currency: 'USD',
    venue,
    dexContractAddress: dexPair?.baseToken?.address || task.dexContractAddress,
    dexNetwork: dexPair?.chainId || task.dexNetwork,
    targetType: parsed.targetType,
    indicator: parsed.indicator,
    candlestickPattern: parsed.candlestickPattern,
    period: parsed.period,
    timeframe: parsed.timeframe,
    targetValue: parsed.targetValue ?? liveQuote.price,
    operator: parsed.operator,
    observedValue: observedNumericValue ?? liveQuote.price,
    conditionSatisfied: conditionEvaluation.conditionSatisfied,
    evaluationDetails: conditionEvaluation.evaluationDetails,
    conditionEvaluation,
  };

  const isLowLiquidity =
    venue === 'DEXSCREENER' &&
    dexPair?.liquidity?.usd !== undefined &&
    dexPair.liquidity.usd < 25000;
  const liquidityWarning = isLowLiquidity
    ? ` [CAUTION: Low liquidity pool ($${Math.round(dexPair!.liquidity!.usd).toLocaleString()}) - potential volatility/slippage risk]`
    : '';

  // Item 12: Dynamically calculate confidence based on venue, liquidity, volume, and candle count
  const confidence = calculateDynamicConfidence({
    venue,
    liquidityUsd: dexPair?.liquidity?.usd,
    volume24h: liveQuote.volume24h,
    targetType: parsed.targetType,
    verifiedCandlesCount,
    requiredCandles,
  });

  const outcome: CryptoResearchOutcome = {
    status: 'EXACT_MATCH',
    taskId,
    query: task.query,
    contract,
    currentDisplayValue: `$${liveQuote.price.toLocaleString()}`,
    verificationDetails: `${indicatorDisplay} (Verified on ${venue} with 24h Vol $${Math.round(liveQuote.volume24h).toLocaleString()})${liquidityWarning}`,
    confidence,
  };

  yield {
    taskId,
    executionId,
    step: 'DISCOVERY_COMPLETE',
    message: `Crypto research complete: synthesized deterministic contract for ${parsed.assetSymbol}.`,
    data: { outcomeStatus: outcome.status, contract },
    timestamp: Date.now(),
  };

  return outcome;
}
