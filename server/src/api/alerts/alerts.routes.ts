/**
 * Strands Sentinel - Alert Notification Routes
 * Endpoints for fetching triggered alert events for dashboard feeds and timelines.
 */

import { FastifyPluginAsync } from 'fastify';
import { alertsController } from './alerts.controller.js';

export const alertRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/alerts
   * Lists historical alert notifications for the authenticated user.
   */
  fastify.get('/', alertsController.list.bind(alertsController));

  /**
   * GET /api/alerts/:id
   * Retrieves single alert event with conversation_id.
   */
  fastify.get('/:id', alertsController.getById.bind(alertsController));
};
