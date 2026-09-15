import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DeleteMessageCommand, ReceiveMessageCommand, ChangeMessageVisibilityCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { CreateScheduleCommand, DeleteScheduleCommand, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import { executionRepository } from '../src/db/index.js';
import { SentinelSqsWorker } from '../src/execution/sqs_worker.js';
import { SentinelEventBridgeScheduler } from '../src/execution/eventbridge_scheduler.js';
import { runSentinelExecution } from '../src/execution/runner.js';
import {
  classifyUserInput,
  generateLockedScopeResponse,
  isQueryConfirmationText,
} from '../src/agent/state_machine.js';

class FakeSqsClient {
  public calls: unknown[] = [];
  async send(command: any): Promise<any> {
    this.calls.push(command);
    if (command instanceof ReceiveMessageCommand) return { Messages: [] };
    return {};
  }
}

class FakeSchedulerClient {
  public calls: unknown[] = [];
  private updateAttempted = false;
  async send(command: any): Promise<any> {
    this.calls.push(command);
    if (command instanceof UpdateScheduleCommand && !this.updateAttempted) {
      this.updateAttempted = true;
      const error: any = new Error('missing schedule');
      error.name = 'ResourceNotFoundException';
      throw error;
    }
    return {};
  }
}

async function run() {
  console.log('--- Execution plane: durable idempotency lease ---');
  const eventId = `test-${randomUUID()}`;
  const first = await executionRepository.claim({
    id: eventId,
    event_type: 'TICK',
    rule_id: null,
    lease_owner: 'test-worker-1',
    lease_expires_at: Date.now() + 60_000,
    now: Date.now(),
  });
  assert.equal(first.claimed, true);
  await executionRepository.complete(eventId, 'test-worker-1', JSON.stringify({ ok: true }));
  const duplicate = await executionRepository.claim({
    id: eventId,
    event_type: 'TICK',
    rule_id: null,
    lease_owner: 'test-worker-2',
    lease_expires_at: Date.now() + 60_000,
    now: Date.now(),
  });
  assert.equal(duplicate.claimed, false);
  console.log('  PASS durable event idempotency prevents duplicate execution');

  console.log('--- Execution plane: SQS acknowledgement/retry semantics ---');
  const client = new FakeSqsClient();
  const worker = new SentinelSqsWorker({
    queueUrl: 'https://sqs.local/test',
    client: client as any,
    runEvent: async () => ({ eventId: 'e1', eventType: 'TICK', status: 'SUCCEEDED' }),
  });
  const result = await worker.processMessage({
    MessageId: 'm1',
    ReceiptHandle: 'r1',
    Body: JSON.stringify({ eventId: 'e1', eventType: 'TICK', requestedAt: Date.now(), source: 'test' }),
    Attributes: { ApproximateReceiveCount: '1' },
  });
  assert.equal(result, 'DELETED');
  assert.ok(client.calls.some((c: any) => c instanceof DeleteMessageCommand));
  console.log('  PASS successful SQS execution is acknowledged only after completion');

  const retryClient = new FakeSqsClient();
  const retryWorker = new SentinelSqsWorker({
    queueUrl: 'https://sqs.local/test',
    client: retryClient as any,
    runEvent: async () => { throw new Error('transient provider failure'); },
  });
  const retryResult = await retryWorker.processMessage({
    MessageId: 'm2',
    ReceiptHandle: 'r2',
    Body: JSON.stringify({ eventId: 'e2', eventType: 'TICK', requestedAt: Date.now(), source: 'test' }),
    Attributes: { ApproximateReceiveCount: '1' },
  });
  assert.equal(retryResult, 'RETRY');
  assert.ok(retryClient.calls.some((c: any) => c instanceof ChangeMessageVisibilityCommand));
  assert.equal(retryClient.calls.some((c: any) => c instanceof DeleteMessageCommand), false);
  console.log('  PASS transient SQS failures remain visible for retry');

  const poisonClient = new FakeSqsClient();
  const poisonWorker = new SentinelSqsWorker({
    queueUrl: 'https://sqs.local/test',
    deadLetterQueueUrl: 'https://sqs.local/sentinel-execution-dlq',
    maxReceiveCount: 2,
    client: poisonClient as any,
    runEvent: async () => { throw new Error('permanent provider failure'); },
  });
  const poisonResult = await poisonWorker.processMessage({
    MessageId: 'm-poison',
    ReceiptHandle: 'r-poison',
    Body: JSON.stringify({ eventId: 'e-poison', eventType: 'TICK', requestedAt: Date.now(), source: 'test' }),
    Attributes: { ApproximateReceiveCount: '2' },
  });
  assert.equal(poisonResult, 'DELETED');
  assert.ok(poisonClient.calls.some((c: any) => c instanceof SendMessageCommand));
  assert.ok(poisonClient.calls.some((c: any) => c instanceof DeleteMessageCommand));
  console.log('  PASS poison SQS events transfer to the configured DLQ before acknowledgement');

  const malformedClient = new FakeSqsClient();
  const malformedWorker = new SentinelSqsWorker({
    queueUrl: 'https://sqs.local/test',
    deadLetterQueueUrl: 'https://sqs.local/sentinel-execution-dlq',
    client: malformedClient as any,
  });
  const malformedResult = await malformedWorker.processMessage({
    MessageId: 'm-malformed',
    ReceiptHandle: 'r-malformed',
    Body: '{this-is-not-json}',
    Attributes: { ApproximateReceiveCount: '1' },
  });
  assert.equal(malformedResult, 'DELETED');
  assert.ok(malformedClient.calls.some((c: any) => c instanceof SendMessageCommand));
  assert.ok(malformedClient.calls.some((c: any) => c instanceof DeleteMessageCommand));
  console.log('  PASS malformed SQS payloads are preserved in the DLQ rather than silently dropped');

  let normalizedEvent: any;
  const normalizedWorker = new SentinelSqsWorker({
    queueUrl: 'https://sqs.local/test',
    client: new FakeSqsClient() as any,
    runEvent: async (event) => {
      normalizedEvent = event;
      return { eventId: 'sqs:m3', eventType: 'TICK', status: 'SUCCEEDED' };
    },
  });
  await normalizedWorker.processMessage({
    MessageId: 'm3',
    ReceiptHandle: 'r3',
    Body: JSON.stringify({ eventType: 'TICK', source: 'eventbridge-scheduler' }),
    Attributes: { ApproximateReceiveCount: '1' },
  });
  assert.equal(normalizedEvent.eventId, 'sqs:m3');
  assert.equal(normalizedEvent.requestedAt > 0, true);
  console.log('  PASS EventBridge static inputs receive stable SQS delivery ids');

  let tickInvocations = 0;
  const runnerResult = await runSentinelExecution({
    eventId: `queue-runner-${randomUUID()}`,
    eventType: 'TICK',
    requestedAt: Date.now(),
    source: 'sqs',
  }, 'queue-runner-test', {
    tick: async () => {
      tickInvocations += 1;
      return { evaluatedSubSentinels: 3, triggeredRules: 1, failures: 0 };
    },
  } as any);
  assert.equal(runnerResult.status, 'SUCCEEDED');
  assert.equal(runnerResult.evaluatedSubSentinels, 3);
  assert.equal(tickInvocations, 1);
  console.log('  PASS queue delivery invokes the durable evaluator runner directly, without an HTTP hop');

  console.log('--- EventBridge Scheduler registration semantics ---');
  const schedulerClient = new FakeSchedulerClient();
  const scheduler = new SentinelEventBridgeScheduler({
    scheduleName: 'sentinel-test-schedule',
    targetArn: 'arn:aws:sqs:us-east-1:123456789012:sentinel',
    roleArn: 'arn:aws:iam::123456789012:role/sentinel-scheduler',
    input: { eventType: 'TICK', source: 'eventbridge-scheduler' },
  }, schedulerClient as any);
  await scheduler.ensure();
  await scheduler.remove();
  assert.ok(schedulerClient.calls.some((c: any) => c instanceof UpdateScheduleCommand));
  assert.ok(schedulerClient.calls.some((c: any) => c instanceof CreateScheduleCommand));
  assert.ok(schedulerClient.calls.some((c: any) => c instanceof DeleteScheduleCommand));
  console.log('  PASS scheduler update/create fallback and removal are wired to AWS SDK commands');

  console.log('--- Conversation gate invariants ---');
  assert.equal(isQueryConfirmationText('Confirm & Deploy'), true);
  assert.equal(isQueryConfirmationText('tell me a joke'), false);
  assert.equal(classifyUserInput('tell me a joke', { phase: 'SCOUTING' }), 'OFF_TOPIC_BS');
  assert.equal(classifyUserInput('what is the current status?', { phase: 'DEPLOYED' }), 'TASK_STATUS_INQUIRY');
  assert.match(generateLockedScopeResponse('SCOUTING'), /do not modify active tasks mid-flight/i);
  console.log('  PASS confirmation, status, and off-topic classifications are deterministic');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
