/**
 * Strands Sentinel - Interrupt Routes
 * Endpoints for fetching pending human-in-the-loop decisions for the dashboard.
 */

import { FastifyPluginAsync } from 'fastify';
import { requireInterruptOwnership } from '../../middlewares/index.js';
import { interruptsController } from './interrupts.controller.js';

export const interruptRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/interrupts/pending
   * Lists all pending interrupts for the authenticated user, joined with conversation_id.
   */
  fastify.get('/pending', interruptsController.getPending.bind(interruptsController));

  /**
   * GET /api/interrupts/:id
   * Retrieves single interrupt action with conversation_id and rule metadata.
   */
  fastify.get(
    '/:id',
    { preHandler: requireInterruptOwnership },
    interruptsController.getById.bind(interruptsController)
  );
};
