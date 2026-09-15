import type { SentinelOperator } from '@sentinel/shared';
import type { FinanceConditionEvaluation, OHLCV } from './types.js';

export interface CryptoConditionEvaluationParams {
  targetType: 'PRICE' | 'INDICATOR' | 'CANDLESTICK';
  operator: SentinelOperator;
  observedValue: number | null;
  previousObservedValue?: number | null;
  indicatorName?: string;
  indicatorSeries?: number[];
  targetValue?: number;
  candlestickMatched?: boolean;
  candles?: OHLCV[];
  high24h?: number;
  low24h?: number;
  isObservationOnly?: boolean;
}

export interface StockConditionEvaluationParams {
  targetType: 'PRICE' | 'INDICATOR' | 'CANDLESTICK';
  operator: SentinelOperator;
  observedValue: number | null;
  previousObservedValue?: number | null;
  indicatorName?: string;
  indicatorSeries?: number[];
  targetValue?: number;
  candlestickMatched?: boolean;
  candles?: OHLCV[];
  high?: number;
  low?: number;
  isObservationOnly?: boolean;
}

/**
 * Evaluates whether an observed cryptocurrency market price, technical indicator value,
 * or candlestick pattern satisfies the requested operator and target threshold.
 */
export function evaluateCryptoCondition(
  params: CryptoConditionEvaluationParams
): FinanceConditionEvaluation {
  let {
    targetType,
    operator,
    targetValue,
    candlestickMatched,
    candles,
    high24h,
    low24h,
    previousObservedValue,
    indicatorName,
    indicatorSeries,
  } = params;

  // 1. Candlestick Pattern Evaluation
  if (targetType === 'CANDLESTICK') {
    const isMatched = Boolean(candlestickMatched);
    return {
      expectedOperator: operator,
      targetValue,
      observedValue: isMatched ? 1 : 0,
      conditionSatisfied: isMatched,
      evaluationDetails: isMatched
        ? `Candlestick pattern confirmed on latest candle series`
        : `Candlestick pattern was not detected on latest candle series`,
    };
  }

  let observedValue = params.observedValue;
  if (
    (observedValue === null || observedValue === undefined || isNaN(observedValue)) &&
    candles &&
    candles.length > 0 &&
    targetType === 'PRICE'
  ) {
    observedValue = candles[candles.length - 1].close;
  }

  // 2. Missing observed value check
  if (observedValue === null || observedValue === undefined || isNaN(observedValue)) {
    return {
      expectedOperator: operator,
      targetValue,
      observedValue: null,
      conditionSatisfied: false,
      evaluationDetails: `No observed numeric value extracted for ${targetType} comparison`,
    };
  }

  // 3. Mathematical and comparison operators require a valid numeric target value
  const comparisonOperators: SentinelOperator[] = [
    'LESS_THAN',
    'GREATER_THAN',
    'EQUALS',
    'TOUCHES',
    'CROSSES_ABOVE',
    'CROSSES_BELOW',
    'CLOSES_ABOVE',
    'CLOSES_BELOW',
    'PERCENT_CHANGE',
  ];

  if (targetValue === undefined || targetValue === null || !Number.isFinite(targetValue)) {
    if (params.isObservationOnly) {
      return {
        expectedOperator: operator,
        targetValue: undefined,
        observedValue,
        conditionSatisfied: true,
        evaluationDetails: `Observed valid live value ${observedValue} (observation-only inquiry, no comparison threshold required)`,
      };
    }

    if (comparisonOperators.includes(operator)) {
      return {
        expectedOperator: operator,
        targetValue: undefined,
        observedValue,
        conditionSatisfied: false,
        evaluationDetails: `Operator ${operator} requires a valid numeric target threshold, but received ${targetValue}`,
      };
    }

    // Only non-comparison operators satisfy purely on valid observation
    return {
      expectedOperator: operator,
      targetValue: undefined,
      observedValue,
      conditionSatisfied: true,
      evaluationDetails: `Observed valid live value ${observedValue} (no comparison threshold required for ${operator})`,
    };
  }

  const entityLabel = targetType === 'INDICATOR' ? (indicatorName || 'Indicator') : 'Observed';

  // 4. Operator comparisons
  switch (operator) {
    case 'LESS_THAN': {
      const satisfied = observedValue < targetValue;
      return {
        expectedOperator: operator,
        targetValue,
        observedValue,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `${entityLabel} ${observedValue} is less than threshold ${targetValue}`
          : `${entityLabel} ${observedValue} is NOT less than threshold ${targetValue}`,
      };
    }

    case 'GREATER_THAN': {
      const satisfied = observedValue > targetValue;
      return {
        expectedOperator: operator,
        targetValue,
        observedValue,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `${entityLabel} ${observedValue} is greater than threshold ${targetValue}`
          : `${entityLabel} ${observedValue} is NOT greater than threshold ${targetValue}`,
      };
    }

    case 'EQUALS': {
      const diff = Math.abs(observedValue - targetValue);
      const tolerance = targetValue === 0 ? 0.0001 : Math.max(0.0001, Math.abs(targetValue) * 0.0001);
      const satisfied = diff <= tolerance;
      return {
        expectedOperator: operator,
        targetValue,
        observedValue,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `${entityLabel} ${observedValue} equals target ${targetValue} (tolerance ${tolerance.toFixed(4)})`
          : `${entityLabel} ${observedValue} does not equal target ${targetValue}`,
      };
    }

    case 'TOUCHES': {
      if (targetType === 'INDICATOR') {
        let touched = false;
        if (previousObservedValue !== undefined && previousObservedValue !== null && !isNaN(previousObservedValue)) {
          const minVal = Math.min(previousObservedValue, observedValue);
          const maxVal = Math.max(previousObservedValue, observedValue);
          touched = targetValue >= minVal && targetValue <= maxVal;
        } else {
          const pctDiff = Math.abs(observedValue - targetValue) / Math.abs(targetValue || 1);
          touched = pctDiff <= 0.005;
        }
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: touched,
          evaluationDetails: touched
            ? `${entityLabel} touched target ${targetValue} within observed range`
            : `${entityLabel} did not touch target ${targetValue}`,
        };
      }

      let touched = false;
      if (high24h !== undefined && low24h !== undefined && high24h >= low24h) {
        touched = targetValue >= low24h && targetValue <= high24h;
      } else if (candles && candles.length > 0) {
        const minLow = Math.min(...candles.map((c) => c.low));
        const maxHigh = Math.max(...candles.map((c) => c.high));
        touched = targetValue >= minLow && targetValue <= maxHigh;
      } else {
        const pctDiff = Math.abs(observedValue - targetValue) / Math.abs(targetValue || 1);
        touched = pctDiff <= 0.0025;
      }

      return {
        expectedOperator: operator,
        targetValue,
        observedValue,
        conditionSatisfied: touched,
        evaluationDetails: touched
          ? `Target value ${targetValue} touched within observed range`
          : `Target value ${targetValue} was not reached in observed price range`,
      };
    }

    case 'CLOSES_ABOVE': {
      if (targetType === 'INDICATOR') {
        const satisfied = observedValue > targetValue;
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: satisfied,
          evaluationDetails: satisfied
            ? `${entityLabel} close ${observedValue} is above threshold ${targetValue}`
            : `${entityLabel} close ${observedValue} is NOT above threshold ${targetValue}`,
        };
      }

      if (!candles || candles.length === 0) {
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: false,
          evaluationDetails: `Operator "CLOSES_ABOVE" requires candle history to verify candle close, but no candles were available.`,
        };
      }
      const latestClose = candles[candles.length - 1].close;
      const satisfied = latestClose > targetValue;
      return {
        expectedOperator: operator,
        targetValue,
        observedValue: latestClose,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Candle close ${latestClose} is above threshold ${targetValue}`
          : `Candle close ${latestClose} is NOT above threshold ${targetValue}`,
      };
    }

    case 'CLOSES_BELOW': {
      if (targetType === 'INDICATOR') {
        const satisfied = observedValue < targetValue;
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: satisfied,
          evaluationDetails: satisfied
            ? `${entityLabel} close ${observedValue} is below threshold ${targetValue}`
            : `${entityLabel} close ${observedValue} is NOT below threshold ${targetValue}`,
        };
      }

      if (!candles || candles.length === 0) {
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: false,
          evaluationDetails: `Operator "CLOSES_BELOW" requires candle history to verify candle close, but no candles were available.`,
        };
      }
      const latestClose = candles[candles.length - 1].close;
      const satisfied = latestClose < targetValue;
      return {
        expectedOperator: operator,
        targetValue,
        observedValue: latestClose,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Candle close ${latestClose} is below threshold ${targetValue}`
          : `Candle close ${latestClose} is NOT below threshold ${targetValue}`,
      };
    }

    case 'CROSSES_ABOVE': {
      if (targetType === 'INDICATOR') {
        if (previousObservedValue === undefined || previousObservedValue === null || isNaN(previousObservedValue)) {
          return {
            expectedOperator: operator,
            targetValue,
            observedValue,
            conditionSatisfied: false,
            evaluationDetails: `Operator "CROSSES_ABOVE" for ${entityLabel} requires historical indicator values, but previous indicator value was unavailable.`,
          };
        }
        const satisfied = previousObservedValue < targetValue && observedValue >= targetValue;
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: satisfied,
          evaluationDetails: satisfied
            ? `${entityLabel} crossed above ${targetValue} (previous: ${previousObservedValue}, latest: ${observedValue})`
            : `${entityLabel} did not cross above ${targetValue} (previous: ${previousObservedValue}, latest: ${observedValue})`,
        };
      }

      // 1. Check if immediate previous tick state is available
      if (previousObservedValue !== undefined && previousObservedValue !== null && !isNaN(previousObservedValue)) {
        const satisfied = previousObservedValue < targetValue && observedValue >= targetValue;
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: satisfied,
          evaluationDetails: satisfied
            ? `Price crossed above ${targetValue} (previous observed: ${previousObservedValue}, latest: ${observedValue})`
            : `Price did not cross above ${targetValue} (previous observed: ${previousObservedValue}, latest: ${observedValue})`,
        };
      }

      // 2. Fall back to historical candles
      if (!candles || candles.length < 2) {
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: false,
          evaluationDetails: `Operator "CROSSES_ABOVE" requires at least 2 historical candles or a previous tick state to verify crossing, but only ${candles?.length ?? 0} candles were available.`,
        };
      }
      const prevClose = candles[candles.length - 2].close;
      const currClose = candles[candles.length - 1].close;
      const satisfied = prevClose < targetValue && currClose >= targetValue;
      return {
        expectedOperator: operator,
        targetValue,
        observedValue: currClose,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Price crossed above ${targetValue} (previous candle close: ${prevClose}, latest close: ${currClose})`
          : `Price did not cross above ${targetValue} (previous candle close: ${prevClose}, latest close: ${currClose})`,
      };
    }

    case 'CROSSES_BELOW': {
      if (targetType === 'INDICATOR') {
        if (previousObservedValue === undefined || previousObservedValue === null || isNaN(previousObservedValue)) {
          return {
            expectedOperator: operator,
            targetValue,
            observedValue,
            conditionSatisfied: false,
            evaluationDetails: `Operator "CROSSES_BELOW" for ${entityLabel} requires historical indicator values, but previous indicator value was unavailable.`,
          };
        }
        const satisfied = previousObservedValue > targetValue && observedValue <= targetValue;
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: satisfied,
          evaluationDetails: satisfied
            ? `${entityLabel} crossed below ${targetValue} (previous: ${previousObservedValue}, latest: ${observedValue})`
            : `${entityLabel} did not cross below ${targetValue} (previous: ${previousObservedValue}, latest: ${observedValue})`,
        };
      }

      // 1. Check if immediate previous tick state is available
      if (previousObservedValue !== undefined && previousObservedValue !== null && !isNaN(previousObservedValue)) {
        const satisfied = previousObservedValue > targetValue && observedValue <= targetValue;
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: satisfied,
          evaluationDetails: satisfied
            ? `Price crossed below ${targetValue} (previous observed: ${previousObservedValue}, latest: ${observedValue})`
            : `Price did not cross below ${targetValue} (previous observed: ${previousObservedValue}, latest: ${observedValue})`,
        };
      }

      // 2. Fall back to historical candles
      if (!candles || candles.length < 2) {
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: false,
          evaluationDetails: `Operator "CROSSES_BELOW" requires at least 2 historical candles or a previous tick state to verify crossing, but only ${candles?.length ?? 0} candles were available.`,
        };
      }
      const prevClose = candles[candles.length - 2].close;
      const currClose = candles[candles.length - 1].close;
      const satisfied = prevClose > targetValue && currClose <= targetValue;
      return {
        expectedOperator: operator,
        targetValue,
        observedValue: currClose,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Price crossed below ${targetValue} (previous candle close: ${prevClose}, latest close: ${currClose})`
          : `Price did not cross below ${targetValue} (previous candle close: ${prevClose}, latest close: ${currClose})`,
      };
    }

    case 'PERCENT_CHANGE': {
      if (targetType === 'INDICATOR') {
        let startVal: number | undefined;
        let endVal: number = observedValue;

        if (indicatorSeries && indicatorSeries.length >= 2) {
          startVal = indicatorSeries[0];
          endVal = indicatorSeries[indicatorSeries.length - 1];
        } else if (previousObservedValue !== undefined && previousObservedValue !== null && !isNaN(previousObservedValue)) {
          startVal = previousObservedValue;
        }

        if (startVal === undefined || isNaN(startVal)) {
          return {
            expectedOperator: operator,
            targetValue,
            observedValue,
            conditionSatisfied: false,
            evaluationDetails: `Insufficient historical indicator data to calculate percent change for ${entityLabel}`,
          };
        }

        if (startVal === 0) {
          return {
            expectedOperator: operator,
            targetValue,
            observedValue,
            conditionSatisfied: false,
            evaluationDetails: `Cannot calculate percent change from zero baseline indicator value for ${entityLabel}`,
          };
        }

        const pct = ((endVal - startVal) / Math.abs(startVal)) * 100;
        const satisfied = Math.abs(pct) >= Math.abs(targetValue);
        return {
          expectedOperator: operator,
          targetValue,
          observedValue: pct,
          conditionSatisfied: satisfied,
          evaluationDetails: satisfied
            ? `Observed ${entityLabel} percent change ${pct.toFixed(2)}% meets target ${targetValue}%`
            : `Observed ${entityLabel} percent change ${pct.toFixed(2)}% did not meet target ${targetValue}%`,
        };
      }

      if (candles && candles.length >= 2) {
        const startClose = candles[0].close;
        const endClose = candles[candles.length - 1].close;
        if (startClose === 0 || !isFinite(startClose) || !isFinite(endClose)) {
          return {
            expectedOperator: operator,
            targetValue,
            observedValue: 0,
            conditionSatisfied: false,
            evaluationDetails: `Cannot calculate percent change from invalid or zero baseline candle close: ${startClose}`,
          };
        }
        const pct = ((endClose - startClose) / Math.abs(startClose)) * 100;
        const satisfied = Math.abs(pct) >= Math.abs(targetValue);
        return {
          expectedOperator: operator,
          targetValue,
          observedValue: pct,
          conditionSatisfied: satisfied,
          evaluationDetails: satisfied
            ? `Observed percent change ${pct.toFixed(2)}% meets target ${targetValue}%`
            : `Observed percent change ${pct.toFixed(2)}% did not meet target ${targetValue}%`,
        };
      }
      return {
        expectedOperator: operator,
        targetValue,
        observedValue,
        conditionSatisfied: false,
        evaluationDetails: `Insufficient historical candles to calculate percent change`,
      };
    }

    default: {
      const satisfied = observedValue > targetValue;
      return {
        expectedOperator: operator,
        targetValue,
        observedValue,
        conditionSatisfied: satisfied,
        evaluationDetails: `Fallback comparison: ${satisfied ? 'satisfied' : 'unsatisfied'}`,
      };
    }
  }
}

/**
 * Evaluates whether an observed stock market price, technical indicator value,
 * or candlestick pattern satisfies the requested operator and target threshold.
 */
export function evaluateStockCondition(
  params: StockConditionEvaluationParams
): FinanceConditionEvaluation {
  return evaluateCryptoCondition({
    targetType: params.targetType,
    operator: params.operator,
    observedValue: params.observedValue,
    previousObservedValue: params.previousObservedValue,
    indicatorName: params.indicatorName,
    indicatorSeries: params.indicatorSeries,
    targetValue: params.targetValue,
    candlestickMatched: params.candlestickMatched,
    candles: params.candles,
    high24h: params.high,
    low24h: params.low,
    isObservationOnly: params.isObservationOnly,
  });
}

export interface PredictionMarketConditionParams {
  operator: SentinelOperator;
  observedProbability: number | null; // Probability in [0, 1]
  targetProbability?: number; // Probability in [0, 1]
  outcome?: 'YES' | 'NO';
  historicalSnapshots?: Array<{ timestamp: number; probability: number }>;
}

/**
 * Evaluates whether an observed prediction market probability satisfies the requested
 * operator and target probability threshold.
 */
export function evaluatePredictionMarketCondition(
  params: PredictionMarketConditionParams
): FinanceConditionEvaluation {
  const { operator, targetProbability, historicalSnapshots, outcome = 'YES' } = params;
  const observedProbability = params.observedProbability;

  // 1. Missing, invalid, or out-of-range observed probability check (must be in [0, 1])
  if (
    observedProbability === null ||
    observedProbability === undefined ||
    !Number.isFinite(observedProbability) ||
    observedProbability < 0 ||
    observedProbability > 1
  ) {
    return {
      expectedOperator: operator,
      targetValue: targetProbability,
      observedValue: null,
      conditionSatisfied: false,
      evaluationDetails: `Invalid observed probability ${observedProbability} (must be a finite number in range [0, 1])`,
    };
  }

  // 2. Comparison operators require a valid target probability
  const comparisonOps: SentinelOperator[] = [
    'LESS_THAN',
    'GREATER_THAN',
    'CROSSES_ABOVE',
    'CROSSES_BELOW',
    'EQUALS',
    'PERCENT_CHANGE',
  ];

  if (targetProbability === undefined || targetProbability === null || !Number.isFinite(targetProbability)) {
    if (comparisonOps.includes(operator)) {
      return {
        expectedOperator: operator,
        targetValue: undefined,
        observedValue: observedProbability,
        conditionSatisfied: false,
        evaluationDetails: `Operator ${operator} requires a valid target probability threshold, but received ${targetProbability}`,
      };
    }

    return {
      expectedOperator: operator,
      targetValue: undefined,
      observedValue: observedProbability,
      conditionSatisfied: true,
      evaluationDetails: `Observed valid live ${outcome} probability ${(observedProbability * 100).toFixed(1)}% (no comparison threshold specified)`,
    };
  }

  if (targetProbability < 0 || targetProbability > 1) {
    return {
      expectedOperator: operator,
      targetValue: targetProbability,
      observedValue: observedProbability,
      conditionSatisfied: false,
      evaluationDetails: `Target probability must be within [0, 1], received ${targetProbability}`,
    };
  }

  // 3. Crossing & historical operators requiring historical probability snapshots
  if (operator === 'CROSSES_ABOVE' || operator === 'CROSSES_BELOW') {
    if (!historicalSnapshots || historicalSnapshots.length < 2) {
      return {
        expectedOperator: operator,
        targetValue: targetProbability,
        observedValue: observedProbability,
        conditionSatisfied: false,
        evaluationDetails: `Operator "${operator}" requires historical probability snapshots, which are currently unavailable for prediction markets.`,
      };
    }

    const prevProb = historicalSnapshots[historicalSnapshots.length - 2].probability;
    const currProb = historicalSnapshots[historicalSnapshots.length - 1].probability;

    if (operator === 'CROSSES_ABOVE') {
      const satisfied = prevProb < targetProbability && currProb >= targetProbability;
      return {
        expectedOperator: operator,
        targetValue: targetProbability,
        observedValue: currProb,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Probability crossed above ${(targetProbability * 100).toFixed(1)}% (previous: ${(prevProb * 100).toFixed(1)}%, current: ${(currProb * 100).toFixed(1)}%)`
          : `Probability did not cross above ${(targetProbability * 100).toFixed(1)}% (previous: ${(prevProb * 100).toFixed(1)}%, current: ${(currProb * 100).toFixed(1)}%)`,
      };
    } else {
      const satisfied = prevProb > targetProbability && currProb <= targetProbability;
      return {
        expectedOperator: operator,
        targetValue: targetProbability,
        observedValue: currProb,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Probability crossed below ${(targetProbability * 100).toFixed(1)}% (previous: ${(prevProb * 100).toFixed(1)}%, current: ${(currProb * 100).toFixed(1)}%)`
          : `Probability did not cross below ${(targetProbability * 100).toFixed(1)}% (previous: ${(prevProb * 100).toFixed(1)}%, current: ${(currProb * 100).toFixed(1)}%)`,
      };
    }
  }

  // 4. Standard threshold operators
  switch (operator) {
    case 'LESS_THAN': {
      const satisfied = observedProbability < targetProbability;
      return {
        expectedOperator: operator,
        targetValue: targetProbability,
        observedValue: observedProbability,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Observed ${outcome} probability ${(observedProbability * 100).toFixed(1)}% is less than threshold ${(targetProbability * 100).toFixed(1)}%`
          : `Observed ${outcome} probability ${(observedProbability * 100).toFixed(1)}% is NOT less than threshold ${(targetProbability * 100).toFixed(1)}%`,
      };
    }

    case 'GREATER_THAN': {
      const satisfied = observedProbability > targetProbability;
      return {
        expectedOperator: operator,
        targetValue: targetProbability,
        observedValue: observedProbability,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Observed ${outcome} probability ${(observedProbability * 100).toFixed(1)}% is greater than threshold ${(targetProbability * 100).toFixed(1)}%`
          : `Observed ${outcome} probability ${(observedProbability * 100).toFixed(1)}% is NOT greater than threshold ${(targetProbability * 100).toFixed(1)}%`,
      };
    }

    case 'EQUALS': {
      const diff = Math.abs(observedProbability - targetProbability);
      const tolerance = 0.005; // 0.5% tolerance
      const satisfied = diff <= tolerance;
      return {
        expectedOperator: operator,
        targetValue: targetProbability,
        observedValue: observedProbability,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Observed ${outcome} probability ${(observedProbability * 100).toFixed(1)}% equals target ${(targetProbability * 100).toFixed(1)}% (tolerance 0.5%)`
          : `Observed ${outcome} probability ${(observedProbability * 100).toFixed(1)}% does not equal target ${(targetProbability * 100).toFixed(1)}%`,
      };
    }

    case 'TOUCHES': {
      const diff = Math.abs(observedProbability - targetProbability);
      const satisfied = diff <= 0.01; // 1% range
      return {
        expectedOperator: operator,
        targetValue: targetProbability,
        observedValue: observedProbability,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Target probability ${(targetProbability * 100).toFixed(1)}% touched within observed range`
          : `Target probability ${(targetProbability * 100).toFixed(1)}% was not reached`,
      };
    }

    default: {
      const satisfied = observedProbability > targetProbability;
      return {
        expectedOperator: operator,
        targetValue: targetProbability,
        observedValue: observedProbability,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Observed ${outcome} probability ${(observedProbability * 100).toFixed(1)}% meets condition against ${(targetProbability * 100).toFixed(1)}%`
          : `Observed ${outcome} probability ${(observedProbability * 100).toFixed(1)}% does not meet condition against ${(targetProbability * 100).toFixed(1)}%`,
      };
    }
  }
}
