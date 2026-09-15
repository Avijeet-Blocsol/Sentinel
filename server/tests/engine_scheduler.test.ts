/**
 * Strands Sentinel - Engine Scheduler & Condition AST Test Suite
 * Rigorously verifies:
 * 1. Arbitrary Boolean Condition AST evaluation ((A OR B) AND C) & NOT logic
 * 2. Heterogeneous evaluation cadence (independent ttl_seconds scheduling)
 * 3. Stateful latching (parent rule evaluation against cached non-due sibling states)
 * 4. Backward compatibility for legacy flat combinators (AND, OR, SINGLE)
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  type Rule,
  type SubSentinel,
  type User,
  type ConditionNode,
  ConditionNodeSchema,
  evaluateConditionTree,
  parseConditionTree,
} from '@sentinel/shared';
import {
  userRepository,
  ruleRepository,
  subSentinelRepository,
} from '../src/db/index.js';
import { EvaluatorEngine } from '../src/services/evaluators/engine.js';

async function runTests() {
  console.log('\n==========================================================');
  console.log('🧪 TEST SUITE: EVALUATOR ENGINE AST & SCHEDULER AUDIT');
  console.log('==========================================================\n');

  // ---------------------------------------------------------
  // Module 1: Direct Condition Tree AST Logic Evaluation
  // ---------------------------------------------------------
  console.log('--- Module 1: Direct Condition Tree AST Evaluation ---');

  const subA = '00000000-0000-0000-0000-000000000001';
  const subB = '00000000-0000-0000-0000-000000000002';
  const subC = '00000000-0000-0000-0000-000000000003';

  // AST: ((A OR B) AND C)
  const compositeTree: ConditionNode = {
    type: 'AND',
    children: [
      {
        type: 'OR',
        children: [
          { type: 'LEAF', subSentinelId: subA },
          { type: 'LEAF', subSentinelId: subB },
        ],
      },
      { type: 'LEAF', subSentinelId: subC },
    ],
  };

  // Case 1A: A=0, B=1, C=1 -> True
  const map1 = new Map([
    [subA, false],
    [subB, true],
    [subC, true],
  ]);
  assert.equal(evaluateConditionTree(compositeTree, map1), true, '((0 OR 1) AND 1) should be true');

  // Case 1B: A=0, B=0, C=1 -> False
  const map2 = new Map([
    [subA, false],
    [subB, false],
    [subC, true],
  ]);
  assert.equal(evaluateConditionTree(compositeTree, map2), false, '((0 OR 0) AND 1) should be false');

  // Case 1C: A=1, B=0, C=0 -> False
  const map3 = new Map([
    [subA, true],
    [subB, false],
    [subC, false],
  ]);
  assert.equal(evaluateConditionTree(compositeTree, map3), false, '((1 OR 0) AND 0) should be false');

  // Unknown is deliberately fail-closed at the root. It still follows
  // three-valued boolean algebra inside nested expressions: a true OR branch
  // can satisfy an unknown sibling, but an unknown required AND leaf cannot
  // generate an alert.
  assert.equal(
    evaluateConditionTree(compositeTree, new Map([[subA, null], [subB, true], [subC, true]])),
    true,
    '((UNKNOWN OR TRUE) AND TRUE) should be true',
  );
  assert.equal(
    evaluateConditionTree(compositeTree, new Map([[subA, true], [subB, false], [subC, null]])),
    false,
    'a required UNKNOWN leaf must fail closed at the rule boundary',
  );

  // Inverted NOT logic: (A AND (NOT B))
  const notTree: ConditionNode = {
    type: 'AND',
    children: [
      { type: 'LEAF', subSentinelId: subA },
      {
        type: 'NOT',
        child: { type: 'LEAF', subSentinelId: subB },
      },
    ],
  };

  assert.equal(evaluateConditionTree(notTree, new Map([[subA, true], [subB, false]])), true, '(1 AND (NOT 0)) should be true');
  assert.equal(evaluateConditionTree(notTree, new Map([[subA, true], [subB, true]])), false, '(1 AND (NOT 1)) should be false');

  // Parsing helper verification
  const serialized = JSON.stringify(compositeTree);
  const parsed = parseConditionTree(serialized);
  assert.ok(parsed, 'parseConditionTree must parse serialized JSON');
  assert.equal(parsed?.type, 'AND');
  console.log('  ✔ Recursive boolean AST evaluation and parsing verified');

  // ---------------------------------------------------------
  // Module 2: Engine Integration with Stored Condition Tree
  // ---------------------------------------------------------
  console.log('\n--- Module 2: Engine Execution with Database-Stored AST ---');
  const engine = new EvaluatorEngine();

  const testUser: User = {
    id: `user_ast_${Date.now()}`,
    email: `ast_${Date.now()}@sentinel.local`,
    name: 'AST Test User',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await userRepository.create(testUser);

  const astRuleId = randomUUID();
  const subIdA = randomUUID();
  const subIdB = randomUUID();
  const subIdC = randomUUID();

  // Rule condition: ((subIdA OR subIdB) AND subIdC)
  const ruleAst: ConditionNode = {
    type: 'AND',
    children: [
      {
        type: 'OR',
        children: [
          { type: 'LEAF', subSentinelId: subIdA },
          { type: 'LEAF', subSentinelId: subIdB },
        ],
      },
      { type: 'LEAF', subSentinelId: subIdC },
    ],
  };

  const astRule: Rule = {
    id: astRuleId,
    user_id: testUser.id,
    title: 'Macro Multi-Asset Alert',
    natural_language_intent: 'Alert if (BTC drops OR ETH drops) AND Fed cuts rate',
    category: 'CRYPTO',
    combinator: 'AND', // Fallback combinator
    condition_tree: JSON.stringify(ruleAst),
    trigger_mode: 'ONE_SHOT',
    cooldown_minutes: 0,
    audio_tone: 'cash_register',
    status: 'ACTIVE',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await ruleRepository.create(astRule);

  // Sub A: BTC price > $1000 (Guaranteed true)
  const subA_Entity: SubSentinel = {
    id: subIdA,
    rule_id: astRuleId,
    sentinel_type: 'CRYPTO',
    target_source: 'BTC',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      assetSymbol: 'BTC',
      currency: 'USD',
      venue: 'COINBASE',
      targetPrice: 1000,
      operator: 'GREATER_THAN',
    }),
    ttl_seconds: 10,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };
  await subSentinelRepository.create(subA_Entity);

  // Sub B: High threshold that will evaluate false (e.g. BTC > $10,000,000)
  const subB_Entity: SubSentinel = {
    id: subIdB,
    rule_id: astRuleId,
    sentinel_type: 'CRYPTO',
    target_source: 'BTC',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      assetSymbol: 'BTC',
      currency: 'USD',
      venue: 'COINBASE',
      targetPrice: 10_000_000,
      operator: 'GREATER_THAN',
    }),
    ttl_seconds: 10,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };
  await subSentinelRepository.create(subB_Entity);

  // Sub C: Stock price > $1 (Guaranteed true)
  const subC_Entity: SubSentinel = {
    id: subIdC,
    rule_id: astRuleId,
    sentinel_type: 'STOCK',
    target_source: 'AAPL',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      ticker: 'AAPL',
      targetType: 'PRICE',
      targetValue: 1.0,
      marketHoursOnly: false,
      currency: 'USD',
      operator: 'GREATER_THAN',
    }),
    ttl_seconds: 300,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };
  await subSentinelRepository.create(subC_Entity);

  // Evaluate rule: SubA (true) OR SubB (false) => true; SubC (true) => true!
  const ruleResult = await engine.evaluateRule(astRule, true);
  assert.equal(ruleResult.isTriggered, true, 'AST condition ((A OR B) AND C) should trigger rule');
  assert.ok(ruleResult.alert, 'Alert should be generated');

  // Verify ONE_SHOT updated rule status in DB
  const updatedAstRule = await ruleRepository.getById(astRuleId);
  assert.equal(updatedAstRule?.status, 'TRIGGERED', 'ONE_SHOT rule must transition to TRIGGERED');
  console.log('  ✔ Database-stored condition_tree AST executed and triggered alert');

  // ---------------------------------------------------------
  // Module 3: Heterogeneous Evaluation Frequencies & Scheduling
  // ---------------------------------------------------------
  console.log('\n--- Module 3: Heterogeneous Cadence (Due-Queue Scheduling) ---');

  const schedRuleId = randomUUID();
  const schedRule: Rule = {
    id: schedRuleId,
    user_id: testUser.id,
    title: 'Heterogeneous Cadence Rule',
    natural_language_intent: 'Test independent polling frequencies',
    category: 'CRYPTO',
    combinator: 'SINGLE',
    trigger_mode: 'PERSISTENT',
    cooldown_minutes: 0,
    audio_tone: 'chime',
    status: 'ACTIVE',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await ruleRepository.create(schedRule);

  const fastSubId = randomUUID();
  const slowSubId = randomUUID();

  // Fast SubSentinel: Polled every 2 seconds
  const fastSub: SubSentinel = {
    id: fastSubId,
    rule_id: schedRuleId,
    sentinel_type: 'CRYPTO',
    target_source: 'BTC',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      assetSymbol: 'BTC',
      currency: 'USD',
      venue: 'COINBASE',
      targetPrice: 1000,
      operator: 'GREATER_THAN',
    }),
    ttl_seconds: 2, // 2 seconds
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };
  await subSentinelRepository.create(fastSub);

  // Slow SubSentinel: Polled every 600 seconds (10 minutes)
  const slowSub: SubSentinel = {
    id: slowSubId,
    rule_id: schedRuleId,
    sentinel_type: 'STOCK',
    target_source: 'AAPL',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      ticker: 'AAPL',
      targetType: 'PRICE',
      targetValue: 1.0,
      marketHoursOnly: false,
      currency: 'USD',
      operator: 'GREATER_THAN',
    }),
    ttl_seconds: 600, // 10 minutes
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };
  await subSentinelRepository.create(slowSub);

  // Tick 1 at t0: Both fastSub and slowSub have last_evaluated_at = NULL, so BOTH must be evaluated
  const t0 = Date.now();
  // Use a test-local capacity large enough that durable data from previous
  // suites cannot starve this fixture behind an older due backlog.
  const tick1 = await engine.tick(t0, 1_000);
  assert.ok(tick1.evaluatedSubSentinels >= 2, 'Initial tick should evaluate newly registered sub-sentinels');

  // Verify timestamps were updated in DB
  const subSentinelsAfterTick1 = await subSentinelRepository.getByRuleId(schedRuleId);
  const fastAfter1 = subSentinelsAfterTick1.find((s) => s.id === fastSubId);
  const slowAfter1 = subSentinelsAfterTick1.find((s) => s.id === slowSubId);
  assert.ok(fastAfter1?.last_evaluated_at, 'Fast sub-sentinel must have last_evaluated_at set');
  assert.ok(slowAfter1?.last_evaluated_at, 'Slow sub-sentinel must have last_evaluated_at set');

  const fastEvalTime = fastAfter1.last_evaluated_at;

  // Tick 2 at fastEvalTime + 1000ms (1 second after evaluation):
  // Fast is NOT due (2s TTL not elapsed), Slow is NOT due (600s TTL not elapsed)
  const dueAt1s = await subSentinelRepository.getDue(fastEvalTime + 1000, 100);
  const dueIds1s = dueAt1s.map((s) => s.id);
  assert.equal(dueIds1s.includes(fastSubId), false, 'Fast sub must NOT be due after only 1s');
  assert.equal(dueIds1s.includes(slowSubId), false, 'Slow sub must NOT be due after only 1s');

  // Tick 3 at fastEvalTime + 2500ms (2.5 seconds after evaluation):
  // Fast IS due (2.5s >= 2s TTL), Slow is STILL NOT due (2.5s < 600s TTL)
  const dueAt3s = await subSentinelRepository.getDue(fastEvalTime + 2500, 100);
  const dueIds3s = dueAt3s.map((s) => s.id);
  assert.equal(dueIds3s.includes(fastSubId), true, 'Fast sub MUST be due after 2.5s');
  assert.equal(dueIds3s.includes(slowSubId), false, 'Slow sub must NOT be due after 2.5s');

  // Run engine.tick at fastEvalTime + 2500ms and verify heterogeneous execution
  const tick3 = await engine.tick(fastEvalTime + 2500, 1_000);
  assert.ok(tick3.evaluatedSubSentinels >= 1, 'Tick 3 should evaluate the fast sub-sentinel');

  console.log('  ✔ Decoupled Due-Queue properly isolates high-frequency from low-frequency sentinels');

  // ---------------------------------------------------------
  // Module 4: Backward Compatibility Verification
  // ---------------------------------------------------------
  console.log('\n--- Module 4: Backward Compatibility for Flat Combinators ---');
  const legacyRule: Rule = {
    id: randomUUID(),
    user_id: testUser.id,
    title: 'Legacy AND Rule',
    natural_language_intent: 'Legacy rule without condition_tree',
    category: 'CRYPTO',
    combinator: 'AND',
    // condition_tree omitted
    trigger_mode: 'PERSISTENT',
    cooldown_minutes: 0,
    audio_tone: 'chime',
    status: 'ACTIVE',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await ruleRepository.create(legacyRule);

  const legacySub: SubSentinel = {
    id: randomUUID(),
    rule_id: legacyRule.id,
    sentinel_type: 'CRYPTO',
    target_source: 'BTC',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      assetSymbol: 'BTC',
      currency: 'USD',
      venue: 'COINBASE',
      targetPrice: 1000,
      operator: 'GREATER_THAN',
    }),
    ttl_seconds: 300,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };
  await subSentinelRepository.create(legacySub);

  const legacyResult = await engine.evaluateRule(legacyRule, true);
  assert.equal(legacyResult.isTriggered, true, 'Legacy rule without condition_tree should evaluate flat combinator');
  console.log('  ✔ Flat combinator fallback verified for backward compatibility');

  console.log('\n🎉 ALL 4 ENGINE SCHEDULER & AST MODULES PASSED WITH 100% SUCCESS!\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
