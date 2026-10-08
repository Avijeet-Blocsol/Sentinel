/**
 * Strands Sentinel - Conversations Service
 * Encapsulates agent conversation queries, searches, creation, and status transitions.
 */

import { randomUUID } from 'node:crypto';
import {
  conversationRepository,
  chatMessageRepository,
  type AgentConversation,
  type ChatMessage,
} from '../../db/index.js';
import type { ListConversationsQuery } from './conversations.schema.js';

export class ConversationsService {
  async listConversations(userId: string, query: ListConversationsQuery): Promise<AgentConversation[]> {
    let conversations =
      query.q && query.q.trim().length > 0
        ? await conversationRepository.search(userId, query.q, query.limit)
        : await conversationRepository.getByUserId(userId, query.limit);

    if (query.status) {
      conversations = conversations.filter((c) => c.status === query.status);
    }

    return conversations;
  }

  async createConversation(userId: string, title?: string): Promise<AgentConversation> {
    const conversation: AgentConversation = {
      id: randomUUID(),
      user_id: userId,
      title: title || 'New Sentinel Task',
      status: 'ACTIVE',
      phase: 'DISCOVERY',
      created_at: Date.now(),
    };

    await conversationRepository.create(conversation);
    return conversation;
  }

  async getConversationWithMessages(
    conversationId: string
  ): Promise<{ conversation: AgentConversation | null; messages: ChatMessage[] }> {
    const conversation = await conversationRepository.getById(conversationId);
    if (!conversation) {
      return { conversation: null, messages: [] };
    }

    const messages = await chatMessageRepository.getByConversationId(conversationId, 500);
    return { conversation, messages };
  }

  async updateConversationStatus(
    conversationId: string,
    status: 'ACTIVE' | 'ARCHIVED'
  ): Promise<void> {
    await conversationRepository.updateStatus(conversationId, status);
  }
}

export const conversationsService = new ConversationsService();
