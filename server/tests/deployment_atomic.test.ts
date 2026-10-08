import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AgentConversation, InterruptAction, Rule, SubSentinel, User } from '@sentinel/shared';
import {
  userRepository,
  conversationRepository,
  chatMessageRepository,
  ruleRepository,
  subSentinelRepository,
  seenEventRepository,
  interruptActionRepository,
  deploymentRepository,
} from '../src/db/index.js';
import { resolveDeploymentProposal } from '../src/services/deployment_workflow.js';

function makeRule(userId: string, conversationId: string, status: Rule['status'] = 'PAUSED'): Rule {
  return {
    id: randomUUID(),
    user_id: userId,
    conversation_id: conversationId,
    title: 'Atomic deployment test',
    natural_language_intent: 'Watch BTC above 1',
    category: 'CRYPTO',
    combinator: 'SINGLE',
    trigger_mode: 'PERSISTENT',
    cooldown_minutes: 60,
    audio_tone: 'chime',
    status,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function makeConversation(userId: string): AgentConversation {
  return {
    id: randomUUID(),
    user_id: userId,
    title: 'Atomic deployment test',
    status: 'ACTIVE',
    phase: 'INTERRUPT_PENDING',
    created_at: Date.now(),
  };
}

function makeSub(ruleId: string): SubSentinel {
  return {
    id: randomUUID(),
    rule_id: ruleId,
    sentinel_type: 'CRYPTO',
    target_source: 'BTC',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({ assetSymbol: 'BTC', currency: 'USD', targetType: 'PRICE', targetValue: 1, operator: 'GREATER_THAN' }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };
}

async function run() {
  const user: User = {
    id: randomUUID(),
    email: `${randomUUID()}@sentinel.local`,
    name: 'Atomic Deployment Test',
    google_sub: null,
    apple_sub: null,
    github_sub: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await userRepository.create(user);

  // Staging a card is also a transactional boundary: no evaluator-visible
  // rule may exist without its matching human confirmation action.
  const conversation = makeConversation(user.id);
  const rule = makeRule(user.id, conversation.id);
  const sub = makeSub(rule.id);
  const interrupt: InterruptAction = {
    id: randomUUID(),
    rule_id: rule.id,
    user_id: user.id,
    action_type: 'CONFIRM_WATCHER',
    action_payload: JSON.stringify({ rule, subSentinels: [sub] }),
    status: 'PENDING',
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
  };
  await conversationRepository.create(conversation);
  assert.equal(await deploymentRepository.stage({
    conversationId: conversation.id,
    rule,
    interrupt,
    now: Date.now(),
  }), true);
  assert.equal((await ruleRepository.getById(rule.id))?.status, 'PAUSED');
  assert.equal((await interruptActionRepository.getById(interrupt.id))?.status, 'PENDING');
  assert.equal((await conversationRepository.getById(conversation.id))?.phase, 'INTERRUPT_PENDING');

  const mismatchedRule = makeRule(user.id, randomUUID());
  const mismatchedInterrupt: InterruptAction = {
    ...interrupt,
    id: randomUUID(),
    rule_id: mismatchedRule.id,
    action_payload: JSON.stringify({ rule: mismatchedRule }),
    created_at: Date.now(),
  };
  assert.equal(await deploymentRepository.stage({
    conversationId: conversation.id,
    rule: mismatchedRule,
    interrupt: mismatchedInterrupt,
    now: Date.now(),
  }), false);
  assert.equal(await ruleRepository.getById(mismatchedRule.id), null);

  const workflowConversation = makeConversation(user.id);
  const workflowRule = makeRule(user.id, workflowConversation.id);
  const workflowSub = makeSub(workflowRule.id);
  const workflowInterrupt: InterruptAction = {
    ...interrupt,
    id: randomUUID(),
    rule_id: workflowRule.id,
    action_payload: JSON.stringify({ rule: workflowRule, subSentinels: [workflowSub] }),
    created_at: Date.now(),
  };
  await conversationRepository.create(workflowConversation);
  assert.equal(await deploymentRepository.stage({
    conversationId: workflowConversation.id,
    rule: workflowRule,
    interrupt: workflowInterrupt,
    now: Date.now(),
  }), true);
  const stagedInterrupt = await interruptActionRepository.getById(workflowInterrupt.id);
  assert.ok(stagedInterrupt);
  const firstResolution = await resolveDeploymentProposal({
    interrupt: stagedInterrupt!,
    resolution: 'APPROVED',
    conversationId: workflowConversation.id,
    userId: user.id,
  });
  assert.equal(firstResolution.alreadyResolved, false);
  assert.ok(firstResolution.messageId);
  const duplicateResolution = await resolveDeploymentProposal({
    interrupt: stagedInterrupt!,
    resolution: 'APPROVED',
    conversationId: workflowConversation.id,
    userId: user.id,
  });
  assert.equal(duplicateResolution.alreadyResolved, true);
  assert.equal(duplicateResolution.messageId, null);
  assert.equal((await chatMessageRepository.getByConversationId(workflowConversation.id)).length, 1);

  const baseline = {
    id: randomUUID(),
    sub_sentinel_id: sub.id,
    source: 'BTC',
    event_hash: 'baseline-hash',
  };
  const committed = await deploymentRepository.approve({
    interruptId: interrupt.id,
    conversationId: conversation.id,
    rule: { ...rule, status: 'PAUSED' },
    subSentinels: [sub],
    baselineEvents: [baseline],
    now: Date.now(),
  });
  assert.equal(committed, true);
  assert.equal((await ruleRepository.getById(rule.id))?.status, 'ACTIVE');
  assert.equal((await conversationRepository.getById(conversation.id))?.phase, 'DEPLOYED');
  assert.equal((await interruptActionRepository.getById(interrupt.id))?.status, 'APPROVED');
  assert.equal((await subSentinelRepository.getByRuleId(rule.id)).length, 1);
  assert.equal(await seenEventRepository.isEventSeen(sub.id, baseline.event_hash), true);

  // A duplicate resolution must be a no-op and must not duplicate the
  // baseline event or assistant completion message.
  assert.equal(await deploymentRepository.approve({
    interruptId: interrupt.id,
    conversationId: conversation.id,
    rule: { ...rule, status: 'PAUSED' },
    subSentinels: [sub],
    baselineEvents: [baseline],
    now: Date.now(),
  }), false);

  const expiredConversation = makeConversation(user.id);
  const expiredRule = makeRule(user.id, expiredConversation.id);
  const expiredSub = makeSub(expiredRule.id);
  const expiredInterrupt: InterruptAction = {
    ...interrupt,
    id: randomUUID(),
    rule_id: expiredRule.id,
    action_payload: JSON.stringify({ rule: expiredRule, subSentinels: [expiredSub] }),
    status: 'PENDING',
    expires_at: Date.now() - 1,
    created_at: Date.now(),
  };
  await conversationRepository.create(expiredConversation);
  await ruleRepository.create(expiredRule);
  await interruptActionRepository.create(expiredInterrupt);
  assert.equal(await deploymentRepository.approve({
    interruptId: expiredInterrupt.id,
    conversationId: expiredConversation.id,
    rule: expiredRule,
    subSentinels: [expiredSub],
    baselineEvents: [],
    now: Date.now(),
  }), false);
  assert.equal((await ruleRepository.getById(expiredRule.id))?.status, 'PAUSED');
  assert.equal((await subSentinelRepository.getByRuleId(expiredRule.id)).length, 0);
  assert.equal((await interruptActionRepository.getById(expiredInterrupt.id))?.status, 'EXPIRED');

  const rejectedConversation = makeConversation(user.id);
  const rejectedRule = makeRule(user.id, rejectedConversation.id);
  const rejectedInterrupt: InterruptAction = {
    ...interrupt,
    id: randomUUID(),
    rule_id: rejectedRule.id,
    action_payload: JSON.stringify({ rule: rejectedRule }),
    status: 'PENDING',
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
  };
  await conversationRepository.create(rejectedConversation);
  await ruleRepository.create(rejectedRule);
  await interruptActionRepository.create(rejectedInterrupt);
  assert.equal(await deploymentRepository.reject({
    interruptId: rejectedInterrupt.id,
    conversationId: rejectedConversation.id,
    rule: rejectedRule,
    now: Date.now(),
  }), true);
  assert.equal((await ruleRepository.getById(rejectedRule.id))?.status, 'DISMISSED');
  assert.equal((await conversationRepository.getById(rejectedConversation.id))?.phase, 'DISCOVERY');
  assert.equal((await interruptActionRepository.getById(rejectedInterrupt.id))?.status, 'REJECTED');

  // The new setup gate has no interrupt row: the selected lifecycle mode is
  // itself the confirmation and atomically activates the paused proposal.
  const modeConversation = { ...makeConversation(user.id), phase: 'AWAITING_TRIGGER_MODE' as const };
  const modeRule = makeRule(user.id, modeConversation.id);
  const modeSub = makeSub(modeRule.id);
  await conversationRepository.create(modeConversation);
  assert.equal(await deploymentRepository.stageMonitoringMode({
    conversationId: modeConversation.id,
    rule: modeRule,
    subSentinels: [modeSub],
    baselineEvents: [{
      id: randomUUID(),
      sub_sentinel_id: modeSub.id,
      source: modeSub.target_source,
      event_hash: 'mode-baseline',
    }],
    now: Date.now(),
  }), true);
  assert.equal((await ruleRepository.getById(modeRule.id))?.status, 'PAUSED');
  assert.equal((await conversationRepository.getById(modeConversation.id))?.phase, 'AWAITING_TRIGGER_MODE');
  assert.equal((await interruptActionRepository.getPendingByUserId(user.id)).some((action) => action.rule_id === modeRule.id), false);
  assert.equal(await deploymentRepository.deployMonitoringMode({
    conversationId: modeConversation.id,
    userId: user.id,
    ruleId: modeRule.id,
    triggerMode: 'ONE_SHOT',
    now: Date.now(),
  }), true);
  assert.equal((await ruleRepository.getById(modeRule.id))?.status, 'ACTIVE');
  assert.equal((await ruleRepository.getById(modeRule.id))?.trigger_mode, 'ONE_SHOT');
  assert.equal((await conversationRepository.getById(modeConversation.id))?.phase, 'DEPLOYED');

  // Clarification interrupts are allowed before a rule exists and move the
  // conversation into a durable blockade until one of the persisted choices
  // is selected.
  const clarificationConversation: AgentConversation = {
    ...makeConversation(user.id),
    phase: 'SCOUTING',
  };
  await conversationRepository.create(clarificationConversation);
  const clarificationInterrupt: InterruptAction = {
    id: randomUUID(),
    alert_id: null,
    rule_id: null,
    conversation_id: clarificationConversation.id,
    user_id: user.id,
    action_type: 'CLARIFICATION_REQUIRED',
    action_payload: JSON.stringify({
      kind: 'CLARIFICATION_REQUIRED',
      question: 'Which source should Sentinel monitor?',
      choices: [
        { id: 'official', label: 'Official source' },
        { id: 'community', label: 'Community sources' },
      ],
      field: 'source_preference',
      resume_phase: 'SCOUTING',
    }),
    status: 'PENDING',
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
    resolved_at: null,
  };
  assert.equal(await interruptActionRepository.createClarification({
    action: clarificationInterrupt,
    conversationId: clarificationConversation.id,
    userId: user.id,
    expectedPhase: 'SCOUTING',
    now: Date.now(),
  }), true);
  assert.equal((await conversationRepository.getById(clarificationConversation.id))?.phase, 'CLARIFICATION_PENDING');
  const pendingClarification = await interruptActionRepository.getById(clarificationInterrupt.id);
  assert.equal(pendingClarification?.conversation_id, clarificationConversation.id);
  assert.equal(pendingClarification?.rule_id, null);
  assert.equal(await interruptActionRepository.resolveClarification({
    interruptId: clarificationInterrupt.id,
    conversationId: clarificationConversation.id,
    userId: user.id,
    resolution: 'APPROVED',
    resumePhase: 'SCOUTING',
    now: Date.now(),
  }), true);
  assert.equal((await interruptActionRepository.getById(clarificationInterrupt.id))?.status, 'APPROVED');
  assert.equal((await conversationRepository.getById(clarificationConversation.id))?.phase, 'SCOUTING');

  console.log('PASS atomic proposal/deployment commit, clarification lifecycle, duplicate no-op, expiry rollback, and rejection lifecycle');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
