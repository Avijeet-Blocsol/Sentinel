/**
 * Strands Sentinel - Rules Service
 * Encapsulates rule retrieval with sub-sentinels, status transitions, and cascade deletion.
 */

import {
  ruleRepository,
  subSentinelRepository,
  telemetryRepository,
  interruptActionRepository,
  type Rule,
  type SubSentinel,
  type TelemetryPoint,
  type RuleStatus,
} from '../../db/index.js';
import type { RuleQuery } from './rules.schema.js';

export class RuleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleConflictError';
  }
}

export class RuleNotFoundError extends Error {
  constructor(message: string = 'Rule not found') {
    super(message);
    this.name = 'RuleNotFoundError';
  }
}

export class RulesService {
  async listRules(
    userId: string,
    filters: RuleQuery
  ): Promise<Array<Rule & { sub_sentinels: SubSentinel[]; telemetry: TelemetryPoint[] }>> {
    let rules = await ruleRepository.getByUserId(userId, filters.limit);

    if (filters.category) {
      rules = rules.filter((r) => r.category === filters.category);
    }
    if (filters.status) {
      rules = rules.filter((r) => r.status === filters.status);
    }

    return Promise.all(
      rules.map(async (rule) => {
        const [subSentinels, telemetry] = await Promise.all([
          subSentinelRepository.getByRuleId(rule.id),
          telemetryRepository.getByRuleId(rule.id, 100),
        ]);
        return {
          ...rule,
          sub_sentinels: subSentinels,
          // Repository adapters return newest-first for efficient recent
          // history queries. The mobile chart consumes chronological data,
          // so normalize the API contract once at the boundary.
          telemetry: [...telemetry].sort((a, b) => a.timestamp - b.timestamp),
        };
      })
    );
  }

  async getRuleWithSubSentinels(
    ruleId: string
  ): Promise<(Rule & { sub_sentinels: SubSentinel[]; telemetry: TelemetryPoint[] }) | null> {
    const rule = await ruleRepository.getById(ruleId);
    if (!rule) {
      return null;
    }

    const [subSentinels, telemetry] = await Promise.all([
      subSentinelRepository.getByRuleId(ruleId),
      telemetryRepository.getByRuleId(ruleId, 100),
    ]);
    return {
      ...rule,
      sub_sentinels: subSentinels,
      telemetry: [...telemetry].sort((a, b) => a.timestamp - b.timestamp),
    };
  }

  async updateRuleStatus(
    userId: string,
    ruleId: string,
    status: RuleStatus
  ): Promise<{ success: boolean; id: string; status: RuleStatus }> {
    const rule = await ruleRepository.getById(ruleId);
    if (!rule) {
      throw new RuleNotFoundError();
    }
    if (rule.user_id !== userId) {
      throw new RuleNotFoundError();
    }

    const pending = await interruptActionRepository.getPendingByUserId(userId);
    if (pending.some((action) => action.rule_id === ruleId)) {
      throw new RuleConflictError(
        'A staged rule can only be activated by resolving its confirmation interrupt'
      );
    }

    const allowedTransitions: Record<string, ReadonlySet<string>> = {
      ACTIVE: new Set(['ACTIVE', 'PAUSED', 'ARCHIVED']),
      PAUSED: new Set(['PAUSED', 'ACTIVE', 'ARCHIVED']),
      TRIGGERED: new Set(['TRIGGERED', 'ARCHIVED']),
      ARCHIVED: new Set(['ARCHIVED', 'ACTIVE']),
      DISMISSED: new Set(['DISMISSED']),
    };

    if (!allowedTransitions[rule.status]?.has(status)) {
      throw new RuleConflictError(`Rule cannot transition from ${rule.status} to ${status}`);
    }

    await ruleRepository.updateStatus(ruleId, status);
    return {
      success: true,
      id: ruleId,
      status,
    };
  }

  async deleteRule(userId: string, ruleId: string): Promise<void> {
    const rule = await ruleRepository.getById(ruleId);
    if (!rule || rule.user_id !== userId) {
      throw new RuleNotFoundError();
    }
    await ruleRepository.delete(ruleId);
  }
}

export const rulesService = new RulesService();
