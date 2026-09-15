/**
 * Strands Sentinel - Alert Notification Routes
 * Endpoints for fetching triggered alert events for dashboard feeds and timelines.
 * Every alert joins conversation_id for seamless deep navigation into the chat session.
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { alertEventRepository } from '../../db/index.js';

const AlertQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  rule_id: z.string().optional(),
});

export const alertRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/alerts
   * Lists historical alert notifications for the authenticated user.
   * Query params:
   *   ?limit=...   - number of items (default 50)
   *   ?rule_id=... - filter alerts triggered by a specific rule
   */
  fastify.get('/', async (req, reply) => {
    const parseResult = AlertQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid alert query parameters',
        issues: parseResult.error.issues,
      });
    }
    const query = parseResult.data;

    const alerts = await alertEventRepository.getByUserId(
      req.user.id,
      query.limit,
      query.rule_id
    );

    return reply.status(200).send({
      alerts,
    });
  });

  /**
   * GET /api/alerts/:id
   * Retrieves single alert event with conversation_id.
   */
  fastify.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const alert = await alertEventRepository.getById(id);

    if (!alert) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Alert event not found',
      });
    }

    if (alert.user_id !== req.user.id) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'You do not have permission to access this alert',
      });
    }

    return reply.status(200).send({
      alert,
    });
  });
};
