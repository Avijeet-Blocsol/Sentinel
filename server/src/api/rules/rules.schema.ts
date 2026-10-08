/**
 * Strands Sentinel - Rules API Schemas
 */

import { z } from 'zod';
import { RuleStatusEnum, RuleCategoryEnum } from '../../db/index.js';

export const RuleQuerySchema = z.object({
  category: RuleCategoryEnum.optional(),
  status: RuleStatusEnum.optional(),
  limit: z.coerce.number().int().positive().max(100).default(100),
});
export type RuleQuery = z.infer<typeof RuleQuerySchema>;

export const UpdateRuleStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']),
});
export type UpdateRuleStatusBody = z.infer<typeof UpdateRuleStatusSchema>;
