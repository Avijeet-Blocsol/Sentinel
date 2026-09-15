/**
 * Durable deployment lifecycle for a Sentinel conversation.
 *
 * Transport handlers may render cards and messages, but this module owns the
 * persistence boundaries: staging a proposal, registering its scheduler, and
 * resolving the human approval gate.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  RuleSchema,
  SubSentinelSchema,
  parseConditionTree,
  type ConditionNode,
  type EnrichedInterruptAction,
  type InterruptAction,
  type Rule,
  type SubSentinel,
} from '@sentinel/shared';
import {
  chatMessageRepository,
  deploymentRepository,
  interruptActionRepository,
  ruleRepository,
  subSentinelRepository,
} from '../db/index.js';
import { ensureConfiguredScheduler } from '../execution/scheduler_registration.js';
import { usesAwsInfrastructure } from '../config/infrastructure_mode.js';

export interface SynthesizedRuleBundle {
  rule?: Rule;
  subSentinels?: SubSentinel[];
  baselineValue?: string;
  baselineSeeds?: string[];
}

export interface DeploymentResolution {
  messageId: string | null;
  message: string;
  rule: Rule | null;
  subSentinels: SubSentinel[];
  resolvedAt: number;
  alreadyResolved: boolean;
}

function parseRawConditionTree(value: unknown): ConditionNode | null {
  return parseConditionTree(typeof value === 'string' ? value : JSON.stringify(value));
}

/** Replace model-local condition keys with server-generated sub-sentinel IDs. */
function bindConditionTreeReferences(
  node: ConditionNode,
  references: ReadonlyMap<string, string>,
): ConditionNode | null {
  switch (node.type) {
    case 'LEAF': {
      const subSentinelId = references.get(node.subSentinelId);
      return subSentinelId ? { type: 'LEAF', subSentinelId } : null;
    }
    case 'NOT': {
      const child = bindConditionTreeReferences(node.child, references);
      return child ? { type: 'NOT', child } : null;
    }
    case 'AND':
    case 'OR': {
      const children = node.children.map((child) => bindConditionTreeReferences(child, references));
      return children.every((child): child is ConditionNode => child !== null)
        ? { type: node.type, children }
        : null;
    }
  }
}

function collectConditionTreeReferences(node: ConditionNode, references = new Set<string>()): Set<string> {
  switch (node.type) {
    case 'LEAF':
      references.add(node.subSentinelId);
      break;
    case 'NOT':
      collectConditionTreeReferences(node.child, references);
      break;
    case 'AND':
    case 'OR':
      for (const child of node.children) collectConditionTreeReferences(child, references);
      break;
  }
  return references;
}

/** Parse a model-generated fenced JSON bundle at the strict persistence boundary. */
export function extractSynthesizedRule(
  text: string,
  userId: string,
  conversationId: string,
): SynthesizedRuleBundle {
  try {
    // Capture the complete fenced payload. A non-greedy `{...}` match stops
    // at the first nested object and therefore corrupts every realistic
    // multi-sentinel/condition-tree synthesis.
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (!jsonMatch) return {};

    const parsed = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    if (typeof parsed.title !== 'string' || typeof parsed.natural_language_intent !== 'string') return {};
    if (!Array.isArray(parsed.sub_sentinels) || parsed.sub_sentinels.length === 0) return {};

    const ruleId = randomUUID();
    const subSentinels: SubSentinel[] = [];
    const conditionReferences = new Map<string, string>();
    let hasDuplicateConditionReference = false;
    for (const [index, candidate] of parsed.sub_sentinels.entries()) {
      if (!candidate || typeof candidate !== 'object') return {};
      const rawSub = candidate as Record<string, unknown>;
      const subSentinelId = randomUUID();
      const subResult = SubSentinelSchema.safeParse({
        id: subSentinelId,
        rule_id: ruleId,
        sentinel_type: rawSub.sentinel_type ?? 'STOCK',
        target_source: rawSub.target_source ?? rawSub.ticker ?? 'MARKET',
        operator: rawSub.operator ?? 'GREATER_THAN',
        threshold: typeof rawSub.threshold === 'string'
          ? rawSub.threshold
          : JSON.stringify(rawSub.threshold ?? rawSub),
        ttl_seconds: rawSub.ttl_seconds ?? 300,
        health_status: 'HEALTHY',
        error_count: 0,
        is_satisfied: 0,
      });
      if (!subResult.success) return {};
      subSentinels.push(subResult.data);

      // The model cannot select durable UUIDs. It labels leaves using a local
      // condition_key (A/B/C), an ordinal, or a generated candidate id; the
      // server binds each accepted reference to its own UUID before storage.
      const aliases = [
        rawSub.condition_key,
        rawSub.conditionKey,
        rawSub.id,
        String(index + 1),
        `sub_${index + 1}`,
        `sub-${index + 1}`,
      ];
      for (const alias of aliases) {
        if (typeof alias !== 'string' || !alias.trim()) continue;
        const key = alias.trim();
        const existing = conditionReferences.get(key);
        if (existing && existing !== subSentinelId) hasDuplicateConditionReference = true;
        else conditionReferences.set(key, subSentinelId);
      }
    }

    let conditionTree: string | undefined;
    if (parsed.condition_tree !== undefined && parsed.condition_tree !== null) {
      const rawTree = parseRawConditionTree(parsed.condition_tree);
      const boundTree = rawTree && bindConditionTreeReferences(rawTree, conditionReferences);
      // A partially bound tree silently changes boolean semantics, so reject
      // the whole model synthesis rather than falling back to a flat rule.
      const allBoundIds = boundTree && collectConditionTreeReferences(boundTree);
      if (!boundTree || hasDuplicateConditionReference ||
          subSentinels.some((sub) => !allBoundIds?.has(sub.id))) return {};
      conditionTree = JSON.stringify(boundTree);
    }

    // A multi-watcher rule without a boolean relationship would otherwise
    // inherit SINGLE and silently ignore all but its first child.
    const combinator = parsed.combinator
      ?? (conditionTree ? 'SINGLE' : subSentinels.length === 1 ? 'SINGLE' : undefined);
    if (!conditionTree && (subSentinels.length > 1) &&
        (combinator !== 'AND' && combinator !== 'OR')) return {};

    const ruleResult = RuleSchema.safeParse({
      id: ruleId,
      user_id: userId,
      conversation_id: conversationId,
      title: parsed.title,
      natural_language_intent: parsed.natural_language_intent,
      category: parsed.category ?? 'FINANCIAL',
      combinator,
      condition_tree: conditionTree,
      trigger_mode: parsed.trigger_mode ?? 'PERSISTENT',
      cooldown_minutes: parsed.cooldown_minutes ?? 60,
      audio_tone: parsed.audio_tone ?? 'chime',
      status: 'ACTIVE',
      action_template: parsed.action_template ? JSON.stringify(parsed.action_template) : undefined,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    if (!ruleResult.success) return {};

    const baselineSeeds = Array.isArray(parsed.baseline_seeds)
      ? parsed.baseline_seeds.map((value) => String(value))
      : [];
    const rawBaselineValue = parsed.baseline_value ?? parsed.current_value;
    if (rawBaselineValue !== undefined && rawBaselineValue !== null) {
      baselineSeeds.push(String(rawBaselineValue));
    }

    return {
      rule: ruleResult.data,
      subSentinels,
      baselineValue: rawBaselineValue === undefined || rawBaselineValue === null ? undefined : String(rawBaselineValue),
      baselineSeeds,
    };
  } catch {
    return {};
  }
}

/** Register the durable EventBridge -> SQS cadence only in explicit AWS mode. */
export async function ensureExecutionSchedulerRegistered(): Promise<void> {
  if (!usesAwsInfrastructure()) return;

  const targetArn = process.env.SENTINEL_SCHEDULER_TARGET_ARN;
  const roleArn = process.env.SENTINEL_SCHEDULER_ROLE_ARN;
  if (!targetArn || !roleArn) {
    throw new Error('AWS scheduler registration requires SENTINEL_SCHEDULER_TARGET_ARN and SENTINEL_SCHEDULER_ROLE_ARN');
  }
  await ensureConfiguredScheduler();
}

/** Atomically stage the PAUSED rule, confirmation card, and conversation phase. */
export async function stageDeploymentProposal(input: {
  rule: Rule;
  subSentinels: SubSentinel[];
  baselineValue?: string;
  baselineSeeds?: string[];
}): Promise<EnrichedInterruptAction> {
  const now = Date.now();
  const rule: Rule = { ...input.rule, status: 'PAUSED', updated_at: now };
  if (!rule.conversation_id) {
    throw new Error('A deployment proposal requires a conversation');
  }
  const interrupt: InterruptAction = {
    id: randomUUID(),
    rule_id: rule.id,
    user_id: rule.user_id,
    action_type: 'CONFIRM_WATCHER',
    action_payload: JSON.stringify({
      rule,
      subSentinels: input.subSentinels,
      baselineSeeds: input.baselineSeeds?.length
        ? input.baselineSeeds
        : input.subSentinels.map((sub) => `${sub.target_source}_${input.baselineValue || 'baseline'}`),
      title: rule.title,
      summary: `Watch ${rule.title} with audio tone "${rule.audio_tone}".`,
      baselineValue: input.baselineValue || 'Live pre-flight verified',
      cadence: 'Checked every 1 minute ($0.00 cost)',
    }),
    status: 'PENDING',
    expires_at: now + 15 * 60 * 1000,
    created_at: now,
  };
  const staged = await deploymentRepository.stage({
    conversationId: rule.conversation_id,
    rule,
    interrupt,
    now,
  });
  if (!staged) {
    throw new Error('Unable to atomically stage the deployment proposal');
  }

  return {
    ...interrupt,
    conversation_id: rule.conversation_id,
    rule_title: rule.title,
  };
}

/** Return an idempotent no-op result without appending another chat completion. */
async function getPreviouslyResolvedResult(input: {
  interruptId: string;
  conversationId: string;
  userId: string;
}): Promise<DeploymentResolution | null> {
  const current = await interruptActionRepository.getById(input.interruptId);
  if (
    !current ||
    current.user_id !== input.userId ||
    current.conversation_id !== input.conversationId ||
    !['APPROVED', 'REJECTED'].includes(current.status)
  ) {
    return null;
  }
  if (current.status === 'APPROVED') {
    const rule = await ruleRepository.getById(current.rule_id);
    return {
      messageId: null,
      message: 'This confirmation was already approved. The watcher remains active.',
      rule,
      subSentinels: rule ? await subSentinelRepository.getByRuleId(rule.id) : [],
      resolvedAt: current.resolved_at ?? Date.now(),
      alreadyResolved: true,
    };
  }
  return {
    messageId: null,
    message: 'This confirmation was already dismissed. No watcher was deployed.',
    rule: null,
    subSentinels: [],
    resolvedAt: current.resolved_at ?? Date.now(),
    alreadyResolved: true,
  };
}

/** Resolve a confirmation card and commit all of its durable side effects. */
export async function resolveDeploymentProposal(input: {
  interrupt: EnrichedInterruptAction;
  resolution: 'APPROVED' | 'REJECTED';
  conversationId: string;
  userId: string;
}): Promise<DeploymentResolution> {
  const { interrupt, resolution, conversationId, userId } = input;
  if (interrupt.user_id !== userId || interrupt.conversation_id !== conversationId) {
    throw new Error('Interrupt does not belong to this user or conversation');
  }

  const parsedPayload = (() => {
    try {
      const value = JSON.parse(interrupt.action_payload) as Record<string, unknown>;
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  })();
  const ruleResult = RuleSchema.safeParse(parsedPayload.rule);
  if (!ruleResult.success) {
    throw new Error('Deployment proposal is missing a valid rule bundle');
  }
  const rule = ruleResult.data;
  if (rule.id !== interrupt.rule_id || rule.user_id !== userId || rule.conversation_id !== conversationId) {
    throw new Error('Deployment proposal does not match its confirmation card');
  }

  const now = Date.now();
  let deployMessage: string;
  let resolvedRule: Rule | null = null;
  let resolvedSubSentinels: SubSentinel[] = [];

  if (resolution === 'APPROVED') {
    if (!Array.isArray(parsedPayload.subSentinels) || parsedPayload.subSentinels.length === 0) {
      throw new Error('Approved deployment is missing a valid rule bundle');
    }
    const subSentinels: SubSentinel[] = [];
    for (const candidate of parsedPayload.subSentinels) {
      const subResult = SubSentinelSchema.safeParse(candidate);
      if (!subResult.success) {
        throw new Error('Approved deployment contains an invalid sub-sentinel');
      }
      subSentinels.push(subResult.data);
    }
    if (subSentinels.some((sub) => sub.rule_id !== rule.id)) {
      throw new Error('Approved deployment contains a sub-sentinel for another rule');
    }

    await ensureExecutionSchedulerRegistered();
    const seeds = Array.isArray(parsedPayload.baselineSeeds) && parsedPayload.baselineSeeds.length > 0
      ? [...new Set(parsedPayload.baselineSeeds.map((seed) => String(seed)))]
      : [String(parsedPayload.baselineValue ?? 'initial_baseline')];
    const baselineEvents = subSentinels.flatMap((sub) => seeds.map((seed) => ({
      id: createHash('sha256').update(`${sub.id}_${seed}`).digest('hex'),
      sub_sentinel_id: sub.id,
      source: sub.target_source,
      event_hash: seed,
    })));
    const committed = await deploymentRepository.approve({
      interruptId: interrupt.id,
      conversationId,
      rule: { ...rule, status: 'PAUSED' },
      subSentinels,
      baselineEvents,
      now,
    });
    if (!committed) {
      const previous = await getPreviouslyResolvedResult({
        interruptId: interrupt.id,
        conversationId,
        userId,
      });
      if (previous) return previous;
      throw new Error('Interrupt is no longer pending or has expired');
    }

    resolvedRule = { ...rule, status: 'ACTIVE', updated_at: now };
    resolvedSubSentinels = subSentinels;
    deployMessage =
      `✅ **Sentinel Task Confirmed & Deployed!**\n\n` +
      `Your watcher **"${rule.title}"** is now actively registered. ` +
      'The interactive setup agent has handed the task to the background evaluator pipeline, including agentic LLM checks wherever the condition requires semantic judgment.';
  } else {
    const committed = await deploymentRepository.reject({
      interruptId: interrupt.id,
      conversationId,
      rule,
      now,
    });
    if (!committed) {
      const previous = await getPreviouslyResolvedResult({
        interruptId: interrupt.id,
        conversationId,
        userId,
      });
      if (previous) return previous;
      throw new Error('Interrupt is no longer pending or has expired');
    }
    deployMessage =
      '❌ **Watcher Configuration Dismissed.**\n\n' +
      'The proposed Sentinel task was discarded. You can ask questions or formulate a new monitoring task.';
  }

  const messageId = randomUUID();
  await chatMessageRepository.create({
    id: messageId,
    conversation_id: conversationId,
    role: 'assistant',
    content: deployMessage,
    created_at: now,
  });

  return {
    messageId,
    message: deployMessage,
    rule: resolvedRule,
    subSentinels: resolvedSubSentinels,
    resolvedAt: now,
    alreadyResolved: false,
  };
}
