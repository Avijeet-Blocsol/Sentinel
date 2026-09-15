import crypto from 'node:crypto';
import type {
  TelegramResearchTask,
  TelegramResearchOutcome,
  TelegramHarnessConfig,
  TelegramTelemetryEvent,
} from './types.js';
import { ProviderError } from './types.js';
import { runTelegramPipeline } from './telegram_graph.js';

export interface ActiveTelegramSession {
  taskId: string;
  executionId: string;
  task: TelegramResearchTask;
  startTime: number;
  abortController: AbortController;
  telemetryHistory: TelegramTelemetryEvent[];
  isTimedOut: boolean;
  isCancelled: boolean;
}

/**
 * ==========================================================
 * TELEGRAM CHANNEL META-HARNESS — LIFECYCLE ORCHESTRATOR
 * ==========================================================
 * Manages the execution lifecycle, timeout management, cancellation,
 * concurrency isolation, and bounded telemetry history.
 */
export class TelegramChannelHarness {
  private readonly config: TelegramHarnessConfig;
  private readonly activeSessions = new Map<string, ActiveTelegramSession>();
  private readonly completedHistory = new Map<string, TelegramTelemetryEvent[]>();
  private readonly MAX_COMPLETED_HISTORY = 50;

  constructor(config: TelegramHarnessConfig = {}) {
    this.config = {
      timeoutMs: config.timeoutMs ?? 12000,
      maxCandidates: config.maxCandidates ?? 5,
      onTelemetry: config.onTelemetry,
      semanticEvaluator: config.semanticEvaluator,
    };
  }

  /**
   * Generates a composite session key that isolates concurrent runs with the same taskId.
   */
  private sessionKey(taskId: string, executionId: string): string {
    return `${taskId}:${executionId}`;
  }

  /**
   * Retains a bounded history of completed session telemetry.
   */
  private recordCompletedHistory(key: string, history: TelegramTelemetryEvent[]): void {
    if (this.completedHistory.size >= this.MAX_COMPLETED_HISTORY) {
      const firstKey = this.completedHistory.keys().next().value;
      if (firstKey) this.completedHistory.delete(firstKey);
    }
    this.completedHistory.set(key, [...history]);
  }

  /**
   * Streams the Telegram research pipeline, yielding real-time telemetry events.
   */
  async *stream(
    task: TelegramResearchTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): AsyncGenerator<TelegramTelemetryEvent, TelegramResearchOutcome, unknown> {
    const taskId = task.id;
    const executionId = options.executionId || crypto.randomUUID();
    const key = this.sessionKey(taskId, executionId);

    const abortController = new AbortController();

    const session: ActiveTelegramSession = {
      taskId,
      executionId,
      task,
      startTime: Date.now(),
      abortController,
      telemetryHistory: [],
      isTimedOut: false,
      isCancelled: false,
    };
    this.activeSessions.set(key, session);

    if (options.signal) {
      if (options.signal.aborted) {
        session.isCancelled = true;
        abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener(
          'abort',
          () => {
            session.isCancelled = true;
            abortController.abort(options.signal?.reason);
          },
          { once: true }
        );
      }
    }

    const timeoutHandle = setTimeout(() => {
      session.isTimedOut = true;
      abortController.abort(
        new Error(`Telegram channel research timed out after ${this.config.timeoutMs}ms`)
      );
    }, this.config.timeoutMs);

    try {
      const pipelineGen = runTelegramPipeline(
        task,
        this.config,
        abortController.signal,
        executionId
      );

      let next = await pipelineGen.next();
      while (!next.done) {
        const event = next.value as TelegramTelemetryEvent;
        session.telemetryHistory.push(event);

        try {
          this.config.onTelemetry?.(event);
        } catch {}

        yield event;
        next = await pipelineGen.next();
      }

      return next.value as TelegramResearchOutcome;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout =
        session.isTimedOut ||
        errMsg.toLowerCase().includes('timed out') ||
        (err instanceof Error && err.name === 'TimeoutError');
      const isCancelled =
        session.isCancelled ||
        (options.signal?.aborted && !isTimeout) ||
        errMsg.toLowerCase().includes('aborted') ||
        errMsg.toLowerCase().includes('cancelled');

      const errorEvent: TelegramTelemetryEvent = {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: isTimeout
          ? `Telegram channel research timed out: ${errMsg}`
          : isCancelled
          ? `Telegram channel research was cancelled: ${errMsg}`
          : `Telegram channel discovery error: ${errMsg}`,
        data: { error: errMsg, isTimeout, isCancelled },
        timestamp: Date.now(),
      };

      session.telemetryHistory.push(errorEvent);
      try {
        this.config.onTelemetry?.(errorEvent);
      } catch {}
      yield errorEvent;

      if (isTimeout) {
        const timeoutOutcome: TelegramResearchOutcome = {
          status: 'TIMED_OUT',
          taskId,
          executionId,
          query: task.query,
          reason: errMsg,
          elapsedMs: Date.now() - session.startTime,
        };
        return timeoutOutcome;
      }

      if (isCancelled) {
        const cancelledOutcome: TelegramResearchOutcome = {
          status: 'CANCELLED',
          taskId,
          executionId,
          query: task.query,
          reason: errMsg || 'Task was cancelled by user or caller signal',
        };
        return cancelledOutcome;
      }

      if (err instanceof ProviderError) {
        const errorOutcome: TelegramResearchOutcome = {
          status: 'ERROR',
          taskId,
          executionId,
          query: task.query,
          error: err.message,
          provider: err.provider,
          details: { statusCode: err.statusCode, cause: String(err.cause) },
        };
        return errorOutcome;
      }

      const genericErrorOutcome: TelegramResearchOutcome = {
        status: 'ERROR',
        taskId,
        executionId,
        query: task.query,
        error: errMsg,
      };
      return genericErrorOutcome;
    } finally {
      clearTimeout(timeoutHandle);
      this.recordCompletedHistory(key, session.telemetryHistory);
      this.recordCompletedHistory(taskId, session.telemetryHistory);
      this.activeSessions.delete(key);
    }
  }

  /**
   * Runs the research task to completion and returns the final outcome.
   */
  async research(
    task: TelegramResearchTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): Promise<TelegramResearchOutcome> {
    const stream = this.stream(task, options);
    let res = await stream.next();
    while (!res.done) {
      res = await stream.next();
    }
    return res.value as TelegramResearchOutcome;
  }

  /**
   * Cancels all active in-flight executions for a given task ID.
   */
  cancel(taskId: string, reason = 'Cancelled by user'): boolean {
    let found = false;
    for (const [key, session] of this.activeSessions.entries()) {
      if (session.taskId === taskId) {
        session.isCancelled = true;
        session.abortController.abort(new Error(reason));
        found = true;
      }
    }
    return found;
  }

  /**
   * Retrieves telemetry history for an active or recently completed session.
   */
  getTelemetryHistory(taskId: string, executionId?: string): TelegramTelemetryEvent[] {
    if (executionId) {
      const key = this.sessionKey(taskId, executionId);
      const active = this.activeSessions.get(key);
      if (active) return [...active.telemetryHistory];
      const completed = this.completedHistory.get(key);
      if (completed) return [...completed];
    }

    // Lookup by taskId
    for (const [key, session] of this.activeSessions.entries()) {
      if (session.taskId === taskId) {
        return [...session.telemetryHistory];
      }
    }

    const completed = this.completedHistory.get(taskId);
    return completed ? [...completed] : [];
  }
}
