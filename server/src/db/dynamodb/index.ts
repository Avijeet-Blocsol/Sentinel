/**
 * Strands Sentinel - Amazon DynamoDB Database Adapter
 * Implements persistent operational storage using AWS DynamoDB DocumentClient.
 */

import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  User,
  UserDevice,
  AgentConversation,
  ChatMessage,
  Rule,
  SubSentinel,
  SeenEvent,
  TelemetryPoint,
  AlertEvent,
  InterruptAction,
  EnrichedInterruptAction,
} from '@sentinel/shared';
import type {
  DatabaseAdapter,
  EnrichedAlertEvent,
  IUserRepository,
  IUserDeviceRepository,
  IConversationRepository,
  IChatMessageRepository,
  IRuleRepository,
  ISubSentinelRepository,
  ISeenEventRepository,
  ITelemetryRepository,
  IAlertEventRepository,
  IInterruptActionRepository,
  IExecutionRepository,
  DeploymentCommitInput,
  DeploymentProposalInput,
  ExecutionLeaseRecord,
  TriggerCommitInput,
} from '../types.js';
import {
  DUE_SCHEDULE_SHARD_COUNT,
  getDueScheduleShard,
  getInitialDueSchedule,
} from '../../scheduling/due_schedule.js';

// Table name resolution with environment variable overrides
const prefix = process.env.DYNAMODB_TABLE_PREFIX || 'sentinel_';
export const TABLES = {
  USERS: process.env.DYNAMODB_TABLE_USERS || `${prefix}users`,
  DEVICES: process.env.DYNAMODB_TABLE_DEVICES || `${prefix}user_devices`,
  CONVERSATIONS: process.env.DYNAMODB_TABLE_CONVERSATIONS || `${prefix}agent_conversations`,
  MESSAGES: process.env.DYNAMODB_TABLE_MESSAGES || `${prefix}chat_messages`,
  RULES: process.env.DYNAMODB_TABLE_RULES || `${prefix}rules`,
  SUB_SENTINELS: process.env.DYNAMODB_TABLE_SUB_SENTINELS || `${prefix}sub_sentinels`,
  SEEN_EVENTS: process.env.DYNAMODB_TABLE_SEEN_EVENTS || `${prefix}seen_events`,
  TELEMETRY: process.env.DYNAMODB_TABLE_TELEMETRY || `${prefix}telemetry_points`,
  ALERTS: process.env.DYNAMODB_TABLE_ALERTS || `${prefix}alert_events`,
  INTERRUPTS: process.env.DYNAMODB_TABLE_INTERRUPTS || `${prefix}interrupt_actions`,
  EXECUTIONS: process.env.DYNAMODB_TABLE_EXECUTIONS || `${prefix}execution_leases`,
};

const DUE_SCHEDULE_INDEX_NAME = process.env.DYNAMODB_DUE_SCHEDULE_INDEX_NAME || 'idx_due_schedule';

/** Builds the bounded, sharded queries used by the scheduler's hot path. */
export function buildDueScheduleQueries(now: number, limit: number): Array<Record<string, unknown>> {
  const perShardLimit = Math.max(1, Math.ceil(Math.max(limit, 1) / DUE_SCHEDULE_SHARD_COUNT));
  return Array.from({ length: DUE_SCHEDULE_SHARD_COUNT }, (_, shard) => ({
    TableName: TABLES.SUB_SENTINELS,
    IndexName: DUE_SCHEDULE_INDEX_NAME,
    KeyConditionExpression: 'schedule_shard = :shard AND next_evaluation_at <= :now',
    ExpressionAttributeValues: { ':shard': `due-${shard}`, ':now': now },
    ScanIndexForward: true,
    Limit: perShardLimit,
  }));
}

let rawClient: DynamoDBClient | null = null;
let docClient: DynamoDBDocumentClient | null = null;

export function getDynamoClient(): DynamoDBDocumentClient {
  if (docClient) return docClient;

  rawClient = new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.DYNAMODB_ENDPOINT || undefined, // Useful for local DynamoDB (e.g. LocalStack)
  });

  docClient = DynamoDBDocumentClient.from(rawClient, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertEmptyValues: true,
    },
  });

  return docClient;
}

function isConditionalCheckFailure(error: unknown): boolean {
  const typed = error as {
    name?: string;
    CancellationReasons?: Array<{ Code?: string }>;
  } | undefined;
  return typed?.name === 'ConditionalCheckFailedException' ||
    (typed?.name === 'TransactionCanceledException' &&
      typed.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed') === true);
}

async function queryAll<T>(client: DynamoDBDocumentClient, params: Record<string, any>, maxItems = 1000): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, any> | undefined;
  do {
    const result = await client.send(new QueryCommand({
      ...params,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      ...(params.Limit ? { Limit: Math.min(params.Limit, maxItems - items.length) } : {}),
    } as any));
    items.push(...((result.Items as T[] | undefined) || []));
    startKey = result.LastEvaluatedKey;
  } while (startKey && items.length < maxItems);
  return items.slice(0, maxItems);
}

async function scanAll<T>(client: DynamoDBDocumentClient, params: Record<string, any>, maxItems = 5000): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, any> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      ...params,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    } as any));
    items.push(...((result.Items as T[] | undefined) || []));
    startKey = result.LastEvaluatedKey;
    if (startKey && items.length >= maxItems) {
      throw new Error(`DynamoDB scan exceeded the safety limit of ${maxItems} items for ${String(params.TableName)}`);
    }
  } while (startKey && items.length < maxItems);
  return items.slice(0, maxItems);
}

// 1. User Repository
export const dynamoUserRepository: IUserRepository = {
  async create(user: User): Promise<void> {
    const client = getDynamoClient();
    await client.send(
      new PutCommand({
        TableName: TABLES.USERS,
        Item: user,
      })
    );
  },

  async getById(id: string): Promise<User | null> {
    const client = getDynamoClient();
    const result = await client.send(
      new GetCommand({
        TableName: TABLES.USERS,
        Key: { id },
      })
    );
    return (result.Item as User) || null;
  },

  async getByGoogleSub(googleSub: string): Promise<User | null> {
    const client = getDynamoClient();
    const result = await client.send(
      new QueryCommand({
        TableName: TABLES.USERS,
        IndexName: 'idx_google_sub',
        KeyConditionExpression: 'google_sub = :sub',
        ExpressionAttributeValues: { ':sub': googleSub },
        Limit: 1,
      })
    );
    return (result.Items?.[0] as User) || null;
  },

  async getByAppleSub(appleSub: string): Promise<User | null> {
    const client = getDynamoClient();
    const result = await client.send(
      new QueryCommand({
        TableName: TABLES.USERS,
        IndexName: 'idx_apple_sub',
        KeyConditionExpression: 'apple_sub = :sub',
        ExpressionAttributeValues: { ':sub': appleSub },
        Limit: 1,
      })
    );
    return (result.Items?.[0] as User) || null;
  },

  async getByGithubSub(githubSub: string): Promise<User | null> {
    const client = getDynamoClient();
    const result = await client.send(
      new QueryCommand({
        TableName: TABLES.USERS,
        IndexName: 'idx_github_sub',
        KeyConditionExpression: 'github_sub = :sub',
        ExpressionAttributeValues: { ':sub': githubSub },
        Limit: 1,
      })
    );
    return (result.Items?.[0] as User) || null;
  },

  async getByEmail(email: string): Promise<User | null> {
    const client = getDynamoClient();
    const result = await client.send(
      new QueryCommand({
        TableName: TABLES.USERS,
        IndexName: 'idx_email',
        KeyConditionExpression: 'email = :email',
        ExpressionAttributeValues: { ':email': email },
        Limit: 1,
      })
    );
    return (result.Items?.[0] as User) || null;
  },
};

// 2. User Device Repository
export const dynamoUserDeviceRepository: IUserDeviceRepository = {
  async registerDevice(device: UserDevice): Promise<void> {
    const client = getDynamoClient();
    await client.send(
      new PutCommand({
        TableName: TABLES.DEVICES,
        Item: device,
      })
    );
  },

  async getByUserId(userId: string): Promise<UserDevice[]> {
    const client = getDynamoClient();
    return queryAll<UserDevice>(client, {
      TableName: TABLES.DEVICES,
      IndexName: 'idx_user_id',
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    });
  },

  async removeById(id: string): Promise<void> {
    await getDynamoClient().send(new DeleteCommand({
      TableName: TABLES.DEVICES,
      Key: { id },
    }));
  },
};

// 3. Conversation Repository
export const dynamoConversationRepository: IConversationRepository = {
  async create(convo: AgentConversation): Promise<void> {
    const client = getDynamoClient();
    await client.send(
      new PutCommand({
        TableName: TABLES.CONVERSATIONS,
        Item: convo,
      })
    );
  },

  async getById(id: string): Promise<AgentConversation | null> {
    const client = getDynamoClient();
    const result = await client.send(
      new GetCommand({
        TableName: TABLES.CONVERSATIONS,
        Key: { id },
      })
    );
    return (result.Item as AgentConversation) || null;
  },

  async getByUserId(userId: string, limit = 50): Promise<AgentConversation[]> {
    const client = getDynamoClient();
    return queryAll<AgentConversation>(client, {
      TableName: TABLES.CONVERSATIONS,
      IndexName: 'idx_user_id',
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ScanIndexForward: false,
    }, Math.min(Math.max(limit, 1), 100));
  },

  async updateStatus(id: string, status: AgentConversation['status']): Promise<void> {
    const client = getDynamoClient();
    await client.send(
      new UpdateCommand({
        TableName: TABLES.CONVERSATIONS,
        Key: { id },
        UpdateExpression: 'SET #st = :status',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':status': status },
      })
    );
  },

  async updatePhase(id: string, phase: AgentConversation['phase']): Promise<void> {
    const client = getDynamoClient();
    await client.send(
      new UpdateCommand({
        TableName: TABLES.CONVERSATIONS,
        Key: { id },
        UpdateExpression: 'SET phase = :phase',
        ExpressionAttributeValues: { ':phase': phase },
      })
    );
  },

  async search(
    userId: string,
    query: string,
    limit = 50
  ): Promise<Array<AgentConversation & { matched_snippet?: string | null }>> {
    const cleanQuery = query.trim().toLowerCase();
    if (!cleanQuery) {
      return this.getByUserId(userId, limit);
    }

    // `limit` is the number of matches requested, not the number of records
    // that may be searched. Inspect the full bounded conversation page so a
    // query can still find an older task when the newest tasks do not match.
    const conversations = await this.getByUserId(userId, 100);
    const client = getDynamoClient();

    // Match on title first
    const matched: Array<AgentConversation & { matched_snippet?: string | null }> = [];

    for (const c of conversations) {
      if (c.title.toLowerCase().includes(cleanQuery)) {
        matched.push({ ...c, matched_snippet: null });
        continue;
      }

      // Check messages for this conversation
      const items = await queryAll<ChatMessage>(client, {
        TableName: TABLES.MESSAGES,
        IndexName: 'idx_conversation_id',
        KeyConditionExpression: 'conversation_id = :cid',
        ExpressionAttributeValues: { ':cid': c.id },
        Limit: 10,
      }, 10);
      const found = items.find((m) => m.content.toLowerCase().includes(cleanQuery));
      if (found) {
        const lower = found.content.toLowerCase();
        const idx = lower.indexOf(cleanQuery);
        const start = Math.max(0, idx - 30);
        const end = Math.min(found.content.length, idx + cleanQuery.length + 50);
        const snippet =
          (start > 0 ? '...' : '') +
          found.content.slice(start, end).trim() +
          (end < found.content.length ? '...' : '');
        matched.push({ ...c, matched_snippet: snippet });
      }

      if (matched.length >= limit) break;
    }

    return matched;
  },
};

// 4. Chat Message Repository
export const dynamoChatMessageRepository: IChatMessageRepository = {
  async create(msg: ChatMessage): Promise<void> {
    const client = getDynamoClient();
    await client.send(
      new PutCommand({
        TableName: TABLES.MESSAGES,
        Item: msg,
      })
    );
  },

  async getByConversationId(conversationId: string, limit = 500): Promise<ChatMessage[]> {
    const client = getDynamoClient();
    return queryAll<ChatMessage>(client, {
      TableName: TABLES.MESSAGES,
      IndexName: 'idx_conversation_id',
      KeyConditionExpression: 'conversation_id = :cid',
      ExpressionAttributeValues: { ':cid': conversationId },
      ScanIndexForward: true,
    }, Math.min(Math.max(limit, 1), 1000));
  },
};

// 5. Rule Repository
export const dynamoRuleRepository: IRuleRepository = {
  async create(rule: Rule): Promise<void> {
    const client = getDynamoClient();
    await client.send(
      new PutCommand({
        TableName: TABLES.RULES,
        Item: rule,
      })
    );
  },

  async getById(id: string): Promise<Rule | null> {
    const client = getDynamoClient();
    const result = await client.send(
      new GetCommand({
        TableName: TABLES.RULES,
        Key: { id },
      })
    );
    return (result.Item as Rule) || null;
  },

  async getByUserId(userId: string, limit = 100): Promise<Rule[]> {
    const client = getDynamoClient();
    return queryAll<Rule>(client, {
      TableName: TABLES.RULES,
      IndexName: 'idx_user_id',
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ScanIndexForward: false,
    }, Math.min(Math.max(limit, 1), 100));
  },

  async getByConversationId(conversationId: string): Promise<Rule[]> {
    const client = getDynamoClient();
    return queryAll<Rule>(client, {
      TableName: TABLES.RULES,
      IndexName: 'idx_conversation_id',
      KeyConditionExpression: 'conversation_id = :cid',
      ExpressionAttributeValues: { ':cid': conversationId },
      ScanIndexForward: false,
    });
  },

  async getActiveRules(): Promise<Rule[]> {
    const client = getDynamoClient();
    return queryAll<Rule>(client, {
      TableName: TABLES.RULES,
      IndexName: 'idx_status',
      KeyConditionExpression: '#st = :status',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':status': 'ACTIVE' },
    }, 5000);
  },

  async updateStatus(id: string, status: Rule['status']): Promise<void> {
    const client = getDynamoClient();
    const now = Date.now();
    await client.send(
      new UpdateCommand({
        TableName: TABLES.RULES,
        Key: { id },
        UpdateExpression: 'SET #st = :status, updated_at = :now',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':status': status,
          ':now': now,
        },
      })
    );

    // Active children need an indexed due time; inactive children must stay
    // out of the scheduler's hot path instead of being filtered after a read.
    const children = await queryAll<SubSentinel>(client, {
      TableName: TABLES.SUB_SENTINELS,
      IndexName: 'idx_rule_id',
      KeyConditionExpression: 'rule_id = :rid',
      ExpressionAttributeValues: { ':rid': id },
    });
    for (let offset = 0; offset < children.length; offset += 20) {
      await Promise.all(children.slice(offset, offset + 20).map((sub) => client.send(
        status === 'ACTIVE'
          ? new UpdateCommand({
              TableName: TABLES.SUB_SENTINELS,
              Key: { id: sub.id },
              UpdateExpression: 'SET schedule_shard = :shard, next_evaluation_at = :next REMOVE lease_expires_at',
              ExpressionAttributeValues: { ':shard': getDueScheduleShard(sub.id), ':next': now },
            })
          : new UpdateCommand({
              TableName: TABLES.SUB_SENTINELS,
              Key: { id: sub.id },
              UpdateExpression: 'REMOVE schedule_shard, next_evaluation_at, lease_expires_at',
            })
      )));
    }
  },

  async claimCooldown(ruleId: string, now: number, cooldownMs: number): Promise<boolean> {
    const client = getDynamoClient();
    const allowedBefore = now - cooldownMs;
    try {
      await client.send(
        new UpdateCommand({
          TableName: TABLES.RULES,
          Key: { id: ruleId },
          UpdateExpression: 'SET last_triggered_at = :now, updated_at = :now',
          ConditionExpression:
            'attribute_not_exists(last_triggered_at) OR last_triggered_at <= :allowedBefore',
          ExpressionAttributeValues: {
            ':now': now,
            ':allowedBefore': allowedBefore,
          },
        })
      );
      return true;
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw err;
    }
  },

  async releaseCooldown(ruleId: string, previousTriggeredAt?: number | null): Promise<void> {
    const client = getDynamoClient();
    const hasPrev = previousTriggeredAt !== null && previousTriggeredAt !== undefined;
    const updateExpr = hasPrev
      ? 'SET last_triggered_at = :val, updated_at = :now'
      : 'REMOVE last_triggered_at SET updated_at = :now';
    const attrValues: Record<string, unknown> = { ':now': Date.now() };
    if (hasPrev) {
      attrValues[':val'] = previousTriggeredAt;
    }
    await client.send(
      new UpdateCommand({
        TableName: TABLES.RULES,
        Key: { id: ruleId },
        UpdateExpression: updateExpr,
        ExpressionAttributeValues: attrValues,
      })
    );
  },

  async commitTrigger(input: TriggerCommitInput): Promise<boolean> {
    const client = getDynamoClient();
    const transactItems: any[] = [
      {
        Update: {
          TableName: TABLES.RULES,
          Key: { id: input.ruleId },
          UpdateExpression: 'SET #st = :status, updated_at = :now',
          ConditionExpression: '#st = :active AND last_triggered_at = :triggeredAt',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: {
            ':status': input.oneShot ? 'TRIGGERED' : 'ACTIVE',
            ':active': 'ACTIVE',
            ':triggeredAt': input.triggeredAt,
            ':now': Date.now(),
          },
        },
      },
      {
        Put: {
          TableName: TABLES.ALERTS,
          Item: input.alert,
          ConditionExpression: 'attribute_not_exists(id)',
        },
      },
    ];
    if (input.interrupt) {
      transactItems.push({
        Put: {
          TableName: TABLES.INTERRUPTS,
          Item: input.interrupt,
          ConditionExpression: 'attribute_not_exists(id)',
        },
      });
    }

    try {
      await client.send(new TransactWriteCommand({
        ClientRequestToken: input.alert.id.slice(0, 36),
        TransactItems: transactItems,
      }));
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  },

  async delete(id: string): Promise<void> {
    const client = getDynamoClient();
    const subSentinels = await queryAll<SubSentinel>(client, {
      TableName: TABLES.SUB_SENTINELS,
      IndexName: 'idx_rule_id',
      KeyConditionExpression: 'rule_id = :rid',
      ExpressionAttributeValues: { ':rid': id },
    });

    const scanMatching = (tableName: string, filterExpression: string, values: Record<string, unknown>) => scanAll<{ id: string }>(client, {
        TableName: tableName,
        FilterExpression: filterExpression,
        ExpressionAttributeValues: values,
      });
    const batchDelete = async (tableName: string, rows: Array<{ id: string }>) => {
      for (let offset = 0; offset < rows.length; offset += 25) {
        let pending = rows.slice(offset, offset + 25).map((row) => ({ DeleteRequest: { Key: { id: row.id } } }));
        for (let attempt = 0; pending.length > 0 && attempt < 6; attempt++) {
          const response = await client.send(new BatchWriteCommand({
            RequestItems: { [tableName]: pending },
          }));
          pending = (response.UnprocessedItems?.[tableName] as typeof pending | undefined) || [];
          if (pending.length > 0) {
            await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
          }
        }
        if (pending.length > 0) throw new Error(`DynamoDB batch deletion did not drain for ${tableName}`);
      }
    };

    // Complete all reads before deleting anything so a scan failure cannot
    // silently leave a partially-pruned rule behind.
    const [alerts, interrupts, telemetry, ...seenBySubSentinel] = await Promise.all([
      scanMatching(TABLES.ALERTS, 'rule_id = :rid', { ':rid': id }),
      scanMatching(TABLES.INTERRUPTS, 'rule_id = :rid', { ':rid': id }),
      scanMatching(TABLES.TELEMETRY, 'rule_id = :rid', { ':rid': id }),
      ...subSentinels.map((sub) => scanMatching(TABLES.SEEN_EVENTS, 'sub_sentinel_id = :sid', { ':sid': sub.id })),
    ]);

    await batchDelete(TABLES.ALERTS, alerts);
    await batchDelete(TABLES.INTERRUPTS, interrupts);
    await batchDelete(TABLES.TELEMETRY, telemetry);
    for (let index = 0; index < subSentinels.length; index++) {
      await batchDelete(TABLES.SEEN_EVENTS, seenBySubSentinel[index] || []);
      await batchDelete(TABLES.SUB_SENTINELS, [{ id: subSentinels[index].id }]);
    }
    await client.send(new DeleteCommand({ TableName: TABLES.RULES, Key: { id } }));
  },
};

// 6. Sub-Sentinel Repository
export const dynamoSubSentinelRepository: ISubSentinelRepository = {
  async create(sentinel: SubSentinel): Promise<void> {
    const client = getDynamoClient();
    const rule = await dynamoRuleRepository.getById(sentinel.rule_id);
    const item = rule?.status === 'ACTIVE'
      ? { ...sentinel, ...getInitialDueSchedule(sentinel) }
      : sentinel;
    await client.send(
      new PutCommand({
        TableName: TABLES.SUB_SENTINELS,
        Item: item,
      })
    );
  },

  async getByRuleId(ruleId: string): Promise<SubSentinel[]> {
    const client = getDynamoClient();
    return queryAll<SubSentinel>(client, {
      TableName: TABLES.SUB_SENTINELS,
      IndexName: 'idx_rule_id',
      KeyConditionExpression: 'rule_id = :rid',
      ExpressionAttributeValues: { ':rid': ruleId },
    });
  },

  async getDue(now = Date.now(), limit = 100): Promise<SubSentinel[]> {
    const client = getDynamoClient();
    const ruleCache = new Map<string, Rule | null>();
    const queried = await Promise.all(buildDueScheduleQueries(now, limit).map(
      (query) => client.send(new QueryCommand(query as any))
    ));
    const candidates = queried
      .flatMap((result) => (result.Items as SubSentinel[] | undefined) || [])
      .sort((a, b) => (a.next_evaluation_at ?? 0) - (b.next_evaluation_at ?? 0));
    const dueItems: SubSentinel[] = [];

    for (const sentinel of candidates) {
      let rule = ruleCache.get(sentinel.rule_id);
      if (rule === undefined) {
        rule = await dynamoRuleRepository.getById(sentinel.rule_id);
        ruleCache.set(sentinel.rule_id, rule);
      }
      if (!rule || rule.status !== 'ACTIVE' || (rule.expires_at && rule.expires_at <= now)) {
        // A failed/deleted deployment may leave an indexed item behind. Make
        // cleanup idempotent so the cost is paid once rather than per tick.
        await client.send(new UpdateCommand({
          TableName: TABLES.SUB_SENTINELS,
          Key: { id: sentinel.id },
          UpdateExpression: 'REMOVE schedule_shard, next_evaluation_at, lease_expires_at',
        }));
        continue;
      }
      dueItems.push(sentinel);
      if (dueItems.length >= limit) break;
    }
    return dueItems;
  },

  async claim(id: string, now = Date.now(), leaseDurationMs = 30000): Promise<boolean> {
    const client = getDynamoClient();
    try {
      const getRes = await client.send(
        new GetCommand({
          TableName: TABLES.SUB_SENTINELS,
          Key: { id },
        })
      );
      const sentinel = getRes.Item as (SubSentinel & { lease_expires_at?: number }) | undefined;
      if (!sentinel) return false;

      // Legacy records without a due schedule are not claimed until the
      // one-time backfill has made them visible in the GSI.
      if (sentinel.next_evaluation_at == null || sentinel.next_evaluation_at > now ||
          (sentinel.lease_expires_at && sentinel.lease_expires_at > now)) {
        return false;
      }
      const exprVals: Record<string, any> = {
        ':now': now,
        ':leaseUntil': now + leaseDurationMs,
      };

      await client.send(
        new UpdateCommand({
          TableName: TABLES.SUB_SENTINELS,
          Key: { id },
          UpdateExpression: 'SET last_evaluated_at = :now, next_evaluation_at = :leaseUntil, lease_expires_at = :leaseUntil',
          ConditionExpression: '(attribute_not_exists(next_evaluation_at) OR next_evaluation_at <= :now) AND (attribute_not_exists(lease_expires_at) OR lease_expires_at <= :now)',
          ExpressionAttributeValues: exprVals,
        })
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  },

  async updateSatisfaction(
    id: string,
    isSatisfied: boolean,
    statePayload?: string,
    error?: string | null,
    healthStatus: 'HEALTHY' | 'DEGRADED' | 'ERROR' = 'ERROR',
    nextEvaluationAt?: number,
  ): Promise<void> {
    const client = getDynamoClient();
    const now = Date.now();
    const satisfiedInt = isSatisfied ? 1 : 0;

    if (error) {
      await client.send(
        new UpdateCommand({
          TableName: TABLES.SUB_SENTINELS,
          Key: { id },
          UpdateExpression:
            'SET last_evaluated_at = :now, next_evaluation_at = :next, error_count = error_count + :one, health_status = :health, last_error = :errMsg, is_satisfied = :zero REMOVE lease_expires_at',
          ExpressionAttributeValues: {
            ':now': now,
            ':next': nextEvaluationAt ?? now,
            ':one': 1,
            ':health': healthStatus,
            ':errMsg': error,
            ':zero': 0,
          },
        })
      );
    } else {
      await client.send(
        new UpdateCommand({
          TableName: TABLES.SUB_SENTINELS,
          Key: { id },
          UpdateExpression:
            'SET last_evaluated_at = :now, next_evaluation_at = :next, is_satisfied = :sat, health_status = :ok, error_count = :zero, last_error = :null, state_payload = :sp REMOVE lease_expires_at',
          ExpressionAttributeValues: {
            ':now': now,
            ':next': nextEvaluationAt ?? now,
            ':sat': satisfiedInt,
            ':ok': 'HEALTHY',
            ':zero': 0,
            ':null': null,
            ':sp': statePayload ?? null,
          },
        })
      );
    }
  },
};

// 7. Seen Event Repository
export const dynamoSeenEventRepository: ISeenEventRepository = {
  async isEventSeen(subSentinelId: string, eventHash: string): Promise<boolean> {
    const client = getDynamoClient();
    const id = `${subSentinelId}#${eventHash}`;
    const result = await client.send(
      new GetCommand({
        TableName: TABLES.SEEN_EVENTS,
        Key: { id },
      })
    );
    return Boolean(result.Item);
  },

  async recordSeenEvent(
    id: string,
    subSentinelId: string,
    source: string,
    eventHash: string
  ): Promise<void> {
    const client = getDynamoClient();
    const compositeId = `${subSentinelId}#${eventHash}`;
    await client.send(
      new PutCommand({
        TableName: TABLES.SEEN_EVENTS,
        Item: {
          id: compositeId,
          sub_sentinel_id: subSentinelId,
          source,
          event_hash: eventHash,
          seen_at: Date.now(),
        },
        ConditionExpression: 'attribute_not_exists(id)',
      })
    ).catch((error) => {
      if (!isConditionalCheckFailure(error)) throw error;
    });
  },
};

// 8. Telemetry Repository
export const dynamoTelemetryRepository: ITelemetryRepository = {
  async log(point: TelemetryPoint): Promise<void> {
    const client = getDynamoClient();
    await client.send(
      new PutCommand({
        TableName: TABLES.TELEMETRY,
        Item: point,
      })
    );
  },

  async getByRuleId(ruleId: string, limit = 100): Promise<TelemetryPoint[]> {
    const client = getDynamoClient();
    const result = await client.send(
      new QueryCommand({
        TableName: TABLES.TELEMETRY,
        IndexName: 'idx_rule_id',
        KeyConditionExpression: 'rule_id = :rid',
        ExpressionAttributeValues: { ':rid': ruleId },
        ScanIndexForward: false,
        Limit: limit,
      })
    );
    return (result.Items as TelemetryPoint[]) || [];
  },
};

// 9. Alert Event Repository
export const dynamoAlertEventRepository: IAlertEventRepository = {
  async create(alert: AlertEvent): Promise<void> {
    const client = getDynamoClient();
    await client.send(
      new PutCommand({
        TableName: TABLES.ALERTS,
        Item: alert,
      })
    );
  },

  async getByUserId(userId: string, limit = 50, ruleId?: string): Promise<EnrichedAlertEvent[]> {
    const client = getDynamoClient();
    let items = await queryAll<AlertEvent>(client, {
      TableName: TABLES.ALERTS,
      IndexName: 'idx_user_id',
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ScanIndexForward: false,
    }, Math.min(Math.max(limit, 1), 100));
    if (ruleId) {
      items = items.filter((a) => a.rule_id === ruleId);
    }

    // Attach conversation_id from rule
    const enriched: EnrichedAlertEvent[] = [];
    for (const alert of items) {
      const rule = await dynamoRuleRepository.getById(alert.rule_id);
      enriched.push({
        ...alert,
        conversation_id: rule?.conversation_id ?? null,
        rule_title: rule?.title ?? null,
      });
    }

    return enriched;
  },

  async getById(id: string): Promise<EnrichedAlertEvent | null> {
    const client = getDynamoClient();
    const result = await client.send(
      new GetCommand({
        TableName: TABLES.ALERTS,
        Key: { id },
      })
    );

    if (!result.Item) return null;
    const alert = result.Item as AlertEvent;
    const rule = await dynamoRuleRepository.getById(alert.rule_id);

    return {
      ...alert,
      conversation_id: rule?.conversation_id ?? null,
      rule_title: rule?.title ?? null,
    };
  },
};

// 10. Interrupt Action Repository
export const dynamoInterruptActionRepository: IInterruptActionRepository = {
  async create(action: InterruptAction): Promise<void> {
    const client = getDynamoClient();
    await client.send(
      new PutCommand({
        TableName: TABLES.INTERRUPTS,
        Item: action,
      })
    );
  },

  async getPendingByUserId(userId: string): Promise<EnrichedInterruptAction[]> {
    const client = getDynamoClient();
    const items = await queryAll<InterruptAction>(client, {
      TableName: TABLES.INTERRUPTS,
      IndexName: 'idx_user_status',
      KeyConditionExpression: 'user_id = :uid AND #st = :status',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':uid': userId,
        ':status': 'PENDING',
      },
    });

    const now = Date.now();
    const activeItems = items.filter(
      (i) => !i.expires_at || i.expires_at > now
    );
    const enriched: EnrichedInterruptAction[] = [];
    for (const item of activeItems) {
      const rule = await dynamoRuleRepository.getById(item.rule_id);
      enriched.push({
        ...item,
        conversation_id: rule?.conversation_id ?? null,
        rule_title: rule?.title ?? null,
      });
    }

    return enriched;
  },

  async getPending(): Promise<InterruptAction[]> {
    const client = getDynamoClient();
    const pending = await scanAll<InterruptAction>(client, {
      TableName: TABLES.INTERRUPTS,
      FilterExpression: '#st = :status',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':status': 'PENDING' },
    });
    const now = Date.now();
    return pending.filter((item) => !item.expires_at || item.expires_at > now);
  },

  async expirePending(now = Date.now()): Promise<InterruptAction[]> {
    const client = getDynamoClient();
    const expired = await scanAll<InterruptAction>(client, {
      TableName: TABLES.INTERRUPTS,
      FilterExpression: '#st = :pending AND expires_at <= :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':pending': 'PENDING', ':now': now },
    });
    for (const action of expired) {
      try {
        await client.send(new UpdateCommand({
          TableName: TABLES.INTERRUPTS,
          Key: { id: action.id },
          UpdateExpression: 'SET #st = :expired, resolved_at = :now',
          ConditionExpression: '#st = :pending AND expires_at <= :now',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':expired': 'EXPIRED', ':pending': 'PENDING', ':now': now },
        }));
      } catch (error) {
        if (!isConditionalCheckFailure(error)) throw error;
      }
    }
    return expired;
  },

  async getById(id: string): Promise<EnrichedInterruptAction | null> {
    const client = getDynamoClient();
    const result = await client.send(
      new GetCommand({
        TableName: TABLES.INTERRUPTS,
        Key: { id },
      })
    );

    if (!result.Item) return null;
    const action = result.Item as InterruptAction;
    const rule = await dynamoRuleRepository.getById(action.rule_id);

    return {
      ...action,
      conversation_id: rule?.conversation_id ?? null,
      rule_title: rule?.title ?? null,
    };
  },

  async updateStatus(id: string, status: InterruptAction['status']): Promise<void> {
    const client = getDynamoClient();
    await client.send(
      new UpdateCommand({
        TableName: TABLES.INTERRUPTS,
        Key: { id },
        UpdateExpression: 'SET #st = :status, resolved_at = :now',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':status': status,
          ':now': Date.now(),
        },
      })
    );
  },

  async resolveIfPending(id: string, status: InterruptAction['status'], now = Date.now()): Promise<boolean> {
    const client = getDynamoClient();
    try {
      await client.send(new UpdateCommand({
        TableName: TABLES.INTERRUPTS,
        Key: { id },
        UpdateExpression: 'SET #st = :status, resolved_at = :now',
        ConditionExpression: '#st = :pending AND (attribute_not_exists(expires_at) OR expires_at > :now)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':status': status, ':pending': 'PENDING', ':now': now },
      }));
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  },
};

export const dynamoExecutionRepository: IExecutionRepository = {
  async claim(record: Omit<ExecutionLeaseRecord, 'status' | 'attempts' | 'created_at' | 'updated_at'> & { now: number }): Promise<{ claimed: boolean; attempts: number }> {
    const client = getDynamoClient();
    const existing = await client.send(new GetCommand({ TableName: TABLES.EXECUTIONS, Key: { id: record.id } }));
    const current = existing.Item as ExecutionLeaseRecord | undefined;
    if (current?.status === 'SUCCEEDED') return { claimed: false, attempts: current.attempts };
    if (current && current.lease_expires_at > record.now && current.lease_owner !== record.lease_owner) {
      return { claimed: false, attempts: current.attempts };
    }
    const attempts = (current?.attempts || 0) + 1;
    try {
      await client.send(new UpdateCommand({
        TableName: TABLES.EXECUTIONS,
        Key: { id: record.id },
        UpdateExpression: 'SET event_type = :eventType, rule_id = :ruleId, #st = :running, lease_owner = :owner, lease_expires_at = :leaseUntil, attempts = :attempts, created_at = if_not_exists(created_at, :now), updated_at = :now, last_error = :null',
        ConditionExpression: 'attribute_not_exists(id) OR lease_expires_at <= :now OR lease_owner = :owner',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':eventType': record.event_type,
          ':ruleId': record.rule_id ?? null,
          ':running': 'RUNNING',
          ':owner': record.lease_owner,
          ':leaseUntil': record.lease_expires_at,
          ':attempts': attempts,
          ':now': record.now,
          ':null': null,
        },
      }));
      return { claimed: true, attempts };
    } catch (error) {
      if (isConditionalCheckFailure(error)) return { claimed: false, attempts };
      throw error;
    }
  },

  async complete(id: string, owner: string, payload: string, now = Date.now()): Promise<void> {
    await getDynamoClient().send(new UpdateCommand({
      TableName: TABLES.EXECUTIONS,
      Key: { id },
      UpdateExpression: 'SET #st = :success, result_payload = :payload, lease_expires_at = :now, updated_at = :now',
      ConditionExpression: 'lease_owner = :owner',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':success': 'SUCCEEDED', ':payload': payload, ':owner': owner, ':now': now },
    }));
  },

  async fail(id: string, owner: string, error: string, retryable: boolean, now = Date.now()): Promise<void> {
    await getDynamoClient().send(new UpdateCommand({
      TableName: TABLES.EXECUTIONS,
      Key: { id },
      UpdateExpression: 'SET #st = :status, last_error = :error, lease_expires_at = :leaseUntil, updated_at = :now',
      ConditionExpression: 'lease_owner = :owner',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':status': retryable ? 'RUNNING' : 'FAILED',
        ':error': error,
        ':leaseUntil': retryable ? now : 0,
        ':owner': owner,
        ':now': now,
      },
    }));
  },
};

export const dynamoDeploymentRepository = {
  async stage(input: DeploymentProposalInput): Promise<boolean> {
    if (
      input.rule.conversation_id !== input.conversationId ||
      input.interrupt.rule_id !== input.rule.id ||
      input.interrupt.user_id !== input.rule.user_id ||
      input.interrupt.status !== 'PENDING'
    ) {
      return false;
    }
    const client = getDynamoClient();
    try {
      await client.send(new TransactWriteCommand({
        ClientRequestToken: input.interrupt.id,
        TransactItems: [
          {
            Put: {
              TableName: TABLES.RULES,
              Item: { ...input.rule, status: 'PAUSED', updated_at: input.now },
              ConditionExpression: 'attribute_not_exists(id)',
            },
          },
          {
            Put: {
              TableName: TABLES.INTERRUPTS,
              Item: { ...input.interrupt, status: 'PENDING', resolved_at: null },
              ConditionExpression: 'attribute_not_exists(id)',
            },
          },
          {
            Update: {
              TableName: TABLES.CONVERSATIONS,
              Key: { id: input.conversationId },
              UpdateExpression: 'SET phase = :phase',
              ConditionExpression: 'user_id = :userId',
              ExpressionAttributeValues: {
                ':phase': 'INTERRUPT_PENDING',
                ':userId': input.rule.user_id,
              },
            },
          },
        ],
      }));
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  },

  async approve(input: DeploymentCommitInput): Promise<boolean> {
    const client = getDynamoClient();
    if (input.subSentinels.length + input.baselineEvents.length + 3 > 90) {
      throw new Error('Deployment proposal exceeds DynamoDB transaction size; reduce baseline seeds or child sentinels');
    }

    const existing = await client.send(new GetCommand({
      TableName: TABLES.INTERRUPTS,
      Key: { id: input.interruptId },
    }));
    const action = existing.Item as InterruptAction | undefined;
    if (!action || action.status !== 'PENDING') return false;
    if (action.expires_at && action.expires_at <= input.now) {
      await dynamoInterruptActionRepository.expirePending(input.now);
      return false;
    }

    const transactItems: any[] = [
      {
        Update: {
          TableName: TABLES.RULES,
          Key: { id: input.rule.id },
          UpdateExpression: 'SET #st = :active, updated_at = :now',
          ConditionExpression: '#st = :paused AND user_id = :userId',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':paused': 'PAUSED', ':active': 'ACTIVE', ':userId': input.rule.user_id, ':now': input.now },
        },
      },
      ...input.subSentinels.map((sub) => ({
        Put: {
          TableName: TABLES.SUB_SENTINELS,
          Item: {
            ...sub,
            ...getInitialDueSchedule(sub, input.now),
            health_status: sub.health_status || 'HEALTHY',
            error_count: sub.error_count ?? 0,
            is_satisfied: sub.is_satisfied ?? 0,
          },
        },
      })),
      ...input.baselineEvents.map((event) => ({
        Put: {
          TableName: TABLES.SEEN_EVENTS,
          Item: { ...event, seen_at: input.now },
        },
      })),
      {
        Update: {
          TableName: TABLES.CONVERSATIONS,
          Key: { id: input.conversationId },
          UpdateExpression: 'SET #status = :synthesized, phase = :deployed',
          ConditionExpression: 'user_id = :userId',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':synthesized': 'SYNTHESIZED', ':deployed': 'DEPLOYED', ':userId': input.rule.user_id },
        },
      },
    ];

    transactItems.push({
      Update: {
        TableName: TABLES.INTERRUPTS,
        Key: { id: input.interruptId },
        UpdateExpression: 'SET #st = :approved, resolved_at = :now',
        ConditionExpression: '#st = :pending AND user_id = :userId AND (attribute_not_exists(expires_at) OR expires_at > :now)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':approved': 'APPROVED', ':pending': 'PENDING', ':userId': input.rule.user_id, ':now': input.now },
      },
    });

    try {
      await client.send(new TransactWriteCommand({
        // DynamoDB limits ClientRequestToken to 36 characters. The interrupt
        // UUID is already unique and stable for the duration of this commit.
        ClientRequestToken: input.interruptId.slice(0, 36),
        TransactItems: transactItems,
      }));
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  },

  async reject(input: Pick<DeploymentCommitInput, 'interruptId' | 'conversationId' | 'rule' | 'now'>): Promise<boolean> {
    const client = getDynamoClient();
    const existing = await client.send(new GetCommand({
      TableName: TABLES.INTERRUPTS,
      Key: { id: input.interruptId },
    }));
    const action = existing.Item as InterruptAction | undefined;
    if (!action || action.status !== 'PENDING') return false;
    if (action.expires_at && action.expires_at <= input.now) {
      await dynamoInterruptActionRepository.expirePending(input.now);
      return false;
    }

    const transactItems: any[] = [
      {
        Update: {
          TableName: TABLES.RULES,
          Key: { id: input.rule.id },
          UpdateExpression: 'SET #st = :dismissed, updated_at = :now',
          ConditionExpression: '#st = :paused AND user_id = :userId',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':paused': 'PAUSED', ':dismissed': 'DISMISSED', ':userId': input.rule.user_id, ':now': input.now },
        },
      },
      {
        Update: {
          TableName: TABLES.CONVERSATIONS,
          Key: { id: input.conversationId },
          UpdateExpression: 'SET phase = :discovery',
          ConditionExpression: 'user_id = :userId',
          ExpressionAttributeValues: { ':discovery': 'DISCOVERY', ':userId': input.rule.user_id },
        },
      },
    ];
    transactItems.push({
      Update: {
        TableName: TABLES.INTERRUPTS,
        Key: { id: input.interruptId },
        UpdateExpression: 'SET #st = :rejected, resolved_at = :now',
        ConditionExpression: '#st = :pending AND user_id = :userId AND (attribute_not_exists(expires_at) OR expires_at > :now)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':rejected': 'REJECTED', ':pending': 'PENDING', ':userId': input.rule.user_id, ':now': input.now },
      },
    });

    try {
      await client.send(new TransactWriteCommand({
        ClientRequestToken: input.interruptId.slice(0, 36),
        TransactItems: transactItems,
      }));
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  },
};

export function closeDynamo(): void {
  if (rawClient) {
    rawClient.destroy();
    rawClient = null;
    docClient = null;
  }
}

export const dynamoDbAdapter: DatabaseAdapter = {
  userRepository: dynamoUserRepository,
  userDeviceRepository: dynamoUserDeviceRepository,
  conversationRepository: dynamoConversationRepository,
  chatMessageRepository: dynamoChatMessageRepository,
  ruleRepository: dynamoRuleRepository,
  subSentinelRepository: dynamoSubSentinelRepository,
  seenEventRepository: dynamoSeenEventRepository,
  telemetryRepository: dynamoTelemetryRepository,
  alertEventRepository: dynamoAlertEventRepository,
  interruptActionRepository: dynamoInterruptActionRepository,
  deploymentRepository: dynamoDeploymentRepository,
  executionRepository: dynamoExecutionRepository,
  async healthCheck(): Promise<void> {
    const client = getDynamoClient();
    await client.send(new DescribeTableCommand({ TableName: TABLES.USERS }));
    const subSentinels = await client.send(new DescribeTableCommand({ TableName: TABLES.SUB_SENTINELS }));
    const dueIndexExists = subSentinels.Table?.GlobalSecondaryIndexes?.some(
      (index) => index.IndexName === DUE_SCHEDULE_INDEX_NAME,
    );
    if (!dueIndexExists) {
      throw new Error(
        `DynamoDB table ${TABLES.SUB_SENTINELS} is missing required due-schedule GSI ${DUE_SCHEDULE_INDEX_NAME}`,
      );
    }
  },
  close: closeDynamo,
};
