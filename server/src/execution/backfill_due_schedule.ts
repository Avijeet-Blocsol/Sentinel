/**
 * One-time migration for active DynamoDB sub-sentinels after provisioning the
 * idx_due_schedule GSI. Normal scheduler ticks never scan this table.
 *
 * Run after the index is ACTIVE:
 *   npm run build && npm run backfill:due-schedule
 */

import 'dotenv/config';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Rule, SubSentinel } from '@sentinel/shared';
import { getInitialDueSchedule } from '../scheduling/due_schedule.js';
import { dynamoRuleRepository, getDynamoClient, TABLES } from '../db/dynamodb/index.js';

async function main(): Promise<void> {
  if ((process.env.DATABASE_PROVIDER || '').toLowerCase() !== 'dynamodb') {
    throw new Error('backfill:due-schedule only applies when DATABASE_PROVIDER=dynamodb');
  }

  const client = getDynamoClient();
  const now = Date.now();
  const ruleCache = new Map<string, Rule | null>();
  let startKey: Record<string, unknown> | undefined;
  let scheduled = 0;
  let unscheduled = 0;

  do {
    const page = await client.send(new ScanCommand({
      TableName: TABLES.SUB_SENTINELS,
      ExclusiveStartKey: startKey,
      Limit: 100,
    }));
    const sentinels = (page.Items || []) as SubSentinel[];

    for (let offset = 0; offset < sentinels.length; offset += 20) {
      const writes = sentinels.slice(offset, offset + 20).map(async (sentinel) => {
        let rule = ruleCache.get(sentinel.rule_id);
        if (rule === undefined) {
          rule = await dynamoRuleRepository.getById(sentinel.rule_id);
          ruleCache.set(sentinel.rule_id, rule);
        }
        const isRunnable = rule?.status === 'ACTIVE' && (!rule.expires_at || rule.expires_at > now);
        if (!isRunnable) {
          unscheduled += 1;
          return client.send(new UpdateCommand({
            TableName: TABLES.SUB_SENTINELS,
            Key: { id: sentinel.id },
            UpdateExpression: 'REMOVE schedule_shard, next_evaluation_at, lease_expires_at',
          }));
        }

        const schedule = getInitialDueSchedule(sentinel, now);
        scheduled += 1;
        return client.send(new UpdateCommand({
          TableName: TABLES.SUB_SENTINELS,
          Key: { id: sentinel.id },
          UpdateExpression: 'SET schedule_shard = :shard, next_evaluation_at = :next REMOVE lease_expires_at',
          ExpressionAttributeValues: {
            ':shard': schedule.schedule_shard,
            ':next': schedule.next_evaluation_at,
          },
        }));
      });
      await Promise.all(writes);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  console.log(`Due-schedule backfill complete: ${scheduled} scheduled, ${unscheduled} inactive/expired unscheduled.`);
}

main().catch((error) => {
  console.error('Due-schedule backfill failed:', error);
  process.exitCode = 1;
});
