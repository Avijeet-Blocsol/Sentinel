/**
 * Strands Sentinel - Interrupts Service
 * Encapsulates human-in-the-loop pending interrupts and expiration logic.
 */

import {
  conversationRepository,
  interruptActionRepository,
  type EnrichedInterruptAction,
} from '../../db/index.js';

export class InterruptsService {
  async getPendingInterrupts(userId: string): Promise<EnrichedInterruptAction[]> {
    await interruptActionRepository.expirePending(Date.now());
    const pending = await interruptActionRepository.getPendingByUserId(userId);
    const pendingConversationIds = new Set(
      pending.map((interrupt) => interrupt.conversation_id).filter(Boolean),
    );
    const conversations = await conversationRepository.getByUserId(userId);
    const needsWorkflowCard = conversations.some(
      (conversation) =>
        (conversation.phase === 'AWAITING_QUERY_CONFIRMATION' ||
          conversation.phase === 'AWAITING_TRIGGER_MODE') &&
        !pendingConversationIds.has(conversation.id),
    );

    if (!needsWorkflowCard) return pending;

    // A process crash can occur after the staged workflow transaction but
    // before the choice card is persisted. Reuse the same idempotent recovery
    // path used by WebSocket reconnects so dashboard HTTP hydration cannot
    // hide the final confirmation/mode interrupt.
    const { ensureWorkflowChoiceInterrupt } = await import('../realtime/ws_stream_handler.js');
    for (const conversation of conversations) {
      if (
        (conversation.phase !== 'AWAITING_QUERY_CONFIRMATION' &&
          conversation.phase !== 'AWAITING_TRIGGER_MODE') ||
        pendingConversationIds.has(conversation.id)
      ) {
        continue;
      }
      const recovered = await ensureWorkflowChoiceInterrupt(conversation.id, userId);
      if (recovered) {
        pending.push(recovered);
        pendingConversationIds.add(conversation.id);
      }
    }
    return pending.sort((left, right) => left.created_at - right.created_at);
  }

  async getInterruptById(id: string): Promise<EnrichedInterruptAction | null> {
    return interruptActionRepository.getById(id);
  }
}

export const interruptsService = new InterruptsService();
