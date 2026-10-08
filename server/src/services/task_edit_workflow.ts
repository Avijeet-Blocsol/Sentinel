import {
  RuleSchema,
  SubSentinelSchema,
  SubSentinelThresholdSchema,
  parseConditionTree,
  type ConditionNode,
  type Rule,
  type SubSentinel,
  type TaskEditProposal,
} from '@sentinel/shared';
import { deploymentRepository } from '../db/index.js';

export type PreparedTaskEdit = {
  rule: Rule;
  subSentinels: SubSentinel[];
  deletedSubSentinelIds: string[];
};

function removeLeaf(node: ConditionNode, subSentinelId: string): ConditionNode | null {
  if (node.type === 'LEAF') return node.subSentinelId === subSentinelId ? null : node;
  if (node.type === 'NOT') {
    const child = removeLeaf(node.child, subSentinelId);
    return child ? { type: 'NOT', child } : null;
  }

  const children = node.children
    .map((child) => removeLeaf(child, subSentinelId))
    .filter((child): child is ConditionNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { type: node.type, children };
}

function resetSubSentinel(sub: SubSentinel, now: number): SubSentinel {
  return {
    ...sub,
    last_evaluated_at: null,
    next_evaluation_at: now,
    last_triggered_at: null,
    is_satisfied: 0,
    satisfied_at: null,
    state_payload: null,
    health_status: 'HEALTHY',
    error_count: 0,
    last_error: null,
  };
}

function patchThreshold(sub: SubSentinel, proposal: TaskEditProposal): string {
  const patch = proposal.changes.threshold_patch ?? {};
  if (Object.keys(patch).length === 0 && proposal.changes.operator === undefined) return sub.threshold;
  let existing: unknown;
  try {
    existing = JSON.parse(sub.threshold);
  } catch {
    throw new Error('The existing condition threshold is not valid JSON');
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error('The existing condition threshold is not a JSON object');
  }
  const next = { ...(existing as Record<string, unknown>), ...patch };
  if (proposal.changes.operator && Object.prototype.hasOwnProperty.call(next, 'operator')) {
    next.operator = proposal.changes.operator;
  }
  if (sub.sentinel_type === 'CRYPTO' &&
      !(typeof next.currency === 'string' && next.currency.trim())) {
    throw new Error('Crypto edits require an explicit quote currency');
  }
  const thresholdValidation = SubSentinelThresholdSchema.safeParse(next);
  if (!thresholdValidation.success) {
    throw new Error('The proposed trigger condition is not valid for this sentinel type');
  }
  // Persist the schema-normalized object so an edit cannot smuggle unknown
  // fields (for example an alternate URL or provider selector) into the
  // evaluator payload after the confirmation card is approved.
  const serialized = JSON.stringify(thresholdValidation.data);
  if (serialized.length > 16_000) throw new Error('The proposed trigger condition is too large');
  return serialized;
}

function validateTarget(proposal: TaskEditProposal, subSentinels: SubSentinel[]): SubSentinel | null {
  if (proposal.operation === 'CHANGE_TRIGGER_MODE') return null;
  // Cardinality is safe deterministic disambiguation: a task with exactly
  // one condition has no competing target. Multiple conditions still require
  // the Strands agent to obtain an explicit target choice.
  if (!proposal.target_sub_sentinel_id) {
    if (subSentinels.length === 1) return subSentinels[0]!;
    throw new Error('The edit did not identify a condition');
  }
  const target = subSentinels.find((sub) => sub.id === proposal.target_sub_sentinel_id);
  if (!target) throw new Error('The requested condition no longer exists on this task');
  return target;
}

/**
 * Applies only pure business rules to an agent proposal. No persistence is
 * performed until the caller has displayed the returned proposal and the user
 * has selected the confirmation card.
 */
export function prepareTaskEdit(input: {
  rule: Rule;
  subSentinels: SubSentinel[];
  proposal: TaskEditProposal;
  now: number;
}): PreparedTaskEdit {
  const { rule, subSentinels, proposal, now } = input;
  if (subSentinels.length === 0) throw new Error('A deployed task must retain at least one condition');

  const target = validateTarget(proposal, subSentinels);
  let nextSubs = subSentinels.map((sub) => ({ ...sub }));
  // Keep the optimistic-concurrency version strictly monotonic even when a
  // local update and the previous write occur within the same millisecond.
  let nextRule: Rule = { ...rule, updated_at: Math.max(now, rule.updated_at + 1), status: 'ACTIVE' };
  const deletedSubSentinelIds: string[] = [];

  if (proposal.operation === 'DELETE_CONDITION') {
    if (!target) throw new Error('A condition is required for deletion');
    if (subSentinels.length <= 1) throw new Error('A task must retain at least one condition');
    nextSubs = nextSubs.filter((sub) => sub.id !== target.id);
    deletedSubSentinelIds.push(target.id);

    const rawTree = parseConditionTree(rule.condition_tree);
    if (rawTree) {
      const nextTree = removeLeaf(rawTree, target.id);
      nextRule.condition_tree = nextTree ? JSON.stringify(nextTree) : null;
    } else {
      nextRule.condition_tree = null;
      nextRule.combinator = nextSubs.length === 1 ? 'SINGLE' : rule.combinator;
      if (nextSubs.length > 1 && nextRule.combinator === 'SINGLE') {
        throw new Error('The task has multiple conditions without a valid boolean combinator');
      }
    }
  } else if (proposal.operation === 'UPDATE_CONDITION') {
    if (!target) throw new Error('A condition is required for update');
    const changes = proposal.changes;
    if (
      changes.schedule_seconds === undefined &&
      changes.operator === undefined &&
      changes.threshold_patch === undefined
    ) {
      throw new Error('The update did not contain a schedule or trigger-condition change');
    }
    nextSubs = nextSubs.map((sub) => {
      if (sub.id !== target.id) return sub;
      const updated = {
        ...sub,
        ...(changes.schedule_seconds !== undefined ? { ttl_seconds: changes.schedule_seconds } : {}),
        ...(changes.operator !== undefined ? { operator: changes.operator } : {}),
        ...((changes.threshold_patch !== undefined || changes.operator !== undefined)
          ? { threshold: patchThreshold(sub, proposal) }
          : {}),
      };
      return resetSubSentinel(updated, now);
    });
  } else if (proposal.operation === 'CHANGE_TRIGGER_MODE') {
    const nextMode = proposal.changes.trigger_mode;
    if (!nextMode) throw new Error('The monitoring mode was not specified');
    nextRule = {
      ...nextRule,
      trigger_mode: nextMode,
      last_triggered_at: null,
    };
    nextSubs = nextSubs.map((sub) => resetSubSentinel(sub, now));
  }

  const parsedRule = RuleSchema.safeParse(nextRule);
  if (!parsedRule.success) throw new Error('The resulting task configuration is invalid');
  const parsedSubs = nextSubs.map((sub) => SubSentinelSchema.safeParse(sub));
  if (parsedSubs.some((result) => !result.success)) {
    throw new Error('The resulting condition configuration is invalid');
  }

  return {
    rule: parsedRule.data,
    subSentinels: parsedSubs.flatMap((result) => result.success ? [result.data] : []),
    deletedSubSentinelIds,
  };
}

export async function commitTaskEdit(input: {
  interruptId: string;
  conversationId: string;
  userId: string;
  expectedRuleUpdatedAt: number;
  prepared: PreparedTaskEdit;
  now: number;
}): Promise<boolean> {
  return deploymentRepository.applyTaskEdit({
    interruptId: input.interruptId,
    conversationId: input.conversationId,
    userId: input.userId,
    expectedRuleUpdatedAt: input.expectedRuleUpdatedAt,
    rule: input.prepared.rule,
    subSentinels: input.prepared.subSentinels,
    deletedSubSentinelIds: input.prepared.deletedSubSentinelIds,
    now: input.now,
  });
}
