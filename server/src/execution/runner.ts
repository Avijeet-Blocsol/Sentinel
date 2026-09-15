import { randomUUID } from 'node:crypto';
import { executionRepository, ruleRepository } from '../db/index.js';
import { globalEvaluatorEngine, type EvaluatorEngine } from '../services/evaluators/engine.js';
import {
  SentinelExecutionEventSchema,
  type SentinelExecutionEvent,
  type SentinelExecutionResult,
} from './contracts.js';

export async function runSentinelExecution(
  rawEvent: unknown,
  owner = `worker-${randomUUID()}`,
  engine: EvaluatorEngine = globalEvaluatorEngine,
  limit = 100,
  forceEvaluateChildren = true
): Promise<SentinelExecutionResult> {
  const event = SentinelExecutionEventSchema.parse(rawEvent);
  const leaseDurationMs = Math.max(
    60_000,
    Number(process.env.SENTINEL_EXECUTION_LEASE_MS || 300_000)
  );
  const lease = await executionRepository.claim({
    id: event.eventId,
    event_type: event.eventType,
    rule_id: event.ruleId ?? null,
    lease_owner: owner,
    lease_expires_at: Date.now() + leaseDurationMs,
    now: Date.now(),
  });

  if (!lease.claimed) {
    return { eventId: event.eventId, eventType: event.eventType, status: 'DUPLICATE' };
  }

  try {
    let result: SentinelExecutionResult;
    if (event.eventType === 'TICK') {
      const tick = await engine.tick(event.now || Date.now(), limit);
      if (tick.failures > 0) {
        throw new Error(`TICK_PARTIAL_FAILURE:${tick.failures}`);
      }
      result = {
        eventId: event.eventId,
        eventType: event.eventType,
        status: 'SUCCEEDED',
        evaluatedSubSentinels: tick.evaluatedSubSentinels,
        triggeredRules: tick.triggeredRules,
      };
    } else {
      if (!event.ruleId) throw new Error('EVALUATE_RULE events require ruleId');
      const rule = await ruleRepository.getById(event.ruleId);
      if (!rule) throw new Error(`Rule not found: ${event.ruleId}`);
      const evaluation = await engine.evaluateRule(rule, forceEvaluateChildren);
      result = {
        eventId: event.eventId,
        eventType: event.eventType,
        status: 'SUCCEEDED',
        isTriggered: evaluation.isTriggered,
      };
    }
    await executionRepository.complete(event.eventId, owner, JSON.stringify(result));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = !/invalid|not found|schema|unauthorized|forbidden/i.test(message);
    try {
      await executionRepository.fail(event.eventId, owner, message, retryable);
    } catch {}
    if (retryable) throw error;
    return { eventId: event.eventId, eventType: event.eventType, status: 'FAILED', error: message };
  }
}
