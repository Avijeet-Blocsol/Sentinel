import assert from 'node:assert/strict';
import { consumeWsTicket, issueWsTicket, verifyWsTicket } from '../src/middlewares/ws_ticket.js';
import { parseConditionTree, WsChatMessageSchema } from '@sentinel/shared';

function run() {
  const issued = issueWsTicket('regression-user');
  const verified = verifyWsTicket(issued.ticket);
  assert.equal(verified?.userId, 'regression-user');
  assert.equal(consumeWsTicket(issued.ticket)?.userId, 'regression-user');
  assert.equal(consumeWsTicket(issued.ticket), null, 'a WebSocket ticket must not be reusable');

  let deepTree: any = { type: 'LEAF', subSentinelId: 'A' };
  for (let index = 0; index < 40; index++) deepTree = { type: 'NOT', child: deepTree };
  assert.equal(parseConditionTree(deepTree), null, 'deep condition trees must be rejected before recursive parsing');

  const wideTree = {
    type: 'AND',
    children: Array.from({ length: 51 }, () => ({ type: 'LEAF', subSentinelId: 'A' })),
  };
  assert.equal(parseConditionTree(wideTree), null, 'wide condition trees must be bounded');
  assert.equal(
    WsChatMessageSchema.safeParse({ type: 'CHAT_MESSAGE', payload: { content: ' '.repeat(16_001) } }).success,
    false,
    'oversized or blank chat payloads must be rejected',
  );
  console.log('PASS ticket replay, condition-tree bounds, and WebSocket payload bounds');
}

run();
