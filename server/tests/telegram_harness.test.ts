import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  TelegramChannelThresholdSchema,
} from '@sentinel/shared';
import { Model, type StreamOptions } from '@strands-agents/sdk';
import {
  TelegramPublicClient,
  TelegramChannelHarness,
  createTelegramChannelTool,
  createTelegramInspectorTool,
  matchesKeywords,
  parseTelegramQuery,
  evaluateTelegramSemanticFilter,
  searchChannelsViaWeb,
  ProviderError,
  type TelegramResearchTask,
  type TelegramParsedMessage,
} from '../src/harness/telegram_channel/index.js';

async function runTests() {
  console.log('\n==========================================================');
  console.log('🧪 TEST SUITE: TELEGRAM OPEN CHANNEL PRODUCTION HARNESS');
  console.log('==========================================================\n');

  // ---------------------------------------------------------
  // 1. Test Shared Threshold Schema
  // ---------------------------------------------------------
  console.log('--- 1. Testing Shared Threshold Schema ---');
  const contract = TelegramChannelThresholdSchema.parse({
    channelHandle: '@whale_alert_io',
    keywords: ['BTC', 'ETH'],
    matchMode: 'ANY',
    minViews: 5000,
    mediaOnly: false,
    semanticFilter: 'Alert if transfer exceeds 1000 BTC',
  });
  assert.equal(contract.channelHandle, '@whale_alert_io');
  assert.equal(contract.keywords.length, 2);
  console.log('  [PASS] TelegramChannelThresholdSchema validated successfully.');

  // ---------------------------------------------------------
  // 2. Test Client Utilities
  // ---------------------------------------------------------
  console.log('\n--- 2. Testing TelegramPublicClient Utilities ---');
  const client = new TelegramPublicClient();

  assert.equal(client.cleanHandle('@whale_alert_io'), 'whale_alert_io');
  assert.equal(client.cleanHandle('https://t.me/whale_alert_io'), 'whale_alert_io');
  assert.equal(client.cleanHandle('t.me/s/whale_alert_io/'), 'whale_alert_io');
  assert.equal(client.cleanHandle('whale_alert_io'), 'whale_alert_io');
  console.log('  [PASS] cleanHandle normalizes all handle and URL formats.');

  assert.equal(client.parseNumericCount('8.9K'), 8900);
  assert.equal(client.parseNumericCount('1.2M'), 1200000);
  assert.equal(client.parseNumericCount('450'), 450);
  assert.equal(client.parseNumericCount('1,500'), 1500);
  console.log('  [PASS] parseNumericCount parses K/M/B metrics accurately.');

  // ---------------------------------------------------------
  // 3. Test Word-Boundary Regex & Match Mode Precedence
  // ---------------------------------------------------------
  console.log('\n--- 3. Testing Word-Boundary Regex & Precedence ---');
  const textWithSol = '🚨 500 SOL transferred to Binance exchange';
  const textWithSolid = 'We are building on a solid foundation with high resolution images.';

  assert.equal(matchesKeywords(textWithSol, ['sol'], 'ANY'), true);
  assert.equal(matchesKeywords(textWithSolid, ['sol'], 'ANY'), false);
  console.log('  [PASS] Substring Bug Prevented: "sol" does not match "solid" or "resolution".');

  // Explicit matchMode precedence over natural language hints
  const conflictingTask: TelegramResearchTask = {
    id: 'test-precedence',
    query: 'Watch for all keywords "apple" and "banana"',
    matchMode: 'EXACT', // Explicit EXACT overrides "all keywords" in query
  };
  const parsedConflict = parseTelegramQuery(conflictingTask);
  assert.equal(parsedConflict.matchMode, 'EXACT', 'Explicit matchMode must not be overridden by query text');
  assert.ok(parsedConflict.matchModeConflictDetected, 'Conflict warning must be recorded');
  assert.equal(parsedConflict.expectedOperator, 'KEYWORD_MATCH');
  console.log('  [PASS] Explicit matchMode takes precedence with conflict telemetry.');

  // ExpectedOperator derived from semanticFilter
  const semanticTask: TelegramResearchTask = {
    id: 'test-semantic-op',
    query: 'Watch @whale_alert_io',
    semanticFilter: 'Transfers to exchanges only',
  };
  const parsedSemantic = parseTelegramQuery(semanticTask);
  assert.equal(parsedSemantic.expectedOperator, 'SEMANTIC_MATCH');
  console.log('  [PASS] expectedOperator correctly inferred as SEMANTIC_MATCH when filter present.');

  // ---------------------------------------------------------
  // 4. Test Live Channel Fetch, Ordering & Strict Timestamps
  // ---------------------------------------------------------
  console.log('\n--- 4. Testing Live Channel Fetch & Chronological Sorting ---');
  const whaleData = await client.fetchChannel('whale_alert_io');
  assert.equal(whaleData.metadata.handle, 'whale_alert_io');
  assert.ok(whaleData.messages.length > 0, 'Must extract messages from live channel');

  // Verify strict newest-first sorting (messages[0] must be newer than messages[1])
  for (let i = 0; i < whaleData.messages.length - 1; i++) {
    const current = whaleData.messages[i];
    const next = whaleData.messages[i + 1];
    assert.ok(
      current.messageId >= next.messageId,
      `Message sorting failure: message[${i}].id (${current.messageId}) < message[${i + 1}].id (${next.messageId})`
    );
    assert.ok(current.timestamp > 0 && !isNaN(current.timestamp), 'Timestamp must be a valid positive integer');
  }
  console.log(`  [PASS] Extracted ${whaleData.messages.length} messages. Verified strict newest-first ordering.`);
  console.log(`    Newest: ${whaleData.messages[0].postId} (${whaleData.messages[0].isoDate})`);
  console.log(`    Oldest: ${whaleData.messages[whaleData.messages.length - 1].postId} (${whaleData.messages[whaleData.messages.length - 1].isoDate})`);

  // ---------------------------------------------------------
  // 5. Test Live Error & Boundary Detection
  // ---------------------------------------------------------
  console.log('\n--- 5. Testing Error & Boundary Classifications ---');

  // User profile redirect
  let userGroupError: any = null;
  try {
    await client.fetchChannel('ethereum');
  } catch (err) {
    userGroupError = err;
  }
  assert.ok(userGroupError);
  assert.equal(userGroupError.code, 'USER_OR_GROUP_PROFILE');
  console.log('  [PASS] USER_OR_GROUP_PROFILE detected on @ethereum profile redirect.');

  // Private invite link
  let privateLinkError: any = null;
  try {
    await client.fetchChannel('t.me/+fakeInviteLink123');
  } catch (err) {
    privateLinkError = err;
  }
  assert.ok(privateLinkError);
  assert.equal(privateLinkError.code, 'PRIVATE_INVITE_ONLY');
  console.log('  [PASS] PRIVATE_INVITE_ONLY rejected on invite link.');

  // Non-existent channel
  let notFoundError: any = null;
  try {
    await client.fetchChannel('non_existent_channel_xyz_123456789');
  } catch (err) {
    notFoundError = err;
  }
  assert.ok(notFoundError);
  assert.equal(notFoundError.code, 'CHANNEL_NOT_FOUND');
  console.log('  [PASS] CHANNEL_NOT_FOUND confirmed on deleted/non-existent channel.');

  // ---------------------------------------------------------
  // 6. Test Semantic Filter Evaluation in Live Harness
  // ---------------------------------------------------------
  console.log('\n--- 6. Testing Semantic Filter Evaluation ---');
  const semanticHarness = new TelegramChannelHarness({
    timeoutMs: 15000,
    // Real deterministic semantic classifier to verify harness gate integration
    semanticEvaluator: async (messages, filter) => {
      // Evaluates whether message mentions USDC or USD
      return messages.map((m) => /USDC|USD|\$/i.test(m.text));
    },
  });

  const semanticTaskRun: TelegramResearchTask = {
    id: `task-sem-${Date.now()}`,
    query: 'Alert when @whale_alert_io posts any transaction',
    channelHandle: 'whale_alert_io',
    keywords: ['transferred', 'USDC'],
    matchMode: 'ANY',
    semanticFilter: 'Only alert for stablecoin transactions',
  };

  const semEvents: string[] = [];
  const semStream = semanticHarness.stream(semanticTaskRun);

  let semNext = await semStream.next();
  while (!semNext.done) {
    semEvents.push(semNext.value.step);
    semNext = await semStream.next();
  }

  const semOutcome = semNext.value;
  assert.ok(semEvents.includes('SIMULATING_SEMANTIC_FILTER'), 'SIMULATING_SEMANTIC_FILTER event must be yielded');
  assert.equal(semOutcome.status, 'EXACT_MATCH');
  if (semOutcome.status === 'EXACT_MATCH') {
    assert.ok(
      typeof semOutcome.dossier.sampleSemanticMatchedCount === 'number',
      'Dossier must contain sampleSemanticMatchedCount'
    );
    assert.equal(semOutcome.dossier.expectedOperator, 'SEMANTIC_MATCH');
    console.log(`  [PASS] Semantic filter evaluated. ${semOutcome.dossier.sampleSemanticMatchedCount} posts matched semantic gate.`);
  }

  // ---------------------------------------------------------
  // 7. Test Cancellation & Timeout Handling
  // ---------------------------------------------------------
  console.log('\n--- 7. Testing Cancellation & Timeout Handling ---');

  // Test explicit cancellation via AbortSignal
  const cancelController = new AbortController();
  const cancelHarness = new TelegramChannelHarness({ timeoutMs: 15000 });
  const cancelTask: TelegramResearchTask = {
    id: `task-cancel-${Date.now()}`,
    query: 'Watch @whale_alert_io',
    channelHandle: 'whale_alert_io',
  };

  cancelController.abort('User cancelled test');
  const cancelOutcome = await cancelHarness.research(cancelTask, {
    signal: cancelController.signal,
  });
  assert.equal(cancelOutcome.status, 'CANCELLED', `Expected CANCELLED, got ${cancelOutcome.status}`);
  console.log('  [PASS] Aborted task cleanly resolved with CANCELLED status.');

  // Test timeout enforcement
  const timeoutHarness = new TelegramChannelHarness({ timeoutMs: 1 }); // 1ms timeout triggers immediately
  const timeoutTask: TelegramResearchTask = {
    id: `task-timeout-${Date.now()}`,
    query: 'Watch @whale_alert_io',
    channelHandle: 'whale_alert_io',
  };

  const timeoutOutcome = await timeoutHarness.research(timeoutTask);
  assert.equal(timeoutOutcome.status, 'TIMED_OUT', `Expected TIMED_OUT, got ${timeoutOutcome.status}`);
  console.log('  [PASS] Exceeded timeout cleanly resolved with TIMED_OUT status.');

  // ---------------------------------------------------------
  // 8. Test Concurrency Isolation on Duplicate Task IDs
  // ---------------------------------------------------------
  console.log('\n--- 8. Testing Concurrency Isolation (Duplicate Task IDs) ---');
  const concurrentHarness = new TelegramChannelHarness({ timeoutMs: 15000 });
  const duplicateTaskId = 'shared-duplicate-task-id';

  const run1 = concurrentHarness.research({
    id: duplicateTaskId,
    query: 'Watch @whale_alert_io for BTC',
    channelHandle: 'whale_alert_io',
    keywords: ['BTC'],
  });

  const run2 = concurrentHarness.research({
    id: duplicateTaskId,
    query: 'Watch @durov for Telegram',
    channelHandle: 'durov',
    keywords: ['Telegram'],
  });

  const [res1, res2] = await Promise.all([run1, run2]);
  assert.equal(res1.status, 'EXACT_MATCH');
  assert.equal(res2.status, 'EXACT_MATCH');
  assert.notEqual(res1.executionId, res2.executionId, 'Executions must receive distinct execution IDs');
  if (res1.status === 'EXACT_MATCH' && res2.status === 'EXACT_MATCH') {
    assert.equal(res1.contract.channelHandle, '@whale_alert_io');
    assert.equal(res2.contract.channelHandle, '@durov');
  }

  // Verify telemetry history lookup from completed history
  const history1 = concurrentHarness.getTelemetryHistory(duplicateTaskId, res1.executionId);
  const history2 = concurrentHarness.getTelemetryHistory(duplicateTaskId, res2.executionId);
  assert.ok(history1.length > 0, 'Completed history for run1 must be retained');
  assert.ok(history2.length > 0, 'Completed history for run2 must be retained');
  console.log('  [PASS] Concurrent runs with duplicate task IDs executed in complete isolation.');

  // ---------------------------------------------------------
  // 9. Test Sample Simulation vs Rule Armed Status
  // ---------------------------------------------------------
  console.log('\n--- 9. Testing Sample Simulation vs Rule Armed Status ---');
  const zeroMatchHarness = new TelegramChannelHarness({ timeoutMs: 15000 });
  const zeroMatchTask: TelegramResearchTask = {
    id: `task-zero-${Date.now()}`,
    query: 'Watch @whale_alert_io for impossible term',
    channelHandle: 'whale_alert_io',
    keywords: ['xyz999nevermatchedterm123'],
    matchMode: 'EXACT',
  };

  const zeroOutcome = await zeroMatchHarness.research(zeroMatchTask);
  assert.equal(zeroOutcome.status, 'EXACT_MATCH');
  if (zeroOutcome.status === 'EXACT_MATCH') {
    assert.equal(zeroOutcome.dossier.simulationVerdict, 'NO_HISTORICAL_MATCHES_RULE_ARMED');
    assert.equal(zeroOutcome.dossier.matchedSampleCount, 0);
    assert.equal(zeroOutcome.dossier.sampleMatchRate, 0);
    assert.ok(
      zeroOutcome.verificationDetails.includes('armed for incoming broadcasts'),
      'Verification details must explain rule is armed despite 0 historical sample matches'
    );
    console.log('  [PASS] Zero sample matches properly classified as NO_HISTORICAL_MATCHES_RULE_ARMED.');
  }

  // ---------------------------------------------------------
  // 10. Test Native Strands Tools Execution
  // ---------------------------------------------------------
  console.log('\n--- 10. Testing Native Strands Tools ---');
  const researchTool = createTelegramChannelTool();
  assert.equal(researchTool.name, 'telegram_channel_research');

  const inspectorTool = createTelegramInspectorTool();
  assert.equal(inspectorTool.name, 'inspect_telegram_channel');

  const invokeMethod = (inspectorTool as any)._callback || (inspectorTool as any).callback;
  const inspectorResult: any = await invokeMethod.call(inspectorTool, {
    channelHandle: 'durov',
    messageLimit: 3,
  });
  assert.equal(inspectorResult.success, true);
  assert.ok(inspectorResult.recentMessages.length <= 3);
  console.log(`  [PASS] inspect_telegram_channel executed on @durov with ${inspectorResult.recentMessages.length} messages.`);

  // ---------------------------------------------------------
  // 11. Test Tool executionId Forwarding from SDK Context
  // ---------------------------------------------------------
  console.log('\n--- 11. Testing Tool executionId Forwarding ---');
  const forwardedExecId = `exec-forward-${Date.now()}`;
  const customContext = {
    invocationState: {
      taskId: 'task-forward-test',
      executionId: forwardedExecId,
    },
    cancelSignal: new AbortController().signal,
  };

  const toolCallback = (researchTool as any)._callback || (researchTool as any).callback;
  const toolStreamGen = toolCallback.call(
    researchTool,
    { query: 'Watch @durov for Telegram' },
    customContext
  );

  let toolNext = await toolStreamGen.next();
  while (!toolNext.done) {
    assert.equal(
      toolNext.value.executionId,
      forwardedExecId,
      'Stream events must preserve forwarded executionId from ToolContext'
    );
    toolNext = await toolStreamGen.next();
  }

  const finalToolOutcome = toolNext.value;
  assert.equal(
    finalToolOutcome.executionId,
    forwardedExecId,
    'Final research outcome must preserve forwarded executionId from ToolContext'
  );
  console.log(`  [PASS] Tool execution ID (${forwardedExecId}) forwarded properly from ToolContext.`);

  // ---------------------------------------------------------
  // 12. Test Strict Semantic Output Validation
  // ---------------------------------------------------------
  console.log('\n--- 12. Testing Strict Semantic Output Validation ---');
  class MockBedrockModel extends Model {
    constructor(
      private responder: (messages: any[], options?: StreamOptions) => Promise<{ text: string }> | { text: string }
    ) {
      super();
    }

    getConfig() {
      return { modelId: 'mock-bedrock-evaluator', contextWindowLimit: 128000 };
    }

    async *stream(messages: any[], options?: StreamOptions) {
      const res = await this.responder(messages, options);
      yield {
        type: 'modelMessageStartEvent',
        role: 'assistant',
      } as any;
      yield {
        type: 'modelContentBlockStartEvent',
      } as any;
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: res.text },
      } as any;
      yield {
        type: 'modelContentBlockStopEvent',
      } as any;
      yield {
        type: 'modelMessageStopEvent',
        stopReason: 'end_turn',
      } as any;
    }
  }

  const sampleMessages: TelegramParsedMessage[] = [
    {
      messageId: 101,
      postId: 'test/101',
      text: 'First sample message mentioning BTC transfer',
      timestamp: 1700000000,
      isoDate: new Date(1700000000000).toISOString(),
      hasMedia: false,
      link: 'https://t.me/test/101',
    },
    {
      messageId: 102,
      postId: 'test/102',
      text: 'Second sample message with regular news',
      timestamp: 1700000001,
      isoDate: new Date(1700000001000).toISOString(),
      hasMedia: false,
      link: 'https://t.me/test/102',
    },
  ];

  // Case A: Batch length mismatch (2 messages, 1 match)
  const lengthMismatchModel = new MockBedrockModel(() => ({
    text: JSON.stringify({ matches: [true] }), // Only 1 element instead of 2
  }));

  let mismatchError: any = null;
  try {
    await evaluateTelegramSemanticFilter(
      sampleMessages,
      'Detect BTC transfers',
      lengthMismatchModel
    );
  } catch (err) {
    mismatchError = err;
  }
  assert.ok(mismatchError instanceof ProviderError, 'Should throw ProviderError on batch length mismatch');
  assert.ok(
    mismatchError.message.includes('batch length mismatch'),
    `Expected batch length mismatch error, got: ${mismatchError.message}`
  );
  console.log('  [PASS] Rejects model response when matches array length does not match batch length.');

  // Case B: Non-boolean value in matches array
  const nonBooleanModel = new MockBedrockModel(() => ({
    text: JSON.stringify({ matches: [true, 'yes'] }), // 'yes' is truthy string, not boolean
  }));

  let nonBoolError: any = null;
  try {
    await evaluateTelegramSemanticFilter(
      sampleMessages,
      'Detect BTC transfers',
      nonBooleanModel
    );
  } catch (err) {
    nonBoolError = err;
  }
  assert.ok(nonBoolError instanceof ProviderError, 'Should throw ProviderError on non-boolean value');
  assert.ok(
    nonBoolError.message.includes('non-boolean value'),
    `Expected non-boolean error, got: ${nonBoolError.message}`
  );
  console.log('  [PASS] Rejects non-boolean values in model matches array (no implicit Boolean coercion).');

  // Case C: Valid strict boolean output
  const validModel = new MockBedrockModel(() => ({
    text: JSON.stringify({ matches: [true, false] }),
  }));
  const validMatches = await evaluateTelegramSemanticFilter(
    sampleMessages,
    'Detect BTC transfers',
    validModel
  );
  assert.deepEqual(validMatches, [true, false]);
  console.log('  [PASS] Valid boolean array [true, false] correctly parsed and returned.');

  // ---------------------------------------------------------
  // 13. Test In-Flight Semantic Evaluation Cancellation
  // ---------------------------------------------------------
  console.log('\n--- 13. Testing In-Flight Semantic Cancellation ---');
  const abortDuringModelController = new AbortController();
  let receivedCancelSignalInModel: AbortSignal | undefined;

  const asyncCancellingModel = new MockBedrockModel(async (_, options) => {
    receivedCancelSignalInModel = options?.cancelSignal;
    // Trigger abort while model call is in-flight
    abortDuringModelController.abort(new Error('Caller cancelled during model invocation'));
    // Simulate slight async delay
    await new Promise((r) => setTimeout(r, 10));
    return { text: JSON.stringify({ matches: [true, true] }) };
  });

  let inFlightAbortError: any = null;
  try {
    await evaluateTelegramSemanticFilter(
      sampleMessages,
      'Detect BTC transfers',
      asyncCancellingModel,
      abortDuringModelController.signal
    );
  } catch (err) {
    inFlightAbortError = err;
  }
  assert.ok(inFlightAbortError, 'Must abort when cancel signal fires in-flight');
  assert.equal(
    inFlightAbortError.message,
    'Caller cancelled during model invocation',
    'Abort error message should be preserved'
  );
  assert.ok(receivedCancelSignalInModel, 'cancelSignal must be forwarded to evaluator.invoke / model.stream');
  console.log('  [PASS] In-flight semantic model call receives cancelSignal and halts cleanly on abort.');

  // ---------------------------------------------------------
  // 14. Test Truly Cancelable DuckDuckGo Search
  // ---------------------------------------------------------
  console.log('\n--- 14. Testing Truly Cancelable DuckDuckGo Search ---');
  const searchAbortController = new AbortController();
  searchAbortController.abort(new Error('Pre-search abort initiated'));

  let searchAbortError: any = null;
  try {
    await searchChannelsViaWeb('crypto news', 5, searchAbortController.signal);
  } catch (err) {
    searchAbortError = err;
  }
  assert.ok(searchAbortError, 'DuckDuckGo search must abort when signal is aborted');
  assert.equal(searchAbortError.message, 'Pre-search abort initiated');
  console.log('  [PASS] DuckDuckGo search cancelled immediately without hanging background tasks.');

  console.log('\n==========================================================');
  console.log('✅ ALL 14 COMPREHENSIVE PRODUCTION TEST SUITES PASSED!');
  console.log('==========================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test execution failed with error:', err);
  process.exit(1);
});
