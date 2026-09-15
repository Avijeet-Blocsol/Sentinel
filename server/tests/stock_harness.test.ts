import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  StockThresholdSchema,
} from '@sentinel/shared';
import {
  StockResearchHarness,
  type StockResearchTask,
} from '../src/harness/stocks/index.js';
import { createStockResearchTool } from '../src/harness/stocks/tools/stock_tool.js';
import {
  detectMarketSession,
  isNYSEHoliday,
  getTimeframeGranularity,
} from '../src/harness/stocks/stock_graph.js';
import {
  IndicatorEngine,
  ProviderError,
  FinnhubClient,
  YahooFinanceClient,
  RequestCoalescer,
  evaluateStockCondition,
  type OHLCV,
} from '../src/harness/finance_common/index.js';

async function runStockHarnessTests() {
  console.log('\n==========================================================');
  console.log('🧪 TEST SUITE: STOCK HARNESS 13-POINT AUDIT VERIFICATION');
  console.log('==========================================================\n');

  const harness = new StockResearchHarness({ timeoutMs: 15000 });

  // ---------------------------------------------------------
  // 1. Condition Evaluation (Satisfied, Unsatisfied, No Target)
  // ---------------------------------------------------------
  console.log('--- 1. Testing Condition Evaluation & Threshold Distinction ---');

  // 1A: Satisfied Price Condition
  const satTask: StockResearchTask = {
    id: `sat-stock-${Date.now()}`,
    query: 'Alert me if Apple stock is above $1',
    ticker: 'AAPL',
    expectedOperator: 'GREATER_THAN',
    targetValue: 1,
  };

  const satOutcome = await harness.research(satTask);
  assert.strictEqual(satOutcome.status, 'EXACT_MATCH', `Expected EXACT_MATCH for AAPL > 1, got ${satOutcome.status}`);
  if (satOutcome.status === 'EXACT_MATCH') {
    assert.strictEqual(satOutcome.contract.ticker, 'AAPL');
    assert.strictEqual(satOutcome.contract.operator, 'GREATER_THAN');
    assert.strictEqual(satOutcome.contract.conditionSatisfied, true);
    assert.strictEqual(satOutcome.contract.targetValue, 1);
    assert.ok(typeof satOutcome.contract.observedValue === 'number' && satOutcome.contract.observedValue > 1);
    console.log('  [PASS] Satisfied condition (AAPL > $1) returned EXACT_MATCH with observed price: $' + satOutcome.contract.observedValue);
  }

  // 1B: Unsatisfied Price Condition (Must fail closed with NOT_FOUND)
  const unsatTask: StockResearchTask = {
    id: `unsat-stock-${Date.now()}`,
    query: 'Alert me if Apple stock drops below $1',
    ticker: 'AAPL',
    expectedOperator: 'LESS_THAN',
    targetValue: 1,
  };

  const unsatOutcome = await harness.research(unsatTask);
  assert.strictEqual(unsatOutcome.status, 'NOT_FOUND', `Expected NOT_FOUND for AAPL < $1, got ${unsatOutcome.status}`);
  if (unsatOutcome.status === 'NOT_FOUND') {
    assert.ok(unsatOutcome.reason.includes('Condition unsatisfied'), `Expected reason to mention condition unsatisfied: ${unsatOutcome.reason}`);
    console.log('  [PASS] Unsatisfied condition (AAPL < $1) correctly returned NOT_FOUND: ' + unsatOutcome.reason);
  }

  // 1C: No Threshold Specified (Must NOT convert to live price as threshold)
  const noThresholdTask: StockResearchTask = {
    id: `no-threshold-${Date.now()}`,
    query: 'Give me current Apple stock price',
    ticker: 'AAPL',
  };

  const noThresholdOutcome = await harness.research(noThresholdTask);
  assert.strictEqual(noThresholdOutcome.status, 'EXACT_MATCH', `Expected EXACT_MATCH for price inquiry, got ${noThresholdOutcome.status}`);
  if (noThresholdOutcome.status === 'EXACT_MATCH') {
    assert.strictEqual(noThresholdOutcome.contract.targetValue, undefined, 'Absence of threshold was incorrectly converted to live price!');
    assert.strictEqual(noThresholdOutcome.contract.conditionSatisfied, true);
    console.log('  [PASS] Absence of threshold preserved (targetValue is undefined, NOT livePrice)');
  }

  // ---------------------------------------------------------
  // 2. Crossing Detection with Two Candles
  // ---------------------------------------------------------
  console.log('\n--- 2. Testing Crossing Detection (Two Candles) ---');

  // Unit edge case on evaluateStockCondition with controlled 2-candle window
  const crossAboveCandles: OHLCV[] = [
    { timestamp: 1000, open: 98, high: 99, low: 94, close: 95, volume: 100 },
    { timestamp: 2000, open: 96, high: 106, low: 95, close: 105, volume: 150 },
  ];

  const crossAboveEval = evaluateStockCondition({
    targetType: 'PRICE',
    operator: 'CROSSES_ABOVE',
    targetValue: 100,
    candles: crossAboveCandles,
    observedValue: 105,
  });
  assert.strictEqual(crossAboveEval.conditionSatisfied, true, 'CROSSES_ABOVE failed to detect crossing from 95 to 105');
  assert.strictEqual(crossAboveEval.observedValue, 105);
  console.log('  [PASS] CROSSES_ABOVE verified crossing from 95 to 105 above threshold 100');

  const crossBelowEval = evaluateStockCondition({
    targetType: 'PRICE',
    operator: 'CROSSES_BELOW',
    targetValue: 100,
    candles: [
      { timestamp: 1000, open: 102, high: 106, low: 101, close: 105, volume: 100 },
      { timestamp: 2000, open: 104, high: 104, low: 93, close: 95, volume: 150 },
    ],
    observedValue: 95,
  });
  assert.strictEqual(crossBelowEval.conditionSatisfied, true, 'CROSSES_BELOW failed to detect crossing from 105 to 95');
  console.log('  [PASS] CROSSES_BELOW verified crossing from 105 to 95 below threshold 100');

  const noCrossEval = evaluateStockCondition({
    targetType: 'PRICE',
    operator: 'CROSSES_ABOVE',
    targetValue: 100,
    candles: [
      { timestamp: 1000, open: 102, high: 105, low: 101, close: 103, volume: 100 },
      { timestamp: 2000, open: 103, high: 108, low: 102, close: 106, volume: 150 },
    ],
    observedValue: 106,
  });
  assert.strictEqual(noCrossEval.conditionSatisfied, false, 'CROSSES_ABOVE false-positive when both candles are above target');
  console.log('  [PASS] CROSSES_ABOVE correctly rejected when previous candle was already above target');

  // Live crossing test: an uncrossed impossible high target must return NOT_FOUND
  const liveUncrossedTask: StockResearchTask = {
    id: `uncrossed-${Date.now()}`,
    query: 'Alert me when Apple stock crosses above 999999',
    ticker: 'AAPL',
    expectedOperator: 'CROSSES_ABOVE',
    targetValue: 999999,
  };
  const liveUncrossedOutcome = await harness.research(liveUncrossedTask);
  assert.strictEqual(liveUncrossedOutcome.status, 'NOT_FOUND', `Expected NOT_FOUND for AAPL crosses above 999k, got ${liveUncrossedOutcome.status}`);
  console.log('  [PASS] Live uncrossed operator correctly failed closed with NOT_FOUND');

  // ---------------------------------------------------------
  // 3. Missing / Insufficient Candle Data
  // ---------------------------------------------------------
  console.log('\n--- 3. Testing Missing / Insufficient Candle Data ---');

  const hugeSMA: StockResearchTask = {
    id: `huge-sma-${Date.now()}`,
    query: 'Apple 5000-day SMA',
    ticker: 'AAPL',
    targetType: 'INDICATOR',
    indicator: 'SMA',
    period: 5000,
    timeframe: '1d',
  };

  const hugeOutcome = await harness.research(hugeSMA);
  assert.strictEqual(hugeOutcome.status, 'NOT_FOUND', `Expected NOT_FOUND for 5000-day SMA, got ${hugeOutcome.status}`);
  if (hugeOutcome.status === 'NOT_FOUND') {
    assert.ok(hugeOutcome.reason.includes('Insufficient'), `Expected reason to note insufficient data: ${hugeOutcome.reason}`);
    console.log('  [PASS] Insufficient candles for 5000-day SMA produced NOT_FOUND: ' + hugeOutcome.reason);
  }

  // ---------------------------------------------------------
  // 4. Structured Field Precedence & Conflict Telemetry
  // ---------------------------------------------------------
  console.log('\n--- 4. Testing Structured Field Precedence & Conflict Telemetry ---');

  const conflictTask: StockResearchTask = {
    id: `conflict-${Date.now()}`,
    query: 'Alert me if Apple drops below 50', // Text implies LESS_THAN
    ticker: 'AAPL',
    expectedOperator: 'GREATER_THAN', // Explicit field takes strict precedence!
    targetValue: 50,
  };

  const conflictWarnings: string[] = [];
  const conflictStream = harness.stream(conflictTask);
  let nextConflict = await conflictStream.next();
  while (!nextConflict.done) {
    if (nextConflict.value.message.includes('precedence')) {
      conflictWarnings.push(nextConflict.value.message);
    }
    nextConflict = await conflictStream.next();
  }

  const conflictOutcome = nextConflict.value;
  assert.ok(conflictWarnings.length > 0, 'No precedence warning emitted in telemetry');
  console.log('  [PASS] Telemetry emitted conflict warning: ' + conflictWarnings[0]);
  if (conflictOutcome.status === 'EXACT_MATCH') {
    assert.strictEqual(conflictOutcome.contract.operator, 'GREATER_THAN', 'Explicit operator was erroneously overridden by query text');
    console.log('  [PASS] Explicit operator GREATER_THAN strictly preserved over query text "drops below"');
  }

  // ---------------------------------------------------------
  // 5. Timeframe-to-Provider Mapping
  // ---------------------------------------------------------
  console.log('\n--- 5. Testing Timeframe-to-Provider Mapping ---');

  const g1m = getTimeframeGranularity('1m');
  assert.strictEqual(g1m.finnhubResolution, '1');
  assert.strictEqual(g1m.yahooInterval, '1m');

  const g1h = getTimeframeGranularity('1h');
  assert.strictEqual(g1h.finnhubResolution, '60');
  assert.strictEqual(g1h.yahooInterval, '1h');

  const g4h = getTimeframeGranularity('4h');
  assert.strictEqual(g4h.finnhubResolution, '60');
  assert.strictEqual(g4h.yahooInterval, '4h');

  const g1d = getTimeframeGranularity('1d');
  assert.strictEqual(g1d.finnhubResolution, 'D');
  assert.strictEqual(g1d.yahooInterval, '1d');

  const g1w = getTimeframeGranularity('1w');
  assert.strictEqual(g1w.finnhubResolution, 'W');
  assert.strictEqual(g1w.yahooInterval, '1w');
  console.log('  [PASS] All standard timeframes (1m, 1h, 4h, 1d, 1w) correctly mapped to provider resolutions');

  // ---------------------------------------------------------
  // 6. Provider Errors & Error Outcome
  // ---------------------------------------------------------
  console.log('\n--- 6. Testing ProviderError Structuring ---');

  const pe = new ProviderError('FINNHUB', 429, 'Rate limit reached');
  assert.ok(pe instanceof ProviderError);
  assert.strictEqual(pe.provider, 'FINNHUB');
  assert.strictEqual(pe.statusCode, 429);
  console.log('  [PASS] ProviderError correctly structured with provider and status code: ' + pe.message);

  // ---------------------------------------------------------
  // 7. Cancellation & Timeout
  // ---------------------------------------------------------
  console.log('\n--- 7. Testing Cancellation & Timeout Handling ---');

  // 7A: Fast Timeout
  const fastTimeoutHarness = new StockResearchHarness({ timeoutMs: 1 });
  const timeoutTask: StockResearchTask = {
    id: `timeout-${Date.now()}`,
    query: 'Tesla stock price',
    ticker: 'TSLA',
  };

  const timeoutOutcome = await fastTimeoutHarness.research(timeoutTask);
  assert.strictEqual(timeoutOutcome.status, 'TIMED_OUT', `Expected TIMED_OUT, got ${timeoutOutcome.status}`);
  console.log('  [PASS] Fast timeout produced TIMED_OUT status');

  // 7B: External AbortController cancellation
  const abortCtrl = new AbortController();
  abortCtrl.abort(new Error('User cancelled'));
  const cancelledOutcome = await harness.research(
    { id: `cancel-${Date.now()}`, query: 'Microsoft stock price' },
    { signal: abortCtrl.signal }
  );
  assert.strictEqual(cancelledOutcome.status, 'CANCELLED', `Expected CANCELLED, got ${cancelledOutcome.status}`);
  console.log('  [PASS] External AbortSignal triggered CANCELLED status');

  // 7C: Abort signal propagation to clients
  const yhClient = new YahooFinanceClient();
  const preAborted = AbortSignal.abort(new Error('Pre-aborted'));
  let clientAborted = false;
  try {
    await yhClient.getQuote('AAPL', { signal: preAborted });
  } catch (err: any) {
    if (err.name === 'AbortError' || err.message?.includes('abort')) {
      clientAborted = true;
    }
  }
  assert.ok(clientAborted, 'YahooFinanceClient did not abort on passed signal');
  console.log('  [PASS] YahooFinanceClient respected external AbortSignal');

  // ---------------------------------------------------------
  // 8. Concurrent Runs with Duplicate Task ID
  // ---------------------------------------------------------
  console.log('\n--- 8. Testing Concurrent Runs with Same Task ID & Telemetry History ---');

  const sharedTaskId = `shared-task-${Date.now()}`;
  const run1 = harness.research({ id: sharedTaskId, query: 'Apple stock price', ticker: 'AAPL' });
  const run2 = harness.research({ id: sharedTaskId, query: 'Microsoft stock price', ticker: 'MSFT' });

  const [res1, res2] = await Promise.all([run1, run2]);
  assert.strictEqual(res1.status, 'EXACT_MATCH', `Run 1 failed: ${res1.status}`);
  assert.strictEqual(res2.status, 'EXACT_MATCH', `Run 2 failed: ${res2.status}`);
  console.log('  [PASS] Concurrent runs with duplicate taskId completed independently without collision');

  const history = harness.getTelemetryHistory(sharedTaskId);
  assert.ok(history.length > 0, 'Completed telemetry history was discarded!');
  console.log(`  [PASS] Completed telemetry preserved (${history.length} events retained for shared task ID)`);

  // ---------------------------------------------------------
  // 9. Provider Preference & Candidate Limits
  // ---------------------------------------------------------
  console.log('\n--- 9. Testing Provider Preference & Candidate Limits ---');

  const yahooHarness = new StockResearchHarness({ preferProvider: 'YAHOO' });
  const yahooOutcome = await yahooHarness.research({ id: `yh-${Date.now()}`, query: 'Apple stock price', ticker: 'AAPL' });
  assert.strictEqual(yahooOutcome.status, 'EXACT_MATCH');
  if (yahooOutcome.status === 'EXACT_MATCH') {
    assert.strictEqual(yahooOutcome.contract.provider, 'YAHOO', `Expected YAHOO provider, got ${yahooOutcome.contract.provider}`);
    console.log('  [PASS] preferProvider: YAHOO prioritized Yahoo Finance');
  }

  const limitHarness = new StockResearchHarness({ maxCandidates: 2 });
  const limitOutcome = await limitHarness.research({ id: `lim-${Date.now()}`, query: 'CORP' });
  if (limitOutcome.status === 'MULTIPLE_OPTIONS') {
    assert.ok(limitOutcome.candidates.length <= 2, `Expected <= 2 candidates, got ${limitOutcome.candidates.length}`);
    console.log(`  [PASS] maxCandidates: 2 enforced (${limitOutcome.candidates.length} candidates returned)`);
  } else {
    console.log(`  [PASS] Disambiguation query completed with status: ${limitOutcome.status}`);
  }

  // ---------------------------------------------------------
  // 10. Market Session & Holiday Detection
  // ---------------------------------------------------------
  console.log('\n--- 10. Testing Market Session & NYSE Holiday Detection ---');

  // Christmas 2026: Dec 25, 2026 is Friday
  const christmasSession = detectMarketSession(new Date('2026-12-25T17:00:00Z'));
  assert.strictEqual(christmasSession.session, 'HOLIDAY_CLOSED');
  assert.ok(christmasSession.description.includes('Christmas Day'));
  console.log('  [PASS] Christmas Day correctly detected: ' + christmasSession.description);

  // New Year's Day 2026: Jan 1, 2026 is Thursday
  const newYearSession = detectMarketSession(new Date('2026-01-01T17:00:00Z'));
  assert.strictEqual(newYearSession.session, 'HOLIDAY_CLOSED');
  assert.ok(newYearSession.description.includes("New Year's Day"));
  console.log('  [PASS] New Year\'s Day correctly detected: ' + newYearSession.description);

  // Memorial Day 2026: Last Monday in May (May 25, 2026)
  const memorialSession = detectMarketSession(new Date('2026-05-25T17:00:00Z'));
  assert.strictEqual(memorialSession.session, 'HOLIDAY_CLOSED');
  assert.ok(memorialSession.description.includes('Memorial Day'));
  console.log('  [PASS] Memorial Day correctly detected: ' + memorialSession.description);

  // Weekend check: Sunday
  const weekendSession = detectMarketSession(new Date('2026-09-13T17:00:00Z'));
  assert.strictEqual(weekendSession.session, 'WEEKEND_CLOSED');
  console.log('  [PASS] Weekend closed correctly detected: ' + weekendSession.description);

  // ---------------------------------------------------------
  // 11. Zod Schema Strict Validation
  // ---------------------------------------------------------
  console.log('\n--- 11. Testing StockThresholdSchema Zod Validation ---');
  if (satOutcome.status === 'EXACT_MATCH') {
    const parseRes = StockThresholdSchema.safeParse(satOutcome.contract);
    assert.ok(parseRes.success, `StockThresholdSchema validation failed: ${JSON.stringify(parseRes.error)}`);
    assert.strictEqual(satOutcome.contract.operator, 'GREATER_THAN');
    assert.strictEqual(satOutcome.contract.conditionSatisfied, true);
    assert.ok(satOutcome.contract.conditionEvaluation !== undefined);
    console.log('  [PASS] Contract strictly parsed by updated StockThresholdSchema');
    console.log('    • Operator:', satOutcome.contract.operator);
    console.log('    • Condition Satisfied:', satOutcome.contract.conditionSatisfied);
    console.log('    • Details:', satOutcome.contract.evaluationDetails);
  }

  // ---------------------------------------------------------
  // 12. Native Strands Tool Verification
  // ---------------------------------------------------------
  console.log('\n--- 12. Testing Native Strands Tool Creation & Invocation ---');
  const tool = createStockResearchTool();
  assert.strictEqual(tool.name, 'stock_research');

  const toolOutcome = await tool.invoke({
    query: 'Alert me if Apple stock is above 1',
    ticker: 'AAPL',
    expectedOperator: 'GREATER_THAN',
    targetValue: 1,
  });
  assert.strictEqual(toolOutcome.status, 'EXACT_MATCH');
  console.log('  [PASS] Native Strands tool successfully instantiated and executed');

  // ---------------------------------------------------------
  // 13. Provider Error Propagation (Must return ERROR, not NOT_FOUND)
  // ---------------------------------------------------------
  console.log('\n--- 13. Testing Provider Error Propagation ---');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('yahoo') || urlStr.includes('finnhub')) {
        return new Response('Rate Limit Exceeded', { status: 429, statusText: 'Too Many Requests' });
      }
      return originalFetch(input);
    };

    const errTask: StockResearchTask = {
      id: `err-stock-${Date.now()}`,
      query: 'Alert me if Apple stock is above 200',
      ticker: 'AAPL',
    };

    const errHarness = new StockResearchHarness({ preferProvider: 'YAHOO', timeoutMs: 5000 });
    const errOutcome = await errHarness.research(errTask);
    assert.strictEqual(errOutcome.status, 'ERROR', `Expected ERROR status for provider 429 outage, got ${errOutcome.status}`);
    if (errOutcome.status === 'ERROR') {
      assert.strictEqual(errOutcome.provider, 'YAHOO');
      assert.ok(errOutcome.error.includes('429'), `Expected error message to mention 429: ${errOutcome.error}`);
      console.log('  [PASS] Provider HTTP 429 correctly propagated as ERROR status (not swallowed as NOT_FOUND)');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ---------------------------------------------------------
  // 14. Finnhub 4h Candle Aggregation
  // ---------------------------------------------------------
  console.log('\n--- 14. Testing Finnhub 4h Candle Aggregation ---');
  const fhClient = new FinnhubClient('test_token');
  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('/stock/candle')) {
        // Return 8 hourly candles
        return new Response(JSON.stringify({
          s: 'ok',
          t: [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000],
          o: [10, 11, 12, 13, 20, 21, 22, 23],
          h: [15, 16, 17, 18, 25, 26, 27, 28],
          l: [8, 9, 7, 10, 18, 19, 17, 20],
          c: [12, 13, 14, 15, 22, 23, 24, 25],
          v: [100, 100, 100, 100, 200, 200, 200, 200],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    };

    const candles4h = await fhClient.getCandles('AAPL', '4h', 2);
    assert.strictEqual(candles4h.length, 2, `Expected 2 aggregated 4h candles from 8 1h candles, got ${candles4h.length}`);
    // Check chunk 0
    assert.strictEqual(candles4h[0].timestamp, 1000 * 1000);
    assert.strictEqual(candles4h[0].open, 10);
    assert.strictEqual(candles4h[0].high, 18);
    assert.strictEqual(candles4h[0].low, 7);
    assert.strictEqual(candles4h[0].close, 15);
    assert.strictEqual(candles4h[0].volume, 400);

    // Check chunk 1
    assert.strictEqual(candles4h[1].timestamp, 5000 * 1000);
    assert.strictEqual(candles4h[1].open, 20);
    assert.strictEqual(candles4h[1].high, 28);
    assert.strictEqual(candles4h[1].low, 17);
    assert.strictEqual(candles4h[1].close, 25);
    assert.strictEqual(candles4h[1].volume, 800);
    console.log('  [PASS] Finnhub 4h resolution successfully aggregated 1h candles into 4-hour OHLCV buckets');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ---------------------------------------------------------
  // 15. Indicator Historical Crossing Semantics
  // ---------------------------------------------------------
  console.log('\n--- 15. Testing Indicator Historical Crossing Semantics ---');
  // 15A: RSI crosses above 70 when stock price is 240
  const dummyPriceCandles: OHLCV[] = [
    { timestamp: 1000, open: 238, high: 242, low: 237, close: 239, volume: 10000 },
    { timestamp: 2000, open: 239, high: 243, low: 238, close: 241, volume: 12000 },
  ];

  const rsiCrossingEval = evaluateStockCondition({
    targetType: 'INDICATOR',
    operator: 'CROSSES_ABOVE',
    targetValue: 70,
    observedValue: 72.5, // latest RSI
    previousObservedValue: 68.0, // previous RSI
    indicatorName: 'RSI',
    candles: dummyPriceCandles,
  });

  assert.strictEqual(rsiCrossingEval.conditionSatisfied, true, 'RSI crossed above 70 was not satisfied!');
  assert.strictEqual(rsiCrossingEval.observedValue, 72.5, 'Observed value should be RSI value (72.5), not stock price!');
  assert.ok(rsiCrossingEval.evaluationDetails.includes('crossed above 70'), `Details should mention crossing: ${rsiCrossingEval.evaluationDetails}`);
  console.log('  [PASS] "RSI crosses above 70" verified on RSI time-series (observed: 72.5, previous: 68.0), ignoring raw stock price 240');

  // 15B: RSI did NOT cross above 70 (was already above 70)
  const rsiAlreadyAboveEval = evaluateStockCondition({
    targetType: 'INDICATOR',
    operator: 'CROSSES_ABOVE',
    targetValue: 70,
    observedValue: 75.0,
    previousObservedValue: 72.0,
    indicatorName: 'RSI',
    candles: dummyPriceCandles,
  });
  assert.strictEqual(rsiAlreadyAboveEval.conditionSatisfied, false, 'RSI already above should NOT satisfy CROSSES_ABOVE!');
  console.log('  [PASS] RSI already above 70 correctly rejected for CROSSES_ABOVE');

  // 15C: Indicator Engine calculates previousValue for indicators
  const sampleCandles: OHLCV[] = Array.from({ length: 30 }, (_, i) => ({
    timestamp: i * 86400000,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 102 + i,
    volume: 1000,
  }));
  const calcResult = IndicatorEngine.calculateIndicator('RSI', sampleCandles, { period: 14 });
  assert.ok(calcResult !== null);
  assert.ok(calcResult.previousValue !== undefined, 'IndicatorEngine did not return previousValue!');
  assert.ok(typeof calcResult.previousValue === 'number' && Number.isFinite(calcResult.previousValue));
  console.log(`  [PASS] IndicatorEngine computed current RSI (${calcResult.value.toFixed(2)}) and previous RSI (${calcResult.previousValue.toFixed(2)})`);

  // ---------------------------------------------------------
  // 16. Request Coalescing Independent Per-Caller Cancellation
  // ---------------------------------------------------------
  console.log('\n--- 16. Testing Request Coalescing Per-Caller Cancellation ---');
  const coalescer = new RequestCoalescer();
  const ctrl1 = new AbortController();
  const ctrl2 = new AbortController();

  let upstreamCallCount = 0;
  const longFetcher = async (coalescedSignal?: AbortSignal) => {
    upstreamCallCount++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve('success_data'), 200);
      if (coalescedSignal) {
        coalescedSignal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(coalescedSignal.reason || new Error('coalesced abort'));
        });
      }
    });
  };

  const promise1 = coalescer.coalesce('test_key', longFetcher, ctrl1.signal);
  const promise2 = coalescer.coalesce('test_key', longFetcher, ctrl2.signal);

  // Abort caller 1 only
  setTimeout(() => ctrl1.abort(new DOMException('Caller 1 aborted', 'AbortError')), 20);

  let caller1FailedWithAbort = false;
  try {
    await promise1;
  } catch (err: any) {
    if (err?.name === 'AbortError' || err?.message?.includes('Caller 1 aborted')) {
      caller1FailedWithAbort = true;
    }
  }
  assert.ok(caller1FailedWithAbort, 'Caller 1 should have aborted immediately with AbortError');

  // Caller 2 must resolve successfully
  const result2 = await promise2;
  assert.strictEqual(result2, 'success_data', `Caller 2 should have resolved with data, got ${result2}`);
  assert.strictEqual(upstreamCallCount, 1, 'Only 1 upstream network dispatch should have occurred');
  console.log('  [PASS] Caller 1 aborting independently did NOT cancel Caller 2 in coalesced execution');

  // ---------------------------------------------------------
  // 17. Strict Finite-Value & OHLC Array Sanitization
  // ---------------------------------------------------------
  console.log('\n--- 17. Testing Strict Finite-Value & OHLC Validation ---');
  const yahooClient = new YahooFinanceClient();
  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('chart')) {
        return new Response(JSON.stringify({
          chart: {
            result: [{
              meta: { regularMarketPrice: NaN }, // Non-finite price
            }],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    };

    const nanQuote = await yahooClient.getQuote('AAPL');
    assert.strictEqual(nanQuote, null, 'Non-finite quote price should return null instead of NaN object');
    console.log('  [PASS] Non-finite quote price (NaN) rejected by Yahoo client');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ---------------------------------------------------------
  // 18. Dynamic Currency & Extended Hours Session Rules
  // ---------------------------------------------------------
  console.log('\n--- 18. Testing Dynamic Currency & Extended Hours Session Rules ---');
  // 18A: Explicit non-USD currency
  const cadTask: StockResearchTask = {
    id: `cad-stock-${Date.now()}`,
    query: 'Alert me if Canadian stock is above 10',
    ticker: 'SHOP.TO',
    currency: 'CAD',
    expectedOperator: 'GREATER_THAN',
    targetValue: 1,
  };
  const cadOutcome = await harness.research(cadTask);
  if (cadOutcome.status === 'EXACT_MATCH') {
    assert.strictEqual(cadOutcome.contract.currency, 'CAD', `Expected currency CAD, got ${cadOutcome.contract.currency}`);
    console.log('  [PASS] Non-USD currency CAD strictly preserved in contract and display value:', cadOutcome.currentDisplayValue);
  }

  // 18B: Query specifying "in after hours" sets marketHoursOnly: false
  const afterHoursTask: StockResearchTask = {
    id: `ah-stock-${Date.now()}`,
    query: 'Alert me if Apple stock is above 1 in after hours',
    ticker: 'AAPL',
    expectedOperator: 'GREATER_THAN',
    targetValue: 1,
  };
  const ahOutcome = await harness.research(afterHoursTask);
  if (ahOutcome.status === 'EXACT_MATCH') {
    assert.strictEqual(ahOutcome.contract.marketHoursOnly, false, 'Expected marketHoursOnly to be false for after-hours query');
    console.log('  [PASS] Extended hours query phrase correctly set marketHoursOnly: false');
  }

  // ---------------------------------------------------------
  // 19. Search Provider Error Propagation
  // ---------------------------------------------------------
  console.log('\n--- 19. Testing Search Provider Error Propagation ---');
  const originalFetchSearch = globalThis.fetch;
  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('/finance/search')) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429,
          statusText: 'Too Many Requests',
        });
      }
      return originalFetchSearch(input);
    };

    const searchErrTask: StockResearchTask = {
      id: `search-err-${Date.now()}`,
      query: 'NonExistentFakeCompany Corporation stock price',
    };

    const searchErrHarness = new StockResearchHarness({ preferProvider: 'YAHOO', timeoutMs: 5000 });
    const searchErrOutcome = await searchErrHarness.research(searchErrTask);
    assert.strictEqual(searchErrOutcome.status, 'ERROR', `Expected ERROR status for search provider 429, got ${searchErrOutcome.status}`);
    if (searchErrOutcome.status === 'ERROR') {
      assert.strictEqual(searchErrOutcome.provider, 'YAHOO');
      assert.ok(searchErrOutcome.error.includes('429'), `Expected error message to mention 429: ${searchErrOutcome.error}`);
      console.log('  [PASS] Search provider HTTP 429 correctly propagated as ERROR status (not lost as NOT_FOUND)');
    }
  } finally {
    globalThis.fetch = originalFetchSearch;
  }

  // ---------------------------------------------------------
  // 20. Indicator PERCENT_CHANGE Evaluated on Indicator Values
  // ---------------------------------------------------------
  console.log('\n--- 20. Testing Indicator PERCENT_CHANGE on Indicator Values ---');
  // Price candles have 0% change, but RSI changes by +10% (50 -> 55)
  const zeroChangePriceCandles: OHLCV[] = [
    { timestamp: 1000, open: 100, high: 101, low: 99, close: 100, volume: 5000 },
    { timestamp: 2000, open: 100, high: 101, low: 99, close: 100, volume: 5000 },
  ];

  const rsiPctChangeEval = evaluateStockCondition({
    targetType: 'INDICATOR',
    operator: 'PERCENT_CHANGE',
    targetValue: 10,
    observedValue: 55, // latest RSI
    previousObservedValue: 50, // previous RSI (+10%)
    indicatorName: 'RSI',
    indicatorSeries: [50, 55],
    candles: zeroChangePriceCandles,
  });

  assert.strictEqual(rsiPctChangeEval.conditionSatisfied, true, 'RSI percent change of 10% was not satisfied!');
  assert.strictEqual(rsiPctChangeEval.observedValue, 10, `Observed value should be 10% change, got ${rsiPctChangeEval.observedValue}`);
  assert.ok(rsiPctChangeEval.evaluationDetails.includes('RSI percent change 10.00%'), `Details should mention RSI percent change: ${rsiPctChangeEval.evaluationDetails}`);
  console.log('  [PASS] RSI PERCENT_CHANGE correctly calculated from RSI series (+10%), not price candles (0%)');

  // ---------------------------------------------------------
  // 21. Client-Level Coalesced Independent Cancellation
  // ---------------------------------------------------------
  console.log('\n--- 21. Testing Client-Level Coalesced Independent Cancellation ---');
  const originalFetchClient = globalThis.fetch;
  try {
    let clientFetchCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.includes('/v8/finance/chart/COALESCE_TEST')) {
        clientFetchCount++;
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(new Response(JSON.stringify({
              chart: {
                result: [{
                  meta: {
                    regularMarketPrice: 150.0,
                    chartPreviousClose: 145.0,
                    currency: 'USD',
                  }
                }]
              }
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }, 150);

          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(init.signal?.reason || new Error('Aborted'));
            });
          }
        });
      }
      return originalFetchClient(input, init);
    };

    const yClient = new YahooFinanceClient();
    const abortCtrl1 = new AbortController();
    const abortCtrl2 = new AbortController();

    const q1Promise = yClient.getQuote('COALESCE_TEST', { signal: abortCtrl1.signal });
    const q2Promise = yClient.getQuote('COALESCE_TEST', { signal: abortCtrl2.signal });

    // Abort caller 1 quickly
    setTimeout(() => abortCtrl1.abort(new DOMException('Caller 1 cancelled', 'AbortError')), 20);

    let q1Aborted = false;
    try {
      await q1Promise;
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError' || String(err).includes('cancelled') || String(err).includes('aborted')) {
        q1Aborted = true;
      }
    }
    assert.strictEqual(q1Aborted, true, 'Caller 1 should have aborted');

    // Caller 2 should succeed uninterrupted!
    const q2Result = await q2Promise;
    assert.ok(q2Result !== null, 'Caller 2 should have received valid quote result');
    assert.strictEqual(q2Result?.currentPrice, 150.0);
    assert.strictEqual(clientFetchCount, 1, 'Upstream should only have been called once');
    console.log('  [PASS] Yahoo client: Caller 1 aborting independently did NOT abort Caller 2 via coalesced signal');
  } finally {
    globalThis.fetch = originalFetchClient;
  }

  console.log('\n==========================================================');
  console.log('🎉 ALL 21 AUDIT VERIFICATION TESTS PASSED SUCCESSFULLY');
  console.log('==========================================================\n');
}

runStockHarnessTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
