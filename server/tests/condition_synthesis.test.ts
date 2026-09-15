import assert from 'node:assert/strict';
import { evaluateConditionTree, parseConditionTree } from '@sentinel/shared';
import { extractSynthesizedRule } from '../src/services/deployment_workflow.js';

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
  console.log('PASS synthesized condition trees bind local keys to durable IDs and reject invalid combinations');
}

run();
