import type {
  TelegramChannelThreshold,
  DisambiguationCandidate,
  SentinelOperator,
} from '@sentinel/shared';

/**
 * ==========================================================
 * TELEGRAM OPEN CHANNEL META-HARNESS — TYPE DEFINITIONS
 * ==========================================================
 * Contract for discovering, validating, and extracting
 * public broadcast channel configurations for Sentinel rules.
 */

// ==========================================================
// 1. Error Definitions
// ==========================================================

export class ProviderError extends Error {
  constructor(
    public readonly provider: 'TELEGRAM' | 'DUCKDUCKGO' | 'BEDROCK' | string,
    public readonly statusCode: number | undefined,
    message: string,
    public readonly cause?: unknown
  ) {
    super(
      `[${provider}] Provider error (${
        statusCode ? `HTTP ${statusCode}` : 'Network/Execution'
      }): ${message}`
    );
    this.name = 'ProviderError';
  }
}

// ==========================================================
// 2. Input Task Definition
// ==========================================================

export interface TelegramResearchTask {
  id: string;
  query: string;
  channelHandle?: string; // e.g. "@whale_alert_io" or "whale_alert_io"
  keywords?: string[];
  matchMode?: 'ANY' | 'ALL' | 'EXACT';
  minViews?: number;
  mediaOnly?: boolean;
  semanticFilter?: string;
  expectedOperator?: SentinelOperator;
}

// ==========================================================
// 3. Channel & Message Metadata Models
// ==========================================================

export interface TelegramChannelMetadata {
  handle: string;
  title: string;
  description: string;
  subscribersCount?: number;
  subscribersDisplay?: string; // e.g. "420.5K"
  isVerified: boolean;
  avatarUrl?: string;
  publicUrl: string;
}

export interface TelegramParsedMessage {
  messageId: number;
  postId: string; // e.g. "whale_alert_io/103112"
  text: string;
  timestamp: number; // Unix timestamp in seconds
  isoDate: string;
  views?: number;
  viewsDisplay?: string; // e.g. "8.9K"
  hasMedia: boolean;
  mediaType?: 'photo' | 'video' | 'document' | 'audio';
  link: string;
}

export type SimulationVerdict =
  | 'ACTIVE_MATCHES_FOUND'
  | 'NO_HISTORICAL_MATCHES_RULE_ARMED';

export interface TelegramDossier {
  channel: TelegramChannelMetadata;
  recentMessages: TelegramParsedMessage[];
  matchedSampleCount: number;
  sampleMatchedPosts: TelegramParsedMessage[];
  sampleSemanticMatchedCount?: number;
  sampleMatchRate: number; // matchedSampleCount / totalRecentAnalyzed
  simulationVerdict: SimulationVerdict;
  expectedOperator: SentinelOperator;
  contract: TelegramChannelThreshold;
  verificationDetails: string;
}

// ==========================================================
// 4. Streaming Telemetry Events
// ==========================================================

export type TelegramTelemetryStep =
  | 'TELEGRAM_START'
  | 'RESOLVING_CHANNEL'
  | 'CHANNEL_RESOLVED'
  | 'FETCHING_SAMPLE_POSTS'
  | 'SIMULATING_FILTER'
  | 'SIMULATING_SEMANTIC_FILTER'
  | 'DISCOVERY_COMPLETE'
  | 'DISCOVERY_WARNING'
  | 'DISCOVERY_ERROR';

export interface TelegramTelemetryEvent {
  taskId: string;
  executionId?: string;
  step: TelegramTelemetryStep;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

// ==========================================================
// 5. Full Lifecycle Meta-Harness Outcomes
// ==========================================================

export type TelegramOutcomeStatus =
  | 'EXACT_MATCH'
  | 'MULTIPLE_OPTIONS'
  | 'NOT_FOUND'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'ERROR';

export type TriStateStatus = TelegramOutcomeStatus;

export interface BaseTelegramOutcome {
  taskId: string;
  status: TelegramOutcomeStatus;
  executionId?: string;
}

export interface TelegramNotFoundOutcome extends BaseTelegramOutcome {
  status: 'NOT_FOUND';
  query: string;
  reason: string;
  suggestion?: string;
}

export interface TelegramMultipleOptionsOutcome extends BaseTelegramOutcome {
  status: 'MULTIPLE_OPTIONS';
  query: string;
  message: string;
  candidates: DisambiguationCandidate[];
}

export interface TelegramExactMatchOutcome extends BaseTelegramOutcome {
  status: 'EXACT_MATCH';
  query: string;
  contract: TelegramChannelThreshold;
  dossier: TelegramDossier;
  currentDisplayValue: string;
  verificationDetails: string;
  confidence: number;
}

export interface TelegramCancelledOutcome extends BaseTelegramOutcome {
  status: 'CANCELLED';
  query: string;
  reason: string;
}

export interface TelegramTimedOutOutcome extends BaseTelegramOutcome {
  status: 'TIMED_OUT';
  query: string;
  reason: string;
  elapsedMs?: number;
}

export interface TelegramErrorOutcome extends BaseTelegramOutcome {
  status: 'ERROR';
  query: string;
  error: string;
  provider?: string;
  details?: Record<string, unknown>;
}

export type TelegramResearchOutcome =
  | TelegramExactMatchOutcome
  | TelegramMultipleOptionsOutcome
  | TelegramNotFoundOutcome
  | TelegramCancelledOutcome
  | TelegramTimedOutOutcome
  | TelegramErrorOutcome;

// ==========================================================
// 6. Harness Configuration
// ==========================================================

export interface TelegramHarnessConfig {
  timeoutMs?: number; // Default: 12000ms
  maxCandidates?: number; // Default: 5
  onTelemetry?: (event: TelegramTelemetryEvent) => void;
  semanticEvaluator?: (
    messages: TelegramParsedMessage[],
    semanticFilter: string,
    signal?: AbortSignal
  ) => Promise<boolean[]>;
}

