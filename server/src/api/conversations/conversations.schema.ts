/**
 * Strands Sentinel - Conversations API Schemas
 */

import { z } from 'zod';

export const ListConversationsQuerySchema = z.object({
  q: z.string().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'SYNTHESIZED']).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type ListConversationsQuery = z.infer<typeof ListConversationsQuerySchema>;

export const CreateConversationBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
});
export type CreateConversationBody = z.infer<typeof CreateConversationBodySchema>;

export const UpdateConversationStatusSchema = z.object({
  // SYNTHESIZED is owned exclusively by the deployment transaction.
  status: z.enum(['ACTIVE', 'ARCHIVED']),
});
export type UpdateConversationStatusBody = z.infer<typeof UpdateConversationStatusSchema>;
