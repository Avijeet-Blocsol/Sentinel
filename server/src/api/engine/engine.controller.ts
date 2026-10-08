/**
 * Strands Sentinel - Engine Controller
 * Handles HTTP requests for operational engine scheduler ticks and rule evaluation.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import {
  EngineTickSchema,
  EvaluateRuleParamsSchema,
  EvaluateRuleBodySchema,
} from './engine.schema.js';
import { engineService, EngineRuleNotFoundError } from './engine.service.js';
import { sendBadRequest, sendNotFound, sendForbidden } from '../common/errors.js';

export async function requireEngineIdentity(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (req.user.id !== 'system_engine_worker') {
    return sendForbidden(reply, 'This endpoint requires engine service authentication') as unknown as void;
  }
}

export class EngineController {
  async tick(req: FastifyRequest, reply: FastifyReply) {
    const parseResult = EngineTickSchema.safeParse(req.body || {});
    if (!parseResult.success) {
      return sendBadRequest(reply, parseResult.error.message);
    }

    const suppliedEventId = (req.headers['idempotency-key'] as string | undefined)?.trim();
    const result = await engineService.executeTick(
      req.user.id,
      parseResult.data,
      suppliedEventId
    );

    return reply.status(200).send(result);
  }

  async evaluateRule(req: FastifyRequest, reply: FastifyReply) {
    const paramsResult = EvaluateRuleParamsSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return sendBadRequest(reply, 'Invalid ruleId parameter');
    }

    const bodyResult = EvaluateRuleBodySchema.safeParse(req.body || {});
    if (!bodyResult.success) {
      return sendBadRequest(reply, bodyResult.error.message);
    }

    try {
      const result = await engineService.evaluateRule(
        req.user.id,
        paramsResult.data.ruleId,
        bodyResult.data
      );
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof EngineRuleNotFoundError) {
        return sendNotFound(reply, err.message);
      }
      throw err;
    }
  }
}

export const engineController = new EngineController();
