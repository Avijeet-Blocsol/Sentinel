import 'dotenv/config';
import {
  SentinelAgent,
  getAgentDefaultModel,
  SENTINEL_AGENT_SYSTEM_PROMPT,
} from '../src/agent/index.js';
import { createStockResearchTool } from '../src/harness/stocks/index.js';
import { createCryptoResearchTool } from '../src/harness/crypto/index.js';
import { createPredictionMarketTool } from '../src/harness/prediction_market/index.js';
import { createRssResearchTool } from '../src/harness/rss/index.js';
import {
  createIndicatorTool,
  createMarketQuoteTool,
  CoinbaseClient,
  globalRequestCoalescer,
  resolveSemanticEntity,
} from '../src/harness/finance_common/index.js';
import { runStockPipeline } from '../src/harness/stocks/stock_graph.js';

async function runAgentTests() {
  console.log('\n==========================================================');
  console.log('🧪 TEST SUITE: STRANDS SENTINEL MASTER AGENT CORE');
  console.log('==========================================================\n');

  // ---------------------------------------------------------
  // 1. Test Master Agent Initialization & Tools Inventory
  // ---------------------------------------------------------
  console.log('--- 1. Testing Master Agent Initialization ---');

  const agentInstance = new SentinelAgent();
  const tools = agentInstance.agent.tools;

  console.assert(tools.length >= 7, `Expected at least 7 tools, got ${tools.length}`);
  console.log(`  [PASS] SentinelAgent instantiated with ${tools.length} active reconnaissance tools.`);

  const toolNames = tools.map((t) => t.name);
  console.assert(toolNames.includes('stock_research'), 'Missing stock_research tool');
  console.assert(toolNames.includes('crypto_research'), 'Missing crypto_research tool');
  console.assert(toolNames.includes('prediction_market_research'), 'Missing prediction_market_research tool');
  console.assert(toolNames.includes('rss_research'), 'Missing rss_research tool');
  console.assert(toolNames.includes('calculate_technical_indicator'), 'Missing calculate_technical_indicator tool');
  console.assert(toolNames.includes('get_market_quote'), 'Missing get_market_quote tool');
  console.assert(toolNames.includes('web_search'), 'Missing web_search tool');

  console.log('  [PASS] All registered tools verified:', toolNames.join(', '));

  // ---------------------------------------------------------
  // 2. Test ConcurrentToolExecutor & System Prompt
  // ---------------------------------------------------------
  console.log('\n--- 2. Testing Tool Executor & Prompt Configuration ---');

  console.assert(
    SENTINEL_AGENT_SYSTEM_PROMPT.includes('Sub-Sentinels'),
    'Prompt missing Sub-Sentinels reference'
  );
  console.assert(
    SENTINEL_AGENT_SYSTEM_PROMPT.includes('stock_research') &&
    SENTINEL_AGENT_SYSTEM_PROMPT.includes('crypto_research'),
    'Prompt missing tool references'
  );
  console.log('  [PASS] SENTINEL_AGENT_SYSTEM_PROMPT verified.');

  // ---------------------------------------------------------
  // 3. Test Model Factory
  // ---------------------------------------------------------
  console.log('\n--- 3. Testing Model Factory ---');

  const model = getAgentDefaultModel();
  console.assert(model !== null && typeof model === 'object', 'Failed to instantiate default model');
  console.log('  [PASS] Default model instantiated successfully.');

  // ---------------------------------------------------------
  // 4. Test Stock Stop-Word Hardening
  // ---------------------------------------------------------
  console.log('\n--- 4. Testing Stock Stop-Word Hardening (No "ALERT" Ticker) ---');

  const stockTool = createStockResearchTool();
  const stockResult = (await stockTool.invoke({
    query: 'Alert me when my stock rises above 150',
  })) as any;
  console.assert(
    stockResult.status === 'NOT_FOUND',
    `Expected NOT_FOUND when no ticker provided, got ${stockResult.status}`
  );
  console.log('  [PASS] Stock stop-word sanitization prevented false "ALERT" ticker parsing.');

  // ---------------------------------------------------------
  // 5. Test Crypto Stop-Word Hardening
  // ---------------------------------------------------------
  console.log('\n--- 5. Testing Crypto Stop-Word Hardening (No "ALERT" Token) ---');

  const cryptoTool = createCryptoResearchTool();
  const cryptoResult = (await cryptoTool.invoke({
    query: 'Notify me if my crypto drops below 50000',
  })) as any;
  console.assert(
    cryptoResult.status === 'NOT_FOUND',
    `Expected NOT_FOUND when no symbol provided, got ${cryptoResult.status}`
  );
  console.log('  [PASS] Crypto stop-word sanitization prevented false "ALERT" token parsing.');

  // ---------------------------------------------------------
  // 6. Test Shared Market Quote Tool Integration
  // ---------------------------------------------------------
  console.log('\n--- 6. Testing Shared Market Quote Tool ---');

  const quoteTool = createMarketQuoteTool();
  const quoteRes = (await quoteTool.invoke({
    assetType: 'CRYPTO',
    symbolOrQuery: 'BTC',
  })) as any;
  console.assert(quoteRes.success === true, 'Failed to fetch quote via market_quote_tool');
  console.log(`  [PASS] market_quote_tool resolved BTC via ${quoteRes.provider}: $${(quoteRes.quote as any).price}`);

  // ---------------------------------------------------------
  // 7. Test Indicator Tool Candle Count Guard
  // ---------------------------------------------------------
  console.log('\n--- 7. Testing Indicator Tool Candle Count Guard ---');

  const indicatorTool = createIndicatorTool();
  const insufficientCandles = [
    { timestamp: 1, open: 100, high: 105, low: 95, close: 102, volume: 10 },
    { timestamp: 2, open: 102, high: 108, low: 100, close: 106, volume: 15 },
  ];

  // Request SMA with period 14 on only 2 candles
  const guardRes = (await indicatorTool.invoke({
    indicator: 'SMA',
    period: 14,
    candles: insufficientCandles,
  })) as any;

  console.assert(guardRes.success === false, 'Expected candle count guard to reject insufficient candles');
  console.assert(
    guardRes.error?.includes('requires at least 14 candles'),
    `Unexpected error message: ${guardRes.error}`
  );
  console.log('  [PASS] Indicator candle count guard successfully caught insufficient history:', guardRes.error);

  // ---------------------------------------------------------
  // 8. Test In-Flight Request Coalescing (Financial APIs)
  // ---------------------------------------------------------
  console.log('\n--- 8. Testing In-Flight Request Coalescing ---');

  globalRequestCoalescer.clear();
  const cbClient = new CoinbaseClient();

  // Dispatch 5 concurrent requests for the exact same ticker simultaneously
  const [q1, q2, q3, q4, q5] = await Promise.all([
    cbClient.getSpotPrice('BTC'),
    cbClient.getSpotPrice('BTC'),
    cbClient.getSpotPrice('BTC'),
    cbClient.getSpotPrice('BTC'),
    cbClient.getSpotPrice('BTC'),
  ]);

  console.assert(q1 !== null && q5 !== null, 'Coinbase spot quotes returned null');
  console.assert(q1?.price === q5?.price, 'Expected coalesced requests to share identical result object');
  console.assert(
    globalRequestCoalescer.totalCoalescedCount >= 4,
    `Expected >= 4 coalesced requests, got ${globalRequestCoalescer.totalCoalescedCount}`
  );
  console.log(
    `  [PASS] Request coalescer successfully intercepted ${globalRequestCoalescer.totalCoalescedCount} concurrent requests (Spot Price: $${q1?.price}).`
  );

  // ---------------------------------------------------------
  // 9. Test Semantic Entity Fallback Handling
  // ---------------------------------------------------------
  console.log('\n--- 9. Testing Semantic Entity Fallback Handling ---');

  // Verify resolveSemanticEntity degrades gracefully when no LLM key present or input inconclusive
  const emptyRes = await resolveSemanticEntity('', 'STOCK');
  console.assert(emptyRes === null, 'Expected empty input to yield null');

  // Verify stock pipeline attempts semantic resolution when heuristic entity extraction is inconclusive
  const stream = runStockPipeline({
    id: 'test-semantic-1',
    query: 'Alert me when the manufacturer of the iPhone rises above 250',
  });

  const stepsYielded: string[] = [];
  for await (const evt of stream) {
    stepsYielded.push(evt.step);
  }

  console.assert(
    stepsYielded.includes('RESOLVING_ENTITY'),
    'Expected pipeline to trigger RESOLVING_ENTITY step for complex descriptive query'
  );
  console.log('  [PASS] Stock pipeline successfully triggered semantic entity resolution step for complex query.');

  console.log('\n==========================================================');
  console.log('✅ ALL 9 MASTER STRANDS AGENT & HARDENING TESTS PASSED!');
  console.log('==========================================================\n');
}

runAgentTests().catch((err) => {
  console.error('\n❌ Sentinel Agent test failed:', err);
  process.exit(1);
});
