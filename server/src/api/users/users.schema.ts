/**
 * Strands Sentinel - Users API Schemas
 */

import { z } from 'zod';

export const RegisterDeviceBodySchema = z.object({
  push_token: z.string().trim().min(1, 'push_token is required').max(4096),
  platform: z.enum(['ios', 'android', 'web']),
});

export type RegisterDeviceBody = z.infer<typeof RegisterDeviceBodySchema>;
