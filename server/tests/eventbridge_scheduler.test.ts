import assert from 'node:assert/strict';
import {
  CreateScheduleCommand,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { SentinelEventBridgeScheduler } from '../src/execution/eventbridge_scheduler.js';
import {
  ensureConfiguredScheduler,
  getConfiguredSchedulerOptions,
} from '../src/execution/scheduler_registration.js';

class FakeSchedulerClient {
  public commands: unknown[] = [];

  constructor(private readonly failures: Array<string | null> = []) {}

  async send(command: unknown): Promise<void> {
    this.commands.push(command);
    const failure = this.failures[this.commands.length - 1];
    if (failure) {
      const error = new Error(failure);
      error.name = failure;
      throw error;
    }
  }
}

async function run() {
  const queueArn = 'arn:aws:sqs:us-east-1:123456789012:sentinel-execution.fifo';
  const dlqArn = 'arn:aws:sqs:us-east-1:123456789012:sentinel-scheduler-dlq';
  const client = new FakeSchedulerClient();
  const scheduler = new SentinelEventBridgeScheduler({
    targetArn: queueArn,
    roleArn: 'arn:aws:iam::123456789012:role/sentinel-scheduler',
    deadLetterQueueArn: dlqArn,
    maxRetryAttempts: 3,
    maxEventAgeSeconds: 3600,
    sqsMessageGroupId: 'global-ticks',
  }, client as any);

  await scheduler.ensure();
  assert.equal(client.commands.length, 1);
  assert.ok(client.commands[0] instanceof UpdateScheduleCommand);
  const updateInput = (client.commands[0] as UpdateScheduleCommand).input;
  assert.deepEqual(updateInput.Target?.DeadLetterConfig, { Arn: dlqArn });
  assert.deepEqual(updateInput.Target?.SqsParameters, { MessageGroupId: 'global-ticks' });
  assert.deepEqual(updateInput.Target?.RetryPolicy, {
    MaximumRetryAttempts: 3,
    MaximumEventAgeInSeconds: 3600,
  });

  const missingClient = new FakeSchedulerClient(['ResourceNotFoundException']);
  const missingScheduler = new SentinelEventBridgeScheduler({
    targetArn: 'arn:aws:sqs:us-east-1:123456789012:sentinel-execution',
    roleArn: 'arn:aws:iam::123456789012:role/sentinel-scheduler',
  }, missingClient as any);
  await missingScheduler.ensure();
  assert.equal(missingClient.commands.length, 2);
  assert.ok(missingClient.commands[0] instanceof UpdateScheduleCommand);
  assert.ok(missingClient.commands[1] instanceof CreateScheduleCommand);

  const concurrentClient = new FakeSchedulerClient([
    'ResourceNotFoundException',
    'ConflictException',
    null,
  ]);
  const concurrentScheduler = new SentinelEventBridgeScheduler({
    targetArn: 'arn:aws:sqs:us-east-1:123456789012:sentinel-execution',
    roleArn: 'arn:aws:iam::123456789012:role/sentinel-scheduler',
  }, concurrentClient as any);
  await concurrentScheduler.ensure();
  assert.equal(concurrentClient.commands.length, 3);
  assert.ok(concurrentClient.commands[2] instanceof UpdateScheduleCommand);

  // The operational scheduler command and deployment workflow must share one
  // complete configuration, including delivery DLQ and retry policy.
  const productionEnv = {
    NODE_ENV: 'production',
    SENTINEL_SCHEDULER_TARGET_ARN: queueArn,
    SENTINEL_SCHEDULER_TARGET_TYPE: 'sqs',
    SENTINEL_SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/sentinel-scheduler',
    SENTINEL_SCHEDULER_DLQ_ARN: dlqArn,
    SENTINEL_SQS_MESSAGE_GROUP_ID: 'global-ticks',
    SENTINEL_SCHEDULER_MAX_RETRY_ATTEMPTS: '7',
    SENTINEL_SCHEDULER_MAX_EVENT_AGE_SECONDS: '600',
  };
  const configured = getConfiguredSchedulerOptions(productionEnv);
  assert.equal(configured.deadLetterQueueArn, dlqArn);
  assert.equal(configured.maxRetryAttempts, 7);
  const configuredClient = new FakeSchedulerClient();
  await ensureConfiguredScheduler(productionEnv, configuredClient as any);
  const configuredInput = (configuredClient.commands[0] as UpdateScheduleCommand).input;
  assert.deepEqual(configuredInput.Target?.DeadLetterConfig, { Arn: dlqArn });
  assert.deepEqual(configuredInput.Target?.RetryPolicy, {
    MaximumRetryAttempts: 7,
    MaximumEventAgeInSeconds: 600,
  });
  assert.throws(
    () => getConfiguredSchedulerOptions({ ...productionEnv, SENTINEL_SCHEDULER_DLQ_ARN: undefined }),
    /DLQ/,
  );

  console.log('PASS EventBridge Scheduler uses bounded retry, DLQ, FIFO parameters, concurrent create recovery, and one shared production configuration');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
