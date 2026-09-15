/**
 * Strands Sentinel - Engine Evaluation & Scheduling Routes Test Suite
 * Tests authenticated triggers designed for Amazon EventBridge Scheduler and Amazon SQS consumers.
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../src/server/app.js';
import {
  userRepository,
  ruleRepository,
  subSentinelRepository,
} from '../src/db/index.js';
import type { User, Rule, SubSentinel } from '@sentinel/shared';

async function runTests() {
  console.log('🚀 Starting Engine Routes Test Suite...\n');

  // Set M2M Engine Secret for testing
  process.env.ENGINE_API_SECRET = 'sentinel_test_secret_key_123';

  const testUser: User = {
    id: `user_engine_${Date.now()}`,
    email: `engine_test_${Date.now()}@sentinel.local`,
    name: 'Engine Test User',
    google_sub: null,
    apple_sub: null,
    github_sub: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await userRepository.create(testUser);

  const testRule: Rule = {
    id: randomUUID(),
    user_id: testUser.id,
    conversation_id: null,
    title: 'Engine Route Test Rule',
    natural_language_intent: 'Test rule for engine endpoint evaluation',
    category: 'CRYPTO',
    combinator: 'SINGLE',
    status: 'ACTIVE',
    trigger_mode: 'PERSISTENT',
    cooldown_minutes: 0,
    audio_tone: 'cash_register',
    last_triggered_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await ruleRepository.create(testRule);

  const testSubSentinel: SubSentinel = {
    id: randomUUID(),
    rule_id: testRule.id,
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
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
    last_evaluated_at: 0,
  };
  await subSentinelRepository.create(testSubSentinel);

  const app = await buildServer();

  // --- Test 1: Unauthenticated request to /api/engine/tick is rejected with 401 ---
  console.log('--- Test 1: Unauthenticated Request Rejection ---');
  const unauthRes = await app.inject({
    method: 'POST',
    url: '/api/engine/tick',
    payload: {},
  });
  assert.strictEqual(unauthRes.statusCode, 401, 'Unauthenticated request must return 401');
  console.log('  ✔ POST /api/engine/tick without credentials returns 401 Unauthorized');

  // --- Test 2: M2M Authentication via Authorization Bearer Secret ---
  console.log('\n--- Test 2: M2M Authentication via Bearer Secret ---');
  const m2mBearerRes = await app.inject({
    method: 'POST',
    url: '/api/engine/tick',
    headers: {
      Authorization: `Bearer ${process.env.ENGINE_API_SECRET}`,
    },
    payload: {
      now: Date.now(),
      limit: 50,
    },
  });
  assert.strictEqual(m2mBearerRes.statusCode, 200, 'Bearer secret request must return 200');
  const bearerData = m2mBearerRes.json();
  assert.strictEqual(bearerData.success, true);
  assert(typeof bearerData.evaluatedSubSentinels === 'number');
  assert(typeof bearerData.triggeredRules === 'number');
  console.log('  ✔ POST /api/engine/tick with Bearer secret succeeded:', bearerData.message);

  // --- Test 3: M2M Authentication via X-Engine-Secret Header ---
  console.log('\n--- Test 3: M2M Authentication via X-Engine-Secret Header ---');
  const m2mHeaderRes = await app.inject({
    method: 'POST',
    url: '/api/engine/tick',
    headers: {
      'x-engine-secret': process.env.ENGINE_API_SECRET,
    },
    payload: {},
  });
  assert.strictEqual(m2mHeaderRes.statusCode, 200, 'X-Engine-Secret header request must return 200');
  const headerData = m2mHeaderRes.json();
  assert.strictEqual(headerData.success, true);
  console.log('  ✔ POST /api/engine/tick with X-Engine-Secret header succeeded');

  // --- Test 4: On-demand Rule Evaluation Endpoint (/api/engine/evaluate-rule/:ruleId) ---
  console.log('\n--- Test 4: On-Demand Rule Evaluation Endpoint ---');
  const notFoundRuleId = randomUUID();
  const notFoundRes = await app.inject({
    method: 'POST',
    url: `/api/engine/evaluate-rule/${notFoundRuleId}`,
    headers: {
      'x-engine-secret': process.env.ENGINE_API_SECRET,
    },
    payload: {},
  });
  assert.strictEqual(notFoundRes.statusCode, 404, 'Non-existent rule must return 404');
  console.log('  ✔ POST /api/engine/evaluate-rule/:ruleId for non-existent rule returned 404 Not Found');

  const evalRuleRes = await app.inject({
    method: 'POST',
    url: `/api/engine/evaluate-rule/${testRule.id}`,
    headers: {
      'x-engine-secret': process.env.ENGINE_API_SECRET,
    },
    payload: {
      forceEvaluateChildren: true,
    },
  });
  assert.strictEqual(evalRuleRes.statusCode, 200, 'Valid rule evaluation must return 200');
  const evalRuleData = evalRuleRes.json();
  assert.strictEqual(evalRuleData.success, true);
  assert.strictEqual(evalRuleData.ruleId, testRule.id);
  assert(typeof evalRuleData.isTriggered === 'boolean');
  console.log(`  ✔ POST /api/engine/evaluate-rule/${testRule.id} evaluated successfully (isTriggered: ${evalRuleData.isTriggered})`);

  await app.close();
  console.log('\n🎉 ALL ENGINE ROUTE & M2M AUTHENTICATION TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
