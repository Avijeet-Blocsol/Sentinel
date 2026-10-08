/**
 * Strands Sentinel - Rules Controller
 * Handles HTTP requests for viewing, status updating, and deleting rules.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { RuleQuerySchema, UpdateRuleStatusSchema } from './rules.schema.js';
import { rulesService, RuleConflictError, RuleNotFoundError } from './rules.service.js';
import { sendBadRequest, sendNotFound } from '../common/errors.js';
import type { RuleStatus } from '../../db/index.js';

export class RulesController {
  async list(req: FastifyRequest, reply: FastifyReply) {
    const parseResult = RuleQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return sendBadRequest(reply, 'Invalid rule query parameters', parseResult.error.issues);
    }

    const rules = await rulesService.listRules(req.user.id, parseResult.data);
    return reply.status(200).send({
      rules,
    });
  }

  async getById(req: FastifyRequest, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const rule = await rulesService.getRuleWithSubSentinels(id);

    if (!rule) {
      return sendNotFound(reply, 'Rule not found');
    }

    return reply.status(200).send({
      rule,
    });
  }

  async updateStatus(req: FastifyRequest, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const parseResult = UpdateRuleStatusSchema.safeParse(req.body);
    if (!parseResult.success) {
      return sendBadRequest(reply, 'Invalid request body', parseResult.error.issues);
    }

    try {
      const result = await rulesService.updateRuleStatus(
        req.user.id,
        id,
        parseResult.data.status as RuleStatus
      );
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof RuleNotFoundError) {
        return sendNotFound(reply, err.message);
      }
      if (err instanceof RuleConflictError) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: err.message,
        });
      }
      throw err;
    }
  }

  async delete(req: FastifyRequest, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    try {
      await rulesService.deleteRule(req.user.id, id);
    } catch (err) {
      if (err instanceof RuleNotFoundError) {
        return sendNotFound(reply, err.message);
      }
      throw err;
    }
    return reply.status(200).send({
      success: true,
      id,
    });
  }
}

export const rulesController = new RulesController();
