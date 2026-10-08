/**
 * Strands Sentinel - WebSocket Ticket Routes
 * Route for generating single-use authenticated WebSocket upgrade tickets.
 */

import { FastifyPluginAsync } from 'fastify';
import { wsTicketController } from './ws_ticket.controller.js';

export const wsTicketRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/ws/ticket
   * Issues a short-lived signed ticket for authenticating a WebSocket upgrade.
   */
  fastify.post('/ticket', wsTicketController.issue.bind(wsTicketController));
};
