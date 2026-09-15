import {
  type RssResearchTask,
  type RssResearchOutcome,
  type RssHarnessConfig,
  type RssTelemetryEvent,
  ProviderError,
} from './types.js';
import { runRssPipeline } from './rss_graph.js';

export interface ActiveRssSession {
  executionId: string;
  task: RssResearchTask;
  startTime: number;
  abortController: AbortController;
  telemetryHistory: RssTelemetryEvent[];
}

export interface CompletedRssSessionRecord {
  executionId: string;
  taskId: string;
  task: RssResearchTask;
  startTime: number;
  completedAt: number;
  outcome: RssResearchOutcome;
  telemetryHistory: RssTelemetryEvent[];
}

/**
 * ==========================================================
 * RSS RESEARCH META-HARNESS — LIFECYCLE ORCHESTRATOR
 * ==========================================================
 * Manages the execution lifecycle, timeout management, cancellation,
 * concurrency isolation via execution IDs, completed history retention,
 * and real-time telemetry streaming for RSS/Atom feed discovery.
 */
export class RssResearchHarness {
  private readonly config: RssHarnessConfig;
  private readonly activeSessions = new Map<string, ActiveRssSession>();
  private readonly taskIdToExecutions = new Map<string, Set<string>>();
  private readonly completedHistory = new Map<string, CompletedRssSessionRecord>();
  private static readonly MAX_HISTORY_ENTRIES = 100;

  constructor(config: RssHarnessConfig = {}) {
    this.config = {
      timeoutMs: config.timeoutMs ?? 10000,
      maxCandidates: config.maxCandidates ?? 5,
      onTelemetry: config.onTelemetry,
      allowPrivateForTesting: config.allowPrivateForTesting,
      semanticEvaluator: config.semanticEvaluator,
    };
  }

  async *stream(
    task: RssResearchTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): AsyncGenerator<RssTelemetryEvent, RssResearchOutcome, unknown> {
    const taskId = task.id;
    const executionId =
      options.executionId ||
      `${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const abortController = new AbortController();

    if (options.signal) {
      if (options.signal.aborted) {
        abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener('abort', () => abortController.abort(options.signal?.reason), {
          once: true,
        });
      }
    }

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error(`RSS research timed out after ${this.config.timeoutMs}ms`));
    }, this.config.timeoutMs);

    const session: ActiveRssSession = {
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

    let finalOutcome: RssResearchOutcome;

    try {
      const pipelineGen = runRssPipeline(task, this.config, abortController.signal, executionId);

      let next = await pipelineGen.next();
      while (!next.done) {
        const event = next.value as RssTelemetryEvent;
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

      finalOutcome = next.value as RssResearchOutcome;
      return finalOutcome;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isAborted = abortController.signal.aborted;

      const errorEvent: RssTelemetryEvent = {
        taskId,
        executionId,
        step: 'DISCOVERY_ERROR',
        message: isAborted
          ? `RSS research cancelled or timed out: ${errMsg}`
          : `RSS research failed: ${errMsg}`,
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

      const completedRecord: CompletedRssSessionRecord = {
        executionId,
        taskId,
        task,
        startTime: session.startTime,
        completedAt: Date.now(),
        outcome: finalOutcome!,
        telemetryHistory: [...session.telemetryHistory],
      };

      if (this.completedHistory.size >= RssResearchHarness.MAX_HISTORY_ENTRIES) {
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
    task: RssResearchTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): Promise<RssResearchOutcome> {
    const stream = this.stream(task, options);
    let res = await stream.next();
    while (!res.done) {
      res = await stream.next();
    }
    return res.value as RssResearchOutcome;
  }

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

  getTelemetryHistory(id: string): RssTelemetryEvent[] {
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
    let latestCompleted: CompletedRssSessionRecord | null = null;
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
