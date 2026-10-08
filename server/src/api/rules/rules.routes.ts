/**
 * Strands Sentinel - Rule Management Routes
 * Endpoints for viewing, pausing/resuming, and deleting Sentinel rules.
 * NOTE: Per architectural rules, NO manual POST creation endpoint is permitted.
 * Rules are synthesized exclusively by LLM agents.
 */

import { FastifyPluginAsync } from 'fastify';
import { requireRuleOwnership } from '../../middlewares/index.js';
import { rulesController } from './rules.controller.js';

export const ruleRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/rules
   * Lists all rules belonging to the authenticated user.
   */
  fastify.get('/', rulesController.list.bind(rulesController));

  /**
   * GET /api/rules/:id
   * Retrieves a specific rule and its child sub-sentinels.
   */
  fastify.get(
    '/:id',
    { preHandler: requireRuleOwnership },
    rulesController.getById.bind(rulesController)
  );

  /**
   * PATCH /api/rules/:id/status
   * Pauses, resumes, or archives an active rule.
   */
  fastify.patch(
    '/:id/status',
    { preHandler: requireRuleOwnership },
    rulesController.updateStatus.bind(rulesController)
  );

  /**
   * DELETE /api/rules/:id
   * Deletes a rule and cascades deletion to child sub-sentinels and alerts.
   */
  fastify.delete(
    '/:id',
    { preHandler: requireRuleOwnership },
    rulesController.delete.bind(rulesController)
  );
};
