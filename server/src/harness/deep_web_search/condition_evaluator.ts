import type { SentinelOperator } from '@sentinel/shared';
import type { ConditionEvaluation } from './types.js';

/**
 * ==========================================================
 * SENTINEL DEEP RESEARCH — DETERMINISTIC CONDITION EVALUATOR
 * ==========================================================
 * Evaluates whether an observed scraped value satisfies the user's
 * specified operator and target threshold (e.g. price < 1800, stock == IN_STOCK).
 */

export function evaluateCondition(
  operator: SentinelOperator,
  observedValue: string | number | null,
  targetValue?: string | number
): ConditionEvaluation {
  if (observedValue === null || observedValue === undefined) {
    return {
      expectedOperator: operator,
      targetValue,
      observedValue: null,
      conditionSatisfied: false,
      evaluationDetails: 'No observed value extracted from target page',
    };
  }

  // If operator requires comparison, a target threshold is strictly required
  const comparisonOperators: SentinelOperator[] = [
    'LESS_THAN',
    'GREATER_THAN',
    'EQUALS',
    'PERCENT_CHANGE',
    'TOUCHES',
    'CROSSES_ABOVE',
    'CROSSES_BELOW',
    'CLOSES_ABOVE',
    'CLOSES_BELOW',
  ];

  if (targetValue === undefined || targetValue === '' || targetValue === null) {
    if (comparisonOperators.includes(operator)) {
      return {
        expectedOperator: operator,
        targetValue,
        observedValue,
        conditionSatisfied: false,
        evaluationDetails: `Operator "${operator}" requires a valid target threshold comparison value, but received none`,
      };
    }

    return {
      expectedOperator: operator,
      targetValue,
      observedValue,
      conditionSatisfied: true,
      evaluationDetails: `Observed valid live value: "${observedValue}" (no comparison threshold specified)`,
    };
  }

  const numObserved = typeof observedValue === 'number' ? observedValue : parseFloat(String(observedValue).replace(/[^0-9.-]/g, ''));
  const numTarget = typeof targetValue === 'number' ? targetValue : parseFloat(String(targetValue).replace(/[^0-9.-]/g, ''));
  const bothNumeric = !isNaN(numObserved) && !isNaN(numTarget) && Number.isFinite(numObserved) && Number.isFinite(numTarget);

  switch (operator) {
    case 'LESS_THAN': {
      if (!bothNumeric) {
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: false,
          evaluationDetails: `Cannot evaluate LESS_THAN: non-numeric values (observed="${observedValue}", target="${targetValue}")`,
        };
      }
      const satisfied = numObserved < numTarget;
      return {
        expectedOperator: operator,
        targetValue: numTarget,
        observedValue: numObserved,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Observed ${numObserved} is less than threshold ${numTarget}`
          : `Observed ${numObserved} is NOT less than threshold ${numTarget}`,
      };
    }

    case 'GREATER_THAN': {
      if (!bothNumeric) {
        return {
          expectedOperator: operator,
          targetValue,
          observedValue,
          conditionSatisfied: false,
          evaluationDetails: `Cannot evaluate GREATER_THAN: non-numeric values (observed="${observedValue}", target="${targetValue}")`,
        };
      }
      const satisfied = numObserved > numTarget;
      return {
        expectedOperator: operator,
        targetValue: numTarget,
        observedValue: numObserved,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Observed ${numObserved} is greater than threshold ${numTarget}`
          : `Observed ${numObserved} is NOT greater than threshold ${numTarget}`,
      };
    }

    case 'EQUALS':
    case 'TOUCHES': {
      if (bothNumeric) {
        const satisfied = Math.abs(numObserved - numTarget) < 0.0001;
        return {
          expectedOperator: operator,
          targetValue: numTarget,
          observedValue: numObserved,
          conditionSatisfied: satisfied,
          evaluationDetails: satisfied
            ? `Observed numeric value ${numObserved} equals target ${numTarget}`
            : `Observed numeric value ${numObserved} does not equal target ${numTarget}`,
        };
      }
      const strObserved = String(observedValue).trim().toLowerCase();
      const strTarget = String(targetValue).trim().toLowerCase();
      const satisfied = strObserved === strTarget;
      return {
        expectedOperator: operator,
        targetValue,
        observedValue,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Observed text "${observedValue}" matches target "${targetValue}"`
          : `Observed text "${observedValue}" does not match target "${targetValue}"`,
      };
    }

    case 'KEYWORD_MATCH':
    case 'SEMANTIC_MATCH': {
      const strObserved = String(observedValue).toLowerCase();
      const strTarget = String(targetValue).toLowerCase();
      const satisfied = strObserved.includes(strTarget);
      return {
        expectedOperator: operator,
        targetValue,
        observedValue,
        conditionSatisfied: satisfied,
        evaluationDetails: satisfied
          ? `Observed text contains keyword "${targetValue}"`
          : `Observed text does not contain keyword "${targetValue}"`,
      };
    }

    // Historical / Streaming operators require time-series data which is unsupported in single-observation web research
    case 'CROSSES_ABOVE':
    case 'CROSSES_BELOW':
    case 'CLOSES_ABOVE':
    case 'CLOSES_BELOW':
    case 'STATE_FLIP':
    case 'PERCENT_CHANGE': {
      return {
        expectedOperator: operator,
        targetValue,
        observedValue,
        conditionSatisfied: false,
        evaluationDetails: `Operator "${operator}" requires historical/time-series telemetry and is unsupported in single-observation web research. Use static operators (LESS_THAN, GREATER_THAN, EQUALS, KEYWORD_MATCH).`,
      };
    }

    default: {
      const strObserved = String(observedValue).toLowerCase();
      const strTarget = String(targetValue).toLowerCase();
      const satisfied = strObserved.includes(strTarget);
      return {
        expectedOperator: operator,
        targetValue,
        observedValue,
        conditionSatisfied: satisfied,
        evaluationDetails: `Fallback comparison: ${satisfied ? 'matched' : 'unmatched'}`,
      };
    }
  }
}
