import type {
  StockResearchTask,
  StockResearchOutcome,
  StockHarnessConfig,
} from './types.js';
import { type FinanceTelemetryEvent, ProviderError } from '../finance_common/index.js';
import { runStockPipeline } from './stock_graph.js';

export interface ActiveStockSession {
  executionId: string;
  task: StockResearchTask;
  startTime: number;
  abortController: AbortController;
  telemetryHistory: FinanceTelemetryEvent[];
}

export interface CompletedStockSessionRecord {
  executionId: string;
  taskId: string;
  task: StockResearchTask;
  startTime: number;
  completedAt: number;
  outcome: StockResearchOutcome;
  telemetryHistory: FinanceTelemetryEvent[];
}

export class StockResearchHarness {
  private readonly config: StockHarnessConfig;
  private readonly activeSessions = new Map<string, ActiveStockSession>();
  private readonly taskIdToExecutions = new Map<string, Set<string>>();
  private readonly completedHistory = new Map<string, CompletedStockSessionRecord>();
  private static readonly MAX_HISTORY_ENTRIES = 100;

  constructor(config: StockHarnessConfig = {}) {
    this.config = {
      timeoutMs: config.timeoutMs ?? 10000,
      maxCandidates: config.maxCandidates ?? 5,
      preferProvider: config.preferProvider ?? 'FINNHUB',
      onTelemetry: config.onTelemetry,
    };
  }

  /**
   * Streams the stock research pipeline, yielding real-time telemetry events.
   * Uses unique executionId to isolate concurrent runs with the same taskId.
   */
  async *stream(
    task: StockResearchTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): AsyncGenerator<FinanceTelemetryEvent, StockResearchOutcome, unknown> {
    const taskId = task.id;
    const executionId =
      options.executionId ||
      `${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const abortController = new AbortController();

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
      abortController.abort(new Error(`Stock research timed out after ${this.config.timeoutMs}ms`));
    }, this.config.timeoutMs);

    const session: ActiveStockSession = {
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

    let finalOutcome: StockResearchOutcome;

    try {
      const pipelineGen = runStockPipeline(task, {
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

      finalOutcome = next.value as StockResearchOutcome;
      return finalOutcome;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isAborted = abortController.signal.aborted;

      const errorEvent: FinanceTelemetryEvent = {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: isAborted
          ? `Stock research cancelled or timed out: ${errMsg}`
          : `Stock research failed: ${errMsg}`,
        data: { error: errMsg, executionId },
        timestamp: Date.now(),
      };

      session.telemetryHistory.push(errorEvent);
      try {
        this.config.onTelemetry?.(errorEvent);
      } catch {}
      yield errorEvent;

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
          error: err.message,
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

      const completedRecord: CompletedStockSessionRecord = {
        executionId,
        taskId,
        task,
        startTime: session.startTime,
        completedAt: Date.now(),
        outcome: finalOutcome!,
        telemetryHistory: [...session.telemetryHistory],
      };

      if (this.completedHistory.size >= StockResearchHarness.MAX_HISTORY_ENTRIES) {
        const oldestKey = this.completedHistory.keys().next().value;
        if (oldestKey) this.completedHistory.delete(oldestKey);
      }
      this.completedHistory.set(executionId, completedRecord);

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
    task: StockResearchTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): Promise<StockResearchOutcome> {
    const stream = this.stream(task, options);
    let res = await stream.next();
    while (!res.done) {
      res = await stream.next();
    }
    return res.value as StockResearchOutcome;
  }

  cancel(id: string, reason = 'Cancelled by user'): boolean {
    const directSession = this.activeSessions.get(id);
    if (directSession) {
      directSession.abortController.abort(new Error(reason));
      return true;
    }

    const execIds = this.taskIdToExecutions.get(id);
    if (execIds && execIds.size > 0) {
      for (const execId of execIds) {
        this.activeSessions.get(execId)?.abortController.abort(new Error(reason));
      }
      return true;
    }
    return false;
  }

  getTelemetryHistory(id: string): FinanceTelemetryEvent[] {
    const active = this.activeSessions.get(id);
    if (active) return [...active.telemetryHistory];

    const completed = this.completedHistory.get(id);
    if (completed) return [...completed.telemetryHistory];

    const execIds = this.taskIdToExecutions.get(id);
    if (execIds && execIds.size > 0) {
      const events: FinanceTelemetryEvent[] = [];
      for (const execId of execIds) {
        const s = this.activeSessions.get(execId);
        if (s) events.push(...s.telemetryHistory);
      }
      return events;
    }

    const historyForTask: FinanceTelemetryEvent[] = [];
    for (const record of this.completedHistory.values()) {
      if (record.taskId === id) {
        historyForTask.push(...record.telemetryHistory);
      }
    }
    return historyForTask;
  }
}
