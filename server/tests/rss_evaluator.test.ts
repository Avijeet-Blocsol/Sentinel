/**
 * Strands Sentinel - RSS Evaluator Unit & Integration Test Suite
 * Rigorously tests:
 * 1. Deterministic Tier 1 regex keyword & author matching
 * 2. HTTP 304 conditional request caching (ETag / Last-Modified)
 * 3. Two-Tier agentic semantic evaluation (via AgenticConditionEvaluator)
 * 4. Error resilience and graceful degradation
 */

import 'dotenv/config';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SubSentinel, Rule, User } from '@sentinel/shared';
import {
  userRepository,
  ruleRepository,
  subSentinelRepository,
} from '../src/db/index.js';
import { RssEvaluator } from '../src/services/evaluators/rss_evaluator.js';
import type { AgenticConditionEvaluator } from '../src/services/evaluators/agentic_evaluator.js';

async function runTests() {
  console.log('\n==========================================================');
  console.log('🧪 TEST SUITE: RSS EVALUATOR TWO-TIER & CACHING AUDIT');
  console.log('==========================================================\n');

  let serverPort = 0;
  let requestCount = 0;
  let lastReceivedHeaders: http.IncomingHttpHeaders = {};

  const server = http.createServer((req, res) => {
    requestCount++;
    lastReceivedHeaders = req.headers;
    const url = new URL(req.url || '/', `http://127.0.0.1:${serverPort}`);

    if (url.pathname === '/cached-feed') {
      const ifNoneMatch = req.headers['if-none-match'];
      const ifModifiedSince = req.headers['if-modified-since'];

      if (ifNoneMatch === '"v1-etag-hash"' || ifModifiedSince === 'Sun, 13 Sep 2026 12:00:00 GMT') {
        res.writeHead(304);
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/rss+xml',
        'ETag': '"v1-etag-hash"',
        'Last-Modified': 'Sun, 13 Sep 2026 12:00:00 GMT',
      });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Fed Macro News</title>
            <link>http://127.0.0.1:${serverPort}/cached-feed</link>
            <item>
              <title>Federal Reserve announces 50bps rate cut</title>
              <link>http://127.0.0.1:${serverPort}/cached-feed/item1</link>
              <description>The Federal Reserve today decided to lower the benchmark target rate.</description>
              <author>Jerome Powell</author>
              <pubDate>Sun, 13 Sep 2026 12:00:00 GMT</pubDate>
            </item>
            <item>
              <title>Tech stocks rally following FOMC announcement</title>
              <link>http://127.0.0.1:${serverPort}/cached-feed/item2</link>
              <description>Markets surged 300 points as inflation expectations eased.</description>
              <author>Jane Doe</author>
              <pubDate>Sun, 13 Sep 2026 13:00:00 GMT</pubDate>
            </item>
          </channel>
        </rss>`);
      return;
    }

    if (url.pathname === '/error-500') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        serverPort = addr.port;
      }
      resolve();
    });
  });

  try {
    const feedUrl = `http://127.0.0.1:${serverPort}/cached-feed`;
    const testFetch = (url: string, options?: any) => fetch(url, options);

    // Initialize DB foreign key parents
    const testUser: User = {
      id: `user_test_rss_${Date.now()}`,
      email: `test_rss_${Date.now()}@sentinel.local`,
      name: 'RSS Test User',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await userRepository.create(testUser);

    const testRule: Rule = {
      id: randomUUID(),
      user_id: testUser.id,
      title: 'RSS Macro Sentinel Rule',
      natural_language_intent: 'Alert on Federal Reserve rate decisions',
      category: 'WEB_INTEL',
      combinator: 'SINGLE',
      trigger_mode: 'PERSISTENT',
      cooldown_minutes: 0,
      audio_tone: 'chime',
      status: 'ACTIVE',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await ruleRepository.create(testRule);

    // ---------------------------------------------------------
    // Module 1: Strands Agent Evaluation (Keyword Criteria & Author Filter)
    // ---------------------------------------------------------
    console.log('--- Module 1: Strands Agent Evaluation (Keyword Criteria & Author Filter) ---');
    let mod1AgentInvoked = false;
    const mockMod1Agent: AgenticConditionEvaluator = {
      evaluate: async (input) => {
        mod1AgentInvoked = true;
        assert.ok(input.conditionToEvaluate.includes('rate cut'), 'Condition must specify keyword target');
        return {
          conditionSatisfied: true,
          confidenceScore: 0.95,
          reasoning: 'The article explicitly discusses Jerome Powell announcing a rate cut.',
          observedEvidence: {
            relevantSnippet: 'Federal Reserve announces 50bps rate cut',
          },
        };
      },
    } as unknown as AgenticConditionEvaluator;

    const evaluator = new RssEvaluator({ agenticEvaluator: mockMod1Agent, fetchFn: testFetch });
    const subSentinelId1 = randomUUID();

    const subSentinel1: SubSentinel = {
      id: subSentinelId1,
      rule_id: testRule.id,
      sentinel_type: 'RSS_FEED',
      target_source: feedUrl,
      operator: 'KEYWORD_MATCH',
      threshold: JSON.stringify({
        feedUrl,
        keywords: ['rate cut'],
        matchMode: 'EXACT',
        authorFilter: 'Powell',
      }),
      ttl_seconds: 300,
      health_status: 'HEALTHY',
      error_count: 0,
      is_satisfied: 0,
    };
    await subSentinelRepository.create(subSentinel1);

    const res1 = await evaluator.evaluate(subSentinel1);
    assert.equal(mod1AgentInvoked, true, 'AgenticConditionEvaluator must be invoked for keyword criteria');
    assert.equal(res1.isSatisfied, true, 'Should match exact keyword "rate cut" and author "Powell"');
    assert.equal(res1.observedValue, 1, 'Should find exactly 1 matching item');
    assert.ok(res1.details.includes('[Semantic Match]'), 'Details should report agent match');
    assert.equal(res1.extraMetadata?.matchedCount, 1);
    console.log('  ✔ Strands Agent keyword evaluation and authorFilter passed');

    // ---------------------------------------------------------
    // Module 2: HTTP 304 Caching Verification
    // ---------------------------------------------------------
    console.log('\n--- Module 2: HTTP 304 Conditional Request & Caching ---');
    // The previous request stored ETag '"v1-etag-hash"' in evaluator's cache.
    // A second evaluate call for the same subSentinel must send If-None-Match and receive 304.
    const res2 = await evaluator.evaluate(subSentinel1);
    assert.equal(res2.isSatisfied, false, 'HTTP 304 should yield isSatisfied: false');
    assert.equal(res2.observedValue, 0, 'HTTP 304 observedValue should be 0');
    assert.ok(res2.details.includes('HTTP 304 Not Modified'), 'Details should note 304 Not Modified');
    assert.equal(res2.extraMetadata?.httpStatus, 304);
    assert.equal(res2.extraMetadata?.cached, true);
    assert.equal(lastReceivedHeaders['if-none-match'], '"v1-etag-hash"');
    console.log('  ✔ HTTP 304 Not Modified detected and handled without re-parsing payload');

    // Clear cache test
    evaluator.clearCache(subSentinelId1);
    // Next request should NOT send If-None-Match
    await evaluator.evaluate(subSentinel1);
    assert.equal(lastReceivedHeaders['if-none-match'], undefined, 'Cleared cache should omit If-None-Match');
    console.log('  ✔ clearCache() invalidated cache entry successfully');

    // ---------------------------------------------------------
    // Module 3: Two-Tier Agentic Semantic Filter - Positive Match
    // ---------------------------------------------------------
    console.log('\n--- Module 3: Two-Tier Semantic Filter (Positive Match) ---');
    let agentInvoked = false;
    let agentInputContext: any = null;

    const mockPositiveAgent: AgenticConditionEvaluator = {
      evaluate: async (input) => {
        agentInvoked = true;
        agentInputContext = input;
        return {
          conditionSatisfied: true,
          confidenceScore: 0.98,
          reasoning: 'The excerpt explicitly announces an official 50 basis point federal funds rate cut.',
          observedEvidence: {
            sourceTitle: 'Fed Macro News',
            sourceUrl: `${feedUrl}/item1`,
            relevantSnippet: 'Federal Reserve announces 50bps rate cut',
            extractedValue: '-50bps',
          },
          suggestedAlert: {
            title: 'FOMC Announces 50bps Rate Cut',
            summary: 'Federal Reserve officially reduced benchmark rate by 50 basis points.',
            severity: 'CRITICAL',
            audioTone: 'cash_register',
          },
          suggestedAction: {
            actionType: 'WEBHOOK_POST',
            target: 'https://trading.internal/macro-trigger',
            parameters: { cut: 50 },
            requiresHumanApproval: true,
            description: 'Trigger interest-rate sensitive rebalancing',
          },
        };
      },
    } as unknown as AgenticConditionEvaluator;

    const agenticEvaluator = new RssEvaluator({ agenticEvaluator: mockPositiveAgent, fetchFn: testFetch });
    const subSentinelId3 = randomUUID();

    const subSentinel3: SubSentinel = {
      id: subSentinelId3,
      rule_id: testRule.id,
      sentinel_type: 'RSS_FEED',
      target_source: feedUrl,
      operator: 'KEYWORD_MATCH',
      threshold: JSON.stringify({
        feedUrl,
        keywords: ['Federal Reserve'],
        semanticFilter: 'Official reduction in benchmark interest rate by FOMC',
      }),
      ttl_seconds: 300,
      health_status: 'HEALTHY',
      error_count: 0,
      is_satisfied: 0,
    };
    await subSentinelRepository.create(subSentinel3);

    const res3 = await agenticEvaluator.evaluate(subSentinel3);
    assert.equal(agentInvoked, true, 'AgenticConditionEvaluator must be invoked when semanticFilter is provided');
    assert.equal(res3.isSatisfied, true, 'Evaluation should be satisfied following agent approval');
    assert.ok(res3.details.includes('[Semantic Match]'), 'Details should indicate semantic match');
    assert.equal(res3.extraMetadata?.agenticResult?.suggestedAlert?.severity, 'CRITICAL');
    assert.equal(res3.extraMetadata?.agenticResult?.suggestedAction?.actionType, 'WEBHOOK_POST');
    console.log('  ✔ Tier 2 Agentic Evaluator invoked and enriched alert/action metadata');

    // ---------------------------------------------------------
    // Module 4: Two-Tier Agentic Semantic Gate - False Positive Rejection
    // ---------------------------------------------------------
    console.log('\n--- Module 4: Two-Tier Semantic Gate (False Positive Rejection) ---');
    const mockNegativeAgent: AgenticConditionEvaluator = {
      evaluate: async () => ({
        conditionSatisfied: false,
        confidenceScore: 0.92,
        reasoning: 'The article only mentions speculation by analysts, not an official rate cut.',
        observedEvidence: {
          relevantSnippet: 'Markets surged 300 points as inflation expectations eased.',
        },
      }),
    } as unknown as AgenticConditionEvaluator;

    const gateEvaluator = new RssEvaluator({ agenticEvaluator: mockNegativeAgent, fetchFn: testFetch });
    const subSentinelId4 = randomUUID();

    const subSentinel4: SubSentinel = {
      id: subSentinelId4,
      rule_id: testRule.id,
      sentinel_type: 'RSS_FEED',
      target_source: feedUrl,
      operator: 'KEYWORD_MATCH',
      threshold: JSON.stringify({
        feedUrl,
        keywords: ['Tech stocks'],
        semanticFilter: 'Official Fed announcement of rate hike',
      }),
      ttl_seconds: 300,
      health_status: 'HEALTHY',
      error_count: 0,
      is_satisfied: 0,
    };
    await subSentinelRepository.create(subSentinel4);

    const res4 = await gateEvaluator.evaluate(subSentinel4);
    assert.equal(res4.isSatisfied, false, 'Semantic gate must reject false positive even when keyword matched');
    assert.equal(res4.observedValue, 0);
    assert.ok(res4.details.includes('[Semantic Gate Filtered]'), 'Details must record gate rejection');
    console.log('  ✔ Semantic gate correctly blocked false-positive trigger');

    // ---------------------------------------------------------
    // Module 5: Error Handling & Degradation
    // ---------------------------------------------------------
    console.log('\n--- Module 5: Error Handling & Degradation ---');
    const errEvaluator = new RssEvaluator({ fetchFn: testFetch });

    // 5A: HTTP 500 error
    const subSentinel5A: SubSentinel = {
      id: randomUUID(),
      rule_id: testRule.id,
      sentinel_type: 'RSS_FEED',
      target_source: `http://127.0.0.1:${serverPort}/error-500`,
      operator: 'KEYWORD_MATCH',
      threshold: JSON.stringify({
        feedUrl: `http://127.0.0.1:${serverPort}/error-500`,
        keywords: ['test'],
      }),
      ttl_seconds: 300,
      health_status: 'HEALTHY',
      error_count: 0,
      is_satisfied: 0,
    };
    await subSentinelRepository.create(subSentinel5A);

    const res5A = await errEvaluator.evaluate(subSentinel5A);
    assert.equal(res5A.isSatisfied, false);
    assert.equal(res5A.error, 'HTTP_500');
    console.log('  ✔ HTTP 500 returned graceful error response');

    // 5B: Schema validation failure
    const subSentinel5B: SubSentinel = {
      id: randomUUID(),
      rule_id: testRule.id,
      sentinel_type: 'RSS_FEED',
      target_source: 'invalid-url',
      operator: 'KEYWORD_MATCH',
      threshold: JSON.stringify({ feedUrl: 'not-a-valid-url', keywords: [] }),
      ttl_seconds: 300,
      health_status: 'HEALTHY',
      error_count: 0,
      is_satisfied: 0,
    };
    await subSentinelRepository.create(subSentinel5B);

    const res5B = await errEvaluator.evaluate(subSentinel5B);
    assert.equal(res5B.isSatisfied, false);
    assert.ok(res5B.error);
    console.log('  ✔ Schema validation failure handled safely');

    console.log('\n🎉 ALL 5 RSS EVALUATOR MODULES PASSED WITH 100% SUCCESS!\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
