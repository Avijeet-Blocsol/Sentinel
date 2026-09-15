import { z } from 'zod';

export const SentinelExecutionEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(['TICK', 'EVALUATE_RULE']),
  ruleId: z.string().uuid().optional(),
  now: z.number().int().positive().optional(),
  requestedAt: z.number().int().positive(),
  source: z.string().min(1),
});
export type SentinelExecutionEvent = z.infer<typeof SentinelExecutionEventSchema>;

export const SentinelExecutionResultSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(['TICK', 'EVALUATE_RULE']),
  status: z.enum(['SUCCEEDED', 'FAILED', 'DUPLICATE']),
  evaluatedSubSentinels: z.number().int().nonnegative().optional(),
  triggeredRules: z.number().int().nonnegative().optional(),
  isTriggered: z.boolean().optional(),
  error: z.string().optional(),
});
export type SentinelExecutionResult = z.infer<typeof SentinelExecutionResultSchema>;
