import type {
  PredictionMarketThreshold,
  SentinelOperator,
} from '@sentinel/shared';
import type {
  FinanceOutcome,
  CommonFinanceConfig,
} from '../finance_common/index.js';

export interface PredictionMarketTask {
  id: string;
  query: string;
  conditionId?: string;
  desiredOutcome?: 'YES' | 'NO';
  targetProbability?: number; // 0.0 - 1.0 (e.g. 0.60 for 60%)
  expectedOperator?: SentinelOperator;
}

export interface PredictionMarketDossier {
  marketTitle: string;
  conditionId: string;
  clobTokenId: string;
  outcome: 'YES' | 'NO';
  currentProbability: number;
  volume24h?: number;
  totalVolume: number;
  resolutionDate?: string;
  contract: PredictionMarketThreshold;
}

export type PredictionMarketOutcome = FinanceOutcome<PredictionMarketThreshold>;

export interface PredictionMarketHarnessConfig extends CommonFinanceConfig {
  maxCandidates?: number;
}

export interface ActivePredictionMarketSession {
  executionId: string;
  task: PredictionMarketTask;
  startTime: number;
  abortController: AbortController;
  telemetryHistory: import('../finance_common/index.js').FinanceTelemetryEvent[];
}

export interface CompletedPredictionMarketSessionRecord {
  executionId: string;
  taskId: string;
  task: PredictionMarketTask;
  startTime: number;
  completedAt: number;
  outcome: PredictionMarketOutcome;
  telemetryHistory: import('../finance_common/index.js').FinanceTelemetryEvent[];
}

export interface PredictionMarketPipelineOptions {
  config?: PredictionMarketHarnessConfig;
  signal?: AbortSignal;
  deadline?: number;
  executionId?: string;
}

