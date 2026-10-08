/**
 * ==========================================================
 * STRANDS SENTINEL - SHARED CONTRACT & SCHEMA DEFINITIONS
 * ==========================================================
 * SINGLE SOURCE OF TRUTH (SSOT)
 * Both Server and Mobile consume models and validators from here.
 */

import { z } from "zod";

// ==========================================================
// 1. Specialized JSON Column Payloads
// ==========================================================

// ==========================================================
// 1. Technical Indicators & Candlestick Pattern Enums
// ==========================================================

export const TechnicalIndicatorEnum = z.enum([
  "SMA",
  "EMA",
  "WMA",
  "WEMA",
  "RSI",
  "MACD",
  "BOLLINGER_BANDS",
  "BOLLINGER", // Backward-compatibility alias
  "KELTNER_CHANNELS",
  "STOCHASTIC",
  "STOCHASTIC_RSI",
  "CCI",
  "ATR",
  "ADX",
  "ROC",
  "AWESOME_OSCILLATOR",
  "TRIX",
  "WILLIAMS_R",
  "VOLUME",
  "OBV",
  "MFI",
  "VWAP",
  "PSAR",
  "ICHIMOKU_CLOUD",
  "PRICE",
]);
export type TechnicalIndicator = z.infer<typeof TechnicalIndicatorEnum>;

export const CandlestickPatternEnum = z.enum([
  // Bullish Reversals
  "BULLISH_ENGULFING",
  "BULLISH_HAMMER",
  "BULLISH_INVERTED_HAMMER",
  "BULLISH_HARAMI",
  "BULLISH_HARAMI_CROSS",
  "BULLISH_MARUBOZU",
  "MORNING_STAR",
  "MORNING_DOJI_STAR",
  "DRAGONFLY_DOJI",
  // Bearish Reversals
  "BEARISH_ENGULFING",
  "BEARISH_HAMMER",
  "BEARISH_INVERTED_HAMMER",
  "BEARISH_HARAMI",
  "BEARISH_HARAMI_CROSS",
  "BEARISH_MARUBOZU",
  "EVENING_STAR",
  "EVENING_DOJI_STAR",
  "GRAVESTONE_DOJI",
  "DARK_CLOUD_COVER",
  "SHOOTING_STAR",
  // Neutral / Indecision
  "DOJI",
]);
export type CandlestickPattern = z.infer<typeof CandlestickPatternEnum>;

export const SentinelOperatorEnum = z.enum([
  "GREATER_THAN",
  "LESS_THAN",
  "CROSSES_ABOVE",
  "CROSSES_BELOW",
  "TOUCHES",
  "CLOSES_ABOVE",
  "CLOSES_BELOW",
  "EQUALS",
  "KEYWORD_MATCH",
  "STATE_FLIP",
  "HASH_DELTA",
  "SEMANTIC_MATCH",
  "PERCENT_CHANGE",
]);
export type SentinelOperator = z.infer<typeof SentinelOperatorEnum>;

export const DisambiguationCandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  currentValue: z.string().min(1),
  context: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type DisambiguationCandidate = z.infer<typeof DisambiguationCandidateSchema>;

// ==========================================================
// 2. Specialized Sub-Sentinel Threshold Payloads
// ==========================================================

export const StockThresholdSchema = z.object({
  ticker: z.string().min(1),
  exchange: z.string().optional(),
  currency: z.string().default("USD"),
  provider: z.enum(["FINNHUB", "YAHOO"]).default("FINNHUB"),
  marketHoursOnly: z.boolean().default(true),
  targetType: z.enum(["PRICE", "INDICATOR", "CANDLESTICK"]).default("PRICE"),
  indicator: TechnicalIndicatorEnum.optional(),
  candlestickPattern: CandlestickPatternEnum.optional(),
  period: z.number().int().positive().optional(),
  timeframe: z.enum(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]).default("1d"),
  targetValue: z.number().optional(),
  fastPeriod: z.number().int().positive().optional(),
  slowPeriod: z.number().int().positive().optional(),
  signalPeriod: z.number().int().positive().optional(),
  operator: SentinelOperatorEnum.optional(),
  observedValue: z.number().optional(),
  conditionSatisfied: z.boolean().optional(),
  evaluationDetails: z.string().optional(),
  conditionEvaluation: z.object({
    expectedOperator: SentinelOperatorEnum,
    targetValue: z.number().optional(),
    observedValue: z.number().nullable().optional(),
    conditionSatisfied: z.boolean(),
    evaluationDetails: z.string(),
  }).optional(),
});
export type StockThreshold = z.infer<typeof StockThresholdSchema>;

export const CryptoThresholdSchema = z.object({
  assetSymbol: z.string().min(1), // e.g. "BTC", "ETH", "SOL", "PEPE"
  currency: z.string().default("USD"),
  venue: z.enum(["COINBASE", "DEXSCREENER"]).default("COINBASE"),
  dexContractAddress: z.string().optional(),
  dexNetwork: z.string().optional(), // e.g. "solana", "base", "ethereum"
  targetType: z.enum(["PRICE", "INDICATOR", "CANDLESTICK"]).default("PRICE"),
  indicator: TechnicalIndicatorEnum.optional(),
  candlestickPattern: CandlestickPatternEnum.optional(),
  period: z.number().int().positive().optional(),
  timeframe: z.enum(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]).default("1h"),
  targetValue: z.number().optional(),
  fastPeriod: z.number().int().positive().optional(),
  slowPeriod: z.number().int().positive().optional(),
  signalPeriod: z.number().int().positive().optional(),
  operator: SentinelOperatorEnum.optional(),
  observedValue: z.number().optional(),
  conditionSatisfied: z.boolean().optional(),
  evaluationDetails: z.string().optional(),
  conditionEvaluation: z.object({
    expectedOperator: SentinelOperatorEnum,
    targetValue: z.number().optional(),
    observedValue: z.number().nullable().optional(),
    conditionSatisfied: z.boolean(),
    evaluationDetails: z.string(),
  }).optional(),
});
export type CryptoThreshold = z.infer<typeof CryptoThresholdSchema>;

export const PredictionMarketThresholdSchema = z.object({
  venue: z.literal("POLYMARKET").default("POLYMARKET"),
  conditionId: z.string().min(1),
  clobTokenId: z.string().min(1).optional(),
  outcome: z.string().min(1), // Supports YES/NO as well as multi-candidate outcome names
  targetProbability: z.number().min(0).max(1), // 0.0 to 1.0 (e.g. 0.45 for 45%)
  marketTitle: z.string().min(1).default("Prediction Market"),
  resolutionDate: z.string().optional(),
  priceType: z.enum(["MIDPOINT", "LAST_TRADE", "GAMMA_PRICE"]).default("MIDPOINT"),
  operator: SentinelOperatorEnum.optional(),
  observedProbability: z.number().optional(),
  conditionSatisfied: z.boolean().optional(),
  evaluationDetails: z.string().optional(),
  conditionEvaluation: z.object({
    expectedOperator: SentinelOperatorEnum,
    targetValue: z.number().optional(),
    observedValue: z.number().nullable().optional(),
    conditionSatisfied: z.boolean(),
    evaluationDetails: z.string(),
  }).optional(),
});
export type PredictionMarketThreshold = z.infer<typeof PredictionMarketThresholdSchema>;

export const TelegramChannelThresholdSchema = z.object({
  channelHandle: z.string().min(1), // e.g. "@whale_alert_io"
  keywords: z.array(z.string()).min(1),
  matchMode: z.enum(["ANY", "ALL", "EXACT"]).default("ANY"),
  minViews: z.number().int().nonnegative().optional(),
  mediaOnly: z.boolean().default(false),
  semanticFilter: z.string().optional(),
});
export type TelegramChannelThreshold = z.infer<typeof TelegramChannelThresholdSchema>;

export const RssFeedThresholdSchema = z.object({
  feedUrl: z.string().url(),
  keywords: z.array(z.string()).min(1),
  matchMode: z.enum(["ANY", "ALL", "EXACT"]).default("ANY"),
  authorFilter: z.string().optional(),
  semanticFilter: z.string().optional(),
});
export type RssFeedThreshold = z.infer<typeof RssFeedThresholdSchema>;

// Legacy / Existing schemas maintained for full backward compatibility
export const FinancialThresholdSchema = z.object({
  indicator: TechnicalIndicatorEnum,
  period: z.number().int().positive().optional(),
  timeframe: z.enum(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]).default("1h"),
  value: z.number(),
  fastPeriod: z.number().int().positive().optional(),
  slowPeriod: z.number().int().positive().optional(),
  signalPeriod: z.number().int().positive().optional(),
});
export type FinancialThreshold = z.infer<typeof FinancialThresholdSchema>;

export const EcommerceThresholdSchema = z.object({
  price: z.number().positive().optional(),
  currency: z.string().default("USD"),
  checkInStock: z.boolean().default(true),
  seller: z.string().optional(),
  minDiscountPercent: z.number().min(0).max(100).optional(),
});
export type EcommerceThreshold = z.infer<typeof EcommerceThresholdSchema>;

export const WebObserverThresholdSchema = z.object({
  selector: z.string().optional(),
  attribute: z.string().default("text"),
  expectedText: z.string().optional(),
  regex: z.string().optional(),
  hashType: z.enum(["SHA256", "DOM_STRUCTURE"]).optional(),
  targetValue: z.union([z.string(), z.number()]).optional(),
  checkInStock: z.boolean().optional(),
});
export type WebObserverThreshold = z.infer<typeof WebObserverThresholdSchema>;

export const StreamIntelligenceThresholdSchema = z.object({
  sourceType: z.enum([
    "REDDIT",
    "TELEGRAM",
    "DISCORD",
    "RSS_NEWS",
    "GOVT_TENDER",
  ]),
  keywords: z.array(z.string()).min(1),
  matchMode: z.enum(["ANY", "ALL", "EXACT"]).default("ANY"),
  semanticFilter: z.string().optional(), // Bedrock Haiku semantic filter prompt
  minUpvotes: z.number().int().nonnegative().optional(),
  authorFilter: z.string().optional(),
});
export type StreamIntelligenceThreshold = z.infer<
  typeof StreamIntelligenceThresholdSchema
>;

export const SubSentinelThresholdSchema = z.union([
  StockThresholdSchema,
  CryptoThresholdSchema,
  PredictionMarketThresholdSchema,
  WebObserverThresholdSchema,
  TelegramChannelThresholdSchema,
  RssFeedThresholdSchema,
  FinancialThresholdSchema,
  EcommerceThresholdSchema,
  StreamIntelligenceThresholdSchema,
]);
export type SubSentinelThreshold = z.infer<typeof SubSentinelThresholdSchema>;

export const SubSentinelStatePayloadSchema = z.object({
  currentValue: z.union([z.string(), z.number(), z.boolean()]),
  previousValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  unit: z.string().optional(),
  sourceTimestamp: z.number().int(),
  rawSnippet: z.string().optional(),
  extraMetadata: z.record(z.string(), z.unknown()).optional(),
});
export type SubSentinelStatePayload = z.infer<typeof SubSentinelStatePayloadSchema>;

export const ToolCallRecordSchema = z.object({
  toolName: z.string(),
  toolCallId: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const InterruptActionPayloadSchema = z.object({
  actionType: z.enum([
    "LIMIT_BUY_ORDER",
    "MARKET_ORDER",
    "WEBHOOK_POST",
    "EMAIL_DISPATCH",
    "DISCORD_MESSAGE",
  ]),
  target: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  reversible: z.boolean().default(false),
  estimatedImpact: z.string().optional(),
});
export type InterruptActionPayload = z.infer<
  typeof InterruptActionPayloadSchema
>;

// ==========================================================
// 2. Primary Database & Domain Entities
// ==========================================================

export const UserSchema = z.object({
  id: z.string().min(1),
  google_sub: z.string().nullable().optional(),
  apple_sub: z.string().nullable().optional(),
  github_sub: z.string().nullable().optional(),
  email: z.string().email(),
  name: z.string().min(1),
  avatar_url: z.string().url().nullable().optional(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type User = z.infer<typeof UserSchema>;

export const UserDeviceSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().min(1),
  push_token: z.string().min(1),
  platform: z.enum(["ios", "android", "web"]),
  last_active_at: z.number().int(),
});
export type UserDevice = z.infer<typeof UserDeviceSchema>;

export const ConversationPhaseEnum = z.enum([
  'DISCOVERY',
  'AWAITING_QUERY_CONFIRMATION',
  'SCOUTING',
  'AWAITING_TRIGGER_MODE',
  'CLARIFICATION_PENDING',
  'INTERRUPT_PENDING',
  'DEPLOYED',
]);
export type ConversationPhase = z.infer<typeof ConversationPhaseEnum>;

export const AgentConversationSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["ACTIVE", "ARCHIVED", "SYNTHESIZED"]).default("ACTIVE"),
  phase: ConversationPhaseEnum.default('DISCOVERY'),
  created_at: z.number().int(),
});
export type AgentConversation = z.infer<typeof AgentConversationSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  tool_calls: z.string().nullable().optional(), // JSON-serialized Array<ToolCallRecord>
  created_at: z.number().int(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const AudioToneEnum = z.enum(["cash_register", "siren", "chime"]);
export type AudioTone = z.infer<typeof AudioToneEnum>;

export const AgenticEvaluationResultSchema = z.object({
  conditionSatisfied: z
    .boolean()
    .describe("Whether the condition requested by the user is satisfied by the observed data"),
  confidenceScore: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence score between 0.0 and 1.0"),
  reasoning: z
    .string()
    .describe("Clear, concise explanation of why the condition is or is not satisfied based on evidence"),
  observedEvidence: z.object({
    sourceTitle: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
    relevantSnippet: z.string().describe("Direct quote, metric, or snippet serving as proof"),
    extractedValue: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  }),
  suggestedAlert: z
    .object({
      title: z.string().describe("Impactful push notification title"),
      summary: z.string().describe("Concise 1-2 sentence alert summary"),
      severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
      audioTone: AudioToneEnum.default("chime"),
    })
    .nullable()
    .optional(),
  suggestedAction: z
    .object({
      actionType: InterruptActionPayloadSchema.shape.actionType,
      target: z.string().min(1),
      parameters: z.record(z.string(), z.unknown()),
      requiresHumanApproval: z.literal(true).default(true),
      description: z.string(),
    })
    .nullable()
    .optional(),
  error: z.string().nullable().optional(),
  status: z.enum(['MATCH', 'NO_MATCH', 'ERROR']).nullable().optional(),
  matchedIndices: z
    .array(z.number().int().min(0))
    .nullable()
    .optional()
    .describe("0-based indices of candidate items in observedContext that specifically satisfied the condition"),
});
export type AgenticEvaluationResult = z.infer<typeof AgenticEvaluationResultSchema>;

// ==========================================================
// Condition Tree AST (Arbitrary Nested Boolean Logic)
// ==========================================================

export type ConditionNode =
  | { type: "LEAF"; subSentinelId: string }
  | { type: "AND"; children: ConditionNode[] }
  | { type: "OR"; children: ConditionNode[] }
  | { type: "NOT"; child: ConditionNode };

export const MAX_CONDITION_TREE_DEPTH = 32;
export const MAX_CONDITION_TREE_NODES = 100;
export const MAX_CONDITION_TREE_CHILDREN = 50;

function isConditionTreeWithinLimits(raw: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 1 }];
  let nodeCount = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== "object" || Array.isArray(current.value)) return false;
    if (current.depth > MAX_CONDITION_TREE_DEPTH || ++nodeCount > MAX_CONDITION_TREE_NODES) return false;

    const candidate = current.value as Record<string, unknown>;
    if (candidate.type === "LEAF") {
      if (typeof candidate.subSentinelId !== "string" || candidate.subSentinelId.length === 0 || candidate.subSentinelId.length > 128) {
        return false;
      }
      continue;
    }

    if (candidate.type === "NOT") {
      pending.push({ value: candidate.child, depth: current.depth + 1 });
      continue;
    }

    if (candidate.type === "AND" || candidate.type === "OR") {
      if (!Array.isArray(candidate.children) || candidate.children.length === 0 || candidate.children.length > MAX_CONDITION_TREE_CHILDREN) {
        return false;
      }
      for (const child of candidate.children) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }

    return false;
  }

  return true;
}

export const ConditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal("LEAF"),
      subSentinelId: z.string().min(1).max(128),
    }),
    z.object({
      type: z.literal("AND"),
      children: z.array(ConditionNodeSchema).min(1).max(MAX_CONDITION_TREE_CHILDREN),
    }),
    z.object({
      type: z.literal("OR"),
      children: z.array(ConditionNodeSchema).min(1).max(MAX_CONDITION_TREE_CHILDREN),
    }),
    z.object({
      type: z.literal("NOT"),
      child: ConditionNodeSchema,
    }),
  ])
);

export type KleeneBool = boolean | null;

/**
 * Evaluates an arbitrary boolean condition tree AST using 3-valued Kleene logic:
 * true, false, or null (UNKNOWN/ERROR).
 * Prevents NOT(UNKNOWN) from evaluating to true.
 */
export function evaluateConditionTreeKleene(
  node: ConditionNode,
  satisfactionMap: Map<string, KleeneBool>
): KleeneBool {
  switch (node.type) {
    case "LEAF": {
      const val = satisfactionMap.get(node.subSentinelId);
      return val === undefined ? null : val;
    }
    case "AND": {
      let hasUnknown = false;
      for (const child of node.children) {
        const res = evaluateConditionTreeKleene(child, satisfactionMap);
        if (res === false) return false;
        if (res === null) hasUnknown = true;
      }
      return hasUnknown ? null : true;
    }
    case "OR": {
      let hasUnknown = false;
      for (const child of node.children) {
        const res = evaluateConditionTreeKleene(child, satisfactionMap);
        if (res === true) return true;
        if (res === null) hasUnknown = true;
      }
      return hasUnknown ? null : false;
    }
    case "NOT": {
      const res = evaluateConditionTreeKleene(node.child, satisfactionMap);
      if (res === null) return null;
      return !res;
    }
  }
}

/**
 * Recursively evaluates an arbitrary boolean condition tree AST against
 * a map of sub-sentinel satisfaction booleans.
 * Requires strict true to satisfy (UNKNOWN/ERROR never satisfies).
 */
export function evaluateConditionTree(
  node: ConditionNode,
  satisfactionMap: Map<string, boolean | null>
): boolean {
  return evaluateConditionTreeKleene(node, satisfactionMap) === true;
}

/**
 * Safely parses and validates a raw condition tree (JSON string or object).
 */
export function parseConditionTree(
  raw: string | ConditionNode | null | undefined
): ConditionNode | null {
  if (!raw) return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!isConditionTreeWithinLimits(obj)) return null;
    const parsed = ConditionNodeSchema.safeParse(obj);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const RuleCombinatorEnum = z.enum(["AND", "OR", "SINGLE"]);
export type RuleCombinator = z.infer<typeof RuleCombinatorEnum>;

export const TriggerModeEnum = z.enum(["ONE_SHOT", "PERSISTENT"]);
export type TriggerMode = z.infer<typeof TriggerModeEnum>;

export const RuleStatusEnum = z.enum([
  "ACTIVE",
  "TRIGGERED",
  "DISMISSED",
  "PAUSED",
  "ARCHIVED",
]);
export type RuleStatus = z.infer<typeof RuleStatusEnum>;

export const RuleCategoryEnum = z.enum([
  "FINANCIAL",
  "CRYPTO",
  "PREDICTION_MARKET",
  "WEB_INTEL",
  "SOCIAL_STREAM",
  "ECOMMERCE",
]);
export type RuleCategory = z.infer<typeof RuleCategoryEnum>;

export const RuleSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().min(1),
  conversation_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  natural_language_intent: z.string().min(1).max(4000),
  category: RuleCategoryEnum.default("FINANCIAL"),
  combinator: RuleCombinatorEnum,
  condition_tree: z.string().max(32_000).nullable().optional(), // JSON serialized ConditionNode AST
  trigger_mode: TriggerModeEnum,
  cooldown_minutes: z.number().int().nonnegative().default(60),
  audio_tone: AudioToneEnum,
  status: RuleStatusEnum.default("ACTIVE"),
  expires_at: z.number().int().nullable().optional(),
  last_triggered_at: z.number().int().nullable().optional(),
  action_template: z.string().max(16_000).nullable().optional(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const SentinelTypeEnum = z.enum([
  "STOCK",
  "CRYPTO",
  "PREDICTION_MARKET",
  "WEB_OBSERVER",
  "TELEGRAM_CHANNEL",
  "RSS_FEED",
  // Backward compatibility aliases
  "FINANCIAL_TECHNICAL",
  "ECOMMERCE_INVENTORY",
  "STREAM_INTELLIGENCE",
]);
export type SentinelType = z.infer<typeof SentinelTypeEnum>;

export const SentinelHealthStatusEnum = z.enum(["HEALTHY", "DEGRADED", "ERROR"]);
export type SentinelHealthStatus = z.infer<typeof SentinelHealthStatusEnum>;

export const SubSentinelSchema = z.object({
  id: z.string().uuid(),
  rule_id: z.string().uuid(),
  sentinel_type: SentinelTypeEnum,
  target_source: z.string().min(1).max(2048),
  operator: SentinelOperatorEnum,
  threshold: z.string().max(16_000), // JSON string conforming to SubSentinelThresholdSchema
  ttl_seconds: z.number().int().positive().default(300),
  last_evaluated_at: z.number().int().nullable().optional(),
  // Internal durable-scheduler fields. Together they form the DynamoDB
  // due-work index key; API clients may safely ignore them.
  schedule_shard: z.string().min(1).nullable().optional(),
  next_evaluation_at: z.number().int().nullable().optional(),
  last_triggered_at: z.number().int().nullable().optional(),
  is_satisfied: z.number().int().min(0).max(1).default(0),
  satisfied_at: z.number().int().nullable().optional(),
  state_payload: z.string().max(32_000).nullable().optional(), // JSON string conforming to SubSentinelStatePayloadSchema
  health_status: SentinelHealthStatusEnum.default("HEALTHY"),
  error_count: z.number().int().nonnegative().default(0),
  last_error: z.string().nullable().optional(),
});
export type SubSentinel = z.infer<typeof SubSentinelSchema>;
export const SubSentrySchema = SubSentinelSchema;
export type SubSentry = SubSentinel;

export const SeenEventSchema = z.object({
  id: z.string(), // SHA-256 hash of (source + event_id)
  sub_sentinel_id: z.string().uuid(),
  source: z.string(),
  event_hash: z.string(),
  seen_at: z.number().int(),
});
export type SeenEvent = z.infer<typeof SeenEventSchema>;

export const TelemetryPointSchema = z.object({
  id: z.string().uuid(),
  rule_id: z.string().uuid(),
  sub_sentinel_id: z.string().uuid().nullable().optional(),
  metric_name: z.string(),
  value: z.number(),
  timestamp: z.number().int(),
  metadata: z.string().nullable().optional(),
});
export type TelemetryPoint = z.infer<typeof TelemetryPointSchema>;

export const AlertEventSchema = z.object({
  id: z.string().uuid(),
  rule_id: z.string().uuid(),
  user_id: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  audio_tone: AudioToneEnum,
  snapshot_data: z.string().nullable().optional(),
  created_at: z.number().int(),
});
export type AlertEvent = z.infer<typeof AlertEventSchema>;

export const InterruptStatusEnum = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
]);
export type InterruptStatus = z.infer<typeof InterruptStatusEnum>;

/**
 * Choice-driven interrupt types. Every workflow gate that requires a user
 * decision must use this contract so it can be rendered as an action card on
 * every client and rehydrated after reconnects.
 */
export const ChoiceInterruptActionTypeEnum = z.enum([
  'CLARIFICATION_REQUIRED',
  'QUERY_CONFIRMATION_REQUIRED',
  'MONITORING_MODE_REQUIRED',
  'TASK_EDIT_CONFIRMATION_REQUIRED',
]);
export type ChoiceInterruptActionType = z.infer<typeof ChoiceInterruptActionTypeEnum>;

export const ChoiceInterruptKindEnum = z.enum([
  'CLARIFICATION_REQUIRED',
  'QUERY_CONFIRMATION_REQUIRED',
  'MONITORING_MODE_REQUIRED',
  'TASK_EDIT_CONFIRMATION_REQUIRED',
]);
export type ChoiceInterruptKind = z.infer<typeof ChoiceInterruptKindEnum>;

export function isChoiceInterruptActionType(actionType: string): actionType is ChoiceInterruptActionType {
  return ChoiceInterruptActionTypeEnum.safeParse(actionType).success;
}

export const ClarificationChoiceSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(300),
  description: z.string().max(1000).optional(),
  input: z.object({
    kind: z.literal('TEXT'),
    placeholder: z.string().max(300).optional(),
    submit_label: z.string().min(1).max(80).optional(),
    max_length: z.number().int().min(1).max(4000).optional(),
  }).optional(),
});
export type ClarificationChoice = z.infer<typeof ClarificationChoiceSchema>;

export const TaskEditOperationEnum = z.enum([
  'DELETE_CONDITION',
  'UPDATE_CONDITION',
  'CHANGE_TRIGGER_MODE',
]);
export type TaskEditOperation = z.infer<typeof TaskEditOperationEnum>;

/**
 * A model-proposed edit is still only a proposal. The server checks the
 * target UUID, expected rule version, resulting condition tree, and database
 * ownership before committing it.
 */
export const TaskEditProposalSchema = z.object({
  operation: TaskEditOperationEnum,
  target_sub_sentinel_id: z.string().uuid().optional(),
  target_label: z.string().max(500).optional(),
  summary: z.string().min(1).max(4000),
  expected_rule_updated_at: z.number().int().optional(),
  changes: z.object({
    schedule_seconds: z.number().int().positive().max(31_536_000).optional(),
    operator: SentinelOperatorEnum.optional(),
    threshold_patch: z.record(z.string(), z.unknown()).optional(),
    trigger_mode: TriggerModeEnum.optional(),
  }).default({}),
});
export type TaskEditProposal = z.infer<typeof TaskEditProposalSchema>;

export const ChoiceInterruptPayloadSchema = z.object({
  kind: ChoiceInterruptKindEnum,
  question: z.string().min(1).max(4000),
  // Agent-provided options are capped at eight; the server may append one
  // explicit manual-response card so every interrupt remains resolvable.
  choices: z.array(ClarificationChoiceSchema).min(2).max(9),
  field: z.string().min(1).max(120).optional(),
  resume_phase: ConversationPhaseEnum,
  retry_message: z.string().max(8000).optional(),
  task_edit: TaskEditProposalSchema.optional(),
  task_edit_request: z.string().max(16000).optional(),
});
export type ChoiceInterruptPayload = z.infer<typeof ChoiceInterruptPayloadSchema>;

export const ClarificationRequestPayloadSchema = ChoiceInterruptPayloadSchema.extend({
  kind: z.literal('CLARIFICATION_REQUIRED'),
});
export type ClarificationRequestPayload = z.infer<typeof ClarificationRequestPayloadSchema>;

export const InterruptActionSchema = z.object({
  id: z.string().uuid(),
  alert_id: z.string().uuid().nullable().optional(),
  rule_id: z.string().uuid().nullable().optional(),
  conversation_id: z.string().uuid().nullable().optional(),
  user_id: z.string().min(1),
  action_type: z.string(),
  action_payload: z.string(), // JSON string conforming to the action-specific payload schema
  status: InterruptStatusEnum.default("PENDING"),
  expires_at: z.number().int().nullable().optional(),
  created_at: z.number().int(),
  resolved_at: z.number().int().nullable().optional(),
});
export type InterruptAction = z.infer<typeof InterruptActionSchema>;

/**
 * Interrupt payload returned to clients after joining the action to its
 * parent rule/conversation.  Keep this separate from the persistence shape
 * so conversation routing metadata is not silently stripped by Zod parsing.
 */
export const EnrichedInterruptActionSchema = InterruptActionSchema.extend({
  conversation_id: z.string().uuid().nullable().optional(),
  rule_title: z.string().nullable().optional(),
});
export type EnrichedInterruptAction = z.infer<typeof EnrichedInterruptActionSchema>;

// ==========================================================
// ==========================================================
// 3. Realtime WebSocket Event Payloads
// ==========================================================

export const WsEventTypeEnum = z.enum([
  "PING",
  "PONG",
  "CHAT_MESSAGE",
  "RESOLVE_INTERRUPT",
  "TELEMETRY_UPDATE",
  "SUB_SENTINEL_EVALUATED",
  "SENTRY_EVALUATED", // Deprecated alias
  "ALERT_TRIGGERED",
  "INTERRUPT_REQUEST",
  "INTERRUPT_RESOLVED",
  "INTERRUPT_REQUIRED",
  "AGENT_CHAT_CHUNK",
  "AGENT_CHAT_DONE",
  "ERROR",
]);
export type WsEventType = z.infer<typeof WsEventTypeEnum>;

// Client -> Server Payloads
export const WsPingMessageSchema = z.object({
  type: z.literal("PING"),
});
export type WsPingMessage = z.infer<typeof WsPingMessageSchema>;

export const WsChatMessageSchema = z.object({
  type: z.literal("CHAT_MESSAGE"),
  payload: z.object({
    content: z.string().trim().min(1).max(16_000),
  }),
});
export type WsChatMessage = z.infer<typeof WsChatMessageSchema>;

export const WsResolveInterruptMessageSchema = z.object({
  type: z.literal("RESOLVE_INTERRUPT"),
  payload: z.object({
    interruptId: z.string().uuid(),
    resolution: z.enum(["APPROVED", "REJECTED"]),
    // Every interrupt is resolved by an explicit UI action. Natural-language
    // messages are never valid resolution requests. Manual text is carried
    // only as the response to the explicit manual-response card.
    choiceId: z.string().min(1).max(120),
    responseText: z.string().trim().max(4000).optional(),
  }),
});
export type WsResolveInterruptMessage = z.infer<typeof WsResolveInterruptMessageSchema>;

export const WsClientMessageSchema = z.discriminatedUnion("type", [
  WsPingMessageSchema,
  WsChatMessageSchema,
  WsResolveInterruptMessageSchema,
]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

// Server -> Client Payloads
export const WsPongMessageSchema = z.object({
  type: z.literal("PONG"),
  timestamp: z.number().int(),
});
export type WsPongMessage = z.infer<typeof WsPongMessageSchema>;

export const TelemetryUpdateEventSchema = z.object({
  type: z.literal("TELEMETRY_UPDATE"),
  payload: TelemetryPointSchema,
});
export type TelemetryUpdateEvent = z.infer<typeof TelemetryUpdateEventSchema>;

export const SubSentinelEvaluatedEventSchema = z.object({
  type: z.union([z.literal("SUB_SENTINEL_EVALUATED"), z.literal("SENTRY_EVALUATED")]),
  payload: z.object({
    subSentinelId: z.string().uuid(),
    ruleId: z.string().uuid(),
    isSatisfied: z.boolean(),
    currentValue: z.union([z.string(), z.number(), z.boolean()]),
    timestamp: z.number().int(),
  }),
});
export type SubSentinelEvaluatedEvent = z.infer<typeof SubSentinelEvaluatedEventSchema>;

export const AlertTriggeredEventSchema = z.object({
  type: z.literal("ALERT_TRIGGERED"),
  payload: AlertEventSchema,
});
export type AlertTriggeredEvent = z.infer<typeof AlertTriggeredEventSchema>;

export const InterruptRequestEventSchema = z.object({
  type: z.literal("INTERRUPT_REQUEST"),
  payload: EnrichedInterruptActionSchema,
});
export type InterruptRequestEvent = z.infer<typeof InterruptRequestEventSchema>;

export const InterruptResolvedEventSchema = z.object({
  type: z.literal("INTERRUPT_RESOLVED"),
  payload: z.object({
    interruptId: z.string().uuid(),
    resolution: z.enum(["APPROVED", "REJECTED"]),
    actionResult: z.string(),
    resolvedAt: z.number().int(),
    choiceId: z.string().min(1).max(120),
    responseText: z.string().max(4000).optional(),
  }),
});
export type InterruptResolvedEvent = z.infer<typeof InterruptResolvedEventSchema>;

export const InterruptRequiredEventSchema = z.object({
  type: z.literal("INTERRUPT_REQUIRED"),
  payload: z.object({
    interruptId: z.string().uuid(),
    message: z.string(),
  }),
});
export type InterruptRequiredEvent = z.infer<typeof InterruptRequiredEventSchema>;

export const AgentChatChunkEventSchema = z.object({
  type: z.literal("AGENT_CHAT_CHUNK"),
  payload: z.object({
    chunk: z.string(),
    turnId: z.string().uuid().optional(),
    sequence: z.number().int().nonnegative().optional(),
  }),
});
export type AgentChatChunkEvent = z.infer<typeof AgentChatChunkEventSchema>;

export const AgentChatDoneEventSchema = z.object({
  type: z.literal("AGENT_CHAT_DONE"),
  payload: z.object({
    messageId: z.string().uuid(),
    content: z.string(),
    turnId: z.string().uuid().optional(),
    phase: ConversationPhaseEnum.optional(),
    rule: RuleSchema.nullable().optional(),
    subSentinels: z.array(SubSentinelSchema).optional().default([]),
    interrupt: EnrichedInterruptActionSchema.nullable().optional(),
  }),
});
export type AgentChatDoneEvent = z.infer<typeof AgentChatDoneEventSchema>;

export const WsErrorMessageSchema = z.object({
  type: z.literal("ERROR"),
  payload: z.object({
    message: z.string(),
    error: z.string().optional(),
  }),
});
export type WsErrorMessage = z.infer<typeof WsErrorMessageSchema>;

export const WsServerMessageSchema = z.discriminatedUnion("type", [
  WsPongMessageSchema,
  TelemetryUpdateEventSchema,
  SubSentinelEvaluatedEventSchema,
  AlertTriggeredEventSchema,
  InterruptRequestEventSchema,
  InterruptResolvedEventSchema,
  InterruptRequiredEventSchema,
  AgentChatChunkEventSchema,
  AgentChatDoneEventSchema,
  WsErrorMessageSchema,
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

// ==========================================================
// 4. HTTP Request & Response DTO Schemas
// ==========================================================

// Users & Devices
export const GetMeResponseSchema = z.object({
  user: UserSchema,
});
export type GetMeResponse = z.infer<typeof GetMeResponseSchema>;

export const RegisterDeviceRequestSchema = z.object({
  push_token: z.string().min(1),
  platform: z.enum(["ios", "android", "web"]),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

export const RegisterDeviceResponseSchema = z.object({
  success: z.boolean(),
  device: UserDeviceSchema,
});
export type RegisterDeviceResponse = z.infer<typeof RegisterDeviceResponseSchema>;

export const GetDevicesResponseSchema = z.object({
  devices: z.array(UserDeviceSchema),
});
export type GetDevicesResponse = z.infer<typeof GetDevicesResponseSchema>;

// Conversations
export const ListConversationsQuerySchema = z.object({
  q: z.string().optional(),
  status: z.enum(["ACTIVE", "ARCHIVED", "SYNTHESIZED"]).optional(),
  limit: z.number().int().positive().max(100).optional().default(50),
});
export type ListConversationsQuery = z.infer<typeof ListConversationsQuerySchema>;

export const ListConversationsResponseSchema = z.object({
  conversations: z.array(AgentConversationSchema),
});
export type ListConversationsResponse = z.infer<typeof ListConversationsResponseSchema>;

export const CreateConversationRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const CreateConversationResponseSchema = z.object({
  conversation: AgentConversationSchema,
});
export type CreateConversationResponse = z.infer<typeof CreateConversationResponseSchema>;

export const GetConversationResponseSchema = z.object({
  conversation: AgentConversationSchema,
  messages: z.array(ChatMessageSchema),
});
export type GetConversationResponse = z.infer<typeof GetConversationResponseSchema>;

export const UpdateConversationStatusRequestSchema = z.object({
  status: z.enum(["ACTIVE", "ARCHIVED"]),
});
export type UpdateConversationStatusRequest = z.infer<typeof UpdateConversationStatusRequestSchema>;

export const UpdateConversationStatusResponseSchema = z.object({
  success: z.boolean(),
  id: z.string(),
  status: z.enum(["ACTIVE", "ARCHIVED", "SYNTHESIZED"]),
});
export type UpdateConversationStatusResponse = z.infer<typeof UpdateConversationStatusResponseSchema>;

// Rules
export const RuleWithSubSentinelsSchema = RuleSchema.extend({
  sub_sentinels: z.array(SubSentinelSchema).default([]),
  // Durable evaluation history is included with dashboard rule snapshots so
  // clients can render charts after reconnecting or opening the dashboard
  // without an active conversation socket.
  telemetry: z.array(TelemetryPointSchema).default([]),
});
export type RuleWithSubSentinels = z.infer<typeof RuleWithSubSentinelsSchema>;

export const ListRulesQuerySchema = z.object({
  category: RuleCategoryEnum.optional(),
  status: RuleStatusEnum.optional(),
});
export type ListRulesQuery = z.infer<typeof ListRulesQuerySchema>;

export const ListRulesResponseSchema = z.object({
  rules: z.array(RuleWithSubSentinelsSchema),
});
export type ListRulesResponse = z.infer<typeof ListRulesResponseSchema>;

export const GetRuleResponseSchema = z.object({
  rule: RuleWithSubSentinelsSchema,
});
export type GetRuleResponse = z.infer<typeof GetRuleResponseSchema>;

export const UpdateRuleStatusRequestSchema = z.object({
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]),
});
export type UpdateRuleStatusRequest = z.infer<typeof UpdateRuleStatusRequestSchema>;

export const UpdateRuleStatusResponseSchema = z.object({
  success: z.boolean(),
  id: z.string(),
  status: RuleStatusEnum,
});
export type UpdateRuleStatusResponse = z.infer<typeof UpdateRuleStatusResponseSchema>;

export const DeleteRuleResponseSchema = z.object({
  success: z.boolean(),
  id: z.string(),
});
export type DeleteRuleResponse = z.infer<typeof DeleteRuleResponseSchema>;

// Interrupts
export const GetPendingInterruptsResponseSchema = z.object({
  interrupts: z.array(EnrichedInterruptActionSchema),
});
export type GetPendingInterruptsResponse = z.infer<typeof GetPendingInterruptsResponseSchema>;

export const GetInterruptResponseSchema = z.object({
  interrupt: EnrichedInterruptActionSchema,
});
export type GetInterruptResponse = z.infer<typeof GetInterruptResponseSchema>;

export const CreateWsTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
export type CreateWsTicketResponse = z.infer<typeof CreateWsTicketResponseSchema>;

// Alerts
export const ListAlertsQuerySchema = z.object({
  limit: z.number().int().positive().max(100).optional().default(50),
  rule_id: z.string().optional(),
});
export type ListAlertsQuery = z.infer<typeof ListAlertsQuerySchema>;

export const ListAlertsResponseSchema = z.object({
  alerts: z.array(AlertEventSchema),
});
export type ListAlertsResponse = z.infer<typeof ListAlertsResponseSchema>;

export const GetAlertResponseSchema = z.object({
  alert: AlertEventSchema,
});
export type GetAlertResponse = z.infer<typeof GetAlertResponseSchema>;

// ==========================================================
// 5. Schema Registry & JSON Schema Helper
// ==========================================================

export const ALL_SCHEMAS = {
  User: UserSchema,
  UserDevice: UserDeviceSchema,
  AgentConversation: AgentConversationSchema,
  ChatMessage: ChatMessageSchema,
  Rule: RuleSchema,
  SubSentinel: SubSentinelSchema,
  SubSentry: SubSentinelSchema, // Backward compatibility alias
  SeenEvent: SeenEventSchema,
  TelemetryPoint: TelemetryPointSchema,
  AlertEvent: AlertEventSchema,
  InterruptAction: InterruptActionSchema,
  EnrichedInterruptAction: EnrichedInterruptActionSchema,
  ChoiceInterruptPayload: ChoiceInterruptPayloadSchema,
  ClarificationChoice: ClarificationChoiceSchema,
  ClarificationRequestPayload: ClarificationRequestPayloadSchema,
  StockThreshold: StockThresholdSchema,
  CryptoThreshold: CryptoThresholdSchema,
  PredictionMarketThreshold: PredictionMarketThresholdSchema,
  TelegramChannelThreshold: TelegramChannelThresholdSchema,
  RssFeedThreshold: RssFeedThresholdSchema,
  DisambiguationCandidate: DisambiguationCandidateSchema,
  FinancialThreshold: FinancialThresholdSchema,
  EcommerceThreshold: EcommerceThresholdSchema,
  WebObserverThreshold: WebObserverThresholdSchema,
  StreamIntelligenceThreshold: StreamIntelligenceThresholdSchema,
  InterruptActionPayload: InterruptActionPayloadSchema,
  AgenticEvaluationResult: AgenticEvaluationResultSchema,
  ConditionNode: ConditionNodeSchema,
  WsClientMessage: WsClientMessageSchema,
  WsServerMessage: WsServerMessageSchema,
};

export function getJsonSchema(name: keyof typeof ALL_SCHEMAS) {
  const schema = ALL_SCHEMAS[name];
  return z.toJSONSchema(schema);
}
