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
import {
  extractSemanticQueryFields,
  type CryptoSemanticFields,
} from '../../agent/structured_query_agent.js';

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

const QUOTE_CURRENCY_ALIASES: Record<string, string> = {
  '$': 'USD',
  'DOLLAR': 'USD',
  'DOLLARS': 'USD',
  'US DOLLAR': 'USD',
  'US DOLLARS': 'USD',
  'U.S. DOLLAR': 'USD',
  'U.S. DOLLARS': 'USD',
  'EURO': 'EUR',
  'EUROS': 'EUR',
  'POUND': 'GBP',
  'POUNDS': 'GBP',
  'BRITISH POUND': 'GBP',
  'BRITISH POUNDS': 'GBP',
  'CANADIAN DOLLAR': 'CAD',
  'CANADIAN DOLLARS': 'CAD',
  'JAPANESE YEN': 'JPY',
  'AUSTRALIAN DOLLAR': 'AUD',
  'AUSTRALIAN DOLLARS': 'AUD',
  'SOUTH KOREAN WON': 'KRW',
};

const CRYPTO_OPERATOR_ALIASES: Record<string, SentinelOperator> = {
  ABOVE: 'GREATER_THAN',
  OVER: 'GREATER_THAN',
  GREATER: 'GREATER_THAN',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN',
  'RISES ABOVE': 'GREATER_THAN',
  'REACHES ABOVE': 'GREATER_THAN',
  BELOW: 'LESS_THAN',
  UNDER: 'LESS_THAN',
  LESS: 'LESS_THAN',
  '<': 'LESS_THAN',
  '<=': 'LESS_THAN',
  'DROPS BELOW': 'LESS_THAN',
  'FALLS BELOW': 'LESS_THAN',
};

const VALID_CRYPTO_OPERATORS = new Set<SentinelOperator>([
  'GREATER_THAN',
  'LESS_THAN',
  'CROSSES_ABOVE',
  'CROSSES_BELOW',
  'TOUCHES',
  'CLOSES_ABOVE',
  'CLOSES_BELOW',
  'EQUALS',
  'PERCENT_CHANGE',
]);

export function normalizeQuoteCurrency(value?: string): string {
  if (!value?.trim()) return 'USD';
  const normalized = value.trim().toUpperCase().replaceAll('-', ' ').replaceAll('_', ' ');
  return QUOTE_CURRENCY_ALIASES[normalized] ?? normalized;
}

function normalizeCryptoAssetSymbol(value?: string): string {
  if (!value?.trim()) return '';
  const normalized = value.trim().toLowerCase();
  return COIN_ALIASES[normalized] ?? value.trim().toUpperCase();
}

function normalizeCryptoOperator(value?: string): SentinelOperator | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toUpperCase();
  const canonical = normalized.replaceAll('-', '_').replaceAll(' ', '_');
  if (VALID_CRYPTO_OPERATORS.has(canonical as SentinelOperator)) {
    return canonical as SentinelOperator;
  }
  return CRYPTO_OPERATOR_ALIASES[normalized] ?? CRYPTO_OPERATOR_ALIASES[canonical];
}

/**
 * Resolve only the operator wording from the user's natural-language query.
 * Asset identity and numeric thresholds remain model/structured-field owned;
 * this narrow guard prevents a semantic model from turning a plain threshold
 * such as "rises above 75k" into a historical crossing requirement.
 */
export function inferCryptoQueryOperator(query?: string): SentinelOperator | undefined {
  if (!query?.trim()) return undefined;
  const normalized = query.toUpperCase().replace(/[\u2018\u2019]/g, "'");

  if (/\bCROS(?:S|SES|SED|SING)\s+(?:ABOVE|OVER)\b/.test(normalized)) {
    return 'CROSSES_ABOVE';
  }
  if (/\bCROS(?:S|SES|SED|SING)\s+(?:BELOW|UNDER)\b/.test(normalized)) {
    return 'CROSSES_BELOW';
  }
  if (/\b(?:ABOVE|OVER|GREATER\s+THAN|AT\s+LEAST|RISES?\s+ABOVE|REACHES?\s+ABOVE|GOES?\s+ABOVE)\b/.test(normalized)) {
    return 'GREATER_THAN';
  }
  if (/\b(?:BELOW|UNDER|LESS\s+THAN|AT\s+MOST|DROPS?\s+BELOW|FALLS?\s+BELOW|GOES?\s+BELOW)\b/.test(normalized)) {
    return 'LESS_THAN';
  }
  return undefined;
}

/**
 * Recover only unambiguous, explicitly written crypto fields when the
 * structured model is unavailable.  This is intentionally narrower than the
 * old free-form parser: it never invents a token or threshold and only
 * accepts an allowlisted asset alias and an explicit quote unit.
 */
export function inferExplicitCryptoFields(query?: string): Pick<CryptoResearchTask, 'assetSymbol' | 'currency'> {
  if (!query?.trim()) return {};

  const assetSymbol = Object.entries(COIN_ALIASES).find(([alias]) => {
    const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escapedAlias}\\b`, 'i').test(query);
  })?.[1];

  // A currency is considered explicit only when a symbol is attached to a
  // numeric value or a supported ISO/name token is present in the query.
  const symbolMatch = query.match(/(?:\$|€|£)\s*(?=\d)/);
  const codeMatch = query.match(/\b(USD|EUR|GBP|CAD|JPY|AUD|KRW)\b/i);
  const nameMatch = query.match(/\b(?:US dollars?|euros?|(?:British )?pounds?|Canadian dollars?|Japanese yen|Australian dollars?|South Korean won)\b/i);
  const currency = symbolMatch?.[0]?.trim().charAt(0) || codeMatch?.[1] || nameMatch?.[0];

  return {
    ...(assetSymbol ? { assetSymbol } : {}),
    ...(currency ? { currency: normalizeQuoteCurrency(currency) } : {}),
  };
}

export interface ParsedCryptoQuery {
  assetSymbol: string;
  currency: string;
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
  const warnings: string[] = [];
  const explicitOperator = normalizeCryptoOperator(task.expectedOperator);
  const targetValue = typeof task.targetValue === 'number' && Number.isFinite(task.targetValue)
    ? task.targetValue
    : undefined;

  if (task.expectedOperator && !explicitOperator) {
    throw new Error('Unsupported crypto operator: ' + task.expectedOperator);
  }
  if (task.targetValue !== undefined && targetValue === undefined) {
    throw new Error('Crypto targetValue must be a finite number');
  }

  const operator = explicitOperator ?? 'GREATER_THAN';
  const isObservationOnly = explicitOperator === undefined && targetValue === undefined;

  // A price alert without an explicit quote unit is ambiguous. Observation
  // requests may still use the provider's display currency, but an alerting
  // task must never silently become USD just because the shared threshold
  // schema has a historical default.
  // When the asset is still unknown, defer this validation until the
  // resolver has had a chance to prove that the query refers to a real
  // cryptocurrency.  This lets vague requests terminate as NOT_FOUND rather
  // than surfacing an unrelated currency error (and never authorizes a
  // provider call because the asset gate below still runs first).
  if (!isObservationOnly && task.assetSymbol?.trim() && !task.currency?.trim()) {
    throw new Error('Crypto price alerts require an explicit quote currency');
  }

  if (task.targetType === 'INDICATOR' && !task.indicator) {
    throw new Error('Crypto indicator target requires an explicit indicator');
  }
  if (task.targetType === 'CANDLESTICK' && !task.candlestickPattern) {
    throw new Error('Crypto candlestick target requires an explicit pattern');
  }

  return {
    assetSymbol: normalizeCryptoAssetSymbol(task.assetSymbol),
    currency: normalizeQuoteCurrency(task.currency),
    targetType: task.targetType ?? 'PRICE',
    indicator: task.indicator,
    candlestickPattern: task.candlestickPattern,
    timeframe: task.timeframe ?? '1h',
    period: task.period,
    operator,
    targetValue,
    isObservationOnly,
    warnings,
  };
}

/** Semantically enriches a free-form crypto query before deterministic parsing. */
export async function parseCryptoQueryWithAgent(
  task: CryptoResearchTask,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<ParsedCryptoQuery> {
  const semantic = await extractSemanticQueryFields<CryptoSemanticFields>('CRYPTO', task.query, options);
  if (!semantic) {
    const explicitQueryFields = inferExplicitCryptoFields(task.query);
    const hasStructuredFields =
      Boolean(task.assetSymbol?.trim()) ||
      Boolean(task.expectedOperator?.trim()) ||
      task.targetValue !== undefined ||
      Boolean(task.targetType) ||
      Boolean(task.indicator) ||
      Boolean(task.candlestickPattern);
    const hasSafeQueryFields = Boolean(explicitQueryFields.assetSymbol || explicitQueryFields.currency);
    if (!hasStructuredFields && !hasSafeQueryFields) {
      throw new Error('Structured crypto intent extraction unavailable');
    }
    return parseCryptoQuery({
      ...task,
      assetSymbol: task.assetSymbol?.trim() || explicitQueryFields.assetSymbol,
      currency: task.currency?.trim() || explicitQueryFields.currency,
    });
  }

  const enriched: CryptoResearchTask = { ...task };
  const explicitQueryFields = inferExplicitCryptoFields(task.query);
  if (!enriched.assetSymbol && explicitQueryFields.assetSymbol) {
    enriched.assetSymbol = explicitQueryFields.assetSymbol;
  }
  if (!enriched.currency && explicitQueryFields.currency) {
    enriched.currency = explicitQueryFields.currency;
  }
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
  const validTimeframes = new Set<NonNullable<CryptoResearchTask['timeframe']>>([
    '1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w',
  ]);
  if (!enriched.assetSymbol && typeof semantic.assetSymbol === 'string' && semantic.assetSymbol.trim()) {
    enriched.assetSymbol = normalizeCryptoAssetSymbol(semantic.assetSymbol);
  }
  if (!enriched.currency && typeof semantic.currency === 'string' && semantic.currency.trim()) {
    const currency = normalizeQuoteCurrency(semantic.currency);
    if (currency.length >= 3 && currency.length <= 8) enriched.currency = currency;
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
  if (!enriched.timeframe && typeof semantic.timeframe === 'string' && validTimeframes.has(semantic.timeframe as NonNullable<CryptoResearchTask['timeframe']>)) {
    enriched.timeframe = semantic.timeframe as NonNullable<CryptoResearchTask['timeframe']>;
  }
  if (!enriched.expectedOperator) {
    // The model's structured operator is useful for explicit crossing and
    // indicator language, but ordinary threshold wording has a deterministic
    // meaning. Prefer that narrow lexical signal when present.
    const queryOperator = inferCryptoQueryOperator(task.query);
    const semanticOperator = typeof semantic.expectedOperator === 'string' && semantic.expectedOperator.trim()
      ? normalizeCryptoOperator(semantic.expectedOperator)
      : undefined;
    const operator = queryOperator ?? semanticOperator;
    if (!operator && typeof semantic.expectedOperator === 'string' && semantic.expectedOperator.trim()) {
      throw new Error('Structured crypto intent returned an unsupported operator: ' + semantic.expectedOperator);
    }
    if (operator) enriched.expectedOperator = operator;
  }
  if (enriched.period === undefined && Number.isInteger(semantic.period) && Number(semantic.period) > 0 && Number(semantic.period) <= 1000) {
    enriched.period = Number(semantic.period);
  }
  if (enriched.targetValue === undefined && typeof semantic.targetValue === 'number' && Number.isFinite(semantic.targetValue)) {
    enriched.targetValue = semantic.targetValue;
  }

  return parseCryptoQuery(enriched);
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

  const parsed = await parseCryptoQueryWithAgent(task, {
    signal,
    timeoutMs: Math.min(5000, Math.max(1000, deadline - Date.now())),
  });

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
      message: `Structured extraction did not include an asset. Attempting a second Strands entity-resolution pass...`,
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

  // A resolved alert must still carry an explicit quote currency.  Do this
  // after entity resolution so an underspecified query can return NOT_FOUND
  // without inventing USD, while a descriptive query that resolves to an
  // asset fails closed with an actionable error.
  const explicitCurrency = task.currency?.trim() || inferExplicitCryptoFields(task.query).currency;
  if (!parsed.isObservationOnly && !explicitCurrency) {
    const reason = 'Crypto price alerts require an explicit quote currency (for example USD, EUR, or GBP).';
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: reason,
      timestamp: Date.now(),
    };
    return {
      status: 'ERROR',
      taskId,
      query: task.query,
      error: reason,
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
    cbProduct = await coinbase.resolveProduct(parsed.assetSymbol, getClientOptions(), parsed.currency);
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

  if (!liveQuote && parsed.currency !== 'USD') {
    return {
      status: 'ERROR',
      taskId,
      query: task.query,
      error: `No live ${parsed.currency} quote is available for ${parsed.assetSymbol}. The provider fallback currently exposes USD DEX prices only, so the requested currency was not substituted.`,
      provider: 'COINBASE',
    };
  }

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
    currency: parsed.currency,
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
