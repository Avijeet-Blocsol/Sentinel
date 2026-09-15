/**
 * Strands Sentinel - Rate Limiting Middleware
 * Protects compute and LLM token budgets against abuse
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit, { RateLimitPluginOptions } from '@fastify/rate-limit';

/**
 * Registers global rate limiting across all incoming requests.
 * Uses authenticated user ID when available, falling back to IP address.
 */
export async function registerRateLimiting(fastify: FastifyInstance): Promise<void> {
  const options: RateLimitPluginOptions = {
    global: true,
    max: 120, // 120 requests per minute general ceiling
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => {
      // Prioritize authenticated user ID over IP
      return req.user?.id || req.ip;
    },
    errorResponseBuilder: (req, context) => {
      return {
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Please try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      };
    },
  };

  await fastify.register(rateLimit, options);
}

/**
 * Stricter rate-limit preset for expensive LLM agent invocations
 */
export const agentInvocationRateLimit = {
  config: {
    rateLimit: {
      max: 20, // max 20 agent invocations per minute
      timeWindow: '1 minute',
    },
  },
};
