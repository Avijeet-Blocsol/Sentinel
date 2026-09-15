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

  // Positive Approvals
  const approvals = ['confirm', 'Confirm & Deploy', 'looks good', 'proceed', 'yes, deploy', 'lgtm', 'approve'];
  for (const text of approvals) {
    const res = isInterruptResolutionText(text);
    assert.strictEqual(res.isResolution, true, `"${text}" should be recognized as interrupt resolution`);
    assert.strictEqual(res.resolution, 'APPROVED', `"${text}" should resolve as APPROVED`);
  }

  // Rejections
  const rejections = ['cancel', 'reject', 'dismiss', 'no', 'stop', 'abort'];
  for (const text of rejections) {
    const res = isInterruptResolutionText(text);
    assert.strictEqual(res.isResolution, true, `"${text}" should be recognized as interrupt resolution`);
    assert.strictEqual(res.resolution, 'REJECTED', `"${text}" should resolve as REJECTED`);
  }

  // Non-resolution text
  const nonResolutions = ['what is your name?', 'tell me a joke', 'check AMD instead', 'status update'];
  for (const text of nonResolutions) {
    const res = isInterruptResolutionText(text);
    assert.strictEqual(res.isResolution, false, `"${text}" should not be an interrupt resolution`);
  }
  console.log('  ✔ NLP interrupt resolution matcher verified across all variations');

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
  for (const q of statusInquiries) {
    assert(isTaskStatusInquiry(q), `"${q}" should be classified as task status inquiry`);
  }

  const modifications = [
    'change the price to $120',
    'also monitor ETH',
    'instead track Tesla',
    'add another condition',
  ];
  for (const m of modifications) {
    assert(isTaskModificationAttempt(m), `"${m}" should be classified as modification attempt`);
  }
  console.log('  ✔ Status inquiry and modification classifiers verified');

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
  assert.strictEqual(statusCategory, 'TASK_STATUS_INQUIRY');
  const summary = generateTaskStatusSummary(context);
  assert(summary.includes('Nvidia Drop Alert'), 'Summary must contain rule title');
  assert(summary.includes('NVDA'), 'Summary must contain target source');
  console.log('  Task Status Summary Generated:\n', summary);

  // Case 4B: User starts asking BS during active task
  const bsCategory = classifyUserInput('what do you think of space exploration?', context);
  assert.strictEqual(bsCategory, 'OFF_TOPIC_BS');
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
  assert.strictEqual(blockedCategory, 'OFF_TOPIC_BS');
  const blockSteer = generateSteeringResponse(blockedContext);
  assert(blockSteer.includes('Action Required'), 'Block response must mandate card decision');
  console.log('  Interrupt Blockade Response:\n', blockSteer);

  // User resolves interrupt via natural language
  const resolveCategory = classifyUserInput('confirm & deploy', blockedContext);
  assert.strictEqual(resolveCategory, 'INTERRUPT_RESOLUTION');

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
  assert.strictEqual(
    classifyUserInput('watch this youtube video with me', discoveryContext),
    'OFF_TOPIC_BS',
    '"watch this youtube video" should be OFF_TOPIC_BS'
  );
  assert.strictEqual(
    classifyUserInput('can you feed my dog tomorrow', discoveryContext),
    'OFF_TOPIC_BS',
    '"feed my dog" should be OFF_TOPIC_BS'
  );
  assert.strictEqual(
    classifyUserInput('what is the price of milk', discoveryContext),
    'OFF_TOPIC_BS',
    '"price of milk" should be OFF_TOPIC_BS'
  );

  // True-positive monitoring intents
  assert.strictEqual(
    classifyUserInput('watch AAPL stock price', discoveryContext),
    'SENTINEL_INTENT',
    '"watch AAPL stock price" should be SENTINEL_INTENT'
  );
  assert.strictEqual(
    classifyUserInput('notify me if bitcoin exceeds 100k', discoveryContext),
    'SENTINEL_INTENT',
    '"notify me if bitcoin exceeds 100k" should be SENTINEL_INTENT'
  );
  assert.strictEqual(
    classifyUserInput('alert me if polymarket probability drops below 40%', discoveryContext),
    'SENTINEL_INTENT',
    '"alert me if polymarket probability drops" should be SENTINEL_INTENT'
  );

  // Unanchored modification checks
  assert(
    isTaskModificationAttempt('can you change the price to $120?'),
    '"can you change the price" should be detected as modification'
  );
  assert(
    isTaskModificationAttempt('hey please also monitor ETH'),
    '"also monitor ETH" should be detected as modification'
  );
  assert(
    isTaskModificationAttempt('instead of that, track Tesla'),
    '"instead of that, track Tesla" should be detected as modification'
  );
  console.log('  ✔ Narrowed classification and unanchored modification detection verified');

  console.log('\n🎉 ALL AGENTIC LOOP & LIFECYCLE TESTS COMPLETED SUCCESSFULLY!\n');
}

runLifecycleTests().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
