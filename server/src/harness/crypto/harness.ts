import type {
  CryptoResearchTask,
  CryptoResearchOutcome,
  CryptoHarnessConfig,
} from './types.js';
import type { FinanceTelemetryEvent } from '../finance_common/index.js';
import { runCryptoPipeline } from './crypto_graph.js';

export interface ActiveCryptoSession {
  executionId: string;
  task: CryptoResearchTask;
  startTime: number;
  abortController: AbortController;
  telemetryHistory: FinanceTelemetryEvent[];
}

export interface CompletedCryptoSessionRecord {
  executionId: string;
  taskId: string;
  task: CryptoResearchTask;
  startTime: number;
  completedAt: number;
  outcome: CryptoResearchOutcome;
  telemetryHistory: FinanceTelemetryEvent[];
}

export class CryptoResearchHarness {
  private readonly config: CryptoHarnessConfig;
  private readonly activeSessions = new Map<string, ActiveCryptoSession>();
  private readonly taskIdToExecutions = new Map<string, Set<string>>();
  private readonly completedHistory = new Map<string, CompletedCryptoSessionRecord>();
  private static readonly MAX_HISTORY_ENTRIES = 100;

  constructor(config: CryptoHarnessConfig = {}) {
    this.config = {
      timeoutMs: config.timeoutMs ?? 10000,
      maxCandidates: config.maxCandidates ?? 5,
      onTelemetry: config.onTelemetry,
    };
  }

  /**
   * Streams the crypto research pipeline, yielding real-time telemetry events.
   * Uses unique executionId to isolate concurrent runs with the same taskId.
   */
  async *stream(
    task: CryptoResearchTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): AsyncGenerator<FinanceTelemetryEvent, CryptoResearchOutcome, unknown> {
    const taskId = task.id;
    // Item 10: Unique executionId isolates concurrent runs with identical taskId
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
        new Error(`Crypto research timed out after ${this.config.timeoutMs}ms`)
      );
    }, this.config.timeoutMs);

    const session: ActiveCryptoSession = {
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

    let finalOutcome: CryptoResearchOutcome;

    try {
      const pipelineGen = runCryptoPipeline(task, {
        config: this.config,
        signal: abortController.signal,
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

      finalOutcome = next.value as CryptoResearchOutcome;
      return finalOutcome;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isAborted = abortController.signal.aborted;

      const errorEvent: FinanceTelemetryEvent = {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: isAborted
          ? `Crypto research cancelled or timed out: ${errMsg}`
          : `Crypto research failed: ${errMsg}`,
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

      // Item 10: Preserve telemetry in bounded completedHistory before deleting active session
      const completedRecord: CompletedCryptoSessionRecord = {
        executionId,
        taskId,
        task,
        startTime: session.startTime,
        completedAt: Date.now(),
        outcome: finalOutcome!,
        telemetryHistory: [...session.telemetryHistory],
      };

      if (this.completedHistory.size >= CryptoResearchHarness.MAX_HISTORY_ENTRIES) {
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
    task: CryptoResearchTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): Promise<CryptoResearchOutcome> {
    const stream = this.stream(task, options);
    let res = await stream.next();
    while (!res.done) {
      res = await stream.next();
    }
    return res.value as CryptoResearchOutcome;
  }

  /**
   * Cancels active sessions. Supports cancelling by either executionId or taskId.
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
   * Supports lookup by executionId or taskId.
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
    let latestCompleted: CompletedCryptoSessionRecord | null = null;
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
