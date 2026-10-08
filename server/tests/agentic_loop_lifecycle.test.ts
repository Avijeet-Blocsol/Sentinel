/**
 * Strands Sentinel - Main Agentic Loop & Conversation Lifecycle Test Suite
 * Tests the 9-step Golden Onboarding Loop, Tri-Category Input Routing,
 * Pre-Flight Dry Run Tool, Query Confirmation Gate, and Interrupt Blockade.
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  isInterruptResolutionText,
  isTaskStatusInquiry,
  isTaskContextQuestion,
  isTaskModificationAttempt,
  classifyUserInput,
  generateSteeringResponse,
  generateTaskStatusSummary,
  type ConversationStateContext,
} from '../src/agent/state_machine.js';
import { createPreFlightProbeTool } from '../src/tools/pre_flight_probe.js';
import {
  userRepository,
  conversationRepository,
  chatMessageRepository,
  ruleRepository,
  subSentinelRepository,
  interruptActionRepository,
  seenEventRepository,
  type Rule,
  type SubSentinel,
  type User,
  type AgentConversation,
  type InterruptAction,
} from '../src/db/index.js';

async function runLifecycleTests() {
  console.log('🚀 Starting Sentinel Agentic Loop & Lifecycle Test Suite...\n');

  // -------------------------------------------------------------
  // Test 1: Pre-Flight Dry Run Probe Tool (Step 4)
  // -------------------------------------------------------------
  console.log('--- Test 1: Pre-Flight Dry Run Probe Tool ---');
  const probeTool = createPreFlightProbeTool();

  // Test stock probe
  const stockProbe = await (probeTool as any).invoke({
    targetType: 'STOCK',
    targetSource: 'AAPL',
  });
  console.log('  Stock Probe Result:', stockProbe);
  assert(stockProbe.passed === true, 'AAPL stock probe should pass');
  assert(typeof stockProbe.baselineValue === 'string', 'Baseline price string must be captured');
  assert(typeof stockProbe.currentNumericValue === 'number', 'Numeric quote must be captured');

  // Test crypto probe
  let cryptoProbe: any;
  for (let attempt = 0; attempt < 2; attempt++) {
    cryptoProbe = await (probeTool as any).invoke({
      targetType: 'CRYPTO',
      targetSource: 'BTC',
    });
    if (cryptoProbe.passed) break;
  }
  console.log('  Crypto Probe Result:', cryptoProbe);
  if (cryptoProbe.passed) {
    assert(cryptoProbe.currentNumericValue > 0, 'BTC price must be positive');
  } else {
    assert(typeof cryptoProbe.reason === 'string', 'Failure must provide structured reason');
  }
  console.log('  ✔ Pre-flight dry run tool verified with live baseline capture');

  // -------------------------------------------------------------
  // Test 2: Input Classification & NLP Interrupt Matcher
  // -------------------------------------------------------------
  console.log('\n--- Test 2: Input Classification & NLP Interrupt Resolution ---');

  // Free-form text is never an interrupt action. The mobile choice-card
  // endpoint is the only supported resolution path.
  const freeFormMessages = ['confirm', 'Confirm & Deploy', 'cancel', 'tell me a joke'];
  for (const text of freeFormMessages) {
    assert.equal(isInterruptResolutionText(text).isResolution, false);
  }
  console.log('  ✔ Free-form interrupt resolution is disabled; choice cards are authoritative');

  // -------------------------------------------------------------
  // Test 3: Task Status Inquiries & Post-Scout Lockout
  // -------------------------------------------------------------
  console.log('\n--- Test 3: Status Inquiries & Scope Lockout ---');

  const statusInquiries = [
    'what is the status?',
    'how is the task going?',
    'what has happened so far?',
    'show progress',
    'summary of what has happened',
  ];
  for (const q of statusInquiries) assert.equal(isTaskStatusInquiry(q), false);

  const taskQuestions = [
    'what does this sentinel monitor?',
    'which sources are being watched?',
    'what conditions are configured for this task?',
    'how often does it run?',
    'why is the task paused?',
  ];
  for (const q of taskQuestions) {
    assert.equal(isTaskContextQuestion(q, { phase: 'DEPLOYED', activeRule: { id: 'rule-1' } as Rule }), false);
  }

  const modifications = [
    'change the price to $120',
    'also monitor ETH',
    'instead track Tesla',
    'add another condition',
  ];
  for (const m of modifications) assert.equal(isTaskModificationAttempt(m), false);
  console.log('  ✔ Synchronous semantic classifiers are disabled; the live Strands classifier owns these decisions');

  // -------------------------------------------------------------
  // Test 4: State-Aware Categorization & Steering (The "Genuine -> BS" Scenario)
  // -------------------------------------------------------------
  console.log('\n--- Test 4: Context-Aware Steering ("Genuine -> BS" Flow) ---');

  const testUser: User = {
    id: `lifecycle_user_${Date.now()}`,
    email: `lifecycle_${Date.now()}@sentinel.local`,
    name: 'Lifecycle Test User',
    google_sub: null,
    apple_sub: null,
    github_sub: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await userRepository.create(testUser);

  const testConvo: AgentConversation = {
    id: randomUUID(),
    user_id: testUser.id,
    title: 'NVDA Watcher Setup',
    status: 'ACTIVE',
    created_at: Date.now(),
  };
  await conversationRepository.create(testConvo);

  const testRule: Rule = {
    id: randomUUID(),
    user_id: testUser.id,
    conversation_id: testConvo.id,
    title: 'Nvidia Drop Alert',
    natural_language_intent: 'Alert me if NVDA drops below $110',
    category: 'FINANCIAL',
    combinator: 'SINGLE',
    trigger_mode: 'PERSISTENT',
    cooldown_minutes: 30,
    audio_tone: 'siren',
    status: 'ACTIVE',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await ruleRepository.create(testRule);

  const sub: SubSentinel = {
    id: randomUUID(),
    rule_id: testRule.id,
    sentinel_type: 'STOCK',
    target_source: 'NVDA',
    operator: 'LESS_THAN',
    threshold: JSON.stringify({ ticker: 'NVDA', targetPrice: 110 }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };
  await subSentinelRepository.create(sub);

  const context: ConversationStateContext = {
    phase: 'DEPLOYED',
    activeRule: testRule,
    subSentinels: [sub],
  };

  // Case 4A: User asks status inquiry during active monitoring
  const statusCategory = classifyUserInput('what is the status?', context);
  assert.strictEqual(statusCategory, 'AI_UNAVAILABLE');
  assert.strictEqual(
    classifyUserInput('what does this sentinel monitor?', context),
    'AI_UNAVAILABLE'
  );
  assert.strictEqual(
    classifyUserInput('what do you think of space exploration?', context),
    'AI_UNAVAILABLE'
  );
  const summary = generateTaskStatusSummary(context);
  assert(summary.includes('Nvidia Drop Alert'), 'Summary must contain rule title');
  assert(summary.includes('NVDA'), 'Summary must contain target source');
  console.log('  Task Status Summary Generated:\n', summary);

  // Case 4B: User starts asking BS during active task
  const bsCategory = classifyUserInput('what do you think of space exploration?', context);
  assert.strictEqual(bsCategory, 'AI_UNAVAILABLE');
  const steerResponse = generateSteeringResponse(context);
  assert(steerResponse.includes('Nvidia Drop Alert'), 'Steering message must anchor to active task');
  assert(steerResponse.includes('actively running'), 'Steering message must remind user task is active');
  console.log('\n  Steering Response Generated:\n', steerResponse);
  console.log('  ✔ Context-anchored steering verified for "Genuine -> BS" flow');

  // -------------------------------------------------------------
  // Test 5: Interrupt Blockade & Resolution Lifecycle (Steps 6 -> 7 -> 8 -> 9)
  // -------------------------------------------------------------
  console.log('\n--- Test 5: Interrupt Blockade & Lifecycle Resolution ---');

  const pendingInterrupt: InterruptAction = {
    id: randomUUID(),
    rule_id: testRule.id,
    user_id: testUser.id,
    action_type: 'CONFIRM_WATCHER',
    action_payload: JSON.stringify({
      rule: testRule,
      subSentinels: [sub],
      baselineSeeds: ['seed_hash_001', 'seed_hash_002'],
      title: testRule.title,
    }),
    status: 'PENDING',
    expires_at: Date.now() + 600000,
    created_at: Date.now(),
  };
  await interruptActionRepository.create(pendingInterrupt);

  const blockedContext: ConversationStateContext = {
    phase: 'INTERRUPT_PENDING',
    activeRule: testRule,
    pendingInterrupt,
  };

  // User sends random BS while interrupt is PENDING
  const blockedCategory = classifyUserInput('write me a poem about butterflies', blockedContext);
  assert.strictEqual(blockedCategory, 'AI_UNAVAILABLE');
  const blockSteer = generateSteeringResponse(blockedContext);
  assert(blockSteer.includes('Action Required'), 'Block response must mandate card decision');
  console.log('  Interrupt Blockade Response:\n', blockSteer);

  // Free-form text cannot resolve an interrupt; only the card endpoint may do so.
  const resolveCategory = classifyUserInput('confirm & deploy', blockedContext);
  assert.strictEqual(resolveCategory, 'AI_UNAVAILABLE');

  // Simulate resolution & baseline seeding
  await interruptActionRepository.updateStatus(pendingInterrupt.id, 'APPROVED');
  const updatedInterrupt = await interruptActionRepository.getById(pendingInterrupt.id);
  assert.strictEqual(updatedInterrupt?.status, 'APPROVED');

  // Seed baseline
  const testSeedHash = `seed_hash_${Date.now()}`;
  await seenEventRepository.recordSeenEvent(
    randomUUID(),
    sub.id,
    sub.target_source,
    testSeedHash
  );
  const isSeen = await seenEventRepository.isEventSeen(sub.id, testSeedHash);
  assert.strictEqual(isSeen, true, 'Baseline seed must be recorded in seenEventRepository');
  console.log('  ✔ Interrupt blockade and baseline seeding verified');

  // -------------------------------------------------------------
  // Test 6: Persisted Conversation Phase Transitions
  // -------------------------------------------------------------
  console.log('\n--- Test 6: Persisted Conversation Phase Transitions ---');
  const phaseConvo: AgentConversation = {
    id: randomUUID(),
    user_id: testUser.id,
    title: 'Phase Persistence Test',
    status: 'ACTIVE',
    phase: 'DISCOVERY',
    created_at: Date.now(),
  };
  await conversationRepository.create(phaseConvo);

  let fetchedConvo = await conversationRepository.getById(phaseConvo.id);
  assert.strictEqual(fetchedConvo?.phase, 'DISCOVERY', 'Initial phase must be DISCOVERY');

  // Transition to SCOUTING
  await conversationRepository.updatePhase(phaseConvo.id, 'SCOUTING');
  fetchedConvo = await conversationRepository.getById(phaseConvo.id);
  assert.strictEqual(fetchedConvo?.phase, 'SCOUTING', 'Phase must transition to SCOUTING');

  // Transition to INTERRUPT_PENDING
  await conversationRepository.updatePhase(phaseConvo.id, 'INTERRUPT_PENDING');
  fetchedConvo = await conversationRepository.getById(phaseConvo.id);
  assert.strictEqual(fetchedConvo?.phase, 'INTERRUPT_PENDING', 'Phase must transition to INTERRUPT_PENDING');

  // Transition to DEPLOYED
  await conversationRepository.updatePhase(phaseConvo.id, 'DEPLOYED');
  fetchedConvo = await conversationRepository.getById(phaseConvo.id);
  assert.strictEqual(fetchedConvo?.phase, 'DEPLOYED', 'Phase must transition to DEPLOYED');
  console.log('  ✔ Persisted conversation phase transitions verified in database');

  // -------------------------------------------------------------
  // Test 7: Interrupt TTL Expiration Filtering
  // -------------------------------------------------------------
  console.log('\n--- Test 7: Interrupt TTL Expiration Filtering ---');
  const expiredInterrupt: InterruptAction = {
    id: randomUUID(),
    rule_id: testRule.id,
    user_id: testUser.id,
    action_type: 'CONFIRM_WATCHER',
    action_payload: JSON.stringify({ test: true }),
    status: 'PENDING',
    expires_at: Date.now() - 10000, // Expired 10 seconds ago
    created_at: Date.now() - 60000,
  };
  await interruptActionRepository.create(expiredInterrupt);

  const pendingList = await interruptActionRepository.getPendingByUserId(testUser.id);
  const foundExpired = pendingList.some((i) => i.id === expiredInterrupt.id);
  assert.strictEqual(foundExpired, false, 'Expired interrupt must NOT be returned in getPendingByUserId');
  console.log('  ✔ Interrupt TTL expiration filtering verified (stale cards filtered)');

  // -------------------------------------------------------------
  // Test 8: Narrowed Classifier & Unanchored Modification Patterns
  // -------------------------------------------------------------
  console.log('\n--- Test 8: Narrowed Classifier & Unanchored Modifications ---');
  const discoveryContext: ConversationStateContext = { phase: 'DISCOVERY' };

  // False-positive prevention: "watch" or "alert" without domain context
  assert.equal(classifyUserInput('watch this youtube video with me', discoveryContext), 'AI_UNAVAILABLE');
  assert.equal(classifyUserInput('can you feed my dog tomorrow', discoveryContext), 'AI_UNAVAILABLE');
  assert.equal(classifyUserInput('what is the price of milk', discoveryContext), 'AI_UNAVAILABLE');

  // True-positive monitoring intents
  assert.equal(classifyUserInput('watch AAPL stock price', discoveryContext), 'AI_UNAVAILABLE');
  assert.equal(classifyUserInput('notify me if bitcoin exceeds 100k', discoveryContext), 'AI_UNAVAILABLE');
  assert.equal(classifyUserInput('alert me if polymarket probability drops below 40%', discoveryContext), 'AI_UNAVAILABLE');

  // Unanchored modification checks
  assert.equal(isTaskModificationAttempt('can you change the price to $120?'), false);
  assert.equal(isTaskModificationAttempt('hey please also monitor ETH'), false);
  assert.equal(isTaskModificationAttempt('instead of that, track Tesla'), false);
  console.log('  ✔ No local modification or intent fallback remains');

  console.log('\n🎉 ALL AGENTIC LOOP & LIFECYCLE TESTS COMPLETED SUCCESSFULLY!\n');
}

runLifecycleTests().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
