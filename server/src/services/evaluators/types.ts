/**
 * Strands Sentinel - Evaluator Types
 * Defines evaluation result contracts for Tier-1 deterministic evaluators.
 */

import type { SubSentinel, Rule } from '@sentinel/shared';

export interface SubSentinelEvaluationResult {
  isSatisfied: boolean;
  observedValue: number | string | boolean | null;
  previousValue?: number | string | boolean | null;
  unit?: string;
  details: string;
  error?: string | null;
  extraMetadata?: Record<string, unknown>;
}

export interface SubSentinelEvaluator {
  evaluate(
    subSentinel: SubSentinel,
    rule?: Rule,
    signal?: AbortSignal
  ): Promise<SubSentinelEvaluationResult>;
}
