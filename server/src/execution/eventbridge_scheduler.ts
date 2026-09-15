import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';

export interface EventBridgeSchedulerOptions {
  scheduleName?: string;
  targetArn: string;
  roleArn: string;
  scheduleExpression?: string;
  input?: Record<string, unknown>;
  deadLetterQueueArn?: string;
  maxRetryAttempts?: number;
  maxEventAgeSeconds?: number;
  sqsMessageGroupId?: string;
}

/** Creates/updates one durable cadence trigger for the SQS execution queue or Lambda target. */
export class SentinelEventBridgeScheduler {
  private readonly client: SchedulerClient;

  constructor(private readonly options: EventBridgeSchedulerOptions, client?: SchedulerClient) {
    this.client = client || new SchedulerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }

  private request() {
    return {
      Name: this.options.scheduleName || 'sentinel-global-tick',
      ScheduleExpression: this.options.scheduleExpression || 'rate(1 minute)',
      FlexibleTimeWindow: { Mode: 'OFF' as const },
      Target: {
        Arn: this.options.targetArn,
        RoleArn: this.options.roleArn,
        Input: JSON.stringify(this.options.input || {
          eventType: 'TICK',
          source: 'eventbridge-scheduler',
        }),
        RetryPolicy: {
          MaximumRetryAttempts: this.options.maxRetryAttempts ?? 3,
          MaximumEventAgeInSeconds: this.options.maxEventAgeSeconds ?? 3600,
        },
        ...(this.options.deadLetterQueueArn
          ? { DeadLetterConfig: { Arn: this.options.deadLetterQueueArn } }
          : {}),
        ...(this.options.sqsMessageGroupId
          ? { SqsParameters: { MessageGroupId: this.options.sqsMessageGroupId } }
          : {}),
      },
      State: 'ENABLED' as const,
    };
  }

  async ensure(): Promise<void> {
    const request = this.request();
    try {
      await this.client.send(new UpdateScheduleCommand(request));
    } catch (error: any) {
      if (error?.name !== 'ResourceNotFoundException') throw error;
      try {
        await this.client.send(new CreateScheduleCommand(request));
      } catch (createError: any) {
        // Multiple API instances may deploy their first rule concurrently:
        // both observe a missing schedule, while only one create can win.
        // The loser updates the schedule that has just been created.
        if (!['ConflictException', 'ResourceAlreadyExistsException'].includes(createError?.name)) {
          throw createError;
        }
        await this.client.send(new UpdateScheduleCommand(request));
      }
    }
  }

  async remove(): Promise<void> {
    await this.client.send(new DeleteScheduleCommand({
      Name: this.options.scheduleName || 'sentinel-global-tick',
    })).catch((error: any) => {
      if (error?.name !== 'ResourceNotFoundException') throw error;
    });
  }
}
