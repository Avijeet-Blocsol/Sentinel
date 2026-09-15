import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { SentinelExecutionEventSchema } from './contracts.js';
import { runSentinelExecution } from './runner.js';
import type { SentinelExecutionResult } from './contracts.js';

export interface SqsWorkerOptions {
  queueUrl: string;
  client?: SQSClient;
  visibilityTimeoutSeconds?: number;
  maxReceiveCount?: number;
  deadLetterQueueUrl?: string;
  pollWaitSeconds?: number;
  concurrency?: number;
  runEvent?: (event: unknown, owner?: string) => Promise<SentinelExecutionResult>;
}

export class SentinelSqsWorker {
  private readonly client: SQSClient;
  private readonly visibilityTimeoutSeconds: number;
  private readonly maxReceiveCount: number;
  private readonly pollWaitSeconds: number;
  private readonly concurrency: number;

  constructor(private readonly options: SqsWorkerOptions) {
    this.client = options.client || new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
    this.visibilityTimeoutSeconds = options.visibilityTimeoutSeconds || 300;
    this.maxReceiveCount = options.maxReceiveCount || 8;
    this.pollWaitSeconds = options.pollWaitSeconds ?? 20;
    this.concurrency = Math.min(Math.max(options.concurrency ?? 5, 1), 10);
  }

  /** Return true only after an explicit dead-letter write and source ack. */
  private async transferToDeadLetter(message: Message, receiveCount: number, error: unknown): Promise<boolean> {
    if (!this.options.deadLetterQueueUrl || !message.ReceiptHandle) return false;
    try {
      await this.client.send(new SendMessageCommand({
        QueueUrl: this.options.deadLetterQueueUrl,
        MessageBody: JSON.stringify({
          source: 'sentinel-sqs-worker',
          failedAt: Date.now(),
          sourceMessageId: message.MessageId ?? null,
          receiveCount,
          error: error instanceof Error ? error.message : String(error),
          originalBody: message.Body,
        }),
      }));
      await this.client.send(new DeleteMessageCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }));
      return true;
    } catch (deadLetterError) {
      console.error('[SentinelSqsWorker] DLQ transfer failed; retaining message for retry:', deadLetterError);
      return false;
    }
  }

  async processMessage(message: Message): Promise<'DELETED' | 'RETRY' | 'IGNORED'> {
    if (!message.Body || !message.ReceiptHandle) return 'IGNORED';
    let raw: unknown;
    try {
      const parsed = JSON.parse(message.Body) as Record<string, unknown>;
      // EventBridge Scheduler does not provide a per-delivery id in a static
      // target input. SQS MessageId is stable across retries, so use it as the
      // execution id and retain durable idempotency in the execution ledger.
      raw = {
        ...parsed,
        eventId: parsed.eventId || `sqs:${message.MessageId || randomUUID()}`,
        source: parsed.source || 'sqs',
        requestedAt: parsed.requestedAt || Date.now(),
      };
      SentinelExecutionEventSchema.parse(raw);
    } catch (error) {
      // Do not silently discard malformed events. Transfer them to the worker
      // DLQ when configured; otherwise retain them so the queue redrive policy
      // can preserve the payload after its configured retry threshold.
      return await this.transferToDeadLetter(
        message,
        Number(message.Attributes?.ApproximateReceiveCount || '1'),
        error,
      ) ? 'DELETED' : 'RETRY';
    }

    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount || '1');
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      await this.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: this.visibilityTimeoutSeconds,
      }));

      // Long-running Strands/browser evaluations can outlive the initial SQS
      // lease. Renew at half-life so a second worker cannot execute the same
      // event while the first worker is still running.
      const heartbeatMs = Math.max(10_000, Math.floor(this.visibilityTimeoutSeconds * 500));
      heartbeat = setInterval(() => {
        void this.client.send(new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: this.visibilityTimeoutSeconds,
        })).catch((error) => {
          console.error('[SentinelSqsWorker] Visibility heartbeat failed:', error);
        });
      }, heartbeatMs);
      heartbeat.unref?.();

      await (this.options.runEvent || runSentinelExecution)(raw, `sqs-${randomUUID()}`);
      await this.client.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
      return 'DELETED';
    } catch (error) {
      if (receiveCount >= this.maxReceiveCount) {
        // A queue redrive policy remains recommended, but the explicit
        // transfer prevents a misconfigured source queue from retrying one
        // poison event forever. Delete only after the DLQ write succeeds.
        if (await this.transferToDeadLetter(message, receiveCount, error)) return 'DELETED';
        console.error(`[SentinelSqsWorker] Message reached max receive count (${receiveCount}) without successful DLQ transfer`);
      }
      return 'RETRY';
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async runOnce(): Promise<number> {
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.options.queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: this.pollWaitSeconds,
      VisibilityTimeout: this.visibilityTimeoutSeconds,
      MessageAttributeNames: ['All'],
      AttributeNames: ['ApproximateReceiveCount' as any],
    }));
    let processed = 0;
    const messages = response.Messages || [];
    for (let i = 0; i < messages.length; i += this.concurrency) {
      await Promise.all(messages.slice(i, i + this.concurrency).map((message) => this.processMessage(message)));
      processed += Math.min(this.concurrency, messages.length - i);
    }
    return processed;
  }

  async run(signal?: AbortSignal): Promise<void> {
    let retryDelayMs = 1_000;
    while (!signal?.aborted) {
      try {
        await this.runOnce();
        retryDelayMs = 1_000;
      } catch (error) {
        console.error('[SentinelSqsWorker] Polling failure; retrying:', error);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryDelayMs);
          timer.unref?.();
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    }
  }
}
