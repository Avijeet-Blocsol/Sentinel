import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  PredictionMarketThresholdSchema,
} from '@sentinel/shared';
import {
  PredictionMarketHarness,
  type PredictionMarketTask,
  runPredictionMarketPipeline,
} from '../src/harness/prediction_market/index.js';
import { createPredictionMarketTool } from '../src/harness/prediction_market/tools/prediction_market_tool.js';
import {
  PolymarketClient,
  type PolymarketMarket,
  ProviderError,
  evaluatePredictionMarketCondition,
} from '../src/harness/finance_common/index.js';

async function runPredictionMarketTestSuite() {
  console.log('\n==========================================================');
  console.log('🧪 TEST SUITE: PREDICTION MARKET HARNESS REGRESSION SUITE');
  console.log('==========================================================\n');

  const validYesNoMarket: PolymarketMarket = {
    id: '0x1111111111111111111111111111111111111111',
    question: 'Will Donald Trump win the 2024 Presidential Election?',
    conditionId: '0x1111111111111111111111111111111111111111',
    slug: 'will-donald-trump-win-2024-presidential-election',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.60, 0.40],
    clobTokenIds: [
      '1111111111111111111111111111111111111111111111111111111111111111',
      '2222222222222222222222222222222222222222222222222222222222222222',
    ],
    volume: 5000000,
    volume24hr: 150000,
    endDate: '2024-11-05T00:00:00Z',
    active: true,
    closed: false,
  };

  // ---------------------------------------------------------
  // 1. Condition Evaluation (Satisfied vs Unsatisfied)
  // ---------------------------------------------------------
  console.log('--- 1. Testing Threshold Condition Evaluation ---');

  // GREATER_THAN Satisfied: 0.60 > 0.50
  const satGtEval = evaluatePredictionMarketCondition({
    operator: 'GREATER_THAN',
    observedProbability: 0.60,
    targetProbability: 0.50,
    outcome: 'YES',
  });
  assert.strictEqual(satGtEval.conditionSatisfied, true, 'Expected GREATER_THAN to be satisfied');
  console.log('  [PASS] evaluatePredictionMarketCondition GREATER_THAN satisfied (60% > 50%)');

  // GREATER_THAN Unsatisfied: 0.40 > 0.50
  const unsatGtEval = evaluatePredictionMarketCondition({
    operator: 'GREATER_THAN',
    observedProbability: 0.40,
    targetProbability: 0.50,
    outcome: 'YES',
  });
  assert.strictEqual(unsatGtEval.conditionSatisfied, false, 'Expected GREATER_THAN to be unsatisfied');
  assert.ok(unsatGtEval.evaluationDetails.includes('NOT greater than'));
  console.log('  [PASS] evaluatePredictionMarketCondition GREATER_THAN unsatisfied (40% > 50%)');

  // LESS_THAN Satisfied: 0.35 < 0.50
  const satLtEval = evaluatePredictionMarketCondition({
    operator: 'LESS_THAN',
    observedProbability: 0.35,
    targetProbability: 0.50,
    outcome: 'YES',
  });
  assert.strictEqual(satLtEval.conditionSatisfied, true, 'Expected LESS_THAN to be satisfied');
  console.log('  [PASS] evaluatePredictionMarketCondition LESS_THAN satisfied (35% < 50%)');

  // EQUALS Satisfied with tolerance (0.502 == 0.50)
  const satEqEval = evaluatePredictionMarketCondition({
    operator: 'EQUALS',
    observedProbability: 0.502,
    targetProbability: 0.50,
    outcome: 'YES',
  });
  assert.strictEqual(satEqEval.conditionSatisfied, true, 'Expected EQUALS to be satisfied within 0.5% tolerance');
  console.log('  [PASS] evaluatePredictionMarketCondition EQUALS satisfied within tolerance');

  // Crossing operator without snapshots produces unsupported details
  const crossingEval = evaluatePredictionMarketCondition({
    operator: 'CROSSES_ABOVE',
    observedProbability: 0.60,
    targetProbability: 0.50,
    outcome: 'YES',
  });
  assert.strictEqual(crossingEval.conditionSatisfied, false);
  assert.ok(crossingEval.evaluationDetails.includes('requires historical probability snapshots'));
  console.log('  [PASS] evaluatePredictionMarketCondition CROSSES_ABOVE without snapshots rejected');

  // ---------------------------------------------------------
  // 2. Crossing Operators in Pipeline Return Explicit ERROR
  // ---------------------------------------------------------
  console.log('\n--- 2. Testing Crossing Operators Pipeline Rejection ---');
  // Mock searchMarkets on a client instance
  const origSearch = PolymarketClient.prototype.searchMarkets;
  const origMidpoint = PolymarketClient.prototype.getMidpointPrice;
  const origOrderbook = PolymarketClient.prototype.getOrderbook;
  const origCondition = PolymarketClient.prototype.getMarketByConditionId;

  try {
    PolymarketClient.prototype.searchMarkets = async () => [validYesNoMarket];
    PolymarketClient.prototype.getMidpointPrice = async () => 0.60;
    PolymarketClient.prototype.getOrderbook = async () => ({
      bids: [{ price: '0.59', size: '100' }],
      asks: [{ price: '0.61', size: '100' }],
    });

    const harness = new PredictionMarketHarness();

    const crossingTask: PredictionMarketTask = {
      id: `task-crossing-${Date.now()}`,
      query: 'Trump probability crosses above 50%',
      expectedOperator: 'CROSSES_ABOVE',
      targetProbability: 0.50,
    };

    const crossingOutcome = await harness.research(crossingTask);
    assert.strictEqual(crossingOutcome.status, 'ERROR', `Expected ERROR for CROSSES_ABOVE, got ${crossingOutcome.status}`);
    assert.ok(
      (crossingOutcome as any).error.includes('requires historical probability snapshots'),
      'Expected error to explain snapshots requirement'
    );
    console.log('  [PASS] CROSSES_ABOVE correctly returned explicit ERROR status');

    // ---------------------------------------------------------
    // 3. Unsatisfied Condition in Pipeline Returns NOT_FOUND
    // ---------------------------------------------------------
    console.log('\n--- 3. Testing Unsatisfied Condition Pipeline Outcome ---');
    const unsatTask: PredictionMarketTask = {
      id: `task-unsat-${Date.now()}`,
      query: 'Trump win probability drops below 30%',
      expectedOperator: 'LESS_THAN',
      targetProbability: 0.30,
    };

    const unsatOutcome = await harness.research(unsatTask);
    assert.strictEqual(unsatOutcome.status, 'NOT_FOUND', `Expected NOT_FOUND for unsatisfied condition, got ${unsatOutcome.status}`);
    assert.ok(
      (unsatOutcome as any).reason.includes('Condition unsatisfied'),
      `Expected reason to indicate unsatisfied condition: ${(unsatOutcome as any).reason}`
    );
    console.log('  [PASS] Unsatisfied condition returned NOT_FOUND with condition explanation');

    // ---------------------------------------------------------
    // 4. Satisfied Condition in Pipeline Returns EXACT_MATCH
    // ---------------------------------------------------------
    console.log('\n--- 4. Testing Satisfied Condition Pipeline Outcome ---');
    const satTask: PredictionMarketTask = {
      id: `task-sat-${Date.now()}`,
      query: 'Trump win probability is above 50%',
      expectedOperator: 'GREATER_THAN',
      targetProbability: 0.50,
    };

    const satOutcome = await harness.research(satTask);
    assert.strictEqual(satOutcome.status, 'EXACT_MATCH', `Expected EXACT_MATCH, got ${satOutcome.status}`);
    assert.strictEqual((satOutcome as any).contract.priceType, 'MIDPOINT');
    assert.strictEqual((satOutcome as any).contract.conditionSatisfied, true);
    PredictionMarketThresholdSchema.parse((satOutcome as any).contract);
    console.log('  [PASS] Satisfied condition returned EXACT_MATCH with valid schema');

    // ---------------------------------------------------------
    // 5. Explicit conditionId Lookup Failure Never Falls Back to Search
    // ---------------------------------------------------------
    console.log('\n--- 5. Testing Failed conditionId Lookup Does NOT Fall Back to Search ---');
    let searchCalled = false;
    PolymarketClient.prototype.getMarketByConditionId = async () => null;
    PolymarketClient.prototype.searchMarkets = async () => {
      searchCalled = true;
      return [validYesNoMarket];
    };

    const failedConditionTask: PredictionMarketTask = {
      id: `task-cond-fail-${Date.now()}`,
      query: 'Trump election',
      conditionId: '0xnonexistentconditionid',
    };

    const condFailOutcome = await harness.research(failedConditionTask);
    assert.strictEqual(condFailOutcome.status, 'NOT_FOUND', `Expected NOT_FOUND for failed conditionId lookup`);
    assert.strictEqual(searchCalled, false, 'Broad search must NOT be called when conditionId is provided!');
    assert.ok((condFailOutcome as any).reason.includes('0xnonexistentconditionid'));
    console.log('  [PASS] Failed conditionId returned NOT_FOUND and did not trigger fallback search');

    // ---------------------------------------------------------
    // 6. Provider Error Propagation (HTTP 500 / Network)
    // ---------------------------------------------------------
    console.log('\n--- 6. Testing Provider Error Propagation ---');
    PolymarketClient.prototype.getMarketByConditionId = origCondition;
    PolymarketClient.prototype.searchMarkets = async () => {
      throw new ProviderError('POLYMARKET', 500, 'Internal Server Error');
    };

    const providerFailTask: PredictionMarketTask = {
      id: `task-prov-fail-${Date.now()}`,
      query: 'Trump election',
    };

    const provFailOutcome = await harness.research(providerFailTask);
    assert.strictEqual(provFailOutcome.status, 'ERROR', `Expected ERROR for 500 failure, got ${provFailOutcome.status}`);
    assert.strictEqual((provFailOutcome as any).provider, 'POLYMARKET');
    console.log('  [PASS] Provider 500 error propagated as ERROR outcome');

    // ---------------------------------------------------------
    // 7. Midpoint Provider Failure Returns ERROR
    // ---------------------------------------------------------
    console.log('\n--- 7. Testing Midpoint Provider Failure ---');
    PolymarketClient.prototype.searchMarkets = async () => [validYesNoMarket];
    PolymarketClient.prototype.getMidpointPrice = async () => {
      throw new ProviderError('POLYMARKET', 502, 'Bad Gateway on CLOB midpoint');
    };

    const midFailOutcome = await harness.research(satTask);
    assert.strictEqual(midFailOutcome.status, 'ERROR', `Expected ERROR on midpoint provider failure, got ${midFailOutcome.status}`);
    console.log('  [PASS] Midpoint provider error returned ERROR status');

    // ---------------------------------------------------------
    // 8. Midpoint Missing Falls Back to GAMMA_PRICE (not LAST_TRADE)
    // ---------------------------------------------------------
    console.log('\n--- 8. Testing Midpoint Missing Accurately Labeled GAMMA_PRICE ---');
    PolymarketClient.prototype.getMidpointPrice = async () => null; // No midpoint order in CLOB
    PolymarketClient.prototype.getOrderbook = async () => ({
      bids: [{ price: '0.58', size: '10' }],
      asks: [{ price: '0.62', size: '10' }],
    });

    const gammaPriceOutcome = await harness.research(satTask);
    assert.strictEqual(gammaPriceOutcome.status, 'EXACT_MATCH');
    assert.strictEqual((gammaPriceOutcome as any).contract.priceType, 'GAMMA_PRICE');
    assert.ok((gammaPriceOutcome as any).confidence < 0.90, 'Confidence should be lower when midpoint is unavailable');
    PredictionMarketThresholdSchema.parse((gammaPriceOutcome as any).contract);
    console.log('  [PASS] Midpoint fallback accurately labeled GAMMA_PRICE with lower confidence');

    // ---------------------------------------------------------
    // 9. Non-Binary and Malformed Markets Rejection
    // ---------------------------------------------------------
    console.log('\n--- 9. Testing Non-Binary & Malformed Markets Rejection ---');
    const client = new PolymarketClient();

    // 3-outcome market
    const multiOutcomeRaw = {
      ...validYesNoMarket,
      outcomes: ['Trump', 'Harris', 'Vance'],
      outcomePrices: [0.50, 0.40, 0.10],
      clobTokenIds: ['tok1', 'tok2', 'tok3'],
    };
    assert.strictEqual(client.normalizeMarket(multiOutcomeRaw), null, '3-outcome market must be rejected');

    // Binary market without YES/NO
    const nonYesNoRaw = {
      ...validYesNoMarket,
      outcomes: ['Candidate A', 'Candidate B'],
      outcomePrices: [0.60, 0.40],
      clobTokenIds: ['tok1', 'tok2'],
    };
    assert.strictEqual(client.normalizeMarket(nonYesNoRaw), null, 'Non-YES/NO binary market must be rejected');

    // Market with clobTokenId equal to conditionId
    const badTokenRaw = {
      ...validYesNoMarket,
      outcomes: ['Yes', 'No'],
      outcomePrices: [0.60, 0.40],
      clobTokenIds: [validYesNoMarket.conditionId, 'tok2'],
    };
    assert.strictEqual(client.normalizeMarket(badTokenRaw), null, 'Market with clobTokenId === conditionId must be rejected');

    // Inactive or closed market
    const inactiveRaw = { ...validYesNoMarket, active: false };
    assert.strictEqual(client.normalizeMarket(inactiveRaw), null, 'Inactive market must be rejected');
    const closedRaw = { ...validYesNoMarket, closed: true };
    assert.strictEqual(client.normalizeMarket(closedRaw), null, 'Closed market must be rejected');

    console.log('  [PASS] normalizeMarket strictly rejects non-binary, bad-token, inactive, and closed markets');

    // ---------------------------------------------------------
    // 10. Orderbook Sorting & Crossed Book Detection
    // ---------------------------------------------------------
    console.log('\n--- 10. Testing Orderbook Sorting & Crossed Book Detection ---');
    // Test orderbook with crossed bids/asks
    PolymarketClient.prototype.getMidpointPrice = async () => 0.60;
    PolymarketClient.prototype.getOrderbook = async () => ({
      bids: [{ price: '0.65', size: '100' }], // Bid > Ask = Crossed
      asks: [{ price: '0.55', size: '100' }],
    });

    const crossedOutcome = await harness.research(satTask);
    assert.strictEqual(crossedOutcome.status, 'EXACT_MATCH');
    assert.ok(
      (crossedOutcome as any).verificationDetails.includes('Crossed orderbook'),
      'Expected verificationDetails to warn about crossed orderbook'
    );
    console.log('  [PASS] Crossed orderbook accurately detected and flagged');

    // ---------------------------------------------------------
    // 11. Boundary Input Validation
    // ---------------------------------------------------------
    console.log('\n--- 11. Testing Boundary Input Validation ---');
    const nanTask: PredictionMarketTask = {
      id: 'task-nan',
      query: 'Trump election',
      targetProbability: NaN,
    };
    const nanOutcome = await harness.research(nanTask);
    assert.strictEqual(nanOutcome.status, 'ERROR');
    assert.ok((nanOutcome as any).error.includes('targetProbability'));

    const outOfBoundsTask: PredictionMarketTask = {
      id: 'task-oob',
      query: 'Trump election',
      targetProbability: 1.5,
    };
    const oobOutcome = await harness.research(outOfBoundsTask);
    assert.strictEqual(oobOutcome.status, 'ERROR');
    assert.ok((oobOutcome as any).error.includes('targetProbability'));

    const badOutcomeTask: PredictionMarketTask = {
      id: 'task-bad-outcome',
      query: 'Trump election',
      desiredOutcome: 'MAYBE' as any,
    };
    const badOutcomeResult = await harness.research(badOutcomeTask);
    assert.strictEqual(badOutcomeResult.status, 'ERROR');
    assert.ok((badOutcomeResult as any).error.includes('desiredOutcome'));
    console.log('  [PASS] Invalid targetProbability and desiredOutcome rejected at harness boundary');

    // ---------------------------------------------------------
    // 12. Explicit Field Precedence over Natural Language
    // ---------------------------------------------------------
    console.log('\n--- 12. Testing Explicit Field Precedence ---');
    PolymarketClient.prototype.getOrderbook = async () => ({
      bids: [{ price: '0.59', size: '100' }],
      asks: [{ price: '0.61', size: '100' }],
    });

    // Query text implies NO and drops below 10%, but explicit fields specify YES > 50%
    const conflictTask: PredictionMarketTask = {
      id: `task-conflict-${Date.now()}`,
      query: 'Trump will not win drops below 10%',
      desiredOutcome: 'YES',
      expectedOperator: 'GREATER_THAN',
      targetProbability: 0.50,
    };

    const conflictOutcome = await harness.research(conflictTask);
    assert.strictEqual(conflictOutcome.status, 'EXACT_MATCH');
    assert.strictEqual((conflictOutcome as any).contract.outcome, 'YES');
    assert.strictEqual((conflictOutcome as any).contract.operator, 'GREATER_THAN');
    assert.strictEqual((conflictOutcome as any).contract.targetProbability, 0.50);

    const telemetry = harness.getTelemetryHistory(conflictTask.id);
    const entityStep = telemetry.find((t) => t.step === 'RESOLVING_ENTITY');
    assert.ok(entityStep?.data?.warnings, 'Telemetry must contain warnings about overridden inferred fields');
    console.log('  [PASS] Explicit fields take strict precedence and emit telemetry warnings');

    // ---------------------------------------------------------
    // 13. Cancellation and Timeout Handling
    // ---------------------------------------------------------
    console.log('\n--- 13. Testing Cancellation and Timeout ---');
    // Test pre-aborted signal
    const abortCtrl = new AbortController();
    abortCtrl.abort(new Error('Pre-aborted test'));

    const cancelOutcome = await harness.research(satTask, { signal: abortCtrl.signal });
    assert.strictEqual(cancelOutcome.status, 'CANCELLED');
    console.log('  [PASS] Pre-aborted signal returns CANCELLED');

    // Test timeout harness
    const timeoutHarness = new PredictionMarketHarness({ timeoutMs: 1 });
    PolymarketClient.prototype.searchMarkets = async () => {
      await new Promise((r) => setTimeout(r, 50));
      return [validYesNoMarket];
    };

    const timedOutOutcome = await timeoutHarness.research(satTask);
    assert.strictEqual(timedOutOutcome.status, 'TIMED_OUT');
    console.log('  [PASS] Short timeout produces TIMED_OUT outcome');

    // ---------------------------------------------------------
    // 14. Session Identity & Concurrent Executions with Same taskId
    // ---------------------------------------------------------
    console.log('\n--- 14. Testing Session Identity & Concurrent Executions ---');
    PolymarketClient.prototype.searchMarkets = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return [validYesNoMarket];
    };

    const sharedTaskId = `shared-task-${Date.now()}`;
    const sharedTask: PredictionMarketTask = {
      id: sharedTaskId,
      query: 'Trump election',
      expectedOperator: 'GREATER_THAN',
      targetProbability: 0.50,
    };

    const sessionHarness = new PredictionMarketHarness({ timeoutMs: 5000 });
    const run1Promise = sessionHarness.research(sharedTask, { executionId: `${sharedTaskId}_run1` });
    const run2Promise = sessionHarness.research(sharedTask, { executionId: `${sharedTaskId}_run2` });

    const [res1, res2] = await Promise.all([run1Promise, run2Promise]);
    assert.strictEqual(res1.status, 'EXACT_MATCH');
    assert.strictEqual(res2.status, 'EXACT_MATCH');

    // Check telemetry history retrieval
    const run1History = sessionHarness.getTelemetryHistory(`${sharedTaskId}_run1`);
    const run2History = sessionHarness.getTelemetryHistory(`${sharedTaskId}_run2`);
    assert.ok(run1History.length > 0, 'run1 must have telemetry history');
    assert.ok(run2History.length > 0, 'run2 must have telemetry history');

    // Lookup by taskId returns history as well
    const taskHistory = sessionHarness.getTelemetryHistory(sharedTaskId);
    assert.ok(taskHistory.length > 0, 'Lookup by taskId must return latest telemetry');
    console.log('  [PASS] Concurrent runs with identical taskId run safely and preserve history');

    // ---------------------------------------------------------
    // 15. Relevance Scoring False Positives Rejection
    // ---------------------------------------------------------
    console.log('\n--- 15. Testing Relevance Scoring False Positives ---');
    const lolMarket: PolymarketMarket = {
      id: '0x999',
      question: 'LoL: Team Vitality vs Movistar KOI - Game 2 Winner',
      conditionId: '0x999',
      slug: 'lol-vitality-vs-movistar-koi-game-2-winner',
      outcomes: ['Yes', 'No'],
      outcomePrices: [0.50, 0.50],
      clobTokenIds: ['tok1', 'tok2'],
      volume: 10000000, // Massive volume
      volume24hr: 500000,
      active: true,
      closed: false,
    };

    const lolScore = client.calculateRelevanceScore('Presidential Election Winner 2028', lolMarket);
    assert.strictEqual(lolScore, 0, 'LoL market must get 0 relevance score for presidential election query');

    const electionMarket: PolymarketMarket = {
      id: '0x888',
      question: 'Will JD Vance win the Presidential Election 2028?',
      conditionId: '0x888',
      slug: 'will-jd-vance-win-presidential-election-2028',
      outcomes: ['Yes', 'No'],
      outcomePrices: [0.50, 0.50],
      clobTokenIds: ['tok1', 'tok2'],
      volume: 1000,
      active: true,
      closed: false,
    };

    const electionScore = client.calculateRelevanceScore('Presidential Election Winner 2028', electionMarket);
    assert.ok(electionScore >= 40, `Election market should have high relevance score, got ${electionScore}`);
    console.log('  [PASS] LoL esports market rejected (score 0), genuine election market scored high');

  } finally {
    // Restore client prototype methods
    PolymarketClient.prototype.searchMarkets = origSearch;
    PolymarketClient.prototype.getMidpointPrice = origMidpoint;
    PolymarketClient.prototype.getOrderbook = origOrderbook;
    PolymarketClient.prototype.getMarketByConditionId = origCondition;
  }

  // ---------------------------------------------------------
  // 16. Strands Native Tool Creation
  // ---------------------------------------------------------
  console.log('\n--- 16. Testing Native Strands Tool Creation ---');
  const pmTool = createPredictionMarketTool();
  assert.strictEqual(pmTool.name, 'prediction_market_research');
  console.log('  [PASS] createPredictionMarketTool instantiates native tool:', pmTool.name);

  console.log('\n==========================================================');
  console.log('✅ ALL 16 PREDICTION MARKET HARNESS REGRESSION TESTS PASSED!');
  console.log('==========================================================\n');
}

runPredictionMarketTestSuite().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
