import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  evaluateStockCondition,
  evaluateCryptoCondition,
  evaluatePredictionMarketCondition,
} from '../src/harness/finance_common/condition_evaluator.js';
import { StockEvaluator, isUsMarketHours } from '../src/services/evaluators/stock_evaluator.js';
import { CryptoEvaluator } from '../src/services/evaluators/crypto_evaluator.js';
import { PredictionMarketEvaluator } from '../src/services/evaluators/prediction_market_evaluator.js';
import { evaluateConditionTree, evaluateConditionTreeKleene } from '@sentinel/shared';
import { subSentinelRepository, ruleRepository, userRepository } from '../src/db/index.js';
import type { SubSentinel, Rule, User } from '@sentinel/shared';
import { safeFetch } from '../src/harness/deep_web_search/security/safe_fetch.js';

async function runHardeningTests() {
  console.log('🚀 Running Sentinel 20-Point Hardening Regression Suite...\n');

  // -------------------------------------------------------------
  // Test 1: Kleene 3-Valued Logic & Error Isolation (Findings 1, 3)
  // -------------------------------------------------------------
  console.log('--- Test 1: Kleene 3-Valued Logic & Error Isolation ---');
  const notTree: any = {
    type: 'NOT',
    child: {
      type: 'LEAF',
      subSentinelId: 'error-node',
    },
  };

  const nodeStatesWithUnknown = new Map<string, boolean | null>([
    ['error-node', null],
  ]);

  const notResult = evaluateConditionTreeKleene(notTree, nodeStatesWithUnknown);
  assert.strictEqual(
    notResult,
    null,
    'Kleene NOT(UNKNOWN) must evaluate to null (UNKNOWN), never true'
  );

  const legacyNotResult = evaluateConditionTree(notTree, nodeStatesWithUnknown);
  assert.strictEqual(
    legacyNotResult,
    false,
    'evaluateConditionTree must treat UNKNOWN as false (not satisfied)'
  );
  console.log('  [PASS] Kleene 3-valued logic prevents false positive triggers on error.');

  // -------------------------------------------------------------
  // Test 2: Numerical Safety & Missing Thresholds (Findings 5, 6)
  // -------------------------------------------------------------
  console.log('--- Test 2: Numerical Safety & Missing Thresholds ---');
  const missingTargetResult = evaluateStockCondition({
    targetType: 'PRICE',
    operator: 'GREATER_THAN',
    observedValue: 150,
    targetValue: undefined,
  });
  assert.strictEqual(
    missingTargetResult.conditionSatisfied,
    false,
    'GREATER_THAN without targetValue must NOT satisfy'
  );

  const touchesNegative = evaluateStockCondition({
    targetType: 'PRICE',
    operator: 'TOUCHES',
    observedValue: 100,
    targetValue: -100,
  });
  assert.strictEqual(
    touchesNegative.conditionSatisfied,
    false,
    'TOUCHES with negative target when price is positive must NOT satisfy'
  );

  const zeroBaseline = evaluateStockCondition({
    targetType: 'PRICE',
    operator: 'PERCENT_CHANGE',
    observedValue: 100,
    targetValue: 5,
    candles: [
      { timestamp: 1, open: 0, high: 0, low: 0, close: 0, volume: 10 },
      { timestamp: 2, open: 100, high: 100, low: 100, close: 100, volume: 10 },
    ],
  });
  assert.strictEqual(
    zeroBaseline.conditionSatisfied,
    false,
    'PERCENT_CHANGE with zero baseline must fail gracefully without Infinity'
  );
  console.log('  [PASS] Numerical boundaries and missing threshold guards verified.');

  // -------------------------------------------------------------
  // Test 3: SSRF Containment on Internal IPs (Finding 8)
  // -------------------------------------------------------------
  console.log('--- Test 3: SSRF Containment on Internal IPs ---');
  await assert.rejects(
    async () => {
      await safeFetch('http://169.254.169.254/latest/meta-data/');
    },
    (err: any) => err.message.includes('[SSRF Guard]'),
    'AWS metadata service IP must be blocked by safeFetch'
  );

  await assert.rejects(
    async () => {
      await safeFetch('http://127.0.0.1:8080/internal-admin');
    },
    (err: any) => err.message.includes('[SSRF Guard]'),
    'Loopback IP must be blocked by safeFetch'
  );
  console.log('  [PASS] safeFetch strictly rejects private IP and cloud metadata destinations.');

  // -------------------------------------------------------------
  // Test 4: Stock Evaluator Provider Fidelity & High/Low (Finding 10)
  // -------------------------------------------------------------
  console.log('--- Test 4: Stock Evaluator Provider Fidelity & High/Low ---');
  let finnhubCalled = false;
  let yahooCalled = false;

  const mockYahooForStock: any = {
    getQuote: async () => {
      yahooCalled = true;
      return {
        currentPrice: 100,
        previousClose: 98,
        high: 105,
        low: 95,
      };
    },
    getCandles: async () => [],
  };

  const mockFinnhubForStock: any = {
    isConfigured: () => true,
    getQuote: async () => {
      finnhubCalled = true;
      return {
        currentPrice: 100,
        previousClose: 98,
        high: 105,
        low: 95,
      };
    },
  };

  const stockEval = new StockEvaluator(mockYahooForStock, mockFinnhubForStock);

  await stockEval.evaluate({
    id: randomUUID(),
    rule_id: 'rule-1',
    sentinel_type: 'STOCK',
    target_source: 'AAPL',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      ticker: 'AAPL',
      provider: 'YAHOO',
      targetValue: 90,
    }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  });

  assert.strictEqual(yahooCalled, true, 'Yahoo must be called when provider is YAHOO');
  assert.strictEqual(finnhubCalled, false, 'Finnhub must NOT be called when provider is YAHOO');
  console.log('  [PASS] Stock evaluator provider preference strictly honored.');

  const saturday = new Date('2026-03-21T18:00:00Z');
  assert.strictEqual(isUsMarketHours(saturday), false, 'Weekend must not be US market hours');
  console.log('  [PASS] US regular trading hours logic verified.');

  // -------------------------------------------------------------
  // Test 5: Crypto Evaluator Strict Venue Isolation (Finding 11)
  // -------------------------------------------------------------
  console.log('--- Test 5: Crypto Evaluator Strict Venue Isolation ---');
  let coinbaseCalled = false;
  const mockCoinbase: any = {
    resolveProduct: async () => {
      coinbaseCalled = true;
      return { id: 'PEPE-USD' };
    },
    getSpotPrice: async () => ({ price: 0.00001, high24h: 0.000012, low24h: 0.000009 }),
    getCandles: async () => [],
  };

  const mockDexScreener: any = {
    searchPairs: async () => [],
  };

  const cryptoEval = new CryptoEvaluator();
  (cryptoEval as any).coinbase = mockCoinbase;
  (cryptoEval as any).dexscreener = mockDexScreener;

  const dexSubSentinel: SubSentinel = {
    id: randomUUID(),
    rule_id: 'rule-1',
    sentinel_type: 'CRYPTO',
    target_source: 'PEPE',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      assetSymbol: 'PEPE',
      venue: 'DEXSCREENER',
      targetValue: 0.0001,
    }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };

  const dexResult = await cryptoEval.evaluate(dexSubSentinel);
  assert.strictEqual(
    coinbaseCalled,
    false,
    'Coinbase must NEVER be called when venue is DEXSCREENER'
  );
  assert.strictEqual(
    dexResult.error,
    'DEX_PAIR_UNAVAILABLE',
    'DEX failure must return DEX_PAIR_UNAVAILABLE'
  );
  console.log('  [PASS] Crypto evaluator venue isolation verified (no cross-venue fallback).');

  // -------------------------------------------------------------
  // Test 6: Prediction Market Closed Market & Outcome Check (Finding 12)
  // -------------------------------------------------------------
  console.log('--- Test 6: Prediction Market Closed Market & Outcome Check ---');
  const mockPolymarket: any = {
    getMarketByConditionId: async (_id: string, opts?: any) => {
      assert.ok(opts?.allowClosed, 'allowClosed must be passed during condition lookup');
      return {
        id: '0x123',
        question: 'Will SpaceX land on Mars in 2026?',
        conditionId: '0x123',
        outcomes: ['Yes', 'No'],
        outcomePrices: [0.15, 0.85],
        clobTokenIds: ['tok-yes', 'tok-no'],
        closed: true,
        active: false,
      };
    },
    getMidpointPrice: async () => 0.15,
  };

  const predEval = new PredictionMarketEvaluator(mockPolymarket);

  const closedMarketResult = await predEval.evaluate({
    id: randomUUID(),
    rule_id: 'rule-1',
    sentinel_type: 'PREDICTION_MARKET',
    target_source: '0x123',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      conditionId: '0x123',
      outcome: 'Yes',
      targetProbability: 0.10,
    }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  });

  assert.strictEqual(closedMarketResult.isSatisfied, false);
  assert.strictEqual(closedMarketResult.error, 'MARKET_CLOSED');
  console.log('  [PASS] Closed prediction market detected and returned MARKET_CLOSED.');

  const mockPolymarketOpen: any = {
    getMarketByConditionId: async () => ({
      id: '0x456',
      question: 'Next President?',
      conditionId: '0x456',
      outcomes: ['Trump', 'Harris'],
      outcomePrices: [0.55, 0.45],
      clobTokenIds: ['tok-trump', 'tok-harris'],
      closed: false,
      active: true,
    }),
  };
  const predEvalOpen = new PredictionMarketEvaluator(mockPolymarketOpen);

  const invalidOutcomeResult = await predEvalOpen.evaluate({
    id: randomUUID(),
    rule_id: 'rule-1',
    sentinel_type: 'PREDICTION_MARKET',
    target_source: '0x456',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({
      conditionId: '0x456',
      outcome: 'Vance',
      targetProbability: 0.10,
    }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  });

  assert.strictEqual(invalidOutcomeResult.isSatisfied, false);
  assert.strictEqual(invalidOutcomeResult.error, 'INVALID_OUTCOME');
  console.log('  [PASS] Invalid outcome name rejected with INVALID_OUTCOME.');

  // -------------------------------------------------------------
  // Test 7: Distributed Concurrency Lease Claim (Finding 18)
  // -------------------------------------------------------------
  console.log('--- Test 7: Distributed Concurrency Lease Claim ---');
  const claimUser: User = {
    id: `user_claim_${Date.now()}`,
    email: `claim_${Date.now()}@sentinel.local`,
    name: 'Claim Tester',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await userRepository.create(claimUser);

  const claimRule: Rule = {
    id: randomUUID(),
    user_id: claimUser.id,
    title: 'Claim Test Rule',
    natural_language_intent: 'Test atomic lease claim',
    category: 'FINANCIAL',
    combinator: 'SINGLE',
    trigger_mode: 'PERSISTENT',
    cooldown_minutes: 0,
    audio_tone: 'chime',
    status: 'ACTIVE',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await ruleRepository.create(claimRule);

  const claimSubSentinelId = randomUUID();
  await subSentinelRepository.create({
    id: claimSubSentinelId,
    rule_id: claimRule.id,
    sentinel_type: 'STOCK',
    target_source: 'NVDA',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({ ticker: 'NVDA', targetValue: 150 }),
    ttl_seconds: 60,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
    last_evaluated_at: null,
  });

  const now = Date.now();
  const worker1Claim = await subSentinelRepository.claim(claimSubSentinelId, now);
  assert.strictEqual(worker1Claim, true, 'Worker 1 must successfully claim due sub-sentinel');

  const worker2Claim = await subSentinelRepository.claim(claimSubSentinelId, now);
  assert.strictEqual(
    worker2Claim,
    false,
    'Worker 2 must be REJECTED when claiming already-claimed sub-sentinel'
  );
  console.log('  [PASS] Distributed concurrency lease strictly guarantees single-worker execution.');

  // -------------------------------------------------------------
  // Test 8: Rule Expiration Enforcement (Finding 4)
  // -------------------------------------------------------------
  console.log('--- Test 8: Rule Expiration Enforcement ---');
  const expiredRule: Rule = {
    id: randomUUID(),
    user_id: claimUser.id,
    title: 'Expired Rule',
    natural_language_intent: 'Expired sentinel',
    category: 'FINANCIAL',
    combinator: 'SINGLE',
    trigger_mode: 'PERSISTENT',
    cooldown_minutes: 0,
    audio_tone: 'chime',
    status: 'ACTIVE',
    expires_at: Date.now() - 60000,
    created_at: Date.now() - 120000,
    updated_at: Date.now() - 120000,
  };
  await ruleRepository.create(expiredRule);

  const expiredSubId = randomUUID();
  await subSentinelRepository.create({
    id: expiredSubId,
    rule_id: expiredRule.id,
    sentinel_type: 'STOCK',
    target_source: 'GOOGL',
    operator: 'GREATER_THAN',
    threshold: JSON.stringify({ ticker: 'GOOGL', targetValue: 150 }),
    ttl_seconds: 1,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
    last_evaluated_at: null,
  });

  const dueList = await subSentinelRepository.getDue(Date.now(), 100);
  const foundExpired = dueList.find((s) => s.id === expiredSubId);
  assert.strictEqual(
    foundExpired,
    undefined,
    'Sub-sentinels belonging to expired rules must NOT be returned by getDue()'
  );
  console.log('  [PASS] Expired rules automatically excluded from evaluation pipeline.');

  console.log('\n🎉 ALL HARDENING AUDIT TESTS COMPLETED SUCCESSFULLY!');
}

runHardeningTests().catch((err) => {
  console.error('❌ Hardening test suite failed:', err);
  process.exit(1);
});
