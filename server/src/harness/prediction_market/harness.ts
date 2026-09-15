import type {
  PredictionMarketTask,
  PredictionMarketOutcome,
  PredictionMarketHarnessConfig,
  ActivePredictionMarketSession,
  CompletedPredictionMarketSessionRecord,
} from './types.js';
import { type FinanceTelemetryEvent, ProviderError } from '../finance_common/index.js';
import { runPredictionMarketPipeline } from './prediction_market_graph.js';

export { ActivePredictionMarketSession, CompletedPredictionMarketSessionRecord };

export class PredictionMarketHarness {
  private readonly config: PredictionMarketHarnessConfig;
  private readonly activeSessions = new Map<string, ActivePredictionMarketSession>();
  private readonly taskIdToExecutions = new Map<string, Set<string>>();
  private readonly completedHistory = new Map<string, CompletedPredictionMarketSessionRecord>();
  private static readonly MAX_HISTORY_ENTRIES = 100;

  constructor(config: PredictionMarketHarnessConfig = {}) {
    this.config = {
      timeoutMs: config.timeoutMs ?? 10000,
      maxCandidates: config.maxCandidates ?? 6,
      onTelemetry: config.onTelemetry,
    };
  }

  /**
   * Streams the prediction market discovery pipeline, yielding real-time telemetry events.
   * Uses unique executionId to isolate concurrent runs with the same taskId (Item 6).
   */
  async *stream(
    task: PredictionMarketTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): AsyncGenerator<FinanceTelemetryEvent, PredictionMarketOutcome, unknown> {
    // Item 5: Validate task input at harness boundary and reject invalid values
    if (!task || typeof task !== 'object') {
      const outcome: PredictionMarketOutcome = {
        status: 'ERROR',
        taskId: (task as any)?.id || 'unknown',
        query: (task as any)?.query || '',
        error: 'Invalid task input: task must be a valid object',
      };
      return outcome;
    }
    if (!task.id || typeof task.id !== 'string' || !task.id.trim()) {
      const outcome: PredictionMarketOutcome = {
        status: 'ERROR',
        taskId: task.id || 'unknown',
        query: task.query || '',
        error: 'Invalid task input: task.id must be a non-empty string',
      };
      return outcome;
    }
    if (!task.query || typeof task.query !== 'string' || !task.query.trim()) {
      const outcome: PredictionMarketOutcome = {
        status: 'ERROR',
        taskId: task.id,
        query: task.query || '',
        error: 'Invalid task input: task.query must be a non-empty string',
      };
      return outcome;
    }
    if (task.targetProbability !== undefined) {
      if (
        typeof task.targetProbability !== 'number' ||
        !isFinite(task.targetProbability) ||
        isNaN(task.targetProbability) ||
        task.targetProbability < 0 ||
        task.targetProbability > 1
      ) {
        const outcome: PredictionMarketOutcome = {
          status: 'ERROR',
          taskId: task.id,
          query: task.query,
          error: `Invalid task input: targetProbability must be a finite number between 0.0 and 1.0, received ${task.targetProbability}`,
        };
        return outcome;
      }
    }
    if (task.desiredOutcome !== undefined && task.desiredOutcome !== 'YES' && task.desiredOutcome !== 'NO') {
      const outcome: PredictionMarketOutcome = {
        status: 'ERROR',
        taskId: task.id,
        query: task.query,
        error: `Invalid task input: desiredOutcome must be 'YES' or 'NO', received "${task.desiredOutcome}"`,
      };
      return outcome;
    }

    const taskId = task.id;
    const executionId =
      options.executionId ||
      `${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const abortController = new AbortController();

    // Link external abort signal if provided (Item 5)
    if (options.signal) {
      if (options.signal.aborted) {
        abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener(
          'abort',
          () => abortController.abort(options.signal?.reason),
          { once: true }
        );
      }
    }

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort(
        new Error(`Prediction market research timed out after ${this.config.timeoutMs}ms`)
      );
    }, this.config.timeoutMs);

    const session: ActivePredictionMarketSession = {
      executionId,
      task,
      startTime: Date.now(),
      abortController,
      telemetryHistory: [],
    };

    this.activeSessions.set(executionId, session);
    if (!this.taskIdToExecutions.has(taskId)) {
      this.taskIdToExecutions.set(taskId, new Set());
    }
    this.taskIdToExecutions.get(taskId)!.add(executionId);

    let finalOutcome: PredictionMarketOutcome;

    try {
      const pipelineGen = runPredictionMarketPipeline(task, {
        config: this.config,
        signal: abortController.signal,
        deadline: Date.now() + (this.config.timeoutMs ?? 10000),
        executionId,
      });

      let next = await pipelineGen.next();
      while (!next.done) {
        const event = next.value as FinanceTelemetryEvent;
        if (executionId && !event.executionId) {
          event.executionId = executionId;
        }
        session.telemetryHistory.push(event);

        try {
          this.config.onTelemetry?.(event);
        } catch {}

        yield event;
        next = await pipelineGen.next();
      }

      finalOutcome = next.value as PredictionMarketOutcome;
      return finalOutcome;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isAborted = abortController.signal.aborted;

      const errorEvent: FinanceTelemetryEvent = {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: isAborted
          ? `Prediction market research cancelled or timed out: ${errMsg}`
          : `Prediction market research failed: ${errMsg}`,
        data: { error: errMsg, executionId },
        timestamp: Date.now(),
      };

      session.telemetryHistory.push(errorEvent);
      try {
        this.config.onTelemetry?.(errorEvent);
      } catch {}
      yield errorEvent;

      // Item 4: Explicit outcome statuses (TIMED_OUT, CANCELLED, ERROR)
      if (timedOut || errMsg.includes('timed out')) {
        finalOutcome = {
          status: 'TIMED_OUT',
          taskId,
          query: task.query,
          reason: errMsg,
          elapsedMs: Date.now() - session.startTime,
        };
      } else if (isAborted || errMsg.includes('cancelled') || errMsg.includes('abort')) {
        finalOutcome = {
          status: 'CANCELLED',
          taskId,
          query: task.query,
          reason: errMsg,
        };
      } else if (err instanceof ProviderError) {
        finalOutcome = {
          status: 'ERROR',
          taskId,
          query: task.query,
          error: errMsg,
          provider: err.provider,
        };
      } else {
        finalOutcome = {
          status: 'ERROR',
          taskId,
          query: task.query,
          error: errMsg,
        };
      }

      return finalOutcome;
    } finally {
      clearTimeout(timeoutHandle);

      // Item 6: Preserve telemetry in bounded completedHistory before deleting active session
      const completedRecord: CompletedPredictionMarketSessionRecord = {
        executionId,
        taskId,
        task,
        startTime: session.startTime,
        completedAt: Date.now(),
        outcome: finalOutcome!,
        telemetryHistory: [...session.telemetryHistory],
      };

      if (this.completedHistory.size >= PredictionMarketHarness.MAX_HISTORY_ENTRIES) {
        const oldestKey = this.completedHistory.keys().next().value;
        if (oldestKey) this.completedHistory.delete(oldestKey);
      }
      this.completedHistory.set(executionId, completedRecord);

      // Cleanup active session
      this.activeSessions.delete(executionId);
      const execSet = this.taskIdToExecutions.get(taskId);
      if (execSet) {
        execSet.delete(executionId);
        if (execSet.size === 0) {
          this.taskIdToExecutions.delete(taskId);
        }
      }
    }
  }

  async research(
    task: PredictionMarketTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): Promise<PredictionMarketOutcome> {
    const stream = this.stream(task, options);
    let res = await stream.next();
    while (!res.done) {
      res = await stream.next();
    }
    return res.value as PredictionMarketOutcome;
  }

  /**
   * Cancels active sessions. Supports cancelling by either executionId or taskId (Item 6).
   */
  cancel(id: string, reason = 'Cancelled by user'): boolean {
    // 1. Direct executionId match
    const session = this.activeSessions.get(id);
    if (session) {
      session.abortController.abort(new Error(reason));
      return true;
    }

    // 2. taskId match - abort all concurrent executions for this taskId
    const executions = this.taskIdToExecutions.get(id);
    if (executions && executions.size > 0) {
      for (const execId of executions) {
        const active = this.activeSessions.get(execId);
        if (active) {
          active.abortController.abort(new Error(reason));
        }
      }
      return true;
    }

    return false;
  }

  /**
   * Retrieves telemetry history. Checks active sessions first, then completed history.
   * Supports lookup by executionId or taskId (Item 6).
   */
  getTelemetryHistory(id: string): FinanceTelemetryEvent[] {
    // 1. Check active session by executionId
    const active = this.activeSessions.get(id);
    if (active) return [...active.telemetryHistory];

    // 2. Check active sessions by taskId (return latest)
    const activeExecs = this.taskIdToExecutions.get(id);
    if (activeExecs && activeExecs.size > 0) {
      const latestExecId = Array.from(activeExecs).pop()!;
      const latestActive = this.activeSessions.get(latestExecId);
      if (latestActive) return [...latestActive.telemetryHistory];
    }

    // 3. Check completed history by executionId
    const completed = this.completedHistory.get(id);
    if (completed) return [...completed.telemetryHistory];

    // 4. Search completed history by taskId (return latest)
    let latestCompleted: CompletedPredictionMarketSessionRecord | null = null;
    for (const record of this.completedHistory.values()) {
      if (record.taskId === id) {
        if (!latestCompleted || record.completedAt > latestCompleted.completedAt) {
          latestCompleted = record;
        }
      }
    }

    return latestCompleted ? [...latestCompleted.telemetryHistory] : [];
  }
}
