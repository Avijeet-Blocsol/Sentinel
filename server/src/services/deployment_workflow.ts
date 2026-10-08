/**
 * Durable deployment lifecycle for a Sentinel conversation.
 *
 * Transport handlers may render cards and messages, but this module owns the
 * persistence boundaries: staging a proposal, registering its scheduler, and
 * committing the selected lifecycle mode.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  RuleSchema,
  SubSentinelSchema,
  SubSentinelThresholdSchema,
  parseConditionTree,
  type ConditionNode,
  type EnrichedInterruptAction,
  type InterruptAction,
  type Rule,
  type SubSentinel,
  type TriggerMode,
} from '@sentinel/shared';
import {
  chatMessageRepository,
  conversationRepository,
  deploymentRepository,
  interruptActionRepository,
  ruleRepository,
  subSentinelRepository,
} from '../db/index.js';
import { ensureConfiguredScheduler } from '../execution/scheduler_registration.js';
import { usesAwsInfrastructure } from '../config/infrastructure_mode.js';
import { parseJsonValue } from '../agent/structured_query_agent.js';

export interface SynthesizedRuleBundle {
  rule?: Rule;
  subSentinels?: SubSentinel[];
  baselineValue?: string;
  baselineSeeds?: string[];
}

const MAX_BASELINE_SEEDS = 50;
const MAX_BASELINE_SEED_LENGTH = 512;

/** Bound provider/model supplied baseline data before it reaches a durable
 * transaction or interrupt payload. This keeps RSS feeds and malformed model
 * output from exceeding DynamoDB transaction/item limits. */
export function normalizeBaselineSeeds(seeds: readonly unknown[]): string[] {
  return [...new Set(seeds
    .map((seed) => String(seed).trim())
    .filter(Boolean)
    .map((seed) => seed.slice(0, MAX_BASELINE_SEED_LENGTH)))]
    .slice(0, MAX_BASELINE_SEEDS);
}

export interface DeploymentResolution {
  messageId: string | null;
  message: string;
  rule: Rule | null;
  subSentinels: SubSentinel[];
  resolvedAt: number;
  alreadyResolved: boolean;
}

export interface MonitoringModeResolution {
  message: string;
  rule: Rule;
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

/** Baseline events are seeded while the rule is PAUSED, so the first live
 * evaluation cannot replay values observed during pre-flight. */
export function buildBaselineEvents(
  subSentinels: SubSentinel[],
  seeds: string[],
): Array<{ id: string; sub_sentinel_id: string; source: string; event_hash: string }> {
  const uniqueSeeds = normalizeBaselineSeeds(seeds);
  return subSentinels.flatMap((sub) => uniqueSeeds.map((seed) => ({
    id: createHash('sha256').update(`${sub.id}_${seed}`).digest('hex'),
    sub_sentinel_id: sub.id,
    source: sub.target_source,
    event_hash: seed,
  })));
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
    const parsedValue = parseJsonValue(text);
    const parsed = parsedValue as Record<string, unknown> | null;
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
      // Never turn an incomplete model bundle into a live watcher by filling
      // operational fields with guessed values. A missing target/operator,
      // threshold, or cadence must fail the persistence boundary closed.
      const sentinelType = rawSub.sentinel_type ?? rawSub.sentinelType;
      const targetSource = rawSub.target_source ?? rawSub.targetSource ?? rawSub.ticker;
      const operator = rawSub.operator;
      const rawThreshold = rawSub.threshold;
      const ttlSeconds = rawSub.ttl_seconds;
      if (
        typeof sentinelType !== 'string' || !sentinelType.trim() ||
        typeof targetSource !== 'string' || !targetSource.trim() ||
        typeof operator !== 'string' || !operator.trim() ||
        rawThreshold === undefined || rawThreshold === null ||
        ttlSeconds === undefined || ttlSeconds === null
      ) return {};
      const serializedThreshold = typeof rawThreshold === 'string'
        ? rawThreshold
        : JSON.stringify(rawThreshold);
      if (!serializedThreshold || serializedThreshold === 'undefined') return {};
      const thresholdObject = parseJsonValue(serializedThreshold);
      if (!thresholdObject || typeof thresholdObject !== 'object' || Array.isArray(thresholdObject)) return {};
      const thresholdCurrency = (thresholdObject as Record<string, unknown>).currency;
      // A crypto price is meaningless without its explicit quote unit. The
      // shared threshold schema historically defaulted this to USD; the
      // persistence boundary must not silently change the user's task.
      if (sentinelType.toUpperCase() === 'CRYPTO' &&
          !(typeof thresholdCurrency === 'string' && Boolean(thresholdCurrency.trim()))) {
        return {};
      }
      const thresholdResult = SubSentinelThresholdSchema.safeParse(thresholdObject);
      if (!thresholdResult.success) return {};
      // Persist the schema-normalized threshold, not the raw model object.
      // This strips unsupported fields (such as an unverified alternate URL)
      // before evaluators or later edits can act on them.
      const canonicalThreshold = JSON.stringify(thresholdResult.data);
      const subSentinelId = randomUUID();
      const subResult = SubSentinelSchema.safeParse({
        id: subSentinelId,
        rule_id: ruleId,
        sentinel_type: sentinelType,
        target_source: targetSource,
        operator,
        threshold: canonicalThreshold,
        ttl_seconds: ttlSeconds,
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
    // Some model responses describe a single condition-tree leaf as the
    // combinator itself (`LEAF`). `LEAF` is an AST node, not a rule combinator;
    // normalize that unambiguous single-watcher shape before schema validation.
    const combinator = parsed.combinator === 'LEAF' && conditionTree
      ? 'SINGLE'
      : parsed.combinator
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
      ? normalizeBaselineSeeds(parsed.baseline_seeds)
      : [];
    const rawBaselineValue = parsed.baseline_value ?? parsed.current_value;
    if (rawBaselineValue !== undefined && rawBaselineValue !== null) {
      baselineSeeds.push(String(rawBaselineValue));
    }

    return {
      rule: ruleResult.data,
      subSentinels,
      baselineValue: rawBaselineValue === undefined || rawBaselineValue === null ? undefined : String(rawBaselineValue),
      baselineSeeds: normalizeBaselineSeeds(baselineSeeds),
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
        ? normalizeBaselineSeeds(input.baselineSeeds)
        : input.subSentinels.map((sub) => `${sub.target_source}_${input.baselineValue || 'baseline'}`),
      title: rule.title,
      summary: `Watch ${rule.title} with audio tone "${rule.audio_tone}".`,
      baselineValue: input.baselineValue || 'Live pre-flight verified',
      cadence: 'Checked every 1 minute ($0.00 cost)',
      choices: [
        {
          id: 'approve',
          label: 'Confirm & deploy',
          description: 'Activate this verified Sentinel monitor.',
        },
        {
          id: 'reject',
          label: 'Dismiss',
          description: 'Discard this proposed monitor.',
        },
      ],
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

/** Atomically stage a PAUSED rule and its watchers while awaiting lifecycle selection. */
export async function stageMonitoringModeProposal(input: {
  rule: Rule;
  subSentinels: SubSentinel[];
  baselineValue?: string;
  baselineSeeds?: string[];
}): Promise<boolean> {
  const rule: Rule = { ...input.rule, status: 'PAUSED', updated_at: Date.now() };
  if (!rule.conversation_id) {
    throw new Error('A monitoring-mode proposal requires a conversation');
  }
  const seeds = input.baselineSeeds?.length
    ? normalizeBaselineSeeds(input.baselineSeeds)
    : input.subSentinels.map((sub) => `${sub.target_source}_${input.baselineValue || 'baseline'}`);
  const staged = await deploymentRepository.stageMonitoringMode({
    conversationId: rule.conversation_id,
    rule,
    subSentinels: input.subSentinels,
    baselineEvents: buildBaselineEvents(input.subSentinels, seeds),
    now: Date.now(),
  });
  if (staged) return true;

  // Cross-process retries can lose the conditional transaction after the
  // first worker has already committed the exact same staged proposal. Treat
  // that state as idempotent; a genuinely different phase/owner remains a
  // hard failure.
  const existingRule = await ruleRepository.getById(rule.id);
  const conversation = await conversationRepository.getById(rule.conversation_id);
  if (existingRule && conversation?.phase === 'AWAITING_TRIGGER_MODE' &&
      existingRule.user_id === rule.user_id &&
      existingRule.conversation_id === rule.conversation_id &&
      existingRule.status === 'PAUSED') {
    return true;
  }
  return false;
}

/** Commit the user's lifecycle choice and make the staged rule evaluator-visible. */
export async function deployMonitoringModeProposal(input: {
  conversationId: string;
  userId: string;
  ruleId: string;
  triggerMode: TriggerMode;
}): Promise<MonitoringModeResolution> {
  const stagedRule = await ruleRepository.getById(input.ruleId);
  if (
    !stagedRule ||
    stagedRule.user_id !== input.userId ||
    stagedRule.conversation_id !== input.conversationId ||
    (stagedRule.status !== 'PAUSED' && stagedRule.status !== 'ACTIVE')
  ) {
    throw new Error('Monitoring-mode proposal is missing or does not belong to this conversation');
  }

  if (stagedRule.status === 'ACTIVE') {
    if (stagedRule.trigger_mode !== input.triggerMode) {
      throw new Error('This Sentinel task has already been deployed with a different monitoring mode');
    }
    return {
      message: `This Sentinel task is already deployed for ${input.triggerMode === 'PERSISTENT' ? 'continuous monitoring' : 'one-time alerting'}.`,
      rule: stagedRule,
      subSentinels: await subSentinelRepository.getByRuleId(stagedRule.id),
      resolvedAt: Date.now(),
      alreadyResolved: true,
    };
  }

  // Revalidate the durable bundle at the final lifecycle boundary. Older
  // local builds could have left a paused rule with a schema-defaulted crypto
  // threshold; never activate one without an explicit quote currency.
  const stagedSubSentinels = await subSentinelRepository.getByRuleId(stagedRule.id);
  for (const sub of stagedSubSentinels) {
    const rawThreshold = parseJsonValue(sub.threshold);
    if (sub.sentinel_type === 'CRYPTO' &&
        (!rawThreshold || typeof rawThreshold !== 'object' || Array.isArray(rawThreshold) ||
          !(typeof (rawThreshold as Record<string, unknown>).currency === 'string' &&
            Boolean(((rawThreshold as Record<string, unknown>).currency as string).trim())))) {
      throw new Error('Monitoring-mode deployment requires an explicit crypto quote currency');
    }
    if (!SubSentinelThresholdSchema.safeParse(rawThreshold).success) {
      throw new Error('Monitoring-mode deployment contains an invalid condition threshold');
    }
  }

  await ensureExecutionSchedulerRegistered();
  const committed = await deploymentRepository.deployMonitoringMode({
    conversationId: input.conversationId,
    userId: input.userId,
    ruleId: input.ruleId,
    triggerMode: input.triggerMode,
    now: Date.now(),
  });
  if (!committed) {
    const current = await ruleRepository.getById(input.ruleId);
    if (current?.status === 'ACTIVE' && current.trigger_mode === input.triggerMode) {
      return {
        message: `This Sentinel task is already deployed for ${input.triggerMode === 'PERSISTENT' ? 'continuous monitoring' : 'one-time alerting'}.`,
        rule: current,
        subSentinels: await subSentinelRepository.getByRuleId(current.id),
        resolvedAt: Date.now(),
        alreadyResolved: true,
      };
    }
    throw new Error('Monitoring-mode proposal is no longer awaiting a lifecycle choice');
  }

  const deployedRule = await ruleRepository.getById(input.ruleId);
  if (!deployedRule) throw new Error('Deployed Sentinel task could not be reloaded');
  return {
    message:
      `✅ **Sentinel Task Deployed!**\n\n` +
      `Your watcher **"${deployedRule.title}"** is now configured for ` +
      `${input.triggerMode === 'PERSISTENT' ? 'continuous monitoring' : 'a one-time alert'}. ` +
      (input.triggerMode === 'PERSISTENT'
        ? 'It will continue evaluating future observations until you stop it.'
        : 'It will finish after the first committed alert.'),
    rule: deployedRule,
    subSentinels: await subSentinelRepository.getByRuleId(deployedRule.id),
    resolvedAt: Date.now(),
    alreadyResolved: false,
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
    const rule = current.rule_id ? await ruleRepository.getById(current.rule_id) : null;
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
      const rawThreshold = parseJsonValue(subResult.data.threshold);
      if (subResult.data.sentinel_type === 'CRYPTO' &&
          (!rawThreshold || typeof rawThreshold !== 'object' || Array.isArray(rawThreshold) ||
            !(typeof (rawThreshold as Record<string, unknown>).currency === 'string' &&
              Boolean(((rawThreshold as Record<string, unknown>).currency as string).trim())))) {
        throw new Error('Approved deployment requires an explicit crypto quote currency');
      }
      const thresholdResult = SubSentinelThresholdSchema.safeParse(rawThreshold);
      if (!thresholdResult.success) {
        throw new Error('Approved deployment contains an invalid threshold');
      }
      subSentinels.push({
        ...subResult.data,
        threshold: JSON.stringify(thresholdResult.data),
      });
    }
    if (subSentinels.some((sub) => sub.rule_id !== rule.id)) {
      throw new Error('Approved deployment contains a sub-sentinel for another rule');
    }

    await ensureExecutionSchedulerRegistered();
    const seeds = Array.isArray(parsedPayload.baselineSeeds) && parsedPayload.baselineSeeds.length > 0
      ? normalizeBaselineSeeds(parsedPayload.baselineSeeds)
      : normalizeBaselineSeeds([String(parsedPayload.baselineValue ?? 'initial_baseline')]);
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
