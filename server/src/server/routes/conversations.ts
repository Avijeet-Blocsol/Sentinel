/**
 * Strands Sentinel - Agent Conversation Routes
 * Endpoints for managing conversational Sentinel setup sessions
 */

import { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  conversationRepository,
  chatMessageRepository,
  type AgentConversation,
} from '../../db/index.js';
import { requireConversationOwnership } from '../../middlewares/index.js';

const ListConversationsQuerySchema = z.object({
  q: z.string().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'SYNTHESIZED']).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const CreateConversationBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

const UpdateConversationStatusSchema = z.object({
  // SYNTHESIZED is owned exclusively by the deployment transaction.
  status: z.enum(['ACTIVE', 'ARCHIVED']),
});

export const conversationRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/conversations
   * Lists or searches agent conversations for the authenticated user.
   * Query params:
   *   ?q=...      - search keyword across conversation titles and chat message bodies
   *   ?status=... - filter by ACTIVE | ARCHIVED | SYNTHESIZED
   *   ?limit=...  - pagination limit (default 50)
   */
  fastify.get('/', async (req, reply) => {
    const parseResult = ListConversationsQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid conversation query parameters',
        issues: parseResult.error.issues,
      });
    }
    const query = parseResult.data;

    let conversations =
      query.q && query.q.trim().length > 0
        ? await conversationRepository.search(req.user.id, query.q, query.limit)
        : await conversationRepository.getByUserId(req.user.id, query.limit);

    if (query.status) {
      conversations = conversations.filter((c) => c.status === query.status);
    }

    return reply.status(200).send({
      conversations,
    });
  });

  /**
   * POST /api/conversations
   * Starts a new agent conversation session.
   */
  fastify.post('/', async (req, reply) => {
    const body = (req.body as Record<string, unknown>) || {};
    const parseResult = CreateConversationBodySchema.safeParse(body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid request body',
        issues: parseResult.error.issues,
      });
    }

    const title = parseResult.data.title || 'New Sentinel Task';

    const conversation: AgentConversation = {
      id: randomUUID(),
      user_id: req.user.id,
      title,
      status: 'ACTIVE',
      phase: 'DISCOVERY',
      created_at: Date.now(),
    };

    await conversationRepository.create(conversation);

    return reply.status(201).send({
      conversation,
    });
  });

  /**
   * GET /api/conversations/:id
   * Retrieves a specific conversation with all historical chat messages.
   */
  fastify.get(
    '/:id',
    { preHandler: requireConversationOwnership },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const conversation = await conversationRepository.getById(id);
      if (!conversation) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Conversation not found',
        });
      }

      const messages = await chatMessageRepository.getByConversationId(id, 500);

      return reply.status(200).send({
        conversation,
        messages,
      });
    }
  );

  /**
   * PATCH /api/conversations/:id/status
   * Updates conversation lifecycle status (ACTIVE, ARCHIVED, SYNTHESIZED).
   */
  fastify.patch(
    '/:id/status',
    { preHandler: requireConversationOwnership },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parseResult = UpdateConversationStatusSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid request body',
          issues: parseResult.error.issues,
        });
      }

      const { status } = parseResult.data;
      await conversationRepository.updateStatus(id, status);

      return reply.status(200).send({
        success: true,
        id,
        status,
      });
    }
  );
};
