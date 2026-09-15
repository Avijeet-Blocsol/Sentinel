import type {
  DisambiguationCandidate,
  TechnicalIndicator,
  CandlestickPattern,
  SentinelOperator,
} from '@sentinel/shared';

/**
 * ==========================================================
 * FINANCIAL META-HARNESS — SHARED COMMON TYPES
 * ==========================================================
 */

export interface OHLCV {
  timestamp: number; // Unix timestamp in ms or seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type FinanceTelemetryStep =
  | 'FINANCE_START'
  | 'RESOLVING_ENTITY'
  | 'ENTITY_RESOLVED'
  | 'FETCHING_MARKET_DATA'
  | 'CALCULATING_INDICATOR'
  | 'DISCOVERY_COMPLETE'
  | 'DISCOVERY_ERROR';

export interface FinanceTelemetryEvent {
  taskId: string;
  executionId?: string;
  step: FinanceTelemetryStep;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

export type FinanceOutcomeStatus =
  | 'EXACT_MATCH'
  | 'MULTIPLE_OPTIONS'
  | 'NOT_FOUND'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'ERROR';

export type TriStateStatus = FinanceOutcomeStatus;

export interface BaseFinanceOutcome {
  taskId: string;
  status: FinanceOutcomeStatus;
}

export interface NotFoundOutcome extends BaseFinanceOutcome {
  status: 'NOT_FOUND';
  query: string;
  reason: string;
  suggestion?: string;
}

export interface MultipleOptionsOutcome extends BaseFinanceOutcome {
  status: 'MULTIPLE_OPTIONS';
  query: string;
  message: string;
  candidates: DisambiguationCandidate[];
}

export interface ExactMatchOutcome<TContract> extends BaseFinanceOutcome {
  status: 'EXACT_MATCH';
  query: string;
  contract: TContract;
  currentDisplayValue: string;
  verificationDetails: string;
  confidence: number;
}

export interface CancelledOutcome extends BaseFinanceOutcome {
  status: 'CANCELLED';
  query: string;
  reason: string;
}

export interface TimedOutOutcome extends BaseFinanceOutcome {
  status: 'TIMED_OUT';
  query: string;
  reason: string;
  elapsedMs?: number;
}

export interface ErrorOutcome extends BaseFinanceOutcome {
  status: 'ERROR';
  query: string;
  error: string;
  provider?: string;
  details?: Record<string, unknown>;
}

export interface FinanceConditionEvaluation {
  expectedOperator: SentinelOperator;
  targetValue?: number;
  observedValue: number | null;
  conditionSatisfied: boolean;
  evaluationDetails: string;
}

export type FinanceOutcome<TContract> =
  | ExactMatchOutcome<TContract>
  | MultipleOptionsOutcome
  | NotFoundOutcome
  | CancelledOutcome
  | TimedOutOutcome
  | ErrorOutcome;

export interface CommonFinanceConfig {
  timeoutMs?: number;
  onTelemetry?: (event: FinanceTelemetryEvent) => void;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly statusCode: number | undefined,
    message: string,
    public readonly cause?: unknown
  ) {
    super(`[${provider}] Provider error (${statusCode ? `HTTP ${statusCode}` : 'Network'}): ${message}`);
    this.name = 'ProviderError';
  }
}

export interface ClientRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

