/**
 * Strands Sentinel - Rule Management Routes
 * Endpoints for viewing, pausing/resuming, and deleting Sentinel rules.
 * NOTE: Per architectural rules, NO manual POST creation endpoint is permitted.
 * Rules are synthesized exclusively by LLM agents.
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ruleRepository,
  subSentinelRepository,
  interruptActionRepository,
  RuleStatusEnum,
  RuleCategoryEnum,
} from '../../db/index.js';
import { requireRuleOwnership } from '../../middlewares/index.js';

const RuleQuerySchema = z.object({
  category: RuleCategoryEnum.optional(),
  status: RuleStatusEnum.optional(),
  limit: z.coerce.number().int().positive().max(100).default(100),
});

const UpdateRuleStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']),
});

export const ruleRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/rules
   * Lists all rules belonging to the authenticated user.
   * Includes sub-sentinels for mobile cards and supports filtering.
   */
  fastify.get('/', async (req, reply) => {
    const parseResult = RuleQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid rule query parameters',
        issues: parseResult.error.issues,
      });
    }
    const filters = parseResult.data;

    let rules = await ruleRepository.getByUserId(req.user.id, filters.limit);

    if (filters.category) {
      rules = rules.filter((r) => r.category === filters.category);
    }
    if (filters.status) {
      rules = rules.filter((r) => r.status === filters.status);
    }

    // Attach sub_sentinels for mobile dashboard rich rendering
    const rulesWithSubSentinels = await Promise.all(
      rules.map(async (rule) => {
        const subSentinels = await subSentinelRepository.getByRuleId(rule.id);
        return {
          ...rule,
          sub_sentinels: subSentinels,
        };
      })
    );

    return reply.status(200).send({
      rules: rulesWithSubSentinels,
    });
  });

  /**
   * GET /api/rules/:id
   * Retrieves a specific rule and its child sub-sentinels.
   */
  fastify.get(
    '/:id',
    { preHandler: requireRuleOwnership },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rule = await ruleRepository.getById(id);
      if (!rule) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Rule not found',
        });
      }

      const subSentinels = await subSentinelRepository.getByRuleId(id);

      return reply.status(200).send({
        rule: {
          ...rule,
          sub_sentinels: subSentinels,
        },
      });
    }
  );

  /**
   * PATCH /api/rules/:id/status
   * Pauses, resumes, or archives an active rule.
   */
  fastify.patch(
    '/:id/status',
    { preHandler: requireRuleOwnership },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parseResult = UpdateRuleStatusSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid request body',
          issues: parseResult.error.issues,
        });
      }

      const { status } = parseResult.data;
      const rule = await ruleRepository.getById(id);
      if (!rule) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Rule not found',
        });
      }

      const pending = await interruptActionRepository.getPendingByUserId(req.user.id);
      if (pending.some((action) => action.rule_id === id)) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'A staged rule can only be activated by resolving its confirmation interrupt',
        });
      }

      const allowedTransitions: Record<string, ReadonlySet<string>> = {
        ACTIVE: new Set(['ACTIVE', 'PAUSED', 'ARCHIVED']),
        PAUSED: new Set(['PAUSED', 'ACTIVE', 'ARCHIVED']),
        TRIGGERED: new Set(['TRIGGERED', 'ARCHIVED']),
        ARCHIVED: new Set(['ARCHIVED', 'ACTIVE']),
        DISMISSED: new Set(['DISMISSED']),
      };
      if (!allowedTransitions[rule.status]?.has(status)) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Rule cannot transition from ${rule.status} to ${status}`,
        });
      }
      await ruleRepository.updateStatus(id, status);

      return reply.status(200).send({
        success: true,
        id,
        status,
      });
    }
  );

  /**
   * DELETE /api/rules/:id
   * Deletes a rule and cascades deletion to child sub-sentinels and alerts.
   */
  fastify.delete(
    '/:id',
    { preHandler: requireRuleOwnership },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await ruleRepository.delete(id);

      return reply.status(200).send({
        success: true,
        id,
      });
    }
  );
};
