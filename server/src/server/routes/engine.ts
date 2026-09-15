/**
 * Strands Sentinel - Engine Evaluation & Scheduling Routes
 * Authenticated operational endpoints for manual/admin evaluation. Production
 * cadence is EventBridge Scheduler -> SQS -> SentinelSqsWorker, not HTTP.
 */

import { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { globalEvaluatorEngine } from '../../services/evaluators/engine.js';
import { ruleRepository } from '../../db/index.js';
import { runSentinelExecution } from '../../execution/runner.js';

const EngineTickSchema = z.object({
  now: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).default(100),
});

const EvaluateRuleParamsSchema = z.object({
  ruleId: z.string().uuid(),
});

const EvaluateRuleBodySchema = z.object({
  forceEvaluateChildren: z.boolean().default(true),
  eventId: z.string().min(1).optional(),
});

export const engineRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/engine/tick
   * Executes a manually requested scheduler pulse for diagnostics or an
   * authenticated control plane; the queue worker owns scheduled delivery.
   */
  fastify.post('/tick', async (req, reply) => {
    const parseResult = EngineTickSchema.safeParse(req.body || {});
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.message,
      });
    }

    const { now, limit } = parseResult.data;
    const targetTimestamp = now || Date.now();
    const suppliedEventId = (req.headers['idempotency-key'] as string | undefined)?.trim();
    const event = await runSentinelExecution({
      eventId: suppliedEventId || `http-tick-${randomUUID()}`,
      eventType: 'TICK',
      now: targetTimestamp,
      requestedAt: Date.now(),
      source: 'engine-http',
    }, `http-${req.user.id}-${randomUUID()}`, globalEvaluatorEngine, limit);

    return reply.status(200).send({
      success: event.status !== 'FAILED',
      timestamp: targetTimestamp,
      evaluatedSubSentinels: event.evaluatedSubSentinels || 0,
      triggeredRules: event.triggeredRules || 0,
      status: event.status,
      message: `Engine scheduler sweep completed: ${event.evaluatedSubSentinels || 0} sub-sentinels evaluated, ${event.triggeredRules || 0} rules triggered.`,
    });
  });

  /**
   * POST /api/engine/evaluate-rule/:ruleId
   * Evaluates a single specific rule on demand (e.g. triggered by an SQS event for a specific market update).
   */
  fastify.post('/evaluate-rule/:ruleId', async (req, reply) => {
    const paramsResult = EvaluateRuleParamsSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid ruleId parameter',
      });
    }

    const { ruleId } = paramsResult.data;
    const rule = await ruleRepository.getById(ruleId);
    if (!rule) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Rule not found: ${ruleId}`,
      });
    }

    const bodyResult = EvaluateRuleBodySchema.safeParse(req.body || {});
    if (!bodyResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: bodyResult.error.message,
      });
    }

    const forceEvaluateChildren = bodyResult.data.forceEvaluateChildren;
    const eventId = bodyResult.data.eventId
      ? bodyResult.data.eventId
      : `http-rule-${randomUUID()}`;

    const evalResult = await runSentinelExecution({
      eventId,
      eventType: 'EVALUATE_RULE',
      ruleId: rule.id,
      requestedAt: Date.now(),
      source: 'engine-http',
    }, `http-${req.user.id}-${randomUUID()}`, globalEvaluatorEngine, 100, forceEvaluateChildren);

    return reply.status(200).send({
      success: evalResult.status !== 'FAILED',
      ruleId: rule.id,
      status: evalResult.status,
      isTriggered: evalResult.isTriggered || false,
    });
  });
};
