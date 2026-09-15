import assert from 'node:assert/strict';
import type { SubSentinel } from '@sentinel/shared';
import {
  DUE_SCHEDULE_SHARD_COUNT,
  getDueScheduleShard,
  getInitialDueSchedule,
  getNextEvaluationAt,
} from '../src/scheduling/due_schedule.js';
import { buildDueScheduleQueries } from '../src/db/dynamodb/index.js';

const now = 1_700_000_000_000;
const sub: SubSentinel = {
  id: 'due-schedule-test-sub',
  rule_id: 'due-schedule-test-rule',
  sentinel_type: 'STOCK',
  target_source: 'AAPL',
  operator: 'GREATER_THAN',
  threshold: '{"targetValue":200}',
  ttl_seconds: 300,
  health_status: 'HEALTHY',
  error_count: 0,
  is_satisfied: 0,
};

function run() {
  const shard = getDueScheduleShard(sub.id);
  assert.equal(shard, getDueScheduleShard(sub.id), 'shard assignment must be stable');
  const shardNumber = Number(shard.replace('due-', ''));
  assert.equal(Number.isInteger(shardNumber), true);
  assert.equal(shardNumber >= 0 && shardNumber < DUE_SCHEDULE_SHARD_COUNT, true);
  assert.deepEqual(getInitialDueSchedule(sub, now), {
    schedule_shard: shard,
    next_evaluation_at: now,
  });
  assert.equal(
    getInitialDueSchedule({ ...sub, health_status: 'ERROR', error_count: 2, last_evaluated_at: now - 3_600_000 }, now).next_evaluation_at,
    now + 240_000,
    'legacy ERROR records must back off from the current scheduler time',
  );
  assert.equal(getNextEvaluationAt(sub, 'HEALTHY', 0, now), now + 300_000);
  assert.equal(getNextEvaluationAt(sub, 'ERROR', 2, now), now + 240_000);

  const queries = buildDueScheduleQueries(now, 100);
  assert.equal(queries.length, DUE_SCHEDULE_SHARD_COUNT);
  assert.ok(queries.every((query) => query.IndexName === 'idx_due_schedule'));
  assert.ok(queries.every((query) => query.KeyConditionExpression === 'schedule_shard = :shard AND next_evaluation_at <= :now'));
  assert.equal(queries.reduce((total, query) => total + Number(query.Limit), 0) >= 100, true);
  console.log('PASS due scheduler uses a bounded, sharded GSI query plan and preserves TTL/backoff cadence');
}

run();
