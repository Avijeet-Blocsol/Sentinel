/**
 * Strands Sentinel - Realtime WebSocket Agentic Flow Routes
 * Handles bi-directional streaming, probe telemetry, interrupt resolution,
 * interrupt blockade enforcement, pre-flight verification, and reconnection rehydration.
 */

import { FastifyPluginAsync } from 'fastify';
import { requireConversationOwnership } from '../../middlewares/index.js';
import { wsController } from './ws.controller.js';

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /ws/conversation/:id
   * WebSocket connection for real-time conversation and agentic monitoring.
   */
  fastify.get(
    '/:id',
    { websocket: true, preHandler: requireConversationOwnership },
    wsController.handleConnection.bind(wsController)
  );
};
