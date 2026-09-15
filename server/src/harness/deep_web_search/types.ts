import { z } from 'zod';
import type { SentinelOperator } from '@sentinel/shared';

/**
 * ==========================================================
 * SENTINEL DEEP RESEARCH META-HARNESS — TYPE DEFINITIONS
 * ==========================================================
 * Single Source of Truth for planning, scouting, inspecting,
 * condition evaluation, and tri-state observability outcomes.
 */

// ==========================================================
// 1. Input Task Definition
// ==========================================================

export const TargetDataKindEnum = z.enum([
  'PRICE',           // Numeric monetary price (currency extraction, sale price)
  'CATEGORICAL',     // Discrete states (In Stock, Out of Stock, Sold Out, Backorder)
  'NUMERIC_METRIC',  // General numeric values (counter, seat count, points)
  'TEXT_MATCH',      // Arbitrary text string matching
  'GENERAL_INFO',    // Open research / general site lookup
]);

export type TargetDataKind = z.infer<typeof TargetDataKindEnum>;

export const PreferredDomainsPolicyEnum = z.enum([
  'SOFT_PREFERENCE',   // Boost preferred domains to the top of candidate queues
  'STRICT_REQUIREMENT', // Strictly reject non-matching domains
]);

export type PreferredDomainsPolicy = z.infer<typeof PreferredDomainsPolicyEnum>;

export interface DeepResearchTask {
  /** Unique task identifier (e.g., 'T1', 'T2') */
  id: string;
  /** Natural language atomic goal (e.g., "Check RTX 5090 inventory on European stores") */
  query: string;
  /** Target classification */
  targetDataKind: TargetDataKind;
  /** Operator user expects to apply (e.g., 'LESS_THAN', 'KEYWORD_MATCH') */
  expectedOperator: SentinelOperator;
  /** Expected threshold value if known (e.g., 1800 for price < 1800) */
  targetValue?: string | number;
  /** User-specified domain constraints (e.g., ["scan.co.uk", "mindfactory.de"]) */
  preferredDomains?: string[];
  /** Policy for preferred domains (SOFT_PREFERENCE vs STRICT_REQUIREMENT) */
  preferredDomainsPolicy?: PreferredDomainsPolicy;
  /** Exclusions or guidance (e.g., ["exclude ebay", "exclude scam sites"]) */
  userConstraints?: string[];
}

// ==========================================================
// 2. Canonical Source Category Taxonomy (SSOT)
// ==========================================================

export const SourceCategoryEnum = z.enum([
  'DIRECT_RETAIL',        // Official merchant/vendor site
  'PUBLIC_DATA_PORTAL',   // Official government gazettes, regulatory registers, tender databases
  'STATUS_DASHBOARD',     // Official system status, health, or incident dashboards
  'OFFICIAL_NEWSROOM',    // Corporate PR newsrooms, investor relations, official release notes
  'STOCK_EXCHANGE_FEED',  // Financial ticker feeds, market indices, commodities
  'CRYPTOMARKET_TRACKER', // On-chain DEX aggregators, token dashboards
  'PREDICTION_MARKET',    // Prediction platforms (Polymarket, Kalshi)
  'RESEARCH_REPOSITORY',  // Clinical trials, arXiv preprints, bioRxiv
  'AGGREGATOR_PORTAL',    // Dedicated multi-store stock tracker / comparison engine
  'PUBLIC_API_FEED',      // Open JSON feed / REST endpoint
  'COMMUNITY_INTEL',      // Forums, Reddit threads with verified tracker links
]);

export type SourceCategory = z.infer<typeof SourceCategoryEnum>;

export interface SearchAngle {
  /** Search query string to send to retriever */
  query: string;
  /** Why the planner chose this query */
  rationale: string;
  /** Expected type of source */
  sourceCategory: SourceCategory;
}

export interface ResearchPlan {
  taskId: string;
  searchAngles: SearchAngle[];
  /** Rules for what constitutes a "qualified" source for this task */
  qualificationCriteria: string[];
}

// ==========================================================
// 3. Scout Output (Candidate Sites)
// ==========================================================

export interface CandidateSite {
  url: string;
  domain: string;
  siteName: string;
  title: string;
  snippet: string;
  sourceCategory: SourceCategory;
  /** Preliminary relevance score (0.0 - 1.0) based on title/snippet */
  snippetRelevanceScore: number;
}

// ==========================================================
// 4. Inspector Output (Site Dossier & DOM Selectors)
// ==========================================================

export type ScrapingTier =
  | 'CHEERIO_STATIC'           // Fast HTML fetch (Tier 1)
  | 'JSON_LD_MICRODATA'        // Schema.org metadata inside static HTML
  | 'FRAMEWORK_EMBEDDED_STATE' // Next.js (__NEXT_DATA__), Nuxt, or Shopify JSON (Tier 1.5)
  | 'PLAYWRIGHT_HEADLESS'      // Rendered dynamic SPA (Tier 2)
  | 'VERIFIED_PUBLIC_API';     // Sniffed JSON endpoint that passed clean fetch

export type SelectorSource =
  | 'MODEL_GENERATED'          // Synthesized by Inspector LLM
  | 'HEURISTIC_FALLBACK'       // Fallback from deterministic DOM candidates
  | 'JSON_PATH'                // Derived from JSON-LD / framework state
  | 'PRESET';                  // User-defined constraint

export interface SelectorExecutionDiagnostics {
  selector: string;
  matchedCount: number;
  rawSampleValue: string | null;
  matchedHtmlSample?: string;
  isPlaceholder?: boolean;
  isDecoy?: boolean;
  rejectionReason?: string;
}

export interface TextualGradient {
  stepIndex: number;
  candidateUrl: string;
  failedSelector: string;
  diagnostics: SelectorExecutionDiagnostics;
  directionalCorrection: string;
}

export interface ConditionEvaluation {
  expectedOperator: SentinelOperator;
  targetValue?: string | number;
  observedValue: string | number | null;
  conditionSatisfied: boolean;
  evaluationDetails: string;
}

export interface SiteDossier {
  url: string;
  domain: string;
  siteName: string;
  scrapingTierUsed: ScrapingTier;
  /** How the selector was derived */
  selectorSource?: SelectorSource;
  /** Whether the site required dynamic JavaScript/client-side hydration */
  requiresDynamicHydration?: boolean;

  /** Did the site respond with 200 without bot blocks? */
  isAccessible: boolean;
  /** Does the page actually display the live data the user wants? */
  hasLiveTargetData: boolean;

  /** The exact CSS Selector for Sentinel's WEB_OBSERVER */
  selector: string | null;
  /** HTML Attribute to extract ('text' | 'value' | 'href' | 'json') */
  attribute: 'text' | 'value' | 'href' | 'json';

  /** Raw text extracted from the element (e.g., "$1,799.00 (In Stock)") */
  rawSampleValue: string | null;
  /** Sanitized numeric or clean string (e.g., 1799.00 or "In Stock") */
  normalizedValue: string | number | null;
  /** Regex pattern to extract value during continuous Sentinel runs */
  valueRegex: string | null;

  /** Deterministic condition evaluation against user's targetValue and operator */
  conditionEvaluation?: ConditionEvaluation;

  /** Optional direct API endpoint if verified without CSRF */
  directApiEndpoint?: string | null;

  /** Quality notes */
  pros: string[];
  cons: string[];

  /** Diagnostics from selector verification */
  diagnostics?: SelectorExecutionDiagnostics;

  /** If failed inspection, why? (e.g. "Behind Cloudflare Turnstile", "Empty SPA") */
  rejectionReason?: string | null;

  /** Overall confidence score (0.0 - 1.0) */
  confidenceScore: number;
}

// ==========================================================
// 5. Tri-State Meta-Harness Outcomes & Error Taxonomy
// ==========================================================

export type DeepResearchOutcomeStatus =
  | 'EXACT_MATCH'
  | 'MULTIPLE_OPTIONS'
  | 'NOT_FOUND'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'ERROR';

export type DeepResearchOutcome =
  | {
      status: 'EXACT_MATCH';
      taskId: string;
      taskDescription: string;
      source: SiteDossier;
      confidence: number;
      conditionEvaluation?: ConditionEvaluation;
    }
  | {
      status: 'MULTIPLE_OPTIONS';
      taskId: string;
      taskDescription: string;
      candidates: SiteDossier[];
      conditionEvaluation?: ConditionEvaluation;
    }
  | {
      status: 'NOT_FOUND';
      taskId: string;
      taskDescription: string;
      reason: string;
      attemptedDomains: string[];
      suggestion?: string;
    }
  | {
      status: 'CANCELLED';
      taskId: string;
      taskDescription: string;
      reason: string;
      attemptedDomains: string[];
    }
  | {
      status: 'TIMED_OUT';
      taskId: string;
      taskDescription: string;
      reason: string;
      attemptedDomains: string[];
      elapsedMs?: number;
    }
  | {
      status: 'ERROR';
      taskId: string;
      taskDescription: string;
      error: string;
      stage?: string;
      attemptedDomains: string[];
    };

// ==========================================================
// 6. Streaming Telemetry Events (For Mobile Chat UI)
// ==========================================================

export type TelemetryStep =
  | 'RESEARCH_START'
  | 'PLAN_GENERATED'
  | 'SCOUTING_SERP'
  | 'SERP_REVECTORING'
  | 'CANDIDATES_FOUND'
  | 'INSPECTING_SITE'
  | 'INSPECTOR_GRADIENT_STEP'
  | 'SITE_INSPECTED'
  | 'RESEARCH_COMPLETE'
  | 'RESEARCH_ERROR';

export interface ResearchTelemetryEvent {
  taskId: string;
  executionId?: string;
  step: TelemetryStep;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

// ==========================================================
// 7. Harness Configuration & Execution Budget
// ==========================================================

export interface ExecutionBudget {
  /** Maximum wall-clock time in milliseconds for the entire task (Default: 120,000ms) */
  maxTotalTimeMs?: number;
  /** Maximum time allowed per individual site inspection (Default: 9,000ms) */
  siteTimeoutMs?: number;
  /** Maximum LLM model calls allowed across all stages (Default: 15) */
  maxModelCalls?: number;
  /** Maximum headless browser instances launched (Default: 2) */
  maxBrowserLaunches?: number;
  /** Maximum gradient descent refinement steps per site (Default: 2) */
  maxGradientIterations?: number;
}

export interface DeepResearchConfig extends ExecutionBudget {
  maxSearchAngles?: number;          // Default: 3
  maxCandidateSites?: number;        // Default: 4
  enableHeadlessFallback?: boolean;  // Default: true
  allowPrivateForTesting?: boolean;  // Default: false (only true for unit tests against localhost)
  preferredDomainsPolicy?: PreferredDomainsPolicy;
  onTelemetry?: (event: ResearchTelemetryEvent) => void;
}