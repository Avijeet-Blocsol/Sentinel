import type {
  RssFeedThreshold,
  DisambiguationCandidate,
  SentinelOperator,
} from '@sentinel/shared';

/**
 * ==========================================================
 * RSS FEED RECONNAISSANCE HARNESS — TYPE DEFINITIONS
 * ==========================================================
 */

export interface NormalizedRssItem {
  id: string;              // Deterministic SHA-256 or guid
  title: string;           // Article title
  link: string;            // Canonical article URL
  pubDate: number;         // Millisecond timestamp
  isoDate?: string;        // ISO 8601 formatted date string
  author?: string;         // Author name if present
  contentSnippet: string;  // Sanitized plaintext excerpt for matching
  categories: string[];    // Tags or category labels
  enclosureUrl?: string;   // Attached media or cover image URL
}

export type FeedFormat = 'RSS_2_0' | 'ATOM' | 'JSON_FEED' | 'RDF';

export interface RssFeedDossier {
  title: string;
  feedUrl: string;
  siteUrl?: string;
  description?: string;
  format: FeedFormat;
  itemCount: number;
  lastBuildDate?: number;
  sampleItems: NormalizedRssItem[];
  suggestedTtlSeconds: number;
  matchedHistoricalCount: number;
  etag?: string;
  lastModified?: string;
  contract: RssFeedThreshold;
}

export interface RssResearchTask {
  id: string;
  query: string;
  feedUrl?: string;
  keywords?: string[];
  matchMode?: 'ANY' | 'ALL' | 'EXACT';
  authorFilter?: string;
  semanticFilter?: string;
  expectedOperator?: SentinelOperator;
}

export type RssTelemetryStep =
  | 'RSS_START'
  | 'RESOLVING_FEED'
  | 'SNIFFING_HTML'
  | 'FETCHING_FEED'
  | 'PARSING_FEED'
  | 'SIMULATING_FILTER'
  | 'DISCOVERY_COMPLETE'
  | 'DISCOVERY_ERROR';

export interface RssTelemetryEvent {
  taskId: string;
  executionId?: string;
  step: RssTelemetryStep;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
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

export type RssOutcomeStatus =
  | 'EXACT_MATCH'
  | 'MULTIPLE_OPTIONS'
  | 'NOT_FOUND'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'ERROR';

export type TriStateStatus = RssOutcomeStatus;

export interface BaseRssOutcome {
  taskId: string;
  status: RssOutcomeStatus;
}

export interface RssNotFoundOutcome extends BaseRssOutcome {
  status: 'NOT_FOUND';
  query: string;
  reason: string;
  suggestion?: string;
}

export interface RssMultipleOptionsOutcome extends BaseRssOutcome {
  status: 'MULTIPLE_OPTIONS';
  query: string;
  message: string;
  candidates: DisambiguationCandidate[];
}

export interface RssExactMatchOutcome extends BaseRssOutcome {
  status: 'EXACT_MATCH';
  query: string;
  contract: RssFeedThreshold;
  dossier: RssFeedDossier;
  currentDisplayValue: string;
  verificationDetails: string;
  confidence: number;
}

export interface RssCancelledOutcome extends BaseRssOutcome {
  status: 'CANCELLED';
  query: string;
  reason: string;
}

export interface RssTimedOutOutcome extends BaseRssOutcome {
  status: 'TIMED_OUT';
  query: string;
  reason: string;
  elapsedMs?: number;
}

export interface RssErrorOutcome extends BaseRssOutcome {
  status: 'ERROR';
  query: string;
  error: string;
  provider?: string;
  details?: Record<string, unknown>;
}

export type RssResearchOutcome =
  | RssExactMatchOutcome
  | RssMultipleOptionsOutcome
  | RssNotFoundOutcome
  | RssCancelledOutcome
  | RssTimedOutOutcome
  | RssErrorOutcome;

export interface RssHarnessConfig {
  timeoutMs?: number;
  maxCandidates?: number;
  onTelemetry?: (event: RssTelemetryEvent) => void;
  allowPrivateForTesting?: boolean;
  semanticEvaluator?: (items: NormalizedRssItem[], filter: string) => Promise<boolean[]>;
}
