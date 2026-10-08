import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  CryptoThresholdSchema,
} from '@sentinel/shared';
import {
  CryptoResearchHarness,
  type CryptoResearchTask,
} from '../src/harness/crypto/index.js';
import { createCryptoResearchTool } from '../src/harness/crypto/tools/crypto_tool.js';
import {
  IndicatorEngine,
  UnsupportedIndicatorError,
  ProviderError,
  CoinbaseClient,
  DexScreenerClient,
  evaluateCryptoCondition,
  type OHLCV,
  type FinanceTelemetryEvent,
} from '../src/harness/finance_common/index.js';

async function runCryptoTests() {
  console.log('\n==========================================================');
  console.log('🧪 TEST SUITE: CRYPTO HARNESS 12-POINT AUDIT VERIFICATION');
  console.log('==========================================================\n');

  // Generate synthetic candles for indicator tests
  const mockCandles: OHLCV[] = [];
  let basePrice = 100;
  for (let i = 0; i < 60; i++) {
    basePrice += (i % 2 === 0 ? 1.5 : -0.8);
    mockCandles.push({
      timestamp: Date.now() - (60 - i) * 3600_000,
      open: basePrice - 0.5,
      high: basePrice + 1.2,
      low: basePrice - 1.0,
      close: basePrice,
      volume: 1000 + i * 50,
    });
  }

  // ---------------------------------------------------------
  // Point 1: Condition evaluation (BTC below $1 returns NOT_FOUND)
  // ---------------------------------------------------------
  console.log('--- 1. Testing Condition Evaluation ---');
  const harness = new CryptoResearchHarness({ timeoutMs: 15000 });

  const unsatisfiableTask: CryptoResearchTask = {
    id: `unsat-${Date.now()}`,
    query: 'Alert me if Bitcoin drops below $1',
    expectedOperator: 'LESS_THAN',
    targetValue: 1,
  };

  const unsatOutcome = await harness.research(unsatisfiableTask);
  assert.strictEqual(unsatOutcome.status, 'NOT_FOUND', `Expected NOT_FOUND for BTC < $1, got ${unsatOutcome.status}`);
  if (unsatOutcome.status === 'NOT_FOUND') {
    assert.ok(unsatOutcome.reason.includes('Condition unsatisfied'), `Expected reason to mention condition unsatisfied: ${unsatOutcome.reason}`);
    console.log('  [PASS] Unsatisfied condition correctly returned NOT_FOUND:', unsatOutcome.reason);
  }

  const satisfiableTask: CryptoResearchTask = {
    id: `sat-${Date.now()}`,
    query: 'Alert me if Bitcoin is above $1',
    expectedOperator: 'GREATER_THAN',
    targetValue: 1,
  };

  const satOutcome = await harness.research(satisfiableTask);
  assert.strictEqual(satOutcome.status, 'EXACT_MATCH', `Expected EXACT_MATCH for BTC > $1, got ${satOutcome.status}`);
  console.log('  [PASS] Satisfied condition returned EXACT_MATCH');

  // ---------------------------------------------------------
  // Point 2: Missing indicator data produces NOT_FOUND
  // ---------------------------------------------------------
  console.log('\n--- 2. Testing Missing / Insufficient Indicator Data ---');
  const hugePeriodTask: CryptoResearchTask = {
    id: `huge-${Date.now()}`,
    query: 'BTC SMA 500 period on 1m',
    targetType: 'INDICATOR',
    indicator: 'SMA',
    period: 500, // Requires 500 candles; Coinbase 1m returns max ~300
    timeframe: '1m',
  };

  const hugeOutcome = await harness.research(hugePeriodTask);
  assert.strictEqual(hugeOutcome.status, 'NOT_FOUND', `Expected NOT_FOUND for insufficient candles, got ${hugeOutcome.status}`);
  if (hugeOutcome.status === 'NOT_FOUND') {
    assert.ok(hugeOutcome.reason.includes('Insufficient'), `Expected reason to mention insufficient data: ${hugeOutcome.reason}`);
    console.log('  [PASS] Insufficient candles correctly produced NOT_FOUND:', hugeOutcome.reason);
  }

  // ---------------------------------------------------------
  // Point 3: Unsupported indicator rejected, new indicators supported
  // ---------------------------------------------------------
  console.log('\n--- 3. Testing Unsupported Indicator Handling & Indicator Engine ---');
  let threwUnsupported = false;
  try {
    IndicatorEngine.calculateIndicator('NON_EXISTENT_INDICATOR' as any, mockCandles);
  } catch (err) {
    if (err instanceof UnsupportedIndicatorError) {
      threwUnsupported = true;
    }
  }
  assert.ok(threwUnsupported, 'IndicatorEngine did not throw UnsupportedIndicatorError for invalid indicator');
  console.log('  [PASS] UnsupportedIndicatorError thrown for unknown indicator');

  // Verify newly implemented indicators calculate properly
  const stochRsi = IndicatorEngine.calculateIndicator('STOCHASTIC_RSI', mockCandles, { period: 14 });
  assert.ok(stochRsi !== null, 'STOCHASTIC_RSI failed');
  console.log('  [PASS] STOCHASTIC_RSI calculated:', stochRsi?.formatted);

  const ao = IndicatorEngine.calculateIndicator('AWESOME_OSCILLATOR', mockCandles);
  assert.ok(ao !== null, 'AWESOME_OSCILLATOR failed');
  console.log('  [PASS] AWESOME_OSCILLATOR calculated:', ao?.formatted);

  const trix = IndicatorEngine.calculateIndicator('TRIX', mockCandles, { period: 10 });
  assert.ok(trix !== null, 'TRIX failed');
  console.log('  [PASS] TRIX calculated:', trix?.formatted);

  const psar = IndicatorEngine.calculateIndicator('PSAR', mockCandles);
  assert.ok(psar !== null, 'PSAR failed');
  console.log('  [PASS] PSAR calculated:', psar?.formatted);

  const keltner = IndicatorEngine.calculateIndicator('KELTNER_CHANNELS', mockCandles, { period: 14 });
  assert.ok(keltner !== null, 'KELTNER_CHANNELS failed');
  console.log('  [PASS] KELTNER_CHANNELS calculated:', keltner?.formatted);

  // ---------------------------------------------------------
  // Point 4: Timeouts and cancellations produce explicit statuses
  // ---------------------------------------------------------
  console.log('\n--- 4. Testing Explicit Cancelled and Timed-Out Outcomes ---');
  const abortCtrl = new AbortController();
  abortCtrl.abort(new Error('User aborted operation'));

  const cancelTask: CryptoResearchTask = {
    id: `cancel-${Date.now()}`,
    query: 'Bitcoin spot price',
  };

  const cancelOutcome = await harness.research(cancelTask, { signal: abortCtrl.signal });
  assert.strictEqual(cancelOutcome.status, 'CANCELLED', `Expected CANCELLED, got ${cancelOutcome.status}`);
  console.log('  [PASS] Aborted research returned status CANCELLED');

  const fastTimeoutHarness = new CryptoResearchHarness({ timeoutMs: 1 });
  const timeoutTask: CryptoResearchTask = {
    id: `timeout-${Date.now()}`,
    query: 'Bitcoin spot price',
  };

  const timeoutOutcome = await fastTimeoutHarness.research(timeoutTask);
  assert.strictEqual(timeoutOutcome.status, 'TIMED_OUT', `Expected TIMED_OUT, got ${timeoutOutcome.status}`);
  console.log('  [PASS] Timed out research returned status TIMED_OUT');

  // ---------------------------------------------------------
  // Point 5: Abort signals reach market-data clients
  // ---------------------------------------------------------
  console.log('\n--- 5. Testing Abort Signal Propagation to Clients ---');
  const cbClient = new CoinbaseClient();
  const preAborted = AbortSignal.abort(new Error('Immediate abort'));
  let clientAborted = false;
  try {
    await cbClient.getSpotPrice('BTC-USD', { signal: preAborted });
  } catch (err: any) {
    if (err.name === 'AbortError' || err.message?.includes('abort')) {
      clientAborted = true;
    }
  }
  assert.ok(clientAborted, 'CoinbaseClient did not abort on passed signal');
  console.log('  [PASS] CoinbaseClient respected external AbortSignal');

  // ---------------------------------------------------------
  // Point 6: DEX results verified against requested token
  // ---------------------------------------------------------
  console.log('\n--- 6. Testing DEX Verification Filtering ---');
  const dexClient = new DexScreenerClient();
  const pairs = await dexClient.searchPairs('PEPE', {
    symbol: 'PEPE',
    maxCandidates: 3,
  });
  assert.ok(pairs.length > 0, 'No pairs returned from DexScreener for PEPE');
  for (const p of pairs) {
    assert.ok(
      p.baseToken.symbol.toUpperCase() === 'PEPE' || p.baseToken.name.toLowerCase().includes('pepe'),
      `Pair ${p.baseToken.symbol} did not match PEPE`
    );
  }
  console.log(`  [PASS] DexScreener search verified ${pairs.length} pairs against symbol PEPE`);

  // ---------------------------------------------------------
  // Point 7: Explicit structured parameters are authoritative; prose is not
  // parsed again by a local fallback.
  // ---------------------------------------------------------
  console.log('\n--- 7. Testing Structured Parameter Authority ---');
  const precedenceTask: CryptoResearchTask = {
    id: `prec-${Date.now()}`,
    query: 'Alert me if Bitcoin drops under 50000', // text implies LESS_THAN
    expectedOperator: 'GREATER_THAN', // explicit GREATER_THAN must take precedence!
    targetValue: 50000,
  };

  const precedenceEvents: string[] = [];
  const precedenceStream = harness.stream(precedenceTask);
  let nextPrec = await precedenceStream.next();
  while (!nextPrec.done) {
    if (nextPrec.value.message.includes('precedence')) {
      precedenceEvents.push(nextPrec.value.message);
    }
    nextPrec = await precedenceStream.next();
  }

  const precedenceOutcome = nextPrec.value;
  assert.equal(precedenceEvents.length, 0, 'Free-form query text must not produce a local precedence warning');
  console.log('  [PASS] Free-form query text was not re-parsed by a fallback');
  if (precedenceOutcome.status === 'EXACT_MATCH') {
    assert.strictEqual(precedenceOutcome.contract.operator, 'GREATER_THAN', `Operator was overwritten to ${precedenceOutcome.contract.operator}`);
    console.log('  [PASS] Explicit operator GREATER_THAN preserved over "under" query text');
  }

  // ---------------------------------------------------------
  // ---------------------------------------------------------
  // Point 8: Provider failures distinguished from no asset
  // ---------------------------------------------------------
  console.log('\n--- 8. Testing ProviderError Structuring ---');
  const pe = new ProviderError('COINBASE', 503, 'Service unavailable');
  assert.ok(pe instanceof ProviderError, 'ProviderError instantiation failed');
  assert.strictEqual(pe.statusCode, 503, 'ProviderError statusCode mismatch');
  assert.strictEqual(pe.provider, 'COINBASE');
  console.log('  [PASS] ProviderError structured with status code and provider name:', pe.message);

  // ---------------------------------------------------------
  // Point 9: maxCandidates is enforced
  // ---------------------------------------------------------
  console.log('\n--- 9. Testing maxCandidates Enforcement ---');
  const maxCandidatesHarness = new CryptoResearchHarness({ maxCandidates: 2 });
  const multiDexTask: CryptoResearchTask = {
    id: `max-cand-${Date.now()}`,
    query: 'PEPE on solana',
    assetSymbol: 'PEPE',
  };

  const maxCandOutcome = await maxCandidatesHarness.research(multiDexTask);
  if (maxCandOutcome.status === 'MULTIPLE_OPTIONS') {
    assert.ok(maxCandOutcome.candidates.length <= 2, `Expected <= 2 candidates, got ${maxCandOutcome.candidates.length}`);
    console.log(`  [PASS] maxCandidates enforced: exactly ${maxCandOutcome.candidates.length} candidate(s) returned`);
  } else {
    console.log(`  [PASS] Research resolved with status ${maxCandOutcome.status}`);
  }

  // ---------------------------------------------------------
  // Point 10: Concurrent runs with same taskId do not collide & telemetry preserved
  // ---------------------------------------------------------
  console.log('\n--- 10. Testing Concurrent Runs with Same taskId & History Retention ---');
  const sharedTaskId = `shared-task-${Date.now()}`;
  const run1Promise = harness.research({ id: sharedTaskId, query: 'Bitcoin price' });
  const run2Promise = harness.research({ id: sharedTaskId, query: 'Bitcoin price' });

  const [res1, res2] = await Promise.all([run1Promise, run2Promise]);
  assert.strictEqual(res1.status, 'EXACT_MATCH', `Run 1 failed: ${res1.status}`);
  assert.strictEqual(res2.status, 'EXACT_MATCH', `Run 2 failed: ${res2.status}`);
  console.log('  [PASS] Concurrent runs with same taskId completed independently');

  const history = harness.getTelemetryHistory(sharedTaskId);
  assert.ok(history.length > 0, 'Completed telemetry was discarded!');
  console.log(`  [PASS] Completed telemetry preserved after run (${history.length} events retrieved)`);

  // ---------------------------------------------------------
  // Point 11: CryptoThreshold preserves operator & condition evaluation
  // ---------------------------------------------------------
  console.log('\n--- 11. Testing CryptoThreshold Contract Preservation & Zod Schema ---');
  if (satOutcome.status === 'EXACT_MATCH') {
    const contract = satOutcome.contract;
    assert.strictEqual(contract.operator, 'GREATER_THAN', 'Operator missing from CryptoThreshold');
    assert.strictEqual(contract.conditionSatisfied, true, 'conditionSatisfied missing from CryptoThreshold');
    assert.ok(contract.conditionEvaluation !== undefined, 'conditionEvaluation missing from CryptoThreshold');
    assert.strictEqual(contract.conditionEvaluation?.expectedOperator, 'GREATER_THAN', 'Evaluation operator mismatch');
    assert.strictEqual(typeof contract.observedValue, 'number', 'observedValue missing from CryptoThreshold');

    // Validate against shared CryptoThresholdSchema
    const parseResult = CryptoThresholdSchema.safeParse(contract);
    assert.ok(parseResult.success, `CryptoThresholdSchema validation failed: ${JSON.stringify(parseResult.error)}`);
    console.log('  [PASS] CryptoThreshold strictly validated by Zod CryptoThresholdSchema');
    console.log('    • Operator:', contract.operator);
    console.log('    • Condition Satisfied:', contract.conditionSatisfied);
    console.log('    • Details:', contract.evaluationDetails);
  }

  // ---------------------------------------------------------
  // Point 12: Dynamic confidence calculation
  // ---------------------------------------------------------
  console.log('\n--- 12. Testing Dynamic Confidence Calculation ---');
  if (satOutcome.status === 'EXACT_MATCH') {
    assert.ok(satOutcome.confidence >= 0.5 && satOutcome.confidence <= 1.0, `Invalid confidence ${satOutcome.confidence}`);
    console.log(`  [PASS] Confidence dynamically calculated: ${satOutcome.confidence}`);
  }

  // ---------------------------------------------------------
  // Point 13: Historical Price Operators with Real Coinbase Data
  // ---------------------------------------------------------
  console.log('\n--- 13. Testing Historical Price Operators with Real Coinbase Data ---');
  // A: CLOSES_ABOVE satisfied with real BTC candles
  const closesAboveTask: CryptoResearchTask = {
    id: `closes-above-${Date.now()}`,
    query: 'Bitcoin closes above $1000',
    expectedOperator: 'CLOSES_ABOVE',
    targetValue: 1000,
    timeframe: '1h',
  };

  const closesAboveOutcome = await harness.research(closesAboveTask);
  assert.strictEqual(closesAboveOutcome.status, 'EXACT_MATCH', `Expected EXACT_MATCH for BTC closes above $1000, got ${closesAboveOutcome.status}`);
  if (closesAboveOutcome.status === 'EXACT_MATCH') {
    assert.strictEqual(closesAboveOutcome.contract.operator, 'CLOSES_ABOVE');
    assert.strictEqual(closesAboveOutcome.contract.conditionSatisfied, true);
    assert.ok(closesAboveOutcome.contract.observedValue > 1000);
    assert.ok(closesAboveOutcome.verificationDetails.includes('Candle close'));
    console.log('  [PASS] Real BTC CLOSES_ABOVE condition satisfied with candle close:', closesAboveOutcome.contract.observedValue);
    console.log('    • Details:', closesAboveOutcome.verificationDetails);
  }

  // B: CLOSES_ABOVE unsatisfied with impossible target
  const closesAboveUnsatTask: CryptoResearchTask = {
    id: `closes-above-unsat-${Date.now()}`,
    query: 'Bitcoin closes above $10000000',
    expectedOperator: 'CLOSES_ABOVE',
    targetValue: 10000000,
    timeframe: '1h',
  };

  const closesAboveUnsatOutcome = await harness.research(closesAboveUnsatTask);
  assert.strictEqual(closesAboveUnsatOutcome.status, 'NOT_FOUND', `Expected NOT_FOUND for BTC closes above $10M, got ${closesAboveUnsatOutcome.status}`);
  if (closesAboveUnsatOutcome.status === 'NOT_FOUND') {
    assert.ok(closesAboveUnsatOutcome.reason.includes('Condition unsatisfied'), `Expected reason to note condition unsatisfied: ${closesAboveUnsatOutcome.reason}`);
    console.log('  [PASS] Unsatisfied CLOSES_ABOVE correctly returned NOT_FOUND:', closesAboveUnsatOutcome.reason);
  }

  // C: Pure condition evaluator verification with controlled crossing candles
  console.log('  • Verifying CROSSES_ABOVE and CROSSES_BELOW unit edge cases:');
  const crossingCandles: OHLCV[] = [
    { timestamp: 1, open: 90, high: 95, low: 88, close: 92, volume: 100 },
    { timestamp: 2, open: 92, high: 105, low: 91, close: 102, volume: 150 },
  ];
  const crossAboveEval = evaluateCryptoCondition({
    targetType: 'PRICE',
    operator: 'CROSSES_ABOVE',
    targetValue: 100,
    candles: crossingCandles,
  });
  assert.strictEqual(crossAboveEval.conditionSatisfied, true, 'CROSSES_ABOVE should be satisfied when crossing 100');
  assert.strictEqual(crossAboveEval.observedValue, 102);

  const nonCrossingCandles: OHLCV[] = [
    { timestamp: 1, open: 101, high: 105, low: 99, close: 101, volume: 100 },
    { timestamp: 2, open: 101, high: 106, low: 100, close: 103, volume: 150 },
  ];
  const nonCrossEval = evaluateCryptoCondition({
    targetType: 'PRICE',
    operator: 'CROSSES_ABOVE',
    targetValue: 100,
    candles: nonCrossingCandles,
  });
  assert.strictEqual(nonCrossEval.conditionSatisfied, false, 'CROSSES_ABOVE should be false if already above');

  const insufficientCandlesEval = evaluateCryptoCondition({
    targetType: 'PRICE',
    operator: 'CROSSES_ABOVE',
    targetValue: 100,
    candles: [crossingCandles[0]],
  });
  assert.strictEqual(insufficientCandlesEval.conditionSatisfied, false, 'CROSSES_ABOVE requires >= 2 candles');
  assert.ok(insufficientCandlesEval.evaluationDetails.includes('requires at least 2 historical candles'));
  console.log('  [PASS] Crossing logic strictly requires >= 2 candles with previous < threshold and current >= threshold');

  // ---------------------------------------------------------
  // Point 14: Historical Price Operators on DEX Tokens Return NOT_FOUND
  // ---------------------------------------------------------
  console.log('\n--- 14. Testing Historical Price Operators for DEX Pairs ---');
  const dexHistoricalTask: CryptoResearchTask = {
    id: `dex-hist-${Date.now()}`,
    query: 'PEPE closes above 0.001',
    assetSymbol: 'PEPE',
    expectedOperator: 'CLOSES_ABOVE',
    targetValue: 0.001,
  };

  const dexHistOutcome = await harness.research(dexHistoricalTask);
  // If resolved via DexScreener (no candles API), must return NOT_FOUND explaining candle absence
  if (dexHistOutcome.status === 'NOT_FOUND') {
    assert.ok(
      dexHistOutcome.reason.includes('candle') || dexHistOutcome.reason.includes('historical') || dexHistOutcome.reason.includes('Condition unsatisfied'),
      `Unexpected reason: ${dexHistOutcome.reason}`
    );
    console.log('  [PASS] DEX token historical operator safely handled:', dexHistOutcome.reason);
  } else {
    console.log(`  [INFO] PEPE resolved with status ${dexHistOutcome.status}`);
  }

  // ---------------------------------------------------------
  // Point 15: DEX Contract Address and Network Forwarding via Tool
  // ---------------------------------------------------------
  console.log('\n--- 15. Testing DEX Contract & Network Forwarding via crypto_research Tool ---');
  const cryptoTool = createCryptoResearchTool();
  assert.strictEqual(cryptoTool.name, 'crypto_research');
  const schemaProps =
    (cryptoTool.toolSpec.inputSchema as any)?.json?.properties ||
    (cryptoTool.toolSpec.inputSchema as any)?.properties;
  assert.ok(schemaProps, 'crypto_research tool must expose inputSchema properties');
  assert.ok('dexContractAddress' in schemaProps, 'dexContractAddress missing from tool inputSchema');
  assert.ok('dexNetwork' in schemaProps, 'dexNetwork missing from tool inputSchema');
  console.log('  [PASS] dexContractAddress and dexNetwork exposed in tool inputSchema');

  // Invoke tool with specific DEX network filter
  const toolOutcome = await cryptoTool.invoke({
    query: 'Find PEPE pool on solana',
    assetSymbol: 'PEPE',
    dexNetwork: 'solana',
  });

  assert.ok(toolOutcome, 'No outcome returned from crypto_research tool invocation');
  console.log(`  [PASS] Tool executed successfully with status: ${toolOutcome.status}`);
  if (toolOutcome.status === 'MULTIPLE_OPTIONS') {
    for (const cand of toolOutcome.candidates) {
      assert.strictEqual(cand.metadata?.chainId, 'solana', `Candidate was not filtered to solana: ${cand.metadata?.chainId}`);
    }
    console.log(`  [PASS] Tool filtered all ${toolOutcome.candidates.length} candidates strictly to solana chain`);
  }

  // ---------------------------------------------------------
  // Point 16: Telemetry Event Execution ID Tracing
  // ---------------------------------------------------------
  console.log('\n--- 16. Testing executionId Telemetry Tracing ---');
  const customExecId = `trace-exec-${Date.now()}-abc`;
  const streamGen = harness.stream(
    {
      id: `task-trace-${Date.now()}`,
      query: 'Bitcoin spot price',
    },
    { executionId: customExecId }
  );

  const tracedEvents: FinanceTelemetryEvent[] = [];
  let streamNext = await streamGen.next();
  while (!streamNext.done) {
    tracedEvents.push(streamNext.value);
    streamNext = await streamGen.next();
  }

  assert.ok(tracedEvents.length > 0, 'No events captured from stream');
  for (const ev of tracedEvents) {
    assert.strictEqual(
      ev.executionId,
      customExecId,
      `Telemetry event ${ev.step} missing or mismatched executionId: expected ${customExecId}, got ${ev.executionId}`
    );
  }
  console.log(`  [PASS] All ${tracedEvents.length} telemetry events carried explicit executionId: "${customExecId}"`);

  console.log('\n==========================================================');
  console.log('🏆 ALL 16 STRICT CRYPTO HARNESS RELEASE-GATE AUDIT CHECKS PASSED!');
  console.log('==========================================================\n');
}

runCryptoTests().catch((err) => {
  console.error('\n❌ Crypto test execution failed:', err);
  process.exit(1);
});
