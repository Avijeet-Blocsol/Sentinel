import 'dotenv/config';
import type {
  DeepResearchTask,
  DeepResearchOutcome,
  ResearchTelemetryEvent,
  DeepResearchConfig,
} from './types.js';
import { runResearchPipeline } from './research_graph.js';

/**
 * ==========================================================
 * SENTINEL DEEP RESEARCH META-HARNESS — LIFECYCLE ORCHESTRATOR
 * ==========================================================
 * Manages execution lifecycle, unique execution IDs, bounded history
 * retention, timeout budgeting, and explicit outcome error classification.
 */

export interface ActiveSession {
  executionId: string;
  task: DeepResearchTask;
  startTime: number;
  abortController: AbortController;
  telemetryHistory: ResearchTelemetryEvent[];
}

export interface CompletedSessionRecord {
  executionId: string;
  taskId: string;
  task: DeepResearchTask;
  startTime: number;
  completedAt: number;
  outcome: DeepResearchOutcome;
  telemetryHistory: ResearchTelemetryEvent[];
}

export class DeepResearchHarness {
  private readonly config: DeepResearchConfig;
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly taskIdToExecutions = new Map<string, Set<string>>();
  private readonly completedHistory = new Map<string, CompletedSessionRecord>();
  private static readonly MAX_HISTORY_ENTRIES = 100;

  constructor(config: DeepResearchConfig = {}) {
    this.config = {
      maxSearchAngles: config.maxSearchAngles ?? 3,
      maxCandidateSites: config.maxCandidateSites ?? 4,
      siteTimeoutMs: config.siteTimeoutMs ?? 9000,
      maxTotalTimeMs: config.maxTotalTimeMs ?? 120000,
      maxModelCalls: config.maxModelCalls ?? 15,
      maxBrowserLaunches: config.maxBrowserLaunches ?? 2,
      maxGradientIterations: config.maxGradientIterations ?? 2,
      enableHeadlessFallback: config.enableHeadlessFallback ?? true,
      allowPrivateForTesting: config.allowPrivateForTesting ?? false,
      preferredDomainsPolicy: config.preferredDomainsPolicy ?? 'SOFT_PREFERENCE',
      onTelemetry: config.onTelemetry,
    };
  }

  /**
   * Streams the deep research pipeline, yielding real-time telemetry events
   * as the multi-agent graph progresses.
   */
  async *stream(
    task: DeepResearchTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): AsyncGenerator<ResearchTelemetryEvent, DeepResearchOutcome, unknown> {
    const taskId = task.id;
    // Point 13: Unique execution ID prevents concurrent task.id overwrites
    const executionId = options.executionId || `${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const abortController = new AbortController();

    // Link external abort signal if provided
    if (options.signal) {
      if (options.signal.aborted) {
        abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener('abort', () => abortController.abort(options.signal?.reason), { once: true });
      }
    }

    // Point 18: Real execution budget (Default 120s total, or configured maxTotalTimeMs)
    const totalTimeoutMs = this.config.maxTotalTimeMs ?? 120000;
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error(`Research execution timed out after ${totalTimeoutMs}ms`));
    }, totalTimeoutMs);

    const session: ActiveSession = {
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

    let finalOutcome: DeepResearchOutcome;

    try {
      const pipelineGen = runResearchPipeline(task, {
        config: this.config,
        signal: abortController.signal,
        executionId,
      });

      let next = await pipelineGen.next();
      while (!next.done) {
        const event = next.value as ResearchTelemetryEvent;
        session.telemetryHistory.push(event);

        try {
          this.config.onTelemetry?.(event);
        } catch (callbackErr: unknown) {
          const msg = callbackErr instanceof Error ? callbackErr.message : String(callbackErr);
          console.warn(`[DeepResearchHarness] Telemetry callback error: ${msg}`);
        }

        yield event;
        next = await pipelineGen.next();
      }

      finalOutcome = next.value as DeepResearchOutcome;
      return finalOutcome;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isAborted = abortController.signal.aborted;

      const errorEvent: ResearchTelemetryEvent = {
        taskId,
        executionId,
        step: 'RESEARCH_ERROR',
        message: isAborted
          ? `Research cancelled or timed out: ${errMsg}`
          : `Research failed: ${errMsg}`,
        data: { error: errMsg, executionId },
        timestamp: Date.now(),
      };

      session.telemetryHistory.push(errorEvent);
      try {
        this.config.onTelemetry?.(errorEvent);
      } catch {}
      yield errorEvent;

      // Point 12: Explicit outcome statuses (TIMED_OUT, CANCELLED, ERROR)
      if (timedOut || errMsg.includes('timed out')) {
        finalOutcome = {
          status: 'TIMED_OUT',
          taskId,
          taskDescription: task.query,
          reason: errMsg,
          attemptedDomains: [],
          elapsedMs: Date.now() - session.startTime,
        };
      } else if (isAborted || errMsg.includes('cancelled') || errMsg.includes('abort')) {
        finalOutcome = {
          status: 'CANCELLED',
          taskId,
          taskDescription: task.query,
          reason: errMsg,
          attemptedDomains: [],
        };
      } else {
        finalOutcome = {
          status: 'ERROR',
          taskId,
          taskDescription: task.query,
          error: errMsg,
          attemptedDomains: [],
        };
      }

      return finalOutcome;
    } finally {
      clearTimeout(timeoutHandle);

      // Point 13: Store in bounded completed history before deleting active session
      const completedRecord: CompletedSessionRecord = {
        executionId,
        taskId,
        task,
        startTime: session.startTime,
        completedAt: Date.now(),
        outcome: finalOutcome!,
        telemetryHistory: [...session.telemetryHistory],
      };

      if (this.completedHistory.size >= DeepResearchHarness.MAX_HISTORY_ENTRIES) {
        const oldestKey = this.completedHistory.keys().next().value;
        if (oldestKey) this.completedHistory.delete(oldestKey);
      }
      this.completedHistory.set(executionId, completedRecord);

      // Delete only this specific execution session
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

  /**
   * Executes the research task to completion, returning the final outcome.
   */
  async research(
    task: DeepResearchTask,
    options: { signal?: AbortSignal; executionId?: string } = {}
  ): Promise<DeepResearchOutcome> {
    const stream = this.stream(task, options);
    let res = await stream.next();
    while (!res.done) {
      res = await stream.next();
    }
    return res.value as DeepResearchOutcome;
  }

  /**
   * Cancels an in-flight research task by taskId or executionId.
   */
  cancel(id: string, reason = 'Cancelled by user'): boolean {
    // 1. Direct match on executionId
    const directSession = this.activeSessions.get(id);
    if (directSession) {
      directSession.abortController.abort(new Error(reason));
      return true;
    }

    // 2. Match on taskId
    const executions = this.taskIdToExecutions.get(id);
    if (executions && executions.size > 0) {
      for (const execId of executions) {
        const s = this.activeSessions.get(execId);
        if (s) s.abortController.abort(new Error(reason));
      }
      return true;
    }

    return false;
  }

  /**
   * Retrieves telemetry history for an active or recently completed task.
   */
  getTelemetryHistory(id: string): ResearchTelemetryEvent[] {
    // 1. Check active sessions by executionId
    const activeDirect = this.activeSessions.get(id);
    if (activeDirect) return [...activeDirect.telemetryHistory];

    // 2. Check active sessions by taskId
    const activeExecs = this.taskIdToExecutions.get(id);
    if (activeExecs && activeExecs.size > 0) {
      const latestExecId = Array.from(activeExecs).pop()!;
      const active = this.activeSessions.get(latestExecId);
      if (active) return [...active.telemetryHistory];
    }

    // 3. Check completed history by executionId
    const completedDirect = this.completedHistory.get(id);
    if (completedDirect) return [...completedDirect.telemetryHistory];

    // 4. Check completed history by taskId (find latest run)
    for (const record of Array.from(this.completedHistory.values()).reverse()) {
      if (record.taskId === id) {
        return [...record.telemetryHistory];
      }
    }

    return [];
  }
}