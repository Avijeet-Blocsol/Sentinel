import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentConversation, InterruptAction, Rule, SubSentinel, User } from '@sentinel/shared';
import { prepareTaskEdit } from '../src/services/task_edit_workflow.js';

function makeRule(userId: string, conversationId: string): Rule {
  return {
    id: randomUUID(),
    user_id: userId,
    conversation_id: conversationId,
    title: 'Task edit test',
    natural_language_intent: 'Watch BTC and ETH conditions',
    category: 'CRYPTO',
    combinator: 'AND',
    condition_tree: null,
    trigger_mode: 'ONE_SHOT',
    cooldown_minutes: 60,
    audio_tone: 'chime',
    status: 'TRIGGERED',
    last_triggered_at: Date.now() - 1_000,
    created_at: Date.now() - 10_000,
    updated_at: Date.now() - 5_000,
  };
}

function makeSub(ruleId: string, targetSource: string, threshold: number): SubSentinel {
  return {
    id: randomUUID(),
    rule_id: ruleId,
    sentinel_type: 'CRYPTO',
    target_source: targetSource,
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      assetSymbol: targetSource,
      currency: 'USD',
      targetType: 'PRICE',
      targetValue: threshold,
      operator: 'GREATER_THAN',
    }),
    ttl_seconds: 300,
    last_evaluated_at: Date.now() - 10_000,
    next_evaluation_at: Date.now() + 100_000,
    last_triggered_at: Date.now() - 1_000,
    is_satisfied: 1,
    satisfied_at: Date.now() - 1_000,
    state_payload: JSON.stringify({ currentValue: threshold + 1, sourceTimestamp: Date.now() }),
    health_status: 'DEGRADED',
    error_count: 2,
    last_error: 'old error',
  };
}

async function run() {
  const userId = randomUUID();
  const conversationId = randomUUID();
  const rule = makeRule(userId, conversationId);
  const btc = makeSub(rule.id, 'BTC', 75_000);
  const eth = makeSub(rule.id, 'ETH', 4_000);
  const now = Date.now();

  const updated = prepareTaskEdit({
    rule,
    subSentinels: [btc, eth],
    proposal: {
      operation: 'UPDATE_CONDITION',
      target_sub_sentinel_id: btc.id,
      target_label: 'BTC price',
      summary: 'Check BTC every five minutes above 80,000 USD',
      changes: {
        schedule_seconds: 300,
        operator: 'CROSSES_ABOVE',
        threshold_patch: { targetValue: 80_000 },
      },
    },
    now,
  });
  assert.equal(updated.rule.status, 'ACTIVE');
  assert.equal(updated.subSentinels[0]?.ttl_seconds, 300);
  assert.equal(updated.subSentinels[0]?.operator, 'CROSSES_ABOVE');
  assert.equal(JSON.parse(updated.subSentinels[0]!.threshold).targetValue, 80_000);
  assert.equal(updated.subSentinels[0]?.is_satisfied, 0);
  assert.equal(updated.subSentinels[0]?.next_evaluation_at, now);

  const treeRule = {
    ...rule,
    condition_tree: JSON.stringify({
      type: 'AND',
      children: [
        { type: 'LEAF', subSentinelId: btc.id },
        { type: 'LEAF', subSentinelId: eth.id },
      ],
    }),
  } satisfies Rule;
  const deleted = prepareTaskEdit({
    rule: treeRule,
    subSentinels: [btc, eth],
    proposal: {
      operation: 'DELETE_CONDITION',
      target_sub_sentinel_id: eth.id,
      target_label: 'ETH price',
      summary: 'Remove the ETH condition',
      changes: {},
    },
    now,
  });
  assert.equal(deleted.subSentinels.length, 1);
  assert.deepEqual(JSON.parse(deleted.rule.condition_tree!), { type: 'LEAF', subSentinelId: btc.id });
  assert.deepEqual(deleted.deletedSubSentinelIds, [eth.id]);

  const modeChanged = prepareTaskEdit({
    rule,
    subSentinels: [btc, eth],
    proposal: {
      operation: 'CHANGE_TRIGGER_MODE',
      summary: 'Switch to continuous monitoring',
      changes: { trigger_mode: 'PERSISTENT' },
    },
    now,
  });
  assert.equal(modeChanged.rule.trigger_mode, 'PERSISTENT');
  assert.equal(modeChanged.rule.last_triggered_at, null);
  assert.ok(modeChanged.subSentinels.every((sub) => sub.is_satisfied === 0));

  assert.equal(prepareTaskEdit({
    rule: { ...rule, combinator: 'SINGLE' },
    subSentinels: [btc, eth],
    proposal: {
      operation: 'DELETE_CONDITION',
      target_sub_sentinel_id: eth.id,
      summary: 'Remove ETH',
      changes: {},
    },
    now,
  }).subSentinels.length, 1);
  assert.throws(() => prepareTaskEdit({
    rule,
    subSentinels: [btc],
    proposal: {
      operation: 'DELETE_CONDITION',
      target_sub_sentinel_id: btc.id,
      summary: 'Remove BTC',
      changes: {},
    },
    now,
  }), /retain at least one/);

  const dbPath = path.resolve('data/task_edit_workflow_test.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.SENTINEL_INFRASTRUCTURE_MODE = 'local';
  process.env.DATABASE_PATH = dbPath;
  const db = await import('../src/db/index.js');
  const user: User = {
    id: userId,
    email: `${userId}@sentinel.local`,
    name: 'Task Edit Test',
    google_sub: null,
    apple_sub: null,
    github_sub: null,
    created_at: now,
    updated_at: now,
  };
  const conversation: AgentConversation = {
    id: conversationId,
    user_id: userId,
    title: 'Task edit test',
    status: 'SYNTHESIZED',
    phase: 'CLARIFICATION_PENDING',
    created_at: now,
  };
  const interrupt: InterruptAction = {
    id: randomUUID(),
    alert_id: null,
    rule_id: rule.id,
    conversation_id: conversationId,
    user_id: userId,
    action_type: 'TASK_EDIT_CONFIRMATION_REQUIRED',
    action_payload: JSON.stringify({}),
    status: 'PENDING',
    expires_at: now + 60_000,
    created_at: now,
    resolved_at: null,
  };
  await db.userRepository.create(user);
  await db.conversationRepository.create(conversation);
  await db.ruleRepository.create({ ...rule, status: 'ACTIVE', updated_at: rule.updated_at });
  await db.subSentinelRepository.create(btc);
  await db.subSentinelRepository.create(eth);
  await db.interruptActionRepository.create(interrupt);
  const committed = await db.deploymentRepository.applyTaskEdit({
    interruptId: interrupt.id,
    conversationId,
    userId,
    expectedRuleUpdatedAt: rule.updated_at,
    rule: updated.rule,
    subSentinels: updated.subSentinels,
    deletedSubSentinelIds: [],
    now,
  });
  assert.equal(committed, true);
  assert.equal((await db.ruleRepository.getById(rule.id))?.status, 'ACTIVE');
  assert.equal((await db.subSentinelRepository.getByRuleId(rule.id))[0]?.operator, 'CROSSES_ABOVE');
  assert.equal((await db.interruptActionRepository.getById(interrupt.id))?.status, 'APPROVED');
  assert.equal((await db.conversationRepository.getById(conversationId))?.phase, 'DEPLOYED');
  assert.equal(await db.deploymentRepository.applyTaskEdit({
    interruptId: interrupt.id,
    conversationId,
    userId,
    expectedRuleUpdatedAt: rule.updated_at,
    rule: updated.rule,
    subSentinels: updated.subSentinels,
    deletedSubSentinelIds: [],
    now,
  }), false);
  db.closeDatabase();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  console.log('task_edit_workflow.test.ts: PASS');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
