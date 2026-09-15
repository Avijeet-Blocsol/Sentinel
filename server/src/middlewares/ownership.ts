/**
 * Strands Sentinel - Ownership & IDOR Protection Middleware
 * Ensures users can only access their own conversations, rules, and interrupts
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { conversationRepository, ruleRepository, interruptActionRepository } from '../db/index.js';

/**
 * Validates that the conversation requested in req.params belongs to req.user
 */
export async function requireConversationOwnership(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const params = req.params as { conversationId?: string; id?: string };
  const conversationId = params.conversationId || params.id;

  if (!conversationId) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'conversationId is required',
    });
  }

  const conversation = await conversationRepository.getById(conversationId);
  if (!conversation) {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Conversation not found',
    });
  }

  if (conversation.user_id !== req.user.id) {
    return reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: 'You do not have permission to access this conversation',
    });
  }
}

/**
 * Validates that the rule requested in req.params belongs to req.user
 */
export async function requireRuleOwnership(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const params = req.params as { ruleId?: string; id?: string };
  const ruleId = params.ruleId || params.id;

  if (!ruleId) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'ruleId is required',
    });
  }

  const rule = await ruleRepository.getById(ruleId);
  if (!rule) {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Rule not found',
    });
  }

  if (rule.user_id !== req.user.id) {
    return reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: 'You do not have permission to access this rule',
    });
  }
}

/**
 * Validates that the interrupt action requested belongs to req.user
 */
export async function requireInterruptOwnership(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const params = req.params as { interruptId?: string; id?: string };
  const interruptId = params.interruptId || params.id;

  if (!interruptId) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'interruptId is required',
    });
  }

  const action = await interruptActionRepository.getById(interruptId);
  if (!action) {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Interrupt action not found',
    });
  }

  if (action.user_id !== req.user.id) {
    return reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: 'You do not have permission to resolve this interrupt',
    });
  }
}
