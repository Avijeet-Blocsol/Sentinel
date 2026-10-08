import assert from 'node:assert/strict';
import { evaluateConditionTree, parseConditionTree } from '@sentinel/shared';
import { extractSynthesizedRule } from '../src/services/deployment_workflow.js';
import { buildVerifiedContractSynthesis } from '../src/api/realtime/ws_stream_handler.js';

const userId = 'condition-synthesis-user';
const conversationId = '00000000-0000-4000-8000-000000000777';

function watcher(condition_key: string, target_source: string) {
  return {
    condition_key,
    sentinel_type: 'STOCK',
    target_source,
    operator: 'GREATER_THAN',
    threshold: { ticker: target_source, targetValue: 1, operator: 'GREATER_THAN' },
    ttl_seconds: 60,
  };
}

function run() {
  const output = extractSynthesizedRule(`\`\`\`json
${JSON.stringify({
  title: 'Nested condition deployment',
  natural_language_intent: 'Alert if (A or B) and C',
  category: 'FINANCIAL',
  combinator: 'AND',
  trigger_mode: 'PERSISTENT',
  audio_tone: 'chime',
  sub_sentinels: [watcher('A', 'AAPL'), watcher('B', 'MSFT'), watcher('C', 'NVDA')],
  condition_tree: {
    type: 'AND',
    children: [
      { type: 'OR', children: [{ type: 'LEAF', subSentinelId: 'A' }, { type: 'LEAF', subSentinelId: 'B' }] },
      { type: 'LEAF', subSentinelId: 'C' },
    ],
  },
})}
\`\`\``, userId, conversationId);

  assert.ok(output.rule);
  assert.equal(output.subSentinels?.length, 3);
  const tree = parseConditionTree(output.rule?.condition_tree);
  assert.ok(tree, 'valid local references must bind to durable sub-sentinel IDs');
  const ids = output.subSentinels!.map((sub) => sub.id);
  assert.equal(JSON.stringify(tree).includes('"A"'), false);
  assert.equal(evaluateConditionTree(tree!, new Map([[ids[0], false], [ids[1], true], [ids[2], true]])), true);

  const unknownReference = extractSynthesizedRule(`\`\`\`json
${JSON.stringify({
  title: 'Invalid condition deployment',
  natural_language_intent: 'Alert',
  combinator: 'SINGLE',
  trigger_mode: 'PERSISTENT',
  audio_tone: 'chime',
  sub_sentinels: [watcher('A', 'AAPL')],
  condition_tree: { type: 'LEAF', subSentinelId: 'missing' },
})}
\`\`\``, userId, conversationId);
  assert.equal(unknownReference.rule, undefined, 'unknown condition keys must fail closed');

  const ambiguousFlatRule = extractSynthesizedRule(`\`\`\`json
${JSON.stringify({
  title: 'Ambiguous multi-watcher deployment',
  natural_language_intent: 'Alert',
  trigger_mode: 'PERSISTENT',
  audio_tone: 'chime',
  sub_sentinels: [watcher('A', 'AAPL'), watcher('B', 'MSFT')],
})}
\`\`\``, userId, conversationId);
  assert.equal(ambiguousFlatRule.rule, undefined, 'multi-watcher proposals must not silently default to SINGLE');

  const incompleteWatcher = extractSynthesizedRule(`\`\`\`json
${JSON.stringify({
  title: 'Incomplete watcher deployment',
  natural_language_intent: 'Alert',
  combinator: 'SINGLE',
  sub_sentinels: [{ condition_key: 'A' }],
})}
\`\`\``, userId, conversationId);
  assert.equal(incompleteWatcher.rule, undefined, 'incomplete watcher fields must fail closed instead of defaulting to MARKET/GREATER_THAN');

  const singleLeafCombinator = extractSynthesizedRule(`\`\`\`json
${JSON.stringify({
  title: 'Single leaf deployment',
  natural_language_intent: 'Alert if BTC is above 75000',
  combinator: 'LEAF',
  trigger_mode: 'PERSISTENT',
  audio_tone: 'chime',
  sub_sentinels: [watcher('A', 'BTC')],
  condition_tree: { type: 'LEAF', subSentinelId: 'A' },
})}
\`\`\``, userId, conversationId);
  assert.equal(singleLeafCombinator.rule?.combinator, 'SINGLE', 'a single LEAF tree must normalize to SINGLE');

  const verifiedContract = buildVerifiedContractSynthesis({
    toolName: 'crypto_research',
    contract: {
      assetSymbol: 'BTC',
      currency: 'USD',
      venue: 'COINBASE',
      targetType: 'PRICE',
      targetValue: 75000,
      operator: 'GREATER_THAN',
    },
  }, userId, conversationId, 'Notify me when Bitcoin exceeds 75,000 USD');
  assert.ok(verifiedContract.rule, 'a validated crypto contract must produce a lifecycle proposal');
  assert.equal(verifiedContract.subSentinels?.[0]?.target_source, 'BTC');
  assert.equal(verifiedContract.subSentinels?.[0]?.operator, 'GREATER_THAN');

  const verifiedAfterChoice = buildVerifiedContractSynthesis({
    toolName: 'crypto_research',
    contract: {
      assetSymbol: 'BTC',
      currency: 'USD',
      venue: 'COINBASE',
      targetType: 'PRICE',
      targetValue: 75000,
      operator: 'GREATER_THAN',
      query: 'Launch live reconnaissance',
    },
  }, userId, conversationId, 'Launch live reconnaissance');
  assert.equal(
    verifiedAfterChoice.rule?.natural_language_intent,
    'BTC greater than 75000 USD',
    'workflow choice labels must never become the persisted task intent',
  );

  const unverifiedWebTarget = extractSynthesizedRule(`\`\`\`json
${JSON.stringify({
  title: 'Web observer target binding',
  natural_language_intent: 'Alert when the verified page changes',
  category: 'WEB_INTEL',
  combinator: 'SINGLE',
  trigger_mode: 'PERSISTENT',
  audio_tone: 'chime',
  sub_sentinels: [{
    condition_key: 'A',
    sentinel_type: 'WEB_OBSERVER',
    target_source: 'https://verified.example/page',
    operator: 'SEMANTIC_MATCH',
    // The raw model object tries to smuggle a second URL into the threshold.
    threshold: { url: 'https://unverified.example/secret', selector: 'h1' },
    ttl_seconds: 60,
  }],
})}
\`\`\``, userId, conversationId);
  assert.ok(unverifiedWebTarget.rule);
  const canonicalWebThreshold = JSON.parse(unverifiedWebTarget.subSentinels?.[0]?.threshold || '{}');
  assert.equal(canonicalWebThreshold.url, undefined, 'unsupported alternate web URL must be stripped at persistence');
  assert.equal(unverifiedWebTarget.subSentinels?.[0]?.target_source, 'https://verified.example/page');
  console.log('PASS synthesized condition trees bind local keys to durable IDs and reject invalid combinations');
}

run();
