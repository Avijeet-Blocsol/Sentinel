/**
 * Builds the one authoritative EventBridge Scheduler configuration.
 *
 * Both deployment-time registration and the operational `scheduler:ensure`
 * command use this module. Keeping the options here prevents a maintenance
 * command from accidentally overwriting the production DLQ or FIFO settings.
 */

import { SchedulerClient } from '@aws-sdk/client-scheduler';
import {
  SentinelEventBridgeScheduler,
  type EventBridgeSchedulerOptions,
} from './eventbridge_scheduler.js';

export type SchedulerEnvironment = Record<string, string | undefined>;

function integerInRange(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/**
 * Parse and validate the scheduler's non-secret topology. This function is
 * deliberately deterministic so it can be tested without AWS credentials.
 */
export function getConfiguredSchedulerOptions(
  env: SchedulerEnvironment = process.env,
): EventBridgeSchedulerOptions {
  const targetArn = env.SENTINEL_SCHEDULER_TARGET_ARN;
  const roleArn = env.SENTINEL_SCHEDULER_ROLE_ARN;
  if (!targetArn || !roleArn) {
    throw new Error('SENTINEL_SCHEDULER_TARGET_ARN and SENTINEL_SCHEDULER_ROLE_ARN are required');
  }
  if ((env.SENTINEL_SCHEDULER_TARGET_TYPE || 'sqs').toLowerCase() !== 'sqs' || !targetArn.startsWith('arn:aws:sqs:')) {
    throw new Error('Sentinel scheduler target must be an Amazon SQS ARN');
  }

  const deadLetterQueueArn = env.SENTINEL_SCHEDULER_DLQ_ARN;
  if (env.NODE_ENV === 'production' && !deadLetterQueueArn) {
    throw new Error('Production scheduler registration requires SENTINEL_SCHEDULER_DLQ_ARN');
  }
  if (deadLetterQueueArn && !deadLetterQueueArn.startsWith('arn:aws:sqs:')) {
    throw new Error('SENTINEL_SCHEDULER_DLQ_ARN must be an Amazon SQS ARN');
  }
  if (deadLetterQueueArn?.endsWith('.fifo')) {
    throw new Error('SENTINEL_SCHEDULER_DLQ_ARN must reference a standard SQS queue');
  }

  const sqsMessageGroupId = env.SENTINEL_SQS_MESSAGE_GROUP_ID;
  if (targetArn.endsWith('.fifo') && !sqsMessageGroupId) {
    throw new Error('A FIFO scheduler target requires SENTINEL_SQS_MESSAGE_GROUP_ID');
  }
  if (sqsMessageGroupId && sqsMessageGroupId.length > 128) {
    throw new Error('SENTINEL_SQS_MESSAGE_GROUP_ID cannot exceed 128 characters');
  }

  return {
    targetArn,
    roleArn,
    scheduleName: env.SENTINEL_SCHEDULER_NAME,
    scheduleExpression: env.SENTINEL_SCHEDULER_EXPRESSION || 'rate(1 minute)',
    input: { eventType: 'TICK', source: 'eventbridge-scheduler' },
    deadLetterQueueArn,
    maxRetryAttempts: integerInRange(
      env.SENTINEL_SCHEDULER_MAX_RETRY_ATTEMPTS,
      3,
      'SENTINEL_SCHEDULER_MAX_RETRY_ATTEMPTS',
      0,
      185,
    ),
    maxEventAgeSeconds: integerInRange(
      env.SENTINEL_SCHEDULER_MAX_EVENT_AGE_SECONDS,
      3600,
      'SENTINEL_SCHEDULER_MAX_EVENT_AGE_SECONDS',
      60,
      86400,
    ),
    sqsMessageGroupId,
  };
}

/** Ensure the configured EventBridge Scheduler target exists or is updated. */
export async function ensureConfiguredScheduler(
  env: SchedulerEnvironment = process.env,
  client?: SchedulerClient,
): Promise<void> {
  const scheduler = new SentinelEventBridgeScheduler(
    getConfiguredSchedulerOptions(env),
    client,
  );
  await scheduler.ensure();
}
