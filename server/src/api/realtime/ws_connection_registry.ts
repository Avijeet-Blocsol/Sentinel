/**
 * Strands Sentinel - WebSocket Connection Registry & Broadcaster
 * Manages active connected sockets per conversation and user, with deduplicated alert/interrupt delivery.
 */

import type WebSocket from 'ws';
import type { AlertEvent, EnrichedInterruptAction, TelemetryPoint } from '@sentinel/shared';
import type { SubSentinelEvaluatedEventPayload } from '../../services/evaluators/engine.js';
import type { DeploymentResolution } from '../../services/deployment_workflow.js';

export const activeConversationSockets = new Map<string, Set<WebSocket>>();
export const activeUserSockets = new Map<string, Set<WebSocket>>();
export const deliveredAlertIds = new Map<string, Set<string>>();
// Delivery is tracked per socket. A user-level set incorrectly suppresses a
// pending card on a newly connected device, while no check at all allows the
// same socket to receive the card repeatedly during rehydration.
const deliveredInterruptIdsBySocket = new WeakMap<WebSocket, Map<string, string>>();
export const deliveredTelemetryIds = new Map<string, Set<string>>();
export const deliveredSubSentinelEvaluationIds = new Map<string, Set<string>>();
export const durableEventCursors = new Map<string, number>();
export const DURABLE_EVENT_OVERLAP_MS = 10_000;
export const MAX_SOCKETS_PER_USER = 8;
export const MAX_SOCKETS_PER_CONVERSATION = 4;

export function registerSocket(userId: string, conversationId: string, socket: WebSocket): boolean {
  const existingConversationSockets = activeConversationSockets.get(conversationId);
  if (existingConversationSockets && existingConversationSockets.size >= MAX_SOCKETS_PER_CONVERSATION) {
    return false;
  }
  const existingUserSockets = activeUserSockets.get(userId);
  if (existingUserSockets && existingUserSockets.size >= MAX_SOCKETS_PER_USER) {
    return false;
  }

  if (!activeConversationSockets.has(conversationId)) {
    activeConversationSockets.set(conversationId, new Set());
  }
  activeConversationSockets.get(conversationId)!.add(socket);

  if (!activeUserSockets.has(userId)) {
    activeUserSockets.set(userId, new Set());
    // Overlap the first poll window so events created during the upgrade or
    // immediately before it are replayed and deduplicated instead of missed.
    durableEventCursors.set(userId, Date.now() - DURABLE_EVENT_OVERLAP_MS);
  }
  activeUserSockets.get(userId)!.add(socket);
  return true;
}

export function unregisterSocket(
  userId: string,
  conversationId: string,
  socket: WebSocket,
  onConversationEmpty?: (conversationId: string) => void
): void {
  const convSet = activeConversationSockets.get(conversationId);
  if (convSet) {
    convSet.delete(socket);
    if (convSet.size === 0) {
      activeConversationSockets.delete(conversationId);
      if (onConversationEmpty) {
        onConversationEmpty(conversationId);
      }
    }
  }

  const userSet = activeUserSockets.get(userId);
  if (userSet) {
    userSet.delete(socket);
    if (userSet.size === 0) {
      activeUserSockets.delete(userId);
      deliveredAlertIds.delete(userId);
      deliveredTelemetryIds.delete(userId);
      deliveredSubSentinelEvaluationIds.delete(userId);
      durableEventCursors.delete(userId);
    }
  }
}

export function broadcastToUser(userId: string, message: unknown): void {
  const userSockets = activeUserSockets.get(userId);
  if (!userSockets) return;

  const serialized = JSON.stringify(message);
  for (const socket of userSockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(serialized);
    }
  }
}

export function broadcastAlert(alert: AlertEvent): void {
  const seen = deliveredAlertIds.get(alert.user_id) ?? new Set<string>();
  if (seen.has(alert.id)) return;
  seen.add(alert.id);
  while (seen.size > 500) {
    seen.delete(seen.values().next().value as string);
  }
  deliveredAlertIds.set(alert.user_id, seen);
  broadcastToUser(alert.user_id, { type: 'ALERT_TRIGGERED', payload: alert });
}

export function broadcastInterrupt(interrupt: EnrichedInterruptAction): void {
  const userSockets = activeUserSockets.get(interrupt.user_id);
  if (!userSockets) return;
  for (const socket of userSockets) {
    sendInterruptRequest(socket, interrupt);
  }
}

/** Send the canonical interrupt event once to this socket. */
export function sendInterruptRequest(socket: WebSocket, interrupt: EnrichedInterruptAction): boolean {
  const fingerprint = JSON.stringify({
    status: interrupt.status,
    action_payload: interrupt.action_payload,
    expires_at: interrupt.expires_at ?? null,
  });
  if (socket.readyState !== socket.OPEN || !markInterruptDelivered(socket, interrupt.id, fingerprint)) return false;
  socket.send(JSON.stringify({ type: 'INTERRUPT_REQUEST', payload: interrupt }));
  return true;
}

export function markInterruptDelivered(socket: WebSocket, interruptId: string, fingerprint = interruptId): boolean {
  const seen = deliveredInterruptIdsBySocket.get(socket) ?? new Map<string, string>();
  if (seen.get(interruptId) === fingerprint) return false;
  seen.set(interruptId, fingerprint);
  while (seen.size > 500) {
    seen.delete(seen.keys().next().value as string);
  }
  deliveredInterruptIdsBySocket.set(socket, seen);
  return true;
}

export function broadcastSubSentinelEvaluated(
  userId: string,
  payload: SubSentinelEvaluatedEventPayload
): void {
  const eventId = `${payload.subSentinelId}:${payload.timestamp}`;
  const seen = deliveredSubSentinelEvaluationIds.get(userId) ?? new Set<string>();
  if (seen.has(eventId)) return;
  seen.add(eventId);
  while (seen.size > 500) {
    seen.delete(seen.values().next().value as string);
  }
  deliveredSubSentinelEvaluationIds.set(userId, seen);
  broadcastToUser(userId, { type: 'SUB_SENTINEL_EVALUATED', payload });
}

export function broadcastTelemetry(userId: string, point: TelemetryPoint): void {
  const seen = deliveredTelemetryIds.get(userId) ?? new Set<string>();
  if (seen.has(point.id)) return;
  seen.add(point.id);
  while (seen.size > 500) {
    seen.delete(seen.values().next().value as string);
  }
  deliveredTelemetryIds.set(userId, seen);
  broadcastToUser(userId, { type: 'TELEMETRY_UPDATE', payload: point });
}

export function emitDeploymentResolution(
  socket: WebSocket,
  interrupt: EnrichedInterruptAction,
  resolution: 'APPROVED' | 'REJECTED',
  choiceId: string,
  result: DeploymentResolution
): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: 'INTERRUPT_RESOLVED',
      payload: {
        interruptId: interrupt.id,
        resolution,
        choiceId,
        actionResult: result.message,
        resolvedAt: result.resolvedAt,
      },
    })
  );
  if (result.messageId) {
    socket.send(
      JSON.stringify({
        type: 'AGENT_CHAT_DONE',
        payload: {
          messageId: result.messageId,
          content: result.message,
          rule: result.rule,
          subSentinels: result.subSentinels,
        },
      })
    );
  }
}
