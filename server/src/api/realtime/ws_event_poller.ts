/**
 * Strands Sentinel - Realtime Event Poller & Expiry Reconciler
 * Rehydrates durable alerts/interrupts for active WebSockets and reconciles expired HITL interrupts.
 */

import {
  alertEventRepository,
  interruptActionRepository,
  ruleRepository,
  conversationRepository,
  telemetryRepository,
} from '../../db/index.js';
import { globalEvaluatorEngine } from '../../services/evaluators/engine.js';
import { configureEvaluatorNotifications } from '../../services/runtime_notifications.js';
import {
  activeUserSockets,
  durableEventCursors,
  DURABLE_EVENT_OVERLAP_MS,
  broadcastAlert,
  broadcastInterrupt,
  broadcastSubSentinelEvaluated,
  broadcastTelemetry,
} from './ws_connection_registry.js';
import { parseClarificationPayload } from '../../services/clarification_workflow.js';

export async function pollDurableEvents(): Promise<void> {
  for (const userId of activeUserSockets.keys()) {
    try {
      const since = (durableEventCursors.get(userId) ?? Date.now()) - DURABLE_EVENT_OVERLAP_MS;
      const pollStartedAt = Date.now();
      const [alerts, interrupts, rules] = await Promise.all([
        alertEventRepository.getByUserId(userId, 100),
        interruptActionRepository.getPendingByUserId(userId),
        ruleRepository.getByUserId(userId, 100),
      ]);

      for (const alert of alerts) {
        if (alert.created_at > since) broadcastAlert(alert);
      }
      for (const interrupt of interrupts) {
        if (interrupt.created_at > since) broadcastInterrupt(interrupt);
      }

      // Evaluations can run in an SQS worker, which has no access to this
      // process-local WebSocket registry. Rehydrate the durable telemetry
      // written by that worker so connected mobile clients receive the same
      // events as clients connected to an in-process evaluation.
      const telemetryByRule = await Promise.all(
        rules.map(async (rule) => {
          try {
            return await telemetryRepository.getByRuleId(rule.id, 100);
          } catch (error) {
            console.warn(`[WebSocket] Telemetry rehydration failed for rule ${rule.id}:`, error);
            return [];
          }
        })
      );

      for (const points of telemetryByRule) {
        for (const point of points) {
          if (point.timestamp <= since) continue;
          broadcastTelemetry(userId, point);

          const metadata = parseTelemetryMetadata(point.metadata);
          if (typeof metadata?.isSatisfied !== 'boolean' || !point.sub_sentinel_id) continue;

          broadcastSubSentinelEvaluated(userId, {
            subSentinelId: point.sub_sentinel_id,
            ruleId: point.rule_id,
            isSatisfied: metadata.isSatisfied,
            currentValue: point.value,
            timestamp: point.timestamp,
          });
        }
      }
      durableEventCursors.set(userId, pollStartedAt);
    } catch (error) {
      console.warn('[WebSocket] Durable event rehydration failed:', error);
    }
  }
}

function parseTelemetryMetadata(metadata: string | null | undefined): { isSatisfied?: boolean } | null {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!parsed || typeof parsed !== 'object') return null;
    const isSatisfied = (parsed as { isSatisfied?: unknown }).isSatisfied;
    return typeof isSatisfied === 'boolean' ? { isSatisfied } : null;
  } catch {
    return null;
  }
}

export async function reconcileExpiredInterrupts(): Promise<void> {
  const expired = await interruptActionRepository.expirePending(Date.now());
  for (const action of expired) {
    const enriched = await interruptActionRepository.getById(action.id);
    if (!enriched?.conversation_id) continue;

    const conversation = await conversationRepository.getById(enriched.conversation_id);
    const choicePayload = parseClarificationPayload(enriched);
    if (conversation?.phase === 'CLARIFICATION_PENDING') {
      await conversationRepository.updatePhase(
        enriched.conversation_id,
        enriched.action_type === 'CLARIFICATION_REQUIRED'
          ? choicePayload?.resume_phase ?? 'DISCOVERY'
          : 'DISCOVERY',
      );
      if (enriched.rule_id) {
        const rule = await ruleRepository.getById(enriched.rule_id);
        if (rule?.status === 'PAUSED') await ruleRepository.updateStatus(rule.id, 'DISMISSED');
      }
    } else if (enriched.rule_id) {
      const rule = await ruleRepository.getById(enriched.rule_id);
      if (rule?.status === 'PAUSED') {
        await ruleRepository.updateStatus(rule.id, 'DISMISSED');
      }
      if (conversation?.phase === 'INTERRUPT_PENDING') {
        await conversationRepository.updatePhase(enriched.conversation_id, 'DISCOVERY');
      }
    }
  }
}

// Background intervals for active WebSocket event synchronization
const durableEventPollTimer = setInterval(() => {
  void pollDurableEvents();
}, 5000);
durableEventPollTimer.unref?.();

const interruptExpiryTimer = setInterval(() => {
  void reconcileExpiredInterrupts().catch((error) => {
    console.warn('[WebSocket] Interrupt expiry reconciliation failed:', error);
  });
}, 60_000);
interruptExpiryTimer.unref?.();

// Configure notifications bridge from the global evaluator engine to active sockets
configureEvaluatorNotifications(globalEvaluatorEngine, {
  publishAlert: broadcastAlert,
  publishInterrupt: broadcastInterrupt,
  publishSubSentinelEvaluated: broadcastSubSentinelEvaluated,
  publishTelemetry: broadcastTelemetry,
});
