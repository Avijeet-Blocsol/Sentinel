/**
 * Strands Sentinel - Engine API Schemas
 */

import { z } from 'zod';

export const EngineTickSchema = z.object({
  now: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).default(100),
});
export type EngineTickBody = z.infer<typeof EngineTickSchema>;

export const EvaluateRuleParamsSchema = z.object({
  ruleId: z.string().uuid(),
});
export type EvaluateRuleParams = z.infer<typeof EvaluateRuleParamsSchema>;

export const EvaluateRuleBodySchema = z.object({
  forceEvaluateChildren: z.boolean().default(true),
  eventId: z.string().min(1).optional(),
});
export type EvaluateRuleBody = z.infer<typeof EvaluateRuleBodySchema>;
