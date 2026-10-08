/**
 * Strands Sentinel - Conversations Controller
 * Handles HTTP requests for conversation management.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import {
  ListConversationsQuerySchema,
  CreateConversationBodySchema,
  UpdateConversationStatusSchema,
} from './conversations.schema.js';
import { conversationsService } from './conversations.service.js';
import { sendBadRequest, sendNotFound } from '../common/errors.js';

export class ConversationsController {
  async list(req: FastifyRequest, reply: FastifyReply) {
    const parseResult = ListConversationsQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return sendBadRequest(reply, 'Invalid conversation query parameters', parseResult.error.issues);
    }

    const conversations = await conversationsService.listConversations(req.user.id, parseResult.data);
    return reply.status(200).send({
      conversations,
    });
  }

  async create(req: FastifyRequest, reply: FastifyReply) {
    const body = (req.body as Record<string, unknown>) || {};
    const parseResult = CreateConversationBodySchema.safeParse(body);
    if (!parseResult.success) {
      return sendBadRequest(reply, 'Invalid request body', parseResult.error.issues);
    }

    const conversation = await conversationsService.createConversation(req.user.id, parseResult.data.title);
    return reply.status(201).send({
      conversation,
    });
  }

  async getById(req: FastifyRequest, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const { conversation, messages } = await conversationsService.getConversationWithMessages(id);

    if (!conversation) {
      return sendNotFound(reply, 'Conversation not found');
    }

    return reply.status(200).send({
      conversation,
      messages,
    });
  }

  async updateStatus(req: FastifyRequest, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const parseResult = UpdateConversationStatusSchema.safeParse(req.body);
    if (!parseResult.success) {
      return sendBadRequest(reply, 'Invalid request body', parseResult.error.issues);
    }

    const { status } = parseResult.data;
    await conversationsService.updateConversationStatus(id, status);

    return reply.status(200).send({
      success: true,
      id,
      status,
    });
  }
}

export const conversationsController = new ConversationsController();
