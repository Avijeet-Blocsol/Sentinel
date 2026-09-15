/**
 * Strands Sentinel - Interrupt Routes
 * Endpoints for fetching pending human-in-the-loop decisions for the dashboard.
 * Tapping an interrupt navigates the user directly to its parent conversation,
 * where the interactive card is resolved over the conversation WebSocket.
 */

import { FastifyPluginAsync } from 'fastify';
import { interruptActionRepository } from '../../db/index.js';
import { requireInterruptOwnership } from '../../middlewares/index.js';

export const interruptRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/interrupts/pending
   * Lists all pending interrupts for the authenticated user, joined with conversation_id.
   */
  fastify.get('/pending', async (req, reply) => {
    await interruptActionRepository.expirePending(Date.now());
    const interrupts = await interruptActionRepository.getPendingByUserId(req.user.id);
    return reply.status(200).send({
      interrupts,
    });
  });

  /**
   * GET /api/interrupts/:id
   * Retrieves single interrupt action with conversation_id and rule metadata.
   */
  fastify.get(
    '/:id',
    { preHandler: requireInterruptOwnership },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const interrupt = await interruptActionRepository.getById(id);
      if (!interrupt) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Interrupt action not found',
        });
      }

      return reply.status(200).send({
        interrupt,
      });
    }
  );
};
