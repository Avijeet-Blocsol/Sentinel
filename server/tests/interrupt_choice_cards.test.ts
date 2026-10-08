import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentConversation, Rule, SubSentinel, User } from '@sentinel/shared';

async function run(): Promise<void> {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'sentinel-interrupt-cards-'));
  process.env.NODE_ENV = 'test';
  process.env.SENTINEL_INFRASTRUCTURE_MODE = 'local';
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_PATH = join(tempDirectory, 'sentinel.db');

  const repositories = await import('../src/db/index.js');
  const workflow = await import('../src/services/clarification_workflow.js');
  const deployment = await import('../src/services/deployment_workflow.js');
  const realtime = await import('../src/api/realtime/ws_stream_handler.js');
  const realtimeRegistry = await import('../src/api/realtime/ws_connection_registry.js');
  const interruptsService = await import('../src/api/interrupts/interrupts.service.js');

  const user: User = {
    id: randomUUID(),
    email: `${randomUUID()}@sentinel.local`,
    name: 'Interrupt Card Test',
    google_sub: null,
    apple_sub: null,
    github_sub: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await repositories.userRepository.create(user);

  const clarificationConversation: AgentConversation = {
    id: randomUUID(),
    user_id: user.id,
    title: 'Clarification card test',
    status: 'ACTIVE',
    phase: 'DISCOVERY',
    created_at: Date.now(),
  };
  await repositories.conversationRepository.create(clarificationConversation);

  const action = await workflow.createClarificationInterrupt({
    conversationId: clarificationConversation.id,
    userId: user.id,
    expectedPhase: 'DISCOVERY',
    resumePhase: 'DISCOVERY',
    request: {
      question: 'Which quote currency should be used?',
      choices: [
        { id: 'USD', label: 'USD' },
        { id: 'EUR', label: 'EUR' },
      ],
    },
  });
  const payload = workflow.parseChoiceInterruptPayload(action);
  assert.ok(payload);
  assert.equal(payload.choices.at(-1)?.id, 'manual_response');
  assert.equal(payload.choices.at(-1)?.input?.kind, 'TEXT');
  await assert.rejects(() => workflow.createClarificationInterrupt({
    conversationId: clarificationConversation.id,
    userId: user.id,
    expectedPhase: 'CLARIFICATION_PENDING',
    resumePhase: 'DISCOVERY',
    request: {
      question: 'Duplicate option ids must be rejected',
      choices: [
        { id: 'same', label: 'First' },
        { id: 'same', label: 'Second' },
      ],
    },
  }), /unique ids/);

  const updated = await workflow.updateChoiceInterruptFeedback(
    action,
    'Your previous action does not resolve the interrupt, please provide the exact response along with the original interrupt title: Which quote currency should be used?',
  );
  assert.ok(updated);
  assert.match(workflow.parseChoiceInterruptPayload(updated!)?.retry_message ?? '', /Your previous action does not resolve/);

  const modeConversation: AgentConversation = {
    id: randomUUID(),
    user_id: user.id,
    title: 'Mode recovery test',
    status: 'ACTIVE',
    phase: 'AWAITING_TRIGGER_MODE',
    created_at: Date.now(),
  };
  await repositories.conversationRepository.create(modeConversation);
  const stagedRule: Rule = {
    id: randomUUID(),
    user_id: user.id,
    conversation_id: modeConversation.id,
    title: 'Recovered mode test',
    natural_language_intent: 'Watch BTC',
    category: 'CRYPTO',
    combinator: 'SINGLE',
    trigger_mode: 'PERSISTENT',
    cooldown_minutes: 60,
    audio_tone: 'chime',
    status: 'PAUSED',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await repositories.ruleRepository.create(stagedRule);

  const recovered = await realtime.ensureWorkflowChoiceInterrupt(modeConversation.id, user.id);
  assert.equal(recovered?.action_type, 'MONITORING_MODE_REQUIRED');
  assert.equal(workflow.parseChoiceInterruptPayload(recovered!)?.choices.at(-1)?.id, 'manual_response');

  const pending = await interruptsService.interruptsService.getPendingInterrupts(user.id);
  assert.ok(pending.some((item) => item.id === recovered?.id));
  const deliverySocket = {
    OPEN: 1,
    readyState: 1,
    sent: [] as string[],
    send(value: string) { this.sent.push(value); },
  } as any;
  assert.equal(realtimeRegistry.sendInterruptRequest(deliverySocket, recovered!), true);
  assert.equal(realtimeRegistry.sendInterruptRequest(deliverySocket, recovered!), false);
  assert.equal(realtimeRegistry.sendInterruptRequest(deliverySocket, {
    ...recovered!,
    action_payload: JSON.stringify({ ...JSON.parse(recovered!.action_payload), retry_message: 'updated' }),
  }), true);
  assert.equal(deliverySocket.sent.length, 2);

  // Staging the verified rule advances the durable phase before the mode card
  // is inserted. The handler must use AWAITING_TRIGGER_MODE for that second
  // transaction, not the stale SCOUTING phase from the agent stream.
  const stagedModeConversation: AgentConversation = {
    id: randomUUID(),
    user_id: user.id,
    title: 'Mode staging phase boundary test',
    status: 'ACTIVE',
    phase: 'SCOUTING',
    created_at: Date.now(),
  };
  await repositories.conversationRepository.create(stagedModeConversation);
  const stagedModeRule: Rule = {
    id: randomUUID(),
    user_id: user.id,
    conversation_id: stagedModeConversation.id,
    title: 'BTC mode boundary test',
    natural_language_intent: 'Watch BTC above 1',
    category: 'CRYPTO',
    combinator: 'SINGLE',
    trigger_mode: 'PERSISTENT',
    cooldown_minutes: 60,
    audio_tone: 'chime',
    status: 'PAUSED',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  const stagedModeSub: SubSentinel = {
    id: randomUUID(),
    rule_id: stagedModeRule.id,
    sentinel_type: 'CRYPTO',
    target_source: 'BTC',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({ assetSymbol: 'BTC', targetValue: 1, operator: 'GREATER_THAN' }),
    ttl_seconds: 300,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };
  assert.equal(await deployment.stageMonitoringModeProposal({
    rule: stagedModeRule,
    subSentinels: [stagedModeSub],
    baselineSeeds: ['btc:1'],
  }), true);
  assert.equal((await repositories.conversationRepository.getById(stagedModeConversation.id))?.phase, 'AWAITING_TRIGGER_MODE');
  const stagedModeInterrupt = await workflow.createChoiceInterrupt({
    conversationId: stagedModeConversation.id,
    userId: user.id,
    ruleId: stagedModeRule.id,
    expectedPhase: 'AWAITING_TRIGGER_MODE',
    resumePhase: 'AWAITING_TRIGGER_MODE',
    actionType: 'MONITORING_MODE_REQUIRED',
    request: {
      kind: 'MONITORING_MODE_REQUIRED',
      question: 'How should this verified Sentinel task run?',
      choices: [{ id: 'continuous_monitoring', label: 'Continuous monitoring' }],
    },
  });
  assert.equal(stagedModeInterrupt.action_type, 'MONITORING_MODE_REQUIRED');

  const queryConversation: AgentConversation = {
    id: randomUUID(),
    user_id: user.id,
    title: 'Query confirmation phase test',
    status: 'ACTIVE',
    phase: 'DISCOVERY',
    created_at: Date.now(),
  };
  await repositories.conversationRepository.create(queryConversation);
  const draftClarification = await workflow.createClarificationInterrupt({
    conversationId: queryConversation.id,
    userId: user.id,
    expectedPhase: 'DISCOVERY',
    resumePhase: 'AWAITING_QUERY_CONFIRMATION',
    request: {
      question: 'Which quote currency should be used?',
      choices: [{ id: 'USD', label: 'USD' }, { id: 'EUR', label: 'EUR' }],
    },
  });
  assert.equal(draftClarification.action_type, 'CLARIFICATION_REQUIRED');
  assert.equal((await repositories.conversationRepository.getById(queryConversation.id))?.phase, 'CLARIFICATION_PENDING');

  // Use a separate conversation for the query-confirmation recovery checks
  // below; the draft clarification above exercises the same phase boundary
  // used when request_clarification runs during a discovery draft.
  const recoveryConversation: AgentConversation = {
    id: randomUUID(),
    user_id: user.id,
    title: 'Query confirmation phase test',
    status: 'ACTIVE',
    phase: 'DISCOVERY',
    created_at: Date.now(),
  };
  await repositories.conversationRepository.create(recoveryConversation);
  const queryAction = await workflow.createChoiceInterrupt({
    conversationId: recoveryConversation.id,
    userId: user.id,
    expectedPhase: 'DISCOVERY',
    resumePhase: 'AWAITING_QUERY_CONFIRMATION',
    actionType: 'QUERY_CONFIRMATION_REQUIRED',
    request: {
      kind: 'QUERY_CONFIRMATION_REQUIRED',
      question: 'Review the proposed monitor.',
      choices: [
        { id: 'confirm', label: 'Launch live reconnaissance' },
        { id: 'modify', label: 'Modify this task' },
      ],
    },
  });
  assert.equal((await repositories.conversationRepository.getById(recoveryConversation.id))?.phase, 'CLARIFICATION_PENDING');
  // Reproduce the stale-card state from the mobile report and verify that a
  // reconnect/resolve repairs only this user-owned pending gate.
  await repositories.conversationRepository.updatePhase(recoveryConversation.id, 'DISCOVERY');
  assert.equal(await repositories.interruptActionRepository.restorePendingClarification({
    interruptId: queryAction.id,
    conversationId: recoveryConversation.id,
    userId: user.id,
    now: Date.now(),
  }), true);
  assert.equal(await repositories.interruptActionRepository.resolveClarification({
    interruptId: queryAction.id,
    conversationId: recoveryConversation.id,
    userId: user.id,
    resolution: 'APPROVED',
    resumePhase: 'AWAITING_QUERY_CONFIRMATION',
    now: Date.now(),
  }), true);
  assert.equal((await repositories.conversationRepository.getById(recoveryConversation.id))?.phase, 'AWAITING_QUERY_CONFIRMATION');
  // Dashboard/Socket recovery must not recreate the resolved launch card
  // while the approved resume is still queued behind the conversation lock.
  const heldWorkflowLock = new Promise<void>(() => undefined);
  realtime.conversationLocks.set(recoveryConversation.id, heldWorkflowLock);
  assert.equal(await realtime.ensureWorkflowChoiceInterrupt(recoveryConversation.id, user.id), null);
  realtime.conversationLocks.delete(recoveryConversation.id);

  // Approval is the atomic lifecycle boundary: the card is consumed and the
  // conversation enters reconnaissance in the same persistence transaction.
  const atomicConversation: AgentConversation = {
    id: randomUUID(),
    user_id: user.id,
    title: 'Atomic query approval test',
    status: 'ACTIVE',
    phase: 'DISCOVERY',
    created_at: Date.now(),
  };
  await repositories.conversationRepository.create(atomicConversation);
  const atomicQuery = await workflow.createChoiceInterrupt({
    conversationId: atomicConversation.id,
    userId: user.id,
    expectedPhase: 'DISCOVERY',
    resumePhase: 'AWAITING_QUERY_CONFIRMATION',
    actionType: 'QUERY_CONFIRMATION_REQUIRED',
    request: {
      kind: 'QUERY_CONFIRMATION_REQUIRED',
      question: 'Launch live reconnaissance?',
      choices: [{ id: 'confirm', label: 'Launch live reconnaissance' }],
    },
  });
  assert.equal(await repositories.interruptActionRepository.resolveClarification({
    interruptId: atomicQuery.id,
    conversationId: atomicConversation.id,
    userId: user.id,
    resolution: 'APPROVED',
    resumePhase: 'SCOUTING',
    now: Date.now(),
  }), true);
  assert.equal((await repositories.conversationRepository.getById(atomicConversation.id))?.phase, 'SCOUTING');
  assert.equal(await repositories.interruptActionRepository.resolveClarification({
    interruptId: atomicQuery.id,
    conversationId: atomicConversation.id,
    userId: user.id,
    resolution: 'APPROVED',
    resumePhase: 'SCOUTING',
    now: Date.now(),
  }), false);
  assert.equal((await repositories.interruptActionRepository.getById(atomicQuery.id))?.status, 'APPROVED');
  const atomicLeaseOwner = `test:${randomUUID()}`;
  assert.equal((await repositories.executionRepository.claim({
    id: `workflow-resume:${atomicQuery.id}`,
    event_type: 'WORKFLOW_RESUME',
    rule_id: null,
    lease_owner: atomicLeaseOwner,
    lease_expires_at: Date.now() + 60_000,
    now: Date.now(),
  })).claimed, true);
  await repositories.executionRepository.complete(
    `workflow-resume:${atomicQuery.id}`,
    atomicLeaseOwner,
    JSON.stringify({ phase: 'SCOUTING' }),
  );
  const duplicateResolutionMessages: Array<{ type: string; payload?: any }> = [];
  await realtime.handleResolveInterrupt(
    {
      OPEN: 1,
      readyState: 1,
      send(value: string) { duplicateResolutionMessages.push(JSON.parse(value)); },
    } as any,
    user,
    atomicConversation.id,
    atomicQuery.id,
    'APPROVED',
    'confirm',
    undefined,
    { error() {}, warn() {}, info() {}, debug() {} } as any,
  );
  assert.equal(duplicateResolutionMessages.filter((event) => event.type === 'ERROR').length, 0);
  assert.equal(duplicateResolutionMessages.find((event) => event.type === 'INTERRUPT_RESOLVED')?.payload.resolution, 'APPROVED');

  // Deterministic end-to-end resume: one approved query card invokes the
  // tool-enabled reconnaissance path once and produces the next lifecycle
  // card, never another query-confirmation card.
  const resumeConversation: AgentConversation = {
    id: randomUUID(),
    user_id: user.id,
    title: 'Query resume e2e test',
    status: 'ACTIVE',
    phase: 'DISCOVERY',
    created_at: Date.now(),
  };
  await repositories.conversationRepository.create(resumeConversation);
  const resumeQuery = await workflow.createChoiceInterrupt({
    conversationId: resumeConversation.id,
    userId: user.id,
    expectedPhase: 'DISCOVERY',
    resumePhase: 'AWAITING_QUERY_CONFIRMATION',
    actionType: 'QUERY_CONFIRMATION_REQUIRED',
    request: {
      kind: 'QUERY_CONFIRMATION_REQUIRED',
      question: 'Review the proposed monitor and choose how to continue.',
      field: 'query_confirmation',
      choices: [
        { id: 'confirm', label: 'Launch live reconnaissance' },
        { id: 'modify', label: 'Modify this task' },
      ],
    },
  });
  const streamEvents = [
    {
      type: 'beforeToolCallEvent',
      toolUse: { name: 'crypto_research', input: { assetSymbol: 'BTC', currency: 'USD', targetValue: 75_000 } },
    },
    {
      type: 'afterToolCallEvent',
      toolUse: { name: 'crypto_research' },
      result: {
        structuredOutput: {
          status: 'EXACT_MATCH',
          contract: {
            assetSymbol: 'BTC',
            currency: 'USD',
            venue: 'COINBASE',
            targetType: 'PRICE',
            targetValue: 75_000,
            operator: 'GREATER_THAN',
          },
        },
      },
    },
    {
      type: 'beforeToolCallEvent',
      toolUse: { name: 'pre_flight_dry_run', input: { targetType: 'CRYPTO', targetSource: 'BTC', currency: 'USD' } },
    },
    {
      type: 'afterToolCallEvent',
      toolUse: { name: 'pre_flight_dry_run' },
      result: {
        structuredOutput: {
          passed: true,
          targetType: 'CRYPTO',
          targetSource: 'BTC',
          currency: 'USD',
          baselineValue: '80,000 USD',
          baselineSeeds: ['btc:80000'],
        },
      },
    },
  ];
  let reconnaissanceInvocations = 0;
  realtime.agentCache.set(resumeConversation.id, {
    agent: {
      stream: async function* () {
        reconnaissanceInvocations += 1;
        yield* streamEvents;
      },
    },
  } as any);
  const sent: Array<{ type: string; payload?: any }> = [];
  const fakeSocket = {
    OPEN: 1,
    readyState: 1,
    send(value: string) { sent.push(JSON.parse(value)); },
    once() {},
    removeListener() {},
  } as any;
  await realtime.handleResolveInterrupt(
    fakeSocket,
    user,
    resumeConversation.id,
    resumeQuery.id,
    'APPROVED',
    'confirm',
    undefined,
    { error() {}, warn() {}, info() {}, debug() {} } as any,
  );
  assert.equal(reconnaissanceInvocations, 1);
  assert.equal((await repositories.conversationRepository.getById(resumeConversation.id))?.phase, 'CLARIFICATION_PENDING');
  const resumePending = await repositories.interruptActionRepository.getPendingByUserId(user.id);
  assert.equal(resumePending.filter((item) => item.conversation_id === resumeConversation.id).length, 1);
  assert.equal(resumePending.find((item) => item.conversation_id === resumeConversation.id)?.action_type, 'MONITORING_MODE_REQUIRED');
  assert.equal(sent.filter((event) => event.type === 'INTERRUPT_REQUEST').length, 1);
  assert.equal(sent.some((event) => event.type === 'INTERRUPT_REQUEST' && event.payload?.action_type === 'QUERY_CONFIRMATION_REQUIRED'), false);
  assert.equal(sent.some((event) => event.type === 'AGENT_CHAT_DONE' && event.payload?.interrupt), false);

  // A draft-provider clarification that is actually the launch gate must be
  // normalized to QUERY_CONFIRMATION_REQUIRED; otherwise resolving it would
  // resume a no-tools draft agent and fail with "crypto_research not found".
  assert.equal(realtime.isQueryConfirmationRequest({
    question: 'Would you like to modify anything before I launch the scouts?',
    choices: [
      { id: 'launch_live_reconnaissance', label: 'Launch live reconnaissance' },
      { id: 'modify_task', label: 'Modify this task' },
    ],
  }, 'AWAITING_QUERY_CONFIRMATION'), true);
  assert.equal(realtime.isQueryConfirmationRequest({
    question: 'Which quote currency should be used?',
    choices: [{ id: 'USD', label: 'USD' }, { id: 'EUR', label: 'EUR' }],
  }, 'AWAITING_QUERY_CONFIRMATION'), false);
  assert.equal(realtime.isLegacyQueryConfirmationLaunch(
    'CLARIFICATION_REQUIRED',
    { resume_phase: 'AWAITING_QUERY_CONFIRMATION' },
    { id: 'launch_live_reconnaissance', label: 'Launch live reconnaissance' },
  ), true);
  assert.equal(realtime.isInterruptRecoveryPhaseAllowed(
    'QUERY_CONFIRMATION_REQUIRED',
    { resume_phase: 'AWAITING_QUERY_CONFIRMATION' },
    'DISCOVERY',
  ), true);
  assert.equal(realtime.isInterruptRecoveryPhaseAllowed(
    'QUERY_CONFIRMATION_REQUIRED',
    { resume_phase: 'AWAITING_QUERY_CONFIRMATION' },
    'DEPLOYED',
  ), false);
  // A reconnect with no resume metadata may recreate a missing launch card,
  // but an approved card resolution must continue into SCOUTING instead of
  // producing the same launch card again.
  assert.equal(realtime.shouldRecoverQueryConfirmationCard('AWAITING_QUERY_CONFIRMATION', false), true);
  assert.equal(realtime.shouldRecoverQueryConfirmationCard('AWAITING_QUERY_CONFIRMATION', true), false);
  assert.equal(realtime.shouldRecoverQueryConfirmationCard('DISCOVERY', true), false);
  assert.equal(realtime.isPreflightBoundToVerifiedContract(
    { passed: true, targetType: 'CRYPTO', targetSource: 'BTC', currency: 'USD' },
    [{ toolName: 'crypto_research', contract: { assetSymbol: 'BTC', currency: 'USD' } }],
  ), true);
  assert.equal(realtime.isPreflightBoundToVerifiedContract(
    { passed: true, targetType: 'CRYPTO', targetSource: 'ETH', currency: 'USD' },
    [{ toolName: 'crypto_research', contract: { assetSymbol: 'BTC', currency: 'USD' } }],
  ), false);
  assert.equal(realtime.isPreflightBoundToVerifiedContract(
    { passed: true, targetType: 'CRYPTO', targetSource: 'BTC', currency: 'EUR' },
    [{ toolName: 'crypto_research', contract: { assetSymbol: 'BTC', currency: 'USD' } }],
  ), false);
  const verifiedWebContract = realtime.buildVerifiedWebContract(
    'deep_web_research',
    {
      status: 'EXACT_MATCH',
      source: {
        url: 'https://example.com/product',
        selector: '[data-price]',
        attribute: 'text',
        isAccessible: true,
        hasLiveTargetData: true,
        valueRegex: null,
      },
      conditionEvaluation: {
        expectedOperator: 'GREATER_THAN',
        targetValue: 100,
      },
    },
    { targetDataKind: 'PRICE' },
  );
  assert.ok(verifiedWebContract);
  assert.equal(realtime.isPreflightBoundToVerifiedContract(
    {
      passed: true,
      targetType: 'WEB_OBSERVER',
      targetSource: 'https://example.com/product',
      selectorOrCondition: '[data-price]',
    },
    [],
  ), false);
  assert.equal(realtime.isPreflightBoundToVerifiedContract(
    {
      passed: true,
      targetType: 'WEB_OBSERVER',
      targetSource: 'https://example.com/product',
      selectorOrCondition: '[data-price]',
    },
    [{ toolName: 'deep_web_research', contract: verifiedWebContract! }],
  ), true);
  assert.equal(realtime.isPreflightBoundToVerifiedContract(
    {
      passed: true,
      targetType: 'WEB_OBSERVER',
      targetSource: 'https://attacker.example/product',
      selectorOrCondition: '[data-price]',
    },
    [{ toolName: 'deep_web_research', contract: verifiedWebContract! }],
  ), false);
  assert.equal(realtime.isPreflightBoundToVerifiedContract(
    {
      passed: true,
      targetType: 'WEB_OBSERVER',
      targetSource: 'https://example.com/product',
      selectorOrCondition: '.unverified',
    },
    [{ toolName: 'deep_web_research', contract: verifiedWebContract! }],
  ), false);
  assert.equal(realtime.isSynthesisBoundToVerifiedContracts([
    {
      sentinel_type: 'WEB_OBSERVER',
      target_source: 'https://example.com/product',
      operator: 'GREATER_THAN',
      threshold: JSON.stringify({ selector: '[data-price]', attribute: 'text', targetValue: 100 }),
    },
  ], [{ toolName: 'deep_web_research', contract: verifiedWebContract! }]), true);
  assert.equal(realtime.isSynthesisBoundToVerifiedContracts([
    {
      sentinel_type: 'WEB_OBSERVER',
      target_source: 'https://example.com/product',
      operator: 'GREATER_THAN',
      threshold: JSON.stringify({ selector: '.unverified', attribute: 'text', targetValue: 100 }),
    },
  ], [{ toolName: 'deep_web_research', contract: verifiedWebContract! }]), false);
  assert.equal(realtime.isSynthesisBoundToPreflight(
    [{ sentinel_type: 'CRYPTO', target_source: 'BTC', threshold: JSON.stringify({}) }],
    { passed: true, targetType: 'CRYPTO', targetSource: 'BTC' },
  ), true);
  assert.equal(realtime.isSynthesisBoundToPreflight(
    [{ sentinel_type: 'CRYPTO', target_source: 'ETH', threshold: JSON.stringify({}) }],
    { passed: true, targetType: 'CRYPTO', targetSource: 'BTC' },
  ), false);
  const exactCryptoContract = {
    toolName: 'crypto_research',
    contract: {
      assetSymbol: 'BTC',
      currency: 'USD',
      targetType: 'PRICE',
      targetValue: 75000,
      operator: 'GREATER_THAN',
    },
  };
  assert.equal(realtime.isSynthesisBoundToVerifiedContracts([
    {
      sentinel_type: 'CRYPTO',
      target_source: 'BTC',
      operator: 'GREATER_THAN',
      threshold: JSON.stringify({
        assetSymbol: 'BTC', currency: 'USD', venue: 'COINBASE', targetType: 'PRICE', targetValue: 75000,
      }),
    },
  ], [exactCryptoContract]), true);
  assert.equal(realtime.isSynthesisBoundToVerifiedContracts([
    {
      sentinel_type: 'CRYPTO',
      target_source: 'BTC',
      operator: 'GREATER_THAN',
      threshold: JSON.stringify({
        assetSymbol: 'BTC', currency: 'USD', venue: 'COINBASE', targetType: 'PRICE', targetValue: 72000,
      }),
    },
  ], [exactCryptoContract]), false);

  await repositories.closeDatabase();
  rmSync(tempDirectory, { recursive: true, force: true });
  console.log('PASS manual interrupt card, retry persistence, and mode-card HTTP recovery');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
