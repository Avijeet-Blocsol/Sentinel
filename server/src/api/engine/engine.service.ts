/**
 * Strands Sentinel - Engine Service
 * Encapsulates scheduler sweeps, execution runs, and on-demand rule evaluation.
 */

import { randomUUID } from 'node:crypto';
import { globalEvaluatorEngine } from '../../services/evaluators/engine.js';
import { ruleRepository, type Rule } from '../../db/index.js';
import { runSentinelExecution } from '../../execution/runner.js';
import type { SentinelExecutionResult } from '../../execution/contracts.js';
import type { EngineTickBody, EvaluateRuleBody } from './engine.schema.js';

export class EngineRuleNotFoundError extends Error {
  constructor(ruleId: string) {
    super(`Rule not found: ${ruleId}`);
    this.name = 'EngineRuleNotFoundError';
  }
}

export class EngineService {
  async executeTick(
    userId: string,
    data: EngineTickBody,
    suppliedEventId?: string
  ): Promise<{
    success: boolean;
    timestamp: number;
    evaluatedSubSentinels: number;
    triggeredRules: number;
    status: SentinelExecutionResult['status'];
    message: string;
  }> {
    const targetTimestamp = data.now || Date.now();
    const event = await runSentinelExecution(
      {
        eventId: suppliedEventId || `http-tick-${randomUUID()}`,
        eventType: 'TICK',
        now: targetTimestamp,
        requestedAt: Date.now(),
        source: 'engine-http',
      },
      `http-${userId}-${randomUUID()}`,
      globalEvaluatorEngine,
      data.limit
    );

    return {
      success: event.status !== 'FAILED',
      timestamp: targetTimestamp,
      evaluatedSubSentinels: event.evaluatedSubSentinels || 0,
      triggeredRules: event.triggeredRules || 0,
      status: event.status,
      message: `Engine scheduler sweep completed: ${event.evaluatedSubSentinels || 0} sub-sentinels evaluated, ${event.triggeredRules || 0} rules triggered.`,
    };
  }

  async evaluateRule(
    userId: string,
    ruleId: string,
    data: EvaluateRuleBody
  ): Promise<{
    success: boolean;
    ruleId: string;
    status: SentinelExecutionResult['status'];
    isTriggered: boolean;
  }> {
    const rule = await ruleRepository.getById(ruleId);
    if (!rule) {
      throw new EngineRuleNotFoundError(ruleId);
    }

    const eventId = data.eventId || `http-rule-${randomUUID()}`;
    const evalResult = await runSentinelExecution(
      {
        eventId,
        eventType: 'EVALUATE_RULE',
        ruleId: rule.id,
        requestedAt: Date.now(),
        source: 'engine-http',
      },
      `http-${userId}-${randomUUID()}`,
      globalEvaluatorEngine,
      100,
      data.forceEvaluateChildren
    );

    return {
      success: evalResult.status !== 'FAILED',
      ruleId: rule.id,
      status: evalResult.status,
      isTriggered: evalResult.isTriggered || false,
    };
  }
}

export const engineService = new EngineService();
