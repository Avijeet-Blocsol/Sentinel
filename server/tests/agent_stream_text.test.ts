import assert from 'node:assert/strict';
import { extractAgentText, parseAgentToolOutput } from '../src/api/realtime/ws_stream_handler.js';

assert.equal(
  extractAgentText({
    type: 'modelStreamUpdateEvent',
    event: { delta: { type: 'textDelta', text: 'draft text' } },
  }),
  'draft text',
);

assert.equal(
  extractAgentText({
    type: 'modelMessageEvent',
    message: { content: [{ type: 'textBlock', text: 'assembled draft' }] },
  }),
  'assembled draft',
);

assert.equal(
  extractAgentText({ type: 'modelStreamUpdateEvent', delta: { type: 'textDelta', text: 'legacy' } }),
  'legacy',
);

assert.deepEqual(
  parseAgentToolOutput({
    result: { content: [{ json: { passed: true, baselineValue: '$81,000' } }] },
  }),
  { passed: true, baselineValue: '$81,000' },
);

assert.deepEqual(
  parseAgentToolOutput({
    result: { content: [{ text: '{"passed":true,"baselineValue":"$81,000"}' }] },
  }),
  { passed: true, baselineValue: '$81,000' },
);

assert.deepEqual(
  parseAgentToolOutput({
    result: { structuredOutput: { passed: true, baselineValue: '$81,000' } },
  }),
  { passed: true, baselineValue: '$81,000' },
);

console.log('PASS Strands SDK stream text adapter');
