import type {
  PredictionMarketThreshold,
  SentinelOperator,
  DisambiguationCandidate,
} from '@sentinel/shared';
import {
  PolymarketClient,
  type PolymarketMarket,
  type FinanceTelemetryEvent,
  ProviderError,
  evaluatePredictionMarketCondition,
} from '../finance_common/index.js';
import type {
  PredictionMarketTask,
  PredictionMarketOutcome,
  PredictionMarketHarnessConfig,
  PredictionMarketPipelineOptions,
} from './types.js';
import {
  extractSemanticQueryFields,
  type PredictionMarketSemanticFields,
} from '../../agent/structured_query_agent.js';

interface ParsedPredictionMarketQuery {
  searchPhrase: string;
  desiredOutcome: 'YES' | 'NO';
  targetProbability?: number;
  operator: SentinelOperator;
  warnings: string[];
}

function parsePredictionMarketQuery(task: PredictionMarketTask): ParsedPredictionMarketQuery {
  if (!task || typeof task !== 'object') {
    throw new Error('Task must be a valid object');
  }
  if (!task.id || typeof task.id !== 'string' || !task.id.trim()) {
    throw new Error('Task ID must be a non-empty string');
  }
  if (!task.query || typeof task.query !== 'string' || !task.query.trim()) {
    throw new Error('Task query must be a non-empty string');
  }

  // Item 5: Reject invalid targetProbability at boundary instead of clamping silently
  if (task.targetProbability !== undefined) {
    if (
      typeof task.targetProbability !== 'number' ||
      !isFinite(task.targetProbability) ||
      isNaN(task.targetProbability) ||
      task.targetProbability < 0 ||
      task.targetProbability > 1
    ) {
      throw new Error(
        `Invalid targetProbability: must be a finite number between 0.0 and 1.0, received ${task.targetProbability}`
      );
    }
  }

  // Validate explicit desiredOutcome
  if (task.desiredOutcome !== undefined && task.desiredOutcome !== 'YES' && task.desiredOutcome !== 'NO') {
    throw new Error(
      `Invalid desiredOutcome: must be 'YES' or 'NO', received "${task.desiredOutcome}"`
    );
  }

  const query = task.query;
  const warnings: string[] = [];

  // 1. Inferred vs Explicit Desired Outcome (Item 7)
  let inferredOutcome: 'YES' | 'NO' | undefined;
  if (/\b(no outcome|odds of no|will not|does not|fails to)\b/i.test(query)) {
    inferredOutcome = 'NO';
  } else if (/\b(yes outcome|odds of yes|will|succeeds)\b/i.test(query)) {
    inferredOutcome = 'YES';
  }

  let desiredOutcome: 'YES' | 'NO';
  if (task.desiredOutcome) {
    desiredOutcome = task.desiredOutcome;
    if (inferredOutcome && inferredOutcome !== task.desiredOutcome) {
      warnings.push(
        `Query implies outcome "${inferredOutcome}" but explicit desiredOutcome "${task.desiredOutcome}" takes strict precedence.`
      );
    }
  } else {
    desiredOutcome = inferredOutcome || 'YES';
  }

  // 2. Inferred vs Explicit Operator (Item 7)
  let inferredOperator: SentinelOperator | undefined;
  if (/\b(drops below|falls below|less than|under|dips below)\b/i.test(query)) {
    inferredOperator = 'LESS_THAN';
  } else if (/\b(crosses above)\b/i.test(query)) {
    inferredOperator = 'CROSSES_ABOVE';
  } else if (/\b(crosses below)\b/i.test(query)) {
    inferredOperator = 'CROSSES_BELOW';
  } else if (/\b(equals|equal to|exactly)\b/i.test(query)) {
    inferredOperator = 'EQUALS';
  } else if (/\b(hits|reaches|rises above|exceeds|above|greater than|over)\b/i.test(query)) {
    inferredOperator = 'GREATER_THAN';
  }

  let operator: SentinelOperator;
  if (task.expectedOperator) {
    operator = task.expectedOperator;
    if (inferredOperator && inferredOperator !== task.expectedOperator) {
      warnings.push(
        `Query implies operator "${inferredOperator}" but explicit expectedOperator "${task.expectedOperator}" takes strict precedence.`
      );
    }
  } else {
    operator = inferredOperator || 'GREATER_THAN';
  }

  // 3. Inferred vs Explicit Target Probability (Item 7)
  let inferredProbability: number | undefined;
  const percentMatch = query.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percentMatch) {
    inferredProbability = parseFloat(percentMatch[1]) / 100;
  } else {
    const centMatch = query.match(/(?:at|\$|under|above)\s*(0\.\d+|\d+)\s*(?:cents)?/i);
    if (centMatch) {
      const val = parseFloat(centMatch[1]);
      inferredProbability = val > 1 ? val / 100 : val;
    }
  }

  let targetProbability: number | undefined;
  if (task.targetProbability !== undefined) {
    targetProbability = task.targetProbability;
    if (
      inferredProbability !== undefined &&
      Math.abs(inferredProbability - task.targetProbability) > 0.001
    ) {
      warnings.push(
        `Query implies probability ${inferredProbability} but explicit targetProbability ${task.targetProbability} takes strict precedence.`
      );
    }
  } else {
    targetProbability = inferredProbability;
  }

  // 4. Clean Search Phrase without stripping key terms
  const searchPhrase = query
    .replace(/(?:alert me if|notify me when|monitor|track)\s*/gi, '')
    .replace(
      /(?:drops below|falls below|hits|reaches|rises above|crosses above|crosses below|over|under|above|less than|greater than)\s*[\$]?\d+(?:\.\d+)?(?:\s*%|\s*cents)?/gi,
      ''
    )
    .replace(/\b(polymarket|prediction market|odds of|odds)\b/gi, '')
    .trim();

  return {
    searchPhrase: searchPhrase || query,
    desiredOutcome,
    targetProbability,
    operator,
    warnings,
  };
}

/** Uses Strands for semantic market-query interpretation, then keeps the
 * existing range and enum validation as the authority. */
async function parsePredictionMarketQueryWithAgent(
  task: PredictionMarketTask,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<ParsedPredictionMarketQuery> {
  const parsed = parsePredictionMarketQuery(task);
  const semantic = await extractSemanticQueryFields<PredictionMarketSemanticFields>(
    'PREDICTION_MARKET',
    task.query,
    options
  );
  if (!semantic) return parsed;

  const validOperators = new Set<SentinelOperator>([
    'GREATER_THAN', 'LESS_THAN', 'CROSSES_ABOVE', 'CROSSES_BELOW', 'EQUALS',
  ]);
  const result = { ...parsed };

  if (!task.conditionId && typeof semantic.searchPhrase === 'string' && semantic.searchPhrase.trim()) {
    result.searchPhrase = semantic.searchPhrase.trim();
  }
  if (!task.desiredOutcome && (semantic.desiredOutcome === 'YES' || semantic.desiredOutcome === 'NO')) {
    result.desiredOutcome = semantic.desiredOutcome;
  }
  if (
    task.targetProbability === undefined &&
    typeof semantic.targetProbability === 'number' &&
    Number.isFinite(semantic.targetProbability) &&
    semantic.targetProbability >= 0 &&
    semantic.targetProbability <= 1
  ) {
    result.targetProbability = semantic.targetProbability;
  }
  if (!task.expectedOperator && typeof semantic.expectedOperator === 'string' && validOperators.has(semantic.expectedOperator as SentinelOperator)) {
    result.operator = semantic.expectedOperator as SentinelOperator;
  }

  return result;
}

export async function* runPredictionMarketPipeline(
  task: PredictionMarketTask,
  optionsOrConfig: PredictionMarketHarnessConfig | PredictionMarketPipelineOptions = {},
  signal?: AbortSignal
): AsyncGenerator<FinanceTelemetryEvent, PredictionMarketOutcome, unknown> {
  const taskId = task.id;
  const polymarket = new PolymarketClient();

  // Support both legacy signature and options object
  const isPipelineOptions =
    'config' in optionsOrConfig ||
    'deadline' in optionsOrConfig ||
    'executionId' in optionsOrConfig;

  const config: PredictionMarketHarnessConfig = isPipelineOptions
    ? (optionsOrConfig as PredictionMarketPipelineOptions).config || {}
    : (optionsOrConfig as PredictionMarketHarnessConfig);

  const effectiveSignal = isPipelineOptions
    ? (optionsOrConfig as PredictionMarketPipelineOptions).signal || signal
    : signal;

  const executionId = isPipelineOptions
    ? (optionsOrConfig as PredictionMarketPipelineOptions).executionId
    : undefined;

  const maxCandidates = config.maxCandidates ?? 6;
  const timeoutMs = config.timeoutMs ?? 10000;
  const deadline = isPipelineOptions && (optionsOrConfig as PredictionMarketPipelineOptions).deadline
    ? (optionsOrConfig as PredictionMarketPipelineOptions).deadline!
    : Date.now() + timeoutMs;

  const clientOptions = {
    signal: effectiveSignal,
    deadline,
    timeoutMs,
  };

  yield {
    taskId,
    executionId,
    step: 'FINANCE_START',
    message: `Initiating prediction market discovery for: "${task.query}"`,
    timestamp: Date.now(),
  };

  if (effectiveSignal?.aborted) throw new Error('Research cancelled by user');

  const parsed = await parsePredictionMarketQueryWithAgent(task, {
    signal: effectiveSignal,
    timeoutMs: Math.min(5000, Math.max(1000, deadline - Date.now())),
  });

  yield {
    taskId,
    executionId,
    step: 'RESOLVING_ENTITY',
    message: `Searching active Polymarket contracts for "${parsed.searchPhrase}"...`,
    data: { parsed, warnings: parsed.warnings },
    timestamp: Date.now(),
  };

  let markets: PolymarketMarket[] = [];

  try {
    if (task.conditionId) {
      const direct = await polymarket.getMarketByConditionId(task.conditionId, clientOptions);
      if (!direct) {
        yield {
          taskId,
          executionId,
          step: 'DISCOVERY_ERROR',
          message: `Direct condition lookup failed: no active valid market found for condition ID "${task.conditionId}".`,
          timestamp: Date.now(),
        };

        return {
          status: 'NOT_FOUND',
          taskId,
          query: task.query,
          reason: `No active, valid prediction market found for condition ID "${task.conditionId}".`,
          suggestion: 'Please verify the condition ID or omit it to search by query phrase.',
        };
      }
      markets = [direct];
    } else {
      // Use configured candidate limits consistently (Item 9)
      markets = await polymarket.searchMarkets(parsed.searchPhrase, maxCandidates, clientOptions);
    }
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError' || effectiveSignal?.aborted) {
      throw err;
    }
    if (err instanceof ProviderError) {
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `Polymarket provider error: ${err.message}`,
        data: { error: err.message, provider: 'POLYMARKET' },
        timestamp: Date.now(),
      };
      return {
        status: 'ERROR',
        taskId,
        query: task.query,
        error: err.message,
        provider: 'POLYMARKET',
      };
    }
    throw err;
  }

  if (effectiveSignal?.aborted) throw new Error('Research cancelled by user');

  if (markets.length === 0) {
    const outcome: PredictionMarketOutcome = {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: `No active prediction markets were found matching "${parsed.searchPhrase}".`,
      suggestion: `Markets may be resolved or named differently. Try broader search terms (e.g. "Fed rate cut" or "Election").`,
    };

    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Zero matching prediction markets found for query.`,
      timestamp: Date.now(),
    };

    return outcome;
  }

  // If multiple distinct markets match, offer Disambiguation Candidate Cards
  // using configured maxCandidates (Item 9)
  if (markets.length > 1 && !task.conditionId) {
    const candidates: DisambiguationCandidate[] = markets.slice(0, maxCandidates).map((m) => {
      const yesPrice = m.outcomePrices[0] ?? 0.5;
      const probPct = Math.round(yesPrice * 100);
      const volDisplay = (m.volume24hr || m.volume).toLocaleString();
      const endDisplay = m.endDate ? new Date(m.endDate).toLocaleDateString() : 'Active';

      return {
        id: m.conditionId,
        title: m.question,
        currentValue: `YES: ${probPct}% ($${yesPrice.toFixed(2)})`,
        context: `24h Vol: $${volDisplay} • Resolves: ${endDisplay}`,
        metadata: {
          conditionId: m.conditionId,
          slug: m.slug,
          clobTokenIds: m.clobTokenIds,
          endDate: m.endDate,
        },
      };
    });

    const outcome: PredictionMarketOutcome = {
      status: 'MULTIPLE_OPTIONS',
      taskId,
      query: task.query,
      message: `Found ${candidates.length} active Polymarket prediction contracts. Please confirm which market to monitor:`,
      candidates,
    };

    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_COMPLETE',
      message: `Multiple candidate prediction markets found. Requesting user selection.`,
      timestamp: Date.now(),
    };

    return outcome;
  }

  const selectedMarket = markets[0];

  // Item 4: Non-binary markets rejection (must be exactly 2 outcomes with YES and NO)
  if (selectedMarket.outcomes.length !== 2) {
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Market "${selectedMarket.question}" is a non-binary market with ${selectedMarket.outcomes.length} outcomes (${selectedMarket.outcomes.join(', ')}). Only binary YES/NO markets are supported.`,
      timestamp: Date.now(),
    };

    return {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: `Market "${selectedMarket.question}" is a non-binary market with ${selectedMarket.outcomes.length} outcomes (${selectedMarket.outcomes.join(', ')}). Only binary YES/NO markets are supported.`,
      suggestion: 'Please specify a binary YES/NO prediction market.',
    };
  }

  const outcomeIndex = selectedMarket.outcomes.findIndex(
    (o) => o.toUpperCase() === parsed.desiredOutcome
  );
  const effectiveOutcomeIndex =
    outcomeIndex >= 0 ? outcomeIndex : parsed.desiredOutcome === 'YES' ? 0 : 1;

  const rawPrice = selectedMarket.outcomePrices[effectiveOutcomeIndex];
  const tokenList = selectedMarket.clobTokenIds || [];
  const clobTokenId = tokenList[effectiveOutcomeIndex];

  // Item 2: Fail closed when outcome token is missing; NEVER substitute conditionId
  if (!clobTokenId || clobTokenId === selectedMarket.conditionId) {
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Market "${selectedMarket.question}" does not have a valid CLOB token ID for outcome "${parsed.desiredOutcome}". Cannot monitor orderbook.`,
      timestamp: Date.now(),
    };

    return {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: `Market "${selectedMarket.question}" does not have an active CLOB token ID for outcome "${parsed.desiredOutcome}".`,
      suggestion: `The market may not have active CLOB trading enabled or tokens may not be minted yet.`,
    };
  }

  // Item 2 & Item 11: Probe fresh CLOB midpoint; track actual data source (MIDPOINT vs GAMMA_PRICE)
  let liveProbability = rawPrice;
  let priceType: 'MIDPOINT' | 'LAST_TRADE' | 'GAMMA_PRICE' = 'GAMMA_PRICE';
  let midpointRetrieved = false;

  try {
    const clobMid = await polymarket.getMidpointPrice(clobTokenId, clientOptions);
    if (clobMid !== null && isFinite(clobMid) && clobMid >= 0 && clobMid <= 1) {
      liveProbability = clobMid;
      priceType = 'MIDPOINT';
      midpointRetrieved = true;
    } else {
      liveProbability = rawPrice;
      priceType = 'GAMMA_PRICE';
    }
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError' || effectiveSignal?.aborted) throw err;
    if (err instanceof ProviderError) {
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `CLOB midpoint lookup provider error: ${err.message}`,
        data: { error: err.message, provider: 'POLYMARKET' },
        timestamp: Date.now(),
      };
      return {
        status: 'ERROR',
        taskId,
        query: task.query,
        error: `CLOB midpoint lookup provider error: ${err.message}`,
        provider: 'POLYMARKET',
      };
    }
    throw err;
  }

  if (effectiveSignal?.aborted) throw new Error('Research cancelled by user');

  if (!isFinite(liveProbability) || liveProbability < 0 || liveProbability > 1) {
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Invalid probability value observed for "${selectedMarket.question}".`,
      timestamp: Date.now(),
    };
    return {
      status: 'ERROR',
      taskId,
      query: task.query,
      error: `Invalid market probability value (${liveProbability}) for condition ${selectedMarket.conditionId}.`,
      provider: 'POLYMARKET',
    };
  }

  yield {
    taskId,
    executionId,
    step: 'ENTITY_RESOLVED',
    message: `Resolved market "${selectedMarket.question}" (Current ${parsed.desiredOutcome}: ${(liveProbability * 100).toFixed(1)}% [${priceType}])`,
    data: {
      conditionId: selectedMarket.conditionId,
      clobTokenId,
      probability: liveProbability,
      priceType,
    },
    timestamp: Date.now(),
  };

  // Item 1: Threshold condition evaluation
  // Crossing operators require historical snapshots; otherwise return explicit unsupported/error result
  if (parsed.operator === 'CROSSES_ABOVE' || parsed.operator === 'CROSSES_BELOW') {
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Operator "${parsed.operator}" is not supported without historical probability snapshots.`,
      timestamp: Date.now(),
    };
    return {
      status: 'ERROR',
      taskId,
      query: task.query,
      error: `Crossing operator "${parsed.operator}" requires historical probability snapshots, which are currently unavailable for prediction markets.`,
    };
  }

  const conditionEvaluation = evaluatePredictionMarketCondition({
    operator: parsed.operator,
    observedProbability: liveProbability,
    targetProbability: parsed.targetProbability,
    outcome: parsed.desiredOutcome,
  });

  if (!conditionEvaluation.conditionSatisfied) {
    yield {
      taskId,
      executionId,
      step: 'DISCOVERY_ERROR',
      message: `Prediction market condition unsatisfied: ${conditionEvaluation.evaluationDetails}`,
      data: { conditionEvaluation },
      timestamp: Date.now(),
    };

    return {
      status: 'NOT_FOUND',
      taskId,
      query: task.query,
      reason: `Condition unsatisfied: ${conditionEvaluation.evaluationDetails}`,
      suggestion: `Observed ${parsed.desiredOutcome} probability is ${(liveProbability * 100).toFixed(1)}%, which does not satisfy ${parsed.operator} ${parsed.targetProbability !== undefined ? `${(parsed.targetProbability * 100).toFixed(1)}%` : ''}.`,
    };
  }

  // Check orderbook spread for illiquid contracts (Item 3)
  let spreadWarning = '';
  try {
    const ob = await polymarket.getOrderbook(clobTokenId, clientOptions);
    if (ob) {
      if (ob.bids.length > 0 && ob.asks.length > 0) {
        const bestBid = parseFloat(ob.bids[0].price);
        const bestAsk = parseFloat(ob.asks[0].price);
        if (bestBid > bestAsk) {
          spreadWarning = ` [CAUTION: Crossed orderbook (Bid $${bestBid.toFixed(2)} > Ask $${bestAsk.toFixed(2)})]`;
        } else {
          const spread = bestAsk - bestBid;
          if (spread > 0.20) {
            spreadWarning = ` [CAUTION: Wide spread ${(spread * 100).toFixed(0)}% (Bid $${bestBid.toFixed(2)} / Ask $${bestAsk.toFixed(2)}) - market may be illiquid]`;
          }
        }
      } else {
        spreadWarning = ` [CAUTION: Thin orderbook with zero ${ob.bids.length === 0 ? 'bids' : 'asks'}]`;
      }
    }
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError' || effectiveSignal?.aborted) throw err;
    if (err instanceof ProviderError) {
      yield {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: `CLOB orderbook lookup provider error: ${err.message}`,
        data: { error: err.message, provider: 'POLYMARKET' },
        timestamp: Date.now(),
      };
      return {
        status: 'ERROR',
        taskId,
        query: task.query,
        error: `CLOB orderbook lookup provider error: ${err.message}`,
        provider: 'POLYMARKET',
      };
    }
    throw err;
  }

  // Synthesize Deterministic Contract with accurate data source tracking (Item 11)
  const contract: PredictionMarketThreshold = {
    venue: 'POLYMARKET',
    conditionId: selectedMarket.conditionId,
    clobTokenId,
    outcome: parsed.desiredOutcome,
    targetProbability: parsed.targetProbability ?? liveProbability,
    marketTitle: selectedMarket.question,
    resolutionDate: selectedMarket.endDate,
    priceType,
    operator: parsed.operator,
    observedProbability: liveProbability,
    conditionSatisfied: conditionEvaluation.conditionSatisfied,
    evaluationDetails: conditionEvaluation.evaluationDetails,
    conditionEvaluation,
  };

  // Adjust confidence based on fresh midpoint availability and spread
  let confidence = 0.95;
  if (!midpointRetrieved) confidence -= 0.15; // lower confidence when fresh midpoint data is unavailable
  if (spreadWarning) confidence -= 0.10;
  confidence = Math.max(0.5, Math.min(1.0, confidence));

  const outcome: PredictionMarketOutcome = {
    status: 'EXACT_MATCH',
    taskId,
    query: task.query,
    contract,
    currentDisplayValue: `${(liveProbability * 100).toFixed(1)}% ($${liveProbability.toFixed(2)})`,
    verificationDetails: `Monitors ${parsed.desiredOutcome} odds on Polymarket ("${selectedMarket.question}") [${priceType}] • Volume: $${Math.round(selectedMarket.volume).toLocaleString()}${spreadWarning}`,
    confidence,
  };

  yield {
    taskId,
    executionId,
    step: 'DISCOVERY_COMPLETE',
    message: `Prediction market discovery complete: synthesized contract for "${selectedMarket.question}".`,
    data: { outcomeStatus: outcome.status, contract },
    timestamp: Date.now(),
  };

  return outcome;
}
