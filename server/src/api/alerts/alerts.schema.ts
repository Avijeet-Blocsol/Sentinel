/**
 * Strands Sentinel - Alerts API Schemas
 */

import { z } from 'zod';

export const AlertQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  rule_id: z.string().optional(),
});
export type AlertQuery = z.infer<typeof AlertQuerySchema>;
