/**
 * Strands Sentinel - WebSocket Controller
 * Manages WebSocket connection lifecycle, authentication rehydration, heartbeats, and message routing.
 */

import { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { WsClientMessageSchema } from '@sentinel/shared';
import { chatMessageRepository, interruptActionRepository } from '../../db/index.js';
import { setupHeartbeat, type WebSocketWithAlive } from '../../middlewares/websocket-guard.js';
import {
  registerSocket,
  unregisterSocket,
  sendInterruptRequest,
} from './ws_connection_registry.js';
import { reconcileExpiredInterrupts } from './ws_event_poller.js';
import {
  handleChatMessage,
  handleResolveInterrupt,
  clearAgentCache,
  ensureWorkflowChoiceInterrupt,
  resumeApprovedQueryConfirmation,
} from './ws_stream_handler.js';

export class WsController {
  handleConnection(connection: unknown, req: FastifyRequest) {
    const socket = ((connection as any).socket ?? connection) as WebSocket;
    const { id: conversationId } = req.params as { id: string };
    const user = req.user;

    // 1. Register socket into active tracking
    if (!registerSocket(user.id, conversationId, socket)) {
      socket.close(1008, 'Too many active realtime connections');
      return;
    }

    // 2. Reconnection Rehydration:
    // Immediately notify client of any PENDING interrupts for this user/conversation
    (async () => {
      try {
        await reconcileExpiredInterrupts();
        const pending = await interruptActionRepository.getPendingByUserId(user.id);
        const conversationPending = pending.find((item) => item.conversation_id === conversationId);
        const recovered = conversationPending
          ? null
          : await ensureWorkflowChoiceInterrupt(conversationId, user.id);
        const actions = conversationPending ? [conversationPending] : recovered ? [recovered] : [];
        for (const item of actions) {
          if (!sendInterruptRequest(socket, item)) continue;
          if (recovered) {
            const content = item.action_type === 'QUERY_CONFIRMATION_REQUIRED'
              ? 'Your proposed monitor is ready for review. Choose an action on the card below.'
              : 'Live pre-flight is complete. Choose an action on the card below to finish setup.';
            const messageId = randomUUID();
            await chatMessageRepository.create({
              id: messageId,
              conversation_id: conversationId,
              role: 'assistant',
              content,
              created_at: Date.now(),
            });
            socket.send(JSON.stringify({
              type: 'AGENT_CHAT_DONE',
              payload: {
                messageId,
                content,
                phase: 'CLARIFICATION_PENDING',
                rule: null,
                subSentinels: [],
              },
            }));
          }
        }
        await resumeApprovedQueryConfirmation(socket, user, conversationId, req.log);
      } catch (rehydrateErr) {
        req.log.warn({ err: rehydrateErr }, 'Failed to rehydrate pending interrupts');
      }
    })();

    // 3. Heartbeat ping/pong with zombie-socket cleanup
    const stopHeartbeat = setupHeartbeat(socket as WebSocketWithAlive);

    // 4. Handle inbound WebSocket messages
    socket.on('message', async (raw: WebSocket.RawData) => {
      try {
        const parseResult = WsClientMessageSchema.safeParse(JSON.parse(raw.toString()));
        if (!parseResult.success) {
          if (socket.readyState === socket.OPEN) {
            socket.send(
              JSON.stringify({
                type: 'ERROR',
                payload: {
                  message: 'Invalid WebSocket message',
                  error: parseResult.error.message,
                },
              })
            );
          }
          return;
        }

        const validatedMessage = parseResult.data;
        const { type } = validatedMessage;

        if (type === 'PING') {
          socket.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
          return;
        }

        const payload: any = (validatedMessage as any).payload;

        if (type === 'CHAT_MESSAGE') {
          const userContent = payload?.content?.trim();
          if (!userContent) return;
          await handleChatMessage(socket, user, conversationId, userContent, req.log);
          return;
        }

        if (type === 'RESOLVE_INTERRUPT') {
          const { interruptId, resolution, choiceId, responseText } = payload || {};
          if (!interruptId || !['APPROVED', 'REJECTED'].includes(resolution) || !choiceId) {
            socket.send(
              JSON.stringify({
                type: 'ERROR',
                payload: { message: 'Choose an action card option to resolve this interrupt' },
              })
            );
            return;
          }
          await handleResolveInterrupt(socket, user, conversationId, interruptId, resolution, choiceId, responseText, req.log);
        }
      } catch (msgErr: any) {
        req.log.warn({ err: msgErr }, 'Malformed WebSocket message received');
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: 'ERROR',
              payload: {
                message: 'Failed to process incoming message',
                error: msgErr?.message || String(msgErr),
              },
            })
          );
        }
      }
    });

    // 5. Handle socket closure and cleanup
    const cleanup = () => {
      stopHeartbeat();
      unregisterSocket(user.id, conversationId, socket, (cId) => clearAgentCache(cId));
    };

    socket.on('close', cleanup);
    socket.on('error', (err: Error) => {
      req.log.error({ err }, 'WebSocket socket error');
      cleanup();
    });
  }
}

export const wsController = new WsController();
