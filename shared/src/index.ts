/**
 * ==========================================================
 * STRANDS SENTINEL - SHARED CONTRACT & SCHEMA DEFINITIONS
 * ==========================================================
 * SINGLE SOURCE OF TRUTH (SSOT)
 * Both Server and Mobile consume models and validators from here.
 */

import { z } from 'zod';

// ==========================================================
// 1. Specialized JSON Column Payloads
// ==========================================================

export const FinancialThresholdSchema = z.object({
  indicator: z.enum(['RSI', 'MACD', 'SMA', 'EMA', 'BOLLINGER', 'PRICE']),
  period: z.number().int().positive().optional(),
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).default('1h'),
  value: z.number(),
  fastPeriod: z.number().int().positive().optional(),
  slowPeriod: z.number().int().positive().optional(),
  signalPeriod: z.number().int().positive().optional(),
});
export type FinancialThreshold = z.infer<typeof FinancialThresholdSchema>;

export const EcommerceThresholdSchema = z.object({
  price: z.number().positive().optional(),
  currency: z.string().default('USD'),
  checkInStock: z.boolean().default(true),
  seller: z.string().optional(),
  minDiscountPercent: z.number().min(0).max(100).optional(),
});
export type EcommerceThreshold = z.infer<typeof EcommerceThresholdSchema>;

export const WebObserverThresholdSchema = z.object({
  selector: z.string().optional(),
  attribute: z.string().default('text'),
  expectedText: z.string().optional(),
  regex: z.string().optional(),
  hashType: z.enum(['SHA256', 'DOM_STRUCTURE']).optional(),
  targetValue: z.union([z.string(), z.number()]).optional(),
});
export type WebObserverThreshold = z.infer<typeof WebObserverThresholdSchema>;

export const StreamIntelligenceThresholdSchema = z.object({
  sourceType: z.enum(['REDDIT', 'TELEGRAM', 'DISCORD', 'RSS_NEWS', 'GOVT_TENDER']),
  keywords: z.array(z.string()).min(1),
  matchMode: z.enum(['ANY', 'ALL', 'EXACT']).default('ANY'),
  semanticFilter: z.string().optional(), // Bedrock Haiku semantic filter prompt
  minUpvotes: z.number().int().nonnegative().optional(),
  authorFilter: z.string().optional(),
});
export type StreamIntelligenceThreshold = z.infer<typeof StreamIntelligenceThresholdSchema>;

export const SubSentryThresholdSchema = z.union([
  FinancialThresholdSchema,
  EcommerceThresholdSchema,
  WebObserverThresholdSchema,
  StreamIntelligenceThresholdSchema,
]);
export type SubSentryThreshold = z.infer<typeof SubSentryThresholdSchema>;

export const SubSentryStatePayloadSchema = z.object({
  currentValue: z.union([z.string(), z.number(), z.boolean()]),
  previousValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  unit: z.string().optional(),
  sourceTimestamp: z.number().int(),
  rawSnippet: z.string().optional(),
  extraMetadata: z.record(z.string(), z.unknown()).optional(),
});
export type SubSentryStatePayload = z.infer<typeof SubSentryStatePayloadSchema>;

export const ToolCallRecordSchema = z.object({
  toolName: z.string(),
  toolCallId: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const InterruptActionPayloadSchema = z.object({
  actionType: z.enum(['LIMIT_BUY_ORDER', 'MARKET_ORDER', 'WEBHOOK_POST', 'EMAIL_DISPATCH', 'DISCORD_MESSAGE']),
  target: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  reversible: z.boolean().default(false),
  estimatedImpact: z.string().optional(),
});
export type InterruptActionPayload = z.infer<typeof InterruptActionPayloadSchema>;

// ==========================================================
// 2. Primary Database & Domain Entities
// ==========================================================

export const UserSchema = z.object({
  id: z.string().uuid(),
  google_sub: z.string().nullable().optional(),
  apple_sub: z.string().nullable().optional(),
  email: z.string().email(),
  name: z.string().min(1),
  avatar_url: z.string().url().nullable().optional(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type User = z.infer<typeof UserSchema>;

export const UserDeviceSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  push_token: z.string().min(1),
  platform: z.enum(['ios', 'android', 'web']),
  last_active_at: z.number().int(),
});
export type UserDevice = z.infer<typeof UserDeviceSchema>;

export const AgentConversationSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  title: z.string().min(1),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'SYNTHESIZED']).default('ACTIVE'),
  created_at: z.number().int(),
});
export type AgentConversation = z.infer<typeof AgentConversationSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  tool_calls: z.string().nullable().optional(), // JSON-serialized Array<ToolCallRecord>
  created_at: z.number().int(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const AudioToneEnum = z.enum(['cash_register', 'siren', 'chime']);
export type AudioTone = z.infer<typeof AudioToneEnum>;

export const RuleCombinatorEnum = z.enum(['AND', 'OR', 'SINGLE']);
export type RuleCombinator = z.infer<typeof RuleCombinatorEnum>;

export const TriggerModeEnum = z.enum(['ONE_SHOT', 'PERSISTENT']);
export type TriggerMode = z.infer<typeof TriggerModeEnum>;

export const RuleStatusEnum = z.enum(['ACTIVE', 'TRIGGERED', 'DISMISSED', 'PAUSED', 'ARCHIVED']);
export type RuleStatus = z.infer<typeof RuleStatusEnum>;

export const RuleSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  conversation_id: z.string().uuid().nullable().optional(),
  natural_language_intent: z.string().min(1),
  combinator: RuleCombinatorEnum,
  trigger_mode: TriggerModeEnum,
  cooldown_minutes: z.number().int().nonnegative().default(60),
  audio_tone: AudioToneEnum,
  status: RuleStatusEnum.default('ACTIVE'),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const SentryTypeEnum = z.enum([
  'FINANCIAL_TECHNICAL',
  'ECOMMERCE_INVENTORY',
  'WEB_OBSERVER',
  'STREAM_INTELLIGENCE',
]);
export type SentryType = z.infer<typeof SentryTypeEnum>;

export const SentryOperatorEnum = z.enum([
  'GREATER_THAN',
  'LESS_THAN',
  'CROSSES_ABOVE',
  'CROSSES_BELOW',
  'EQUALS',
  'KEYWORD_MATCH',
  'STATE_FLIP',
  'HASH_DELTA',
]);
export type SentryOperator = z.infer<typeof SentryOperatorEnum>;

export const SentryHealthStatusEnum = z.enum(['HEALTHY', 'DEGRADED', 'ERROR']);
export type SentryHealthStatus = z.infer<typeof SentryHealthStatusEnum>;

export const SubSentrySchema = z.object({
  id: z.string().uuid(),
  rule_id: z.string().uuid(),
  sentry_type: SentryTypeEnum,
  target_source: z.string().min(1),
  operator: SentryOperatorEnum,
  threshold: z.string(), // JSON string conforming to SubSentryThresholdSchema
  ttl_seconds: z.number().int().positive().default(300),
  last_evaluated_at: z.number().int().nullable().optional(),
  last_triggered_at: z.number().int().nullable().optional(),
  is_satisfied: z.number().int().min(0).max(1).default(0),
  satisfied_at: z.number().int().nullable().optional(),
  state_payload: z.string().nullable().optional(), // JSON string conforming to SubSentryStatePayloadSchema
  health_status: SentryHealthStatusEnum.default('HEALTHY'),
  error_count: z.number().int().nonnegative().default(0),
  last_error: z.string().nullable().optional(),
});
export type SubSentry = z.infer<typeof SubSentrySchema>;

export const SeenEventSchema = z.object({
  id: z.string(), // SHA-256 hash of (source + event_id)
  sentry_id: z.string().uuid(),
  source: z.string(),
  event_hash: z.string(),
  seen_at: z.number().int(),
});
export type SeenEvent = z.infer<typeof SeenEventSchema>;

export const TelemetryPointSchema = z.object({
  id: z.string().uuid(),
  rule_id: z.string().uuid(),
  sentry_id: z.string().uuid().nullable().optional(),
  metric_name: z.string(),
  value: z.number(),
  timestamp: z.number().int(),
  metadata: z.string().nullable().optional(),
});
export type TelemetryPoint = z.infer<typeof TelemetryPointSchema>;

export const AlertEventSchema = z.object({
  id: z.string().uuid(),
  rule_id: z.string().uuid(),
  user_id: z.string().uuid(),
  title: z.string(),
  summary: z.string(),
  audio_tone: AudioToneEnum,
  snapshot_data: z.string().nullable().optional(),
  created_at: z.number().int(),
});
export type AlertEvent = z.infer<typeof AlertEventSchema>;

export const InterruptStatusEnum = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']);
export type InterruptStatus = z.infer<typeof InterruptStatusEnum>;

export const InterruptActionSchema = z.object({
  id: z.string().uuid(),
  alert_id: z.string().uuid().nullable().optional(),
  rule_id: z.string().uuid(),
  user_id: z.string().uuid(),
  action_type: z.string(),
  action_payload: z.string(), // JSON string conforming to InterruptActionPayloadSchema
  status: InterruptStatusEnum.default('PENDING'),
  expires_at: z.number().int().nullable().optional(),
  created_at: z.number().int(),
  resolved_at: z.number().int().nullable().optional(),
});
export type InterruptAction = z.infer<typeof InterruptActionSchema>;

// ==========================================================
// 3. Realtime WebSocket Event Payloads
// ==========================================================

export const WsEventTypeEnum = z.enum([
  'TELEMETRY_UPDATE',
  'SENTRY_EVALUATED',
  'ALERT_TRIGGERED',
  'INTERRUPT_REQUEST',
  'INTERRUPT_RESOLVED',
  'AGENT_CHAT_CHUNK',
  'AGENT_CHAT_DONE',
]);
export type WsEventType = z.infer<typeof WsEventTypeEnum>;

export const TelemetryUpdateEventSchema = z.object({
  type: z.literal('TELEMETRY_UPDATE'),
  payload: TelemetryPointSchema,
});
export type TelemetryUpdateEvent = z.infer<typeof TelemetryUpdateEventSchema>;

export const SentryEvaluatedEventSchema = z.object({
  type: z.literal('SENTRY_EVALUATED'),
  payload: z.object({
    sentryId: z.string().uuid(),
    ruleId: z.string().uuid(),
    isSatisfied: z.boolean(),
    currentValue: z.union([z.string(), z.number(), z.boolean()]),
    timestamp: z.number().int(),
  }),
});
export type SentryEvaluatedEvent = z.infer<typeof SentryEvaluatedEventSchema>;

export const AlertTriggeredEventSchema = z.object({
  type: z.literal('ALERT_TRIGGERED'),
  payload: AlertEventSchema,
});
export type AlertTriggeredEvent = z.infer<typeof AlertTriggeredEventSchema>;

export const InterruptRequestEventSchema = z.object({
  type: z.literal('INTERRUPT_REQUEST'),
  payload: InterruptActionSchema,
});
export type InterruptRequestEvent = z.infer<typeof InterruptRequestEventSchema>;

// ==========================================================
// 4. Schema Registry & JSON Schema Helper
// ==========================================================

export const ALL_SCHEMAS = {
  User: UserSchema,
  UserDevice: UserDeviceSchema,
  AgentConversation: AgentConversationSchema,
  ChatMessage: ChatMessageSchema,
  Rule: RuleSchema,
  SubSentry: SubSentrySchema,
  SeenEvent: SeenEventSchema,
  TelemetryPoint: TelemetryPointSchema,
  AlertEvent: AlertEventSchema,
  InterruptAction: InterruptActionSchema,
  FinancialThreshold: FinancialThresholdSchema,
  EcommerceThreshold: EcommerceThresholdSchema,
  WebObserverThreshold: WebObserverThresholdSchema,
  StreamIntelligenceThreshold: StreamIntelligenceThresholdSchema,
  InterruptActionPayload: InterruptActionPayloadSchema,
} as const;

export function getJsonSchema(name: keyof typeof ALL_SCHEMAS) {
  const schema = ALL_SCHEMAS[name];
  return z.toJSONSchema(schema);
}
