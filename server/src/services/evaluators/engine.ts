/**
 * Strands Sentinel - Scheduled Evaluator Engine
 * Coordinates deterministic and agentic sub-sentinel evaluators, condition AST trees, rule combinators,
 * alert generation, interrupt requests, and heterogeneous cadence scheduling.
 */

import { randomUUID } from 'node:crypto';
import {
  type Rule,
  type SubSentinel,
  type AlertEvent,
  type InterruptAction,
  type SubSentinelStatePayload,
  type TelemetryPoint,
  parseConditionTree,
  evaluateConditionTree,
  InterruptActionPayloadSchema,
} from '@sentinel/shared';
import {
  ruleRepository,
  subSentinelRepository,
  telemetryRepository,
} from '../../db/index.js';
import { StockEvaluator } from './stock_evaluator.js';
import { CryptoEvaluator } from './crypto_evaluator.js';
import { PredictionMarketEvaluator } from './prediction_market_evaluator.js';
import { RssEvaluator } from './rss_evaluator.js';
import { WebSearchEvaluator } from './web_search_evaluator.js';
import { WebObserverEvaluator } from './web_observer_evaluator.js';
import { TelegramEvaluator } from './telegram_evaluator.js';
import type { SubSentinelEvaluationResult, SubSentinelEvaluator } from './types.js';
import { getNextEvaluationAt } from '../../scheduling/due_schedule.js';

export interface EvaluatorEngineOptions {
  intervalMs?: number;
  onAlertTriggered?: (alert: AlertEvent) => void;
  onInterruptRequest?: (interrupt: InterruptAction) => void;
  onSubSentinelEvaluated?: (userId: string, event: SubSentinelEvaluatedEventPayload) => void;
  onTelemetryUpdate?: (userId: string, point: TelemetryPoint) => void;
}

export interface SubSentinelEvaluatedEventPayload {
  subSentinelId: string;
  ruleId: string;
  isSatisfied: boolean;
  currentValue: string | number | boolean;
  timestamp: number;
}

export class EvaluatorEngine {
  private readonly evaluators: Map<string, SubSentinelEvaluator> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isTickBusy = false;
  private readonly intervalMs: number;
  private onAlertTriggered?: (alert: AlertEvent) => void;
  private onInterruptRequest?: (interrupt: InterruptAction) => void;
  private onSubSentinelEvaluated?: (userId: string, event: SubSentinelEvaluatedEventPayload) => void;
  private onTelemetryUpdate?: (userId: string, point: TelemetryPoint) => void;

  constructor(options: EvaluatorEngineOptions = {}) {
    this.intervalMs = options.intervalMs || 10000; // Default: 10s poll tick
    this.onAlertTriggered = options.onAlertTriggered;
    this.onInterruptRequest = options.onInterruptRequest;
    this.onSubSentinelEvaluated = options.onSubSentinelEvaluated;
    this.onTelemetryUpdate = options.onTelemetryUpdate;

    // Register evaluator adapters. Individual adapters may use deterministic
    // comparisons, agentic semantic judgment, or both.
    const stockEvaluator = new StockEvaluator();
    const cryptoEvaluator = new CryptoEvaluator();
    const predictionMarketEvaluator = new PredictionMarketEvaluator();
    const rssEvaluator = new RssEvaluator();
    const webSearchEvaluator = new WebSearchEvaluator();
    const webObserverEvaluator = new WebObserverEvaluator();
    const telegramEvaluator = new TelegramEvaluator();

    this.evaluators.set('STOCK', stockEvaluator);
    this.evaluators.set('FINANCIAL_TECHNICAL', stockEvaluator);
    this.evaluators.set('CRYPTO', cryptoEvaluator);
    this.evaluators.set('PREDICTION_MARKET', predictionMarketEvaluator);
    this.evaluators.set('RSS_FEED', rssEvaluator);
    this.evaluators.set('STREAM_INTELLIGENCE', webSearchEvaluator);
    this.evaluators.set('WEB_SEARCH', webSearchEvaluator);
    this.evaluators.set('WEB_OBSERVER', webObserverEvaluator);
    this.evaluators.set('ECOMMERCE_INVENTORY', webObserverEvaluator);
    this.evaluators.set('TELEGRAM_CHANNEL', telegramEvaluator);
    this.evaluators.set('TELEGRAM_OPEN_CHANNEL', telegramEvaluator);
  }

  public setEventCallbacks(callbacks: {
    onAlertTriggered?: (alert: AlertEvent) => void;
    onInterruptRequest?: (interrupt: InterruptAction) => void;
    onSubSentinelEvaluated?: (userId: string, event: SubSentinelEvaluatedEventPayload) => void;
    onTelemetryUpdate?: (userId: string, point: TelemetryPoint) => void;
  }) {
    // Explicit replacement prevents stale process-local callbacks from a
    // previous bootstrap path leaking into a new runtime configuration.
    this.onAlertTriggered = callbacks.onAlertTriggered;
    this.onInterruptRequest = callbacks.onInterruptRequest;
    this.onSubSentinelEvaluated = callbacks.onSubSentinelEvaluated;
    this.onTelemetryUpdate = callbacks.onTelemetryUpdate;
  }

  /**
   * Evaluates an individual sub-sentinel deterministically.
   * Handles health state degradation and logs telemetry.
   */
  async evaluateSubSentinel(
    subSentinel: SubSentinel,
    rule: Rule
  ): Promise<SubSentinelEvaluationResult> {
    const evaluator = this.evaluators.get(subSentinel.sentinel_type);
    let result: SubSentinelEvaluationResult;

    if (!evaluator) {
      result = {
        isSatisfied: false,
        observedValue: null,
        details: `No evaluator registered for type ${subSentinel.sentinel_type}`,
        error: 'NO_EVALUATOR',
      };
    } else {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 30000); // 30s timeout per evaluator
      try {
        result = await evaluator.evaluate(subSentinel, rule, controller.signal);
      } catch (err: any) {
        result = {
          isSatisfied: false,
          observedValue: null,
          details: `Evaluator failure or timeout: ${err?.message || String(err)}`,
          error: err?.name === 'AbortError' ? 'EVALUATION_TIMEOUT' : (err?.message || 'EVALUATOR_EXECUTION_ERROR'),
        };
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    // Health state degradation lifecycle
    let newHealthStatus: SubSentinel['health_status'] = subSentinel.health_status;
    let newErrorCount = subSentinel.error_count;

    if (result.error) {
      newErrorCount += 1;
      if (newErrorCount >= 5) {
        newHealthStatus = 'ERROR'; // Circuit breaker tripped
      } else if (newErrorCount >= 3) {
        newHealthStatus = 'DEGRADED';
      }
    } else {
      newHealthStatus = 'HEALTHY';
      newErrorCount = 0;
    }

    const statePayload: SubSentinelStatePayload = {
      currentValue: result.observedValue ?? (result.isSatisfied ? 1 : 0),
      previousValue: result.previousValue ?? undefined,
      unit: result.unit,
      sourceTimestamp: Date.now(),
      rawSnippet: result.details,
      extraMetadata: result.extraMetadata,
    };

    // Update sub-sentinel state in repository
    await subSentinelRepository.updateSatisfaction(
      subSentinel.id,
      result.isSatisfied,
      JSON.stringify(statePayload),
      result.error || null,
      newHealthStatus,
      getNextEvaluationAt(subSentinel, newHealthStatus, newErrorCount),
    );

    // Log telemetry point
    const metricValue =
      typeof result.observedValue === 'number' && Number.isFinite(result.observedValue)
        ? result.observedValue
        : result.isSatisfied
        ? 1
        : 0;

    const telemetryPoint: TelemetryPoint = {
      id: randomUUID(),
      rule_id: rule.id,
      sub_sentinel_id: subSentinel.id,
      metric_name: `${subSentinel.sentinel_type}_VALUE`,
      value: metricValue,
      timestamp: Date.now(),
      metadata: JSON.stringify({
        details: result.details,
        isSatisfied: result.isSatisfied,
        error: result.error,
        healthStatus: newHealthStatus,
      }),
    };

    try {
      await telemetryRepository.log(telemetryPoint);
    } catch {
      // Telemetry log error non-fatal
    }

    const evaluatedEvent: SubSentinelEvaluatedEventPayload = {
      subSentinelId: subSentinel.id,
      ruleId: rule.id,
      isSatisfied: result.isSatisfied,
      currentValue: result.observedValue ?? (result.isSatisfied ? true : false),
      timestamp: telemetryPoint.timestamp,
    };
    try {
      this.onSubSentinelEvaluated?.(rule.user_id, evaluatedEvent);
      this.onTelemetryUpdate?.(rule.user_id, telemetryPoint);
    } catch {
      // Realtime delivery is best effort; durable evaluation must continue.
    }

    return result;
  }

  /**
   * Evaluates a rule against its child sub-sentinels.
   * Supports:
   * 1. Arbitrary Boolean Condition AST trees (`rule.condition_tree`).
   * 2. Legacy flat combinators (`SINGLE`, `AND`, `OR`).
   * 3. Heterogeneous evaluation using cached state when forceEvaluateChildren = false.
   */
  async evaluateRule(
    rule: Rule,
    forceEvaluateChildren = true
  ): Promise<{
    isTriggered: boolean;
    alert?: AlertEvent;
    interrupt?: InterruptAction;
  }> {
    if (rule.status !== 'ACTIVE') {
      return { isTriggered: false };
    }

    // Enforce rule expiration (Finding 4)
    if (rule.expires_at && Date.now() > rule.expires_at) {
      await ruleRepository.updateStatus(rule.id, 'ARCHIVED');
      return { isTriggered: false };
    }

    const subSentinels = await subSentinelRepository.getByRuleId(rule.id);
    if (subSentinels.length === 0) {
      return { isTriggered: false };
    }

    const satisfactionMap = new Map<string, boolean | null>();
    const evaluationResults: SubSentinelEvaluationResult[] = [];
    const evaluations: Array<boolean | null> = [];

    for (const subSentinel of subSentinels) {
      let isSat = Boolean(subSentinel.is_satisfied);
      let evalResult: SubSentinelEvaluationResult;

      // Force evaluate if requested OR if sub-sentinel has never been evaluated before
      if (forceEvaluateChildren || subSentinel.last_evaluated_at == null) {
        evalResult = await this.evaluateSubSentinel(subSentinel, rule);
        isSat = evalResult.isSatisfied;
      } else {
        // Read latest known state from cached state payload
        let details = `Observed state: ${isSat ? 'Satisfied' : 'Not satisfied'}`;
        let extraMeta: Record<string, unknown> | undefined;
        let obsVal: any = subSentinel.is_satisfied;
        if (subSentinel.state_payload) {
          try {
            const payload = JSON.parse(subSentinel.state_payload);
            details = payload.rawSnippet || details;
            extraMeta = payload.extraMetadata;
            obsVal = payload.currentValue ?? obsVal;
          } catch {
            // State payload fallback
          }
        }
        evalResult = {
          isSatisfied: isSat,
          observedValue: obsVal,
          details,
          extraMetadata: extraMeta,
          error: subSentinel.health_status === 'ERROR' ? (subSentinel.last_error || 'Previous evaluation error') : null,
        };
      }

      // If sub-sentinel errored, mark state as UNKNOWN (null) in Kleene logic
      const nodeState: boolean | null = evalResult.error ? null : isSat;
      satisfactionMap.set(subSentinel.id, nodeState);
      evaluations.push(nodeState);
      evaluationResults.push(evalResult);
    }

    // 1. Evaluate Condition Tree AST if present
    let isSatisfied = false;
    const parsedTree = parseConditionTree(rule.condition_tree);

    if (parsedTree) {
      isSatisfied = evaluateConditionTree(parsedTree, satisfactionMap);
    } else {
      // 2. Fallback to legacy rule combinator (treating null as UNKNOWN)
      if (rule.combinator === 'SINGLE') {
        isSatisfied = evaluations[0] === true;
      } else if (rule.combinator === 'AND') {
        isSatisfied = evaluations.every((e) => e === true);
      } else if (rule.combinator === 'OR') {
        isSatisfied = evaluations.some((e) => e === true);
      }
    }

    if (!isSatisfied) {
      return { isTriggered: false };
    }

    // Atomic Cooldown claim across distributed worker processes (Issue 6)
    const cooldownMinutes = rule.cooldown_minutes ?? 60;
    const cooldownMs = cooldownMinutes * 60 * 1000;
    const previousTriggeredAt = rule.last_triggered_at ?? null;
    const triggeredAt = Date.now();
    const claimed = await ruleRepository.claimCooldown(rule.id, triggeredAt, cooldownMs);
    if (!claimed) {
      // Another worker already claimed trigger window, or cooldown is active
      return { isTriggered: false };
    }

    try {
      // Inspect if any sub-sentinel evaluation has an agentic result with suggestedAlert or suggestedAction
      let agenticAlertTitle = `Sentinel Alert: ${rule.title}`;
      let agenticAlertSummary = `Triggered: ${rule.natural_language_intent}. ${evaluationResults.map((r) => r.details).join(' | ')}`;
      let agenticAudioTone = rule.audio_tone;
      let agenticAction: any = null;

      for (const res of evaluationResults) {
        const agentic = res.extraMetadata?.agenticResult as any;
        if (agentic) {
          if (agentic.suggestedAlert?.title) {
            agenticAlertTitle = agentic.suggestedAlert.title;
          }
          if (agentic.suggestedAlert?.summary) {
            agenticAlertSummary = agentic.suggestedAlert.summary;
          }
          if (agentic.suggestedAlert?.audioTone) {
            agenticAudioTone = agentic.suggestedAlert.audioTone;
          }
          if (agentic.suggestedAction) {
            agenticAction = agentic.suggestedAction;
          }
        }
      }

      // Create AlertEvent
      const alert: AlertEvent = {
        id: randomUUID(),
        rule_id: rule.id,
        user_id: rule.user_id,
        title: agenticAlertTitle,
        summary: agenticAlertSummary,
        audio_tone: agenticAudioTone,
        snapshot_data: JSON.stringify({
          ruleTitle: rule.title,
          evaluations: evaluationResults,
        }),
        created_at: Date.now(),
      };

      // Create InterruptAction only for an allowlisted, human-approved action
      // payload. Untrusted model output must never become an executable action.
      let interrupt: InterruptAction | undefined;
      let actionPayload: string | undefined = rule.action_template || (agenticAction ? JSON.stringify(agenticAction) : undefined);
      if (actionPayload) {
        try {
          const parsedAction = JSON.parse(actionPayload);
          const validAction = InterruptActionPayloadSchema.safeParse({
            ...parsedAction,
            parameters: parsedAction.parameters || {},
            reversible: parsedAction.reversible ?? false,
          });
          const agentRequiresApproval = agenticAction ? agenticAction.requiresHumanApproval !== false : true;
          if (!validAction.success || !agentRequiresApproval) {
            actionPayload = undefined;
          }
        } catch {
          actionPayload = undefined;
        }
      }

      if (actionPayload && actionPayload.trim().length > 0) {
        let actionType = 'LIMIT_BUY_ORDER';
        try {
          const parsed = JSON.parse(actionPayload);
          if (parsed.actionType) actionType = parsed.actionType;
        } catch {
          // Default actionType
        }

        interrupt = {
          id: randomUUID(),
          alert_id: alert.id,
          rule_id: rule.id,
          user_id: rule.user_id,
          action_type: actionType,
          action_payload: actionPayload,
          status: 'PENDING',
          expires_at: Date.now() + 600_000, // 10 minutes TTL
          created_at: Date.now(),
        };

      }

      // Commit the alert, optional interrupt, and ONE_SHOT lifecycle state as
      // one durable operation. A crash cannot leave only part of a trigger.
      const committed = await ruleRepository.commitTrigger({
        ruleId: rule.id,
        triggeredAt,
        oneShot: rule.trigger_mode === 'ONE_SHOT',
        alert,
        interrupt,
      });
      if (!committed) {
        throw new Error(`Trigger commit rejected for rule ${rule.id}`);
      }

      // Publish only after all durable writes for this evaluation have
      // succeeded. Consumers can safely rehydrate from persistence if the
      // process crashes before this best-effort notification.
      if (this.onAlertTriggered) {
        this.onAlertTriggered(alert);
      }
      if (interrupt && this.onInterruptRequest) {
        this.onInterruptRequest(interrupt);
      }

      return {
        isTriggered: true,
        alert,
        interrupt,
      };
    } catch (err) {
      // Cooldown rollback: A failed alert write must NOT consume the cooldown window
      try {
        await ruleRepository.releaseCooldown(rule.id, previousTriggeredAt);
      } catch (rollbackErr) {
        console.error(`[EvaluatorEngine] Failed to release cooldown for rule ${rule.id}:`, rollbackErr);
      }
      throw err;
    }
  }

  /**
   * Executes a high-resolution scheduler pulse.
   * Decoupled Heterogeneous Execution:
   * 1. Fetches only sub-sentinels that are DUE based on their own ttl_seconds.
   * 2. Evaluates due sub-sentinels without touching non-due siblings.
   * 3. Triggers evaluation of parent rules whose sub-sentinels updated.
   */
  async tick(now = Date.now(), limit = 100): Promise<{
    evaluatedSubSentinels: number;
    triggeredRules: number;
    failures: number;
  }> {
    if (this.isTickBusy) return { evaluatedSubSentinels: 0, triggeredRules: 0, failures: 0 };
    this.isTickBusy = true;

    let evaluatedCount = 0;
    let triggeredCount = 0;
    let failures = 0;

    try {
      // 1. Fetch only sub-sentinels due for evaluation
      const dueSubSentinels = await subSentinelRepository.getDue(now, Math.min(Math.max(limit, 1), 500));
      if (dueSubSentinels.length === 0) {
        return { evaluatedSubSentinels: 0, triggeredRules: 0, failures: 0 };
      }

      // Track parent rule IDs affected by these evaluations
      const affectedRuleIds = new Set<string>();

      // Bounded concurrency batching (chunks of 5) to eliminate N+1 sequential waterfall latency
      const BATCH_SIZE = 5;
      for (let i = 0; i < dueSubSentinels.length; i += BATCH_SIZE) {
        const batch = dueSubSentinels.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async (subSentinel) => {
            try {
              // Distributed lease claim check: ensure another worker hasn't claimed this sub-sentinel (Finding 18)
              const claimed = await subSentinelRepository.claim(subSentinel.id, now);
              if (!claimed) {
                return;
              }

              const rule = await ruleRepository.getById(subSentinel.rule_id);
              if (!rule || rule.status !== 'ACTIVE') return;

              await this.evaluateSubSentinel(subSentinel, rule);
              evaluatedCount++;
              affectedRuleIds.add(rule.id);
            } catch (subErr) {
              failures++;
              console.error(`[EvaluatorEngine] Error evaluating sub-sentinel ${subSentinel.id}:`, subErr);
            }
          })
        );
      }

      // 2. Evaluate parent rules that had sub-sentinel updates
      for (const ruleId of affectedRuleIds) {
        try {
          const rule = await ruleRepository.getById(ruleId);
          if (!rule || rule.status !== 'ACTIVE') continue;

          // Heterogeneous check: siblings not due will use their cached state
          const evalResult = await this.evaluateRule(rule, false);
          if (evalResult.isTriggered) {
            triggeredCount++;
          }
        } catch (ruleErr) {
          failures++;
          console.error(`[EvaluatorEngine] Error evaluating parent rule ${ruleId}:`, ruleErr);
        }
      }
    } catch (err) {
      failures++;
      console.error('[EvaluatorEngine] Error during scheduler tick pulse:', err);
    } finally {
      this.isTickBusy = false;
    }

    return { evaluatedSubSentinels: evaluatedCount, triggeredRules: triggeredCount, failures };
  }

  /**
   * Starts periodic polling background loop with high-resolution cadence.
   */
  start(intervalMs?: number): void {
    if (this.isRunning) return;
    this.isRunning = true;
    const pulse = intervalMs || this.intervalMs;
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[EvaluatorEngine] Tick uncaught error:', err));
    }, pulse);
  }

  /**
   * Stops the background polling loop.
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const globalEvaluatorEngine = new EvaluatorEngine();
