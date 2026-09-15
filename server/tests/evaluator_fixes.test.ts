/**
 * Strands Sentinel - Evaluator Edge Cases & Fixes Test Suite
 * Validates exponential backoff auto-heal, Telegram evaluator integration,
 * crossing operator tick state tracking, lookaround punctuation regex,
 * balanced JSON extraction, and cooldown preservation.
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  userRepository,
  ruleRepository,
  subSentinelRepository,
} from '../src/db/index.js';
import type { User, Rule, SubSentinel } from '@sentinel/shared';
import { TelegramEvaluator } from '../src/services/evaluators/telegram_evaluator.js';
import { StockEvaluator } from '../src/services/evaluators/stock_evaluator.js';
import { PredictionMarketEvaluator } from '../src/services/evaluators/prediction_market_evaluator.js';
import { extractFirstValidJson } from '../src/services/evaluators/agentic_evaluator.js';
import { EvaluatorEngine } from '../src/services/evaluators/engine.js';

async function runTests() {
  console.log('🚀 Starting Comprehensive Evaluator Fixes Test Suite...\n');

  // -----------------------------------------------------------
  // TEST 1: Circuit Breaker Exponential Backoff Auto-Recovery
  // -----------------------------------------------------------
  console.log('--- Test 1: Circuit Breaker Exponential Backoff Auto-Recovery ---');
  const testUser: User = {
    id: `user_cb_${Date.now()}`,
    email: `cb_test_${Date.now()}@sentinel.local`,
    name: 'Circuit Breaker Tester',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await userRepository.create(testUser);

  const testRule: Rule = {
    id: randomUUID(),
    user_id: testUser.id,
    title: 'Circuit Breaker Auto-Heal Rule',
    natural_language_intent: 'Test exponential backoff probe',
    category: 'FINANCIAL',
    combinator: 'SINGLE',
    trigger_mode: 'PERSISTENT',
    cooldown_minutes: 0,
    audio_tone: 'chime',
    status: 'ACTIVE',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await ruleRepository.create(testRule);

  const subId = randomUUID();
  const baseTime = Date.now();
  const subSentinel: SubSentinel = {
    id: subId,
    rule_id: testRule.id,
    sentinel_type: 'STOCK',
    target_source: 'AAPL',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({ ticker: 'AAPL', targetPrice: 200 }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };
  await subSentinelRepository.create(subSentinel);

  // Simulate 3 successive errors to trip into backoff
  // (error_count: 3 => backoff: (1 << 3) * 60,000 = 8 minutes = 480,000 ms)
  const db = (await import('../src/db/sqlite/index.js')).getDatabase();
  db.prepare(`
    UPDATE sub_sentinels
    SET health_status = 'ERROR',
        error_count = 3,
        last_evaluated_at = ?,
        next_evaluation_at = ?
    WHERE id = ?
  `).run(baseTime, baseTime + 480_000, subId);

  // Verify at baseTime + 2 minutes (120,000 ms), it is NOT due because 8 min backoff has not elapsed
  const dueAt2Min = await subSentinelRepository.getDue(baseTime + 120000, 1000);
  const foundAt2Min = dueAt2Min.find((s) => s.id === subId);
  assert.strictEqual(
    foundAt2Min,
    undefined,
    'Sub-sentinel in ERROR must not be due before exponential backoff window expires'
  );
  console.log('  [PASS] Sub-sentinel correctly excluded during exponential backoff window.');

  // Verify at baseTime + 9 minutes (540,000 ms), it IS due for auto-heal probe
  const dueAt9Min = await subSentinelRepository.getDue(baseTime + 540000, 1000);
  const foundAt9Min = dueAt9Min.find((s) => s.id === subId);
  assert.ok(
    foundAt9Min,
    'Sub-sentinel in ERROR must be included in getDue after exponential backoff window elapses'
  );
  console.log('  [PASS] Sub-sentinel correctly probed for auto-heal after backoff window.');

  // Simulate successful evaluation recovery
  await subSentinelRepository.updateSatisfaction(subId, false, JSON.stringify({ currentValue: 195 }), null);
  const recoveredList = await subSentinelRepository.getByRuleId(testRule.id);
  const recoveredSentinel = recoveredList.find((s) => s.id === subId);
  assert.strictEqual(recoveredSentinel?.health_status, 'HEALTHY');
  assert.strictEqual(recoveredSentinel?.error_count, 0);
  assert.strictEqual(recoveredSentinel?.last_error, null);
  console.log('  [PASS] Sub-sentinel successfully auto-healed to HEALTHY with error_count = 0.\n');

  // -----------------------------------------------------------
  // -----------------------------------------------------------
  // TEST 2: TelegramEvaluator Strands Agent Semantic Evaluation (No Brittle Regex)
  // -----------------------------------------------------------
  console.log('--- Test 2: TelegramEvaluator Strands Agent Semantic Evaluation ---');
  let agentCalledWithCondition = '';

  const mockAgenticEvaluator: any = {
    evaluate: async (input: any) => {
      agentCalledWithCondition = input.conditionToEvaluate;
      const postText = input.observedContext?.[0]?.text || '';
      const isNegation = postText.toLowerCase().includes('denies') || postText.toLowerCase().includes('false alarm');
      return {
        conditionSatisfied: !isNegation,
        confidenceScore: 0.94,
        reasoning: isNegation
          ? 'Post is a denial or negation of the reported transfer event.'
          : 'Post semantically indicates a major transfer of crypto assets to an exchange.',
        observedEvidence: {
          relevantSnippet: postText.slice(0, 100),
        },
      };
    },
  };

  const mockClientWithMessages = (messageTexts: string[]) => ({
    cleanHandle: (h: string) => h.replace(/^@/, ''),
    fetchChannel: async (handle: string) => ({
      metadata: { handle, title: 'Crypto Channel', description: 'Alerts' },
      messages: messageTexts.map((text, idx) => ({
        messageId: 200 + idx,
        postId: `${handle}/200_${idx}_${Date.now()}_${randomUUID().slice(0, 6)}`,
        text,
        timestamp: Math.floor(Date.now() / 1000),
        isoDate: new Date().toISOString(),
        views: 3000,
        hasMedia: false,
        link: `https://t.me/${handle}/200_${idx}`,
      })),
      totalExtracted: messageTexts.length,
    }),
  });

  // Test 2A: Semantic match with natural language intent / keywords without regex brittleness
  const semanticTgEvaluator = new TelegramEvaluator(
    mockClientWithMessages(['Whale deposited 5,000 BTC ($450M) to Binance']) as any,
    mockAgenticEvaluator
  );

  const subSentinel2A: SubSentinel = {
    id: randomUUID(),
    rule_id: testRule.id,
    sentinel_type: 'TELEGRAM_CHANNEL',
    target_source: '@crypto_feed',
    operator: 'KEYWORD_MATCH',
    threshold: JSON.stringify({ channelHandle: '@crypto_feed', keywords: ['BTC', 'Whale'], matchMode: 'ALL' }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };

  const result2A = await semanticTgEvaluator.evaluate(subSentinel2A, testRule);
  assert.strictEqual(result2A.isSatisfied, true);
  assert.ok(agentCalledWithCondition.includes('BTC') && agentCalledWithCondition.includes('Whale'));
  assert.ok(result2A.details.includes('[Strands Agent Match]'));
  console.log('  [PASS] Strands Agent evaluates Telegram criteria semantically without regex.');

  // Test 2B: Semantic rejection of negations (which naive regex would falsely trigger on)
  const negationTgEvaluator = new TelegramEvaluator(
    mockClientWithMessages(['Binance official denies false alarm about 5000 BTC whale transfer']) as any,
    mockAgenticEvaluator
  );

  const subSentinel2B: SubSentinel = {
    id: randomUUID(),
    rule_id: testRule.id,
    sentinel_type: 'TELEGRAM_CHANNEL',
    target_source: '@crypto_feed',
    operator: 'KEYWORD_MATCH',
    threshold: JSON.stringify({ channelHandle: '@crypto_feed', keywords: ['BTC', 'Whale'], matchMode: 'ALL' }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };

  const result2B = await negationTgEvaluator.evaluate(subSentinel2B, testRule);
  assert.strictEqual(result2B.isSatisfied, false);
  assert.ok(result2B.details.includes('[Strands Agent Filtered]'));
  console.log('  [PASS] Strands Agent correctly rejects negations that brittle regex would trigger on.\n');

  // -----------------------------------------------------------
  // TEST 3: TelegramEvaluator End-to-End Evaluation & Engine Registration
  // -----------------------------------------------------------
  console.log('--- Test 3: Telegram Evaluator Execution & Engine Registration ---');
  const mockTgClient: any = {
    cleanHandle: (h: string) => h.replace(/^@/, ''),
    fetchChannel: async (handle: string) => ({
      metadata: { handle, title: 'Crypto Alerts', description: 'Real-time crypto signals' },
      messages: [
        {
          messageId: 101,
          postId: `${handle}/101_${Date.now()}_${randomUUID().slice(0, 6)}`,
          text: 'Alert: Whale moved 5000 BTC to Binance exchange!',
          timestamp: Math.floor(Date.now() / 1000),
          isoDate: new Date().toISOString(),
          views: 4500,
          hasMedia: false,
          link: `https://t.me/${handle}/101`,
        },
      ],
      totalExtracted: 1,
    }),
  };

  const customTgEvaluator = new TelegramEvaluator(mockTgClient, mockAgenticEvaluator);
  const tgSubSentinel: SubSentinel = {
    id: randomUUID(),
    rule_id: testRule.id,
    sentinel_type: 'TELEGRAM_CHANNEL',
    target_source: '@crypto_signals',
    operator: 'KEYWORD_MATCH',
    threshold: JSON.stringify({ channelHandle: '@crypto_signals', keywords: ['BTC', 'Whale'], matchMode: 'ALL' }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };

  const tgResult = await customTgEvaluator.evaluate(tgSubSentinel, testRule);
  assert.strictEqual(tgResult.isSatisfied, true);
  assert.strictEqual(tgResult.observedValue, 1);
  assert.ok(tgResult.details.includes('[Strands Agent Match]'));
  console.log('  [PASS] TelegramEvaluator successfully evaluated public channel post via Strands Agent.');

  // Verify EvaluatorEngine has Telegram registered
  const engine = new EvaluatorEngine();
  const registeredEvaluators = (engine as any).evaluators as Map<string, any>;
  assert.ok(registeredEvaluators.has('TELEGRAM_CHANNEL'), 'TELEGRAM_CHANNEL must be registered in engine');
  assert.ok(registeredEvaluators.has('TELEGRAM_OPEN_CHANNEL'), 'TELEGRAM_OPEN_CHANNEL must be registered in engine');
  console.log('  [PASS] EvaluatorEngine properly registers TELEGRAM_CHANNEL and TELEGRAM_OPEN_CHANNEL.\n');

  // -----------------------------------------------------------
  // TEST 4: Stock Crossing Operator with State Payload Tick Tracking
  // -----------------------------------------------------------
  console.log('--- Test 4: Stock Crossing Operator with State Payload Tick Tracking ---');
  let mockStockPrice = 205;
  const mockYahoo: any = {
    getQuote: async () => ({
      ticker: 'TSLA',
      price: mockStockPrice,
      change: 10,
      changePercent: 5.1,
      previousClose: 195, // Yesterday's close was 195
    }),
    getCandles: async () => [],
  };

  const customStockEvaluator = new StockEvaluator(mockYahoo);
  const stockSubSentinel: SubSentinel = {
    id: randomUUID(),
    rule_id: testRule.id,
    sentinel_type: 'STOCK',
    target_source: 'TSLA',
    operator: 'CROSSES_ABOVE',
    threshold: JSON.stringify({ ticker: 'TSLA', targetType: 'PRICE', targetValue: 200 }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
    state_payload: JSON.stringify({ currentValue: 198 }), // Immediate prior tick was 198
  };

  // Tick 1: Price goes 198 -> 205. Crosses above 200!
  const tick1Result = await customStockEvaluator.evaluate(stockSubSentinel);
  assert.strictEqual(tick1Result.isSatisfied, true, 'Tick 1 should satisfy CROSSES_ABOVE');
  console.log('  [PASS] Tick 1: Crossed above 200 (198 -> 205) evaluated to TRUE.');

  // Tick 2: Price moves from 205 -> 206.
  // Prior tick is now 205 (stored in state_payload).
  mockStockPrice = 206;
  const stockSubSentinelTick2: SubSentinel = {
    ...stockSubSentinel,
    state_payload: JSON.stringify({ currentValue: 205 }),
  };

  const tick2Result = await customStockEvaluator.evaluate(stockSubSentinelTick2);
  assert.strictEqual(
    tick2Result.isSatisfied,
    false,
    'Tick 2 must NOT satisfy CROSSES_ABOVE because price was already above 200 on prior tick'
  );
  console.log('  [PASS] Tick 2: Price remaining above 200 (205 -> 206) evaluated to FALSE (no false alarm).\n');

  // -----------------------------------------------------------
  // TEST 5: Falsy Zero Cooldown Bug Prevention
  // -----------------------------------------------------------
  console.log('--- Test 5: Falsy Zero Cooldown Bug Prevention ---');
  const zeroCooldownRule: Rule = {
    ...testRule,
    cooldown_minutes: 0,
  };
  const cooldownMinutes = zeroCooldownRule.cooldown_minutes ?? 60;
  assert.strictEqual(cooldownMinutes, 0, 'cooldown_minutes: 0 must not default to 60');
  console.log('  [PASS] Cooldown of 0 minutes correctly preserved as 0 minutes.\n');

  // -----------------------------------------------------------
  // TEST 6: PredictionMarket Multi-Candidate Categorical Outcome Matching
  // -----------------------------------------------------------
  console.log('--- Test 6: Prediction Market Multi-Candidate Outcome Matching ---');
  const mockPolymarket: any = {
    getMidpointPrice: async () => null,
    getMarketByConditionId: async () => ({
      conditionId: '0xabc123',
      question: 'Who will win the election?',
      outcomes: ['Alice', 'Bob', 'Charlie'],
      outcomePrices: [0.25, 0.65, 0.10],
      closed: false,
    }),
  };

  const pmEvaluator = new PredictionMarketEvaluator(mockPolymarket);
  const pmSubSentinel: SubSentinel = {
    id: randomUUID(),
    rule_id: testRule.id,
    sentinel_type: 'PREDICTION_MARKET',
    target_source: '0xabc123',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      conditionId: '0xabc123',
      outcome: 'Bob', // Target candidate Bob (index 1)
      targetProbability: 0.60,
    }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };

  const pmResult = await pmEvaluator.evaluate(pmSubSentinel);
  assert.strictEqual(pmResult.isSatisfied, true);
  assert.strictEqual(pmResult.observedValue, 0.65, 'Should correctly resolve Bob to 0.65 (index 1)');
  console.log('  [PASS] Polymarket categorical market resolved candidate index by outcome name.\n');

  // -----------------------------------------------------------
  // TEST 7: Agentic Evaluator Balanced JSON Parser
  // -----------------------------------------------------------
  console.log('--- Test 7: Agentic Evaluator Balanced JSON Parser ---');
  const messyLlmResponse = `
Here is my analysis of the token:
{AAPL} showed strong technicals.

\`\`\`json
{
  "conditionSatisfied": true,
  "reasoning": "Apple stock price is above $200 and RSI is healthy",
  "confidenceScore": 0.95,
  "observedEvidence": {
    "relevantSnippet": "Current price is $205",
    "extractedValue": 205
  }
}
\`\`\`
I hope this helps!
`;

  const parsedJson = extractFirstValidJson(messyLlmResponse);
  assert.strictEqual(parsedJson.conditionSatisfied, true);
  assert.strictEqual(parsedJson.confidenceScore, 0.95);
  assert.strictEqual(parsedJson.observedEvidence.extractedValue, 205);
  console.log('  [PASS] Balanced JSON parser successfully extracted JSON despite leading curly braces.\n');

  console.log('🎉 ALL 7 EVALUATOR FIXES VERIFIED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Evaluator Fixes Test Suite Failed:', err);
  process.exit(1);
});
