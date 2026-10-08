/**
 * Process-local delivery bridge for durable evaluator events.
 *
 * Evaluators persist alerts and interrupt actions before invoking this bridge.
 * The bridge can therefore fail without losing operational state: realtime
 * clients rehydrate from the API and offline clients receive best-effort push.
 */

import type { AlertEvent, EnrichedInterruptAction, InterruptAction, TelemetryPoint } from '@sentinel/shared';
import { ruleRepository } from '../db/index.js';
import { type EvaluatorEngine, type SubSentinelEvaluatedEventPayload } from './evaluators/engine.js';
import { sendUserPushNotification } from './notifications/push_notifications.js';

export interface RuntimeEventPublisher {
  publishAlert?: (alert: AlertEvent) => void;
  publishInterrupt?: (interrupt: EnrichedInterruptAction) => void;
  publishSubSentinelEvaluated?: (userId: string, event: SubSentinelEvaluatedEventPayload) => void;
  publishTelemetry?: (userId: string, point: TelemetryPoint) => void;
}

function reportDeliveryFailure(channel: string, error: unknown): void {
  console.warn(`[RuntimeNotifications] ${channel} delivery failed:`, error);
}

async function deliverInterrupt(
  interrupt: InterruptAction,
  publisher: RuntimeEventPublisher,
): Promise<void> {
  let ruleTitle: string | null = null;
  let conversationId: string | null = null;
  try {
    const rule = interrupt.rule_id ? await ruleRepository.getById(interrupt.rule_id) : null;
    ruleTitle = rule?.title ?? null;
    conversationId = interrupt.conversation_id ?? rule?.conversation_id ?? null;
  } catch (error) {
    reportDeliveryFailure('interrupt enrichment', error);
  }

  const enriched: EnrichedInterruptAction = {
    ...interrupt,
    conversation_id: conversationId,
    rule_title: ruleTitle,
  };
  try {
    publisher.publishInterrupt?.(enriched);
  } catch (error) {
    reportDeliveryFailure('realtime interrupt', error);
  }

  await sendUserPushNotification(interrupt.user_id, {
    title: 'Sentinel confirmation required',
    body: ruleTitle ? `Review: ${ruleTitle}` : 'A Sentinel task needs your confirmation.',
    data: {
      type: 'INTERRUPT_REQUEST',
      interruptId: interrupt.id,
      conversationId,
    },
  });
}

async function deliverAlert(alert: AlertEvent, publisher: RuntimeEventPublisher): Promise<void> {
  try {
    publisher.publishAlert?.(alert);
  } catch (error) {
    reportDeliveryFailure('realtime alert', error);
  }

  await sendUserPushNotification(alert.user_id, {
    title: alert.title,
    body: alert.summary,
    data: { type: 'ALERT_TRIGGERED', alertId: alert.id, ruleId: alert.rule_id },
  });
}

/** Attach identical notification behavior in the API and SQS worker processes. */
export function configureEvaluatorNotifications(
  engine: EvaluatorEngine,
  publisher: RuntimeEventPublisher = {},
): void {
  engine.setEventCallbacks({
    onAlertTriggered: (alert) => {
      void deliverAlert(alert, publisher).catch((error) => reportDeliveryFailure('alert', error));
    },
    onInterruptRequest: (interrupt) => {
      void deliverInterrupt(interrupt, publisher).catch((error) => reportDeliveryFailure('interrupt', error));
    },
    onSubSentinelEvaluated: (userId, event) => {
      try {
        publisher.publishSubSentinelEvaluated?.(userId, event);
      } catch (error) {
        reportDeliveryFailure('realtime sub-sentinel event', error);
      }
    },
    onTelemetryUpdate: (userId, point) => {
      try {
        publisher.publishTelemetry?.(userId, point);
      } catch (error) {
        reportDeliveryFailure('realtime telemetry', error);
      }
    },
  });
}
