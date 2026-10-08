/**
 * Strands Sentinel - Engine Evaluation & Scheduling Routes
 * Authenticated operational endpoints for manual/admin evaluation.
 */

import { FastifyPluginAsync } from 'fastify';
import { engineController, requireEngineIdentity } from './engine.controller.js';

export const engineRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/engine/tick
   * Executes a manually requested scheduler pulse for diagnostics or control plane.
   */
  fastify.post(
    '/tick',
    { preHandler: requireEngineIdentity },
    engineController.tick.bind(engineController)
  );

  /**
   * POST /api/engine/evaluate-rule/:ruleId
   * Evaluates a single specific rule on demand.
   */
  fastify.post(
    '/evaluate-rule/:ruleId',
    { preHandler: requireEngineIdentity },
    engineController.evaluateRule.bind(engineController)
  );
};
