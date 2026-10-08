/**
 * Strands Sentinel - Agent Conversation Routes
 * Endpoints for managing conversational Sentinel setup sessions.
 */

import { FastifyPluginAsync } from 'fastify';
import { requireConversationOwnership } from '../../middlewares/index.js';
import { conversationsController } from './conversations.controller.js';

export const conversationRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/conversations
   * Lists or searches agent conversations for the authenticated user.
   */
  fastify.get('/', conversationsController.list.bind(conversationsController));

  /**
   * POST /api/conversations
   * Starts a new agent conversation session.
   */
  fastify.post('/', conversationsController.create.bind(conversationsController));

  /**
   * GET /api/conversations/:id
   * Retrieves a specific conversation with historical chat messages.
   */
  fastify.get(
    '/:id',
    { preHandler: requireConversationOwnership },
    conversationsController.getById.bind(conversationsController)
  );

  /**
   * PATCH /api/conversations/:id/status
   * Updates conversation lifecycle status (ACTIVE, ARCHIVED).
   */
  fastify.patch(
    '/:id/status',
    { preHandler: requireConversationOwnership },
    conversationsController.updateStatus.bind(conversationsController)
  );
};
