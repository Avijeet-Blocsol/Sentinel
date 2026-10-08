/**
 * Strands Sentinel - WebSocket Agent Stream & Message Handler
 * Manages conversational turns, state-machine transitions, tool reconnaissance streaming,
 * rule synthesis, and interrupt resolution.
 */

import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import {
  type Rule,
  type SubSentinel,
  type EnrichedInterruptAction,
  type ClarificationChoice,
  type ChoiceInterruptActionType,
  type TaskEditProposal,
  ClarificationRequestPayloadSchema,
  SentinelOperatorEnum,
  isChoiceInterruptActionType,
  type User,
} from '@sentinel/shared';
import {
  conversationRepository,
  chatMessageRepository,
  ruleRepository,
  subSentinelRepository,
  interruptActionRepository,
  alertEventRepository,
  telemetryRepository,
  executionRepository,
} from '../../db/index.js';
import { getSessionStorage } from '../../db/s3/session_storage.js';
import { SentinelAgent } from '../../agent/sentinel_agent.js';
import {
  generateSteeringResponse,
  generateLockedScopeResponse,
  type ConversationPhase,
  type ConversationStateContext,
  type UserInputCategory,
} from '../../agent/state_machine.js';
import { classifyUserInputWithAgent } from '../../agent/task_intent_classifier.js';
import { assessIntentCompleteness } from '../../agent/intent_completeness_agent.js';
import { assessInterruptResponse } from '../../agent/interrupt_response_agent.js';
import { assessTaskEdit } from '../../agent/task_edit_agent.js';
import { answerConversationQuestion } from '../../agent/conversation_question_agent.js';
import { SessionManager } from '@strands-agents/sdk';
import {
  deployMonitoringModeProposal,
  extractSynthesizedRule,
  resolveDeploymentProposal,
  stageMonitoringModeProposal,
} from '../../services/deployment_workflow.js';
import { emitDeploymentResolution, sendInterruptRequest } from './ws_connection_registry.js';
import { reconcileExpiredInterrupts } from './ws_event_poller.js';
import {
  createClarificationInterrupt,
  createChoiceInterrupt,
  findClarificationChoice,
  parseChoiceInterruptPayload,
  updateChoiceInterruptFeedback,
  type ClarificationRequest,
} from '../../services/clarification_workflow.js';
import { parseJsonValue } from '../../agent/structured_output.js';
import { commitTaskEdit, prepareTaskEdit } from '../../services/task_edit_workflow.js';

// Per-conversation message processing mutex to prevent race conditions
export const conversationLocks = new Map<string, Promise<void>>();

// Per-conversation SentinelAgent cache to avoid re-instantiating on every message
export const agentCache = new Map<string, SentinelAgent>();

type ChoiceLike = Pick<ClarificationChoice, 'id' | 'label'>;

function normalizedChoiceText(choice: ChoiceLike): string {
  return `${choice.id} ${choice.label}`.trim().toLowerCase();
}

function isLaunchReconnaissanceChoice(choice?: ChoiceLike | null): boolean {
  if (!choice) return false;
  const text = normalizedChoiceText(choice);
  return /\blaunch\b.*\b(reconnaissance|scout)|\bstart\b.*\b(reconnaissance|scout)|\b(reconnaissance|scout)\b.*\blaunch\b/.test(text);
}

function isModifyTaskChoice(choice?: ChoiceLike | null): boolean {
  if (!choice) return false;
  return /\b(modify|change|adjust|edit)\b/.test(normalizedChoiceText(choice));
}

/**
 * A draft agent can occasionally call request_clarification for the
 * server-owned "launch reconnaissance" gate even though the prompt asks it
 * to leave that gate to the router. Detect that shape before persisting it as
 * a generic clarification so the next click receives the real tool registry.
 */
export function isQueryConfirmationRequest(
  request: Pick<ClarificationRequest, 'question' | 'choices' | 'field'>,
  resumePhase: ConversationPhase,
): boolean {
  if (resumePhase !== 'AWAITING_QUERY_CONFIRMATION') return false;
  if (request.field?.trim().toLowerCase() === 'query_confirmation') return true;

  const choices = request.choices ?? [];
  return choices.some(isLaunchReconnaissanceChoice) && choices.some(isModifyTaskChoice);
}

/**
 * Compatibility guard for cards written by older builds before the creation
 * normalization above existed.
 */
export function isLegacyQueryConfirmationLaunch(
  actionType: string,
  payload: { resume_phase?: ConversationPhase; field?: string },
  choice?: ChoiceLike | null,
): boolean {
  return actionType === 'CLARIFICATION_REQUIRED' &&
    payload.resume_phase === 'AWAITING_QUERY_CONFIRMATION' &&
    (payload.field?.trim().toLowerCase() === 'query_confirmation' || isLaunchReconnaissanceChoice(choice));
}

/**
 * Restrict stale-card repair to phases that are compatible with the card's
 * workflow purpose. A generic "restore any pending card" repair can otherwise
 * reopen an old action after the conversation has already advanced.
 */
export function isInterruptRecoveryPhaseAllowed(
  actionType: string,
  payload: { resume_phase?: ConversationPhase },
  currentPhase: ConversationPhase,
): boolean {
  if (currentPhase === 'CLARIFICATION_PENDING') return true;
  if (actionType === 'QUERY_CONFIRMATION_REQUIRED') {
    return currentPhase === 'DISCOVERY' || currentPhase === 'AWAITING_QUERY_CONFIRMATION';
  }
  if (actionType === 'MONITORING_MODE_REQUIRED') {
    return currentPhase === 'SCOUTING' || currentPhase === 'AWAITING_TRIGGER_MODE';
  }
  if (actionType === 'CLARIFICATION_REQUIRED') {
    return payload.resume_phase === currentPhase ||
      (payload.resume_phase === 'AWAITING_QUERY_CONFIRMATION' && currentPhase === 'DISCOVERY');
  }
  return false;
}

/**
 * A workflow resume is already carrying an explicit, server-validated card
 * decision. It must continue through the state machine instead of being
 * treated like a reconnect that needs a replacement card.
 */
export function shouldRecoverQueryConfirmationCard(
  currentPhase: ConversationPhase,
  hasWorkflowResume: boolean,
): boolean {
  return currentPhase === 'AWAITING_QUERY_CONFIRMATION' && !hasWorkflowResume;
}

type ChoiceResolution = {
  interruptId: string;
  actionType: ChoiceInterruptActionType;
  choiceId: string;
  choiceLabel: string;
  responseText?: string;
};

const QUERY_RECONNAISSANCE_LEASE_MS = 120_000;

type WorkflowResumeLease = {
  id: string;
  owner: string;
};

async function claimQueryReconnaissanceLease(interruptId: string): Promise<WorkflowResumeLease | null> {
  const now = Date.now();
  const lease = {
    id: `workflow-resume:${interruptId}`,
    owner: `realtime:${randomUUID()}`,
  };
  const result = await executionRepository.claim({
    ...lease,
    event_type: 'WORKFLOW_RESUME',
    rule_id: null,
    lease_owner: lease.owner,
    lease_expires_at: now + QUERY_RECONNAISSANCE_LEASE_MS,
    now,
  });
  return result.claimed ? lease : null;
}

async function completeQueryReconnaissanceLease(
  lease: WorkflowResumeLease,
  phase: ConversationPhase,
): Promise<void> {
  await executionRepository.complete(lease.id, lease.owner, JSON.stringify({ phase }), Date.now());
}

async function failQueryReconnaissanceLease(
  lease: WorkflowResumeLease,
  error: unknown,
): Promise<void> {
  await executionRepository.fail(
    lease.id,
    lease.owner,
    error instanceof Error ? error.message : String(error),
    false,
    Date.now(),
  );
}

function startQueryReconnaissanceResume(
  socket: WebSocket,
  user: User,
  conversationId: string,
  interruptId: string,
  selectedLabel: string,
  responseText: string | undefined,
  logger: FastifyBaseLogger,
  lease: WorkflowResumeLease,
): Promise<void> {
  const task = handleChatMessage(socket, user, conversationId, selectedLabel, logger, {
    choiceResolution: {
      interruptId,
      actionType: 'QUERY_CONFIRMATION_REQUIRED',
      choiceId: 'confirm',
      choiceLabel: selectedLabel,
      responseText,
    },
  });
  return task.then(
    async () => completeQueryReconnaissanceLease(lease, 'SCOUTING'),
    async (error) => {
      await failQueryReconnaissanceLease(lease, error);
      throw error;
    },
  );
}

/**
 * Reclaims an approved query resume after a process crash. An active durable
 * lease makes this a no-op while another instance is already running it.
 */
export async function resumeApprovedQueryConfirmation(
  socket: WebSocket,
  user: User,
  conversationId: string,
  logger: FastifyBaseLogger,
): Promise<boolean> {
  const conversation = await conversationRepository.getById(conversationId);
  if (!conversation || conversation.user_id !== user.id || conversation.phase !== 'SCOUTING') return false;
  const action = await interruptActionRepository.getLatestByConversationId(
    conversationId,
    'QUERY_CONFIRMATION_REQUIRED',
    'APPROVED',
  ) ?? await interruptActionRepository.getLatestByConversationId(
    conversationId,
    'CLARIFICATION_REQUIRED',
    'APPROVED',
  );
  if (!action) return false;
  const payload = parseChoiceInterruptPayload(action);
  if (action.action_type === 'CLARIFICATION_REQUIRED' &&
      (!payload || !isQueryConfirmationRequest(payload, 'AWAITING_QUERY_CONFIRMATION'))) {
    return false;
  }
  const launchChoice = payload?.choices.find((choice) =>
    choice.id === 'confirm' || isLaunchReconnaissanceChoice(choice),
  );
  const lease = await claimQueryReconnaissanceLease(action.id);
  if (!lease) return false;
  await startQueryReconnaissanceResume(
    socket,
    user,
    conversationId,
    action.id,
    launchChoice?.label ?? 'Launch live reconnaissance',
    undefined,
    logger,
    lease,
  );
  return true;
}

export function clearAgentCache(conversationId: string): void {
  agentCache.delete(conversationId);
}

/**
 * Rehydrates workflow gates created by older builds that stored only the
 * conversation phase and assistant text. The conditional persistence in
 * createChoiceInterrupt makes this safe when multiple devices reconnect at
 * the same time.
 */
export async function ensureWorkflowChoiceInterrupt(
  conversationId: string,
  userId: string,
  options?: { allowWhileProcessing?: boolean },
): Promise<EnrichedInterruptAction | null> {
  // A resolved launch card briefly leaves the durable phase at
  // AWAITING_QUERY_CONFIRMATION while its approved resume is queued behind
  // the conversation lock. HTTP hydration and WebSocket reconnects must not
  // create a second card during that window.
  if (!options?.allowWhileProcessing && conversationLocks.has(conversationId)) {
    return null;
  }
  const conversation = await conversationRepository.getById(conversationId);
  if (!conversation || conversation.user_id !== userId) return null;

  const pending = (await interruptActionRepository.getPendingByUserId(userId))
    .find((action) => action.conversation_id === conversationId);
  if (pending) return pending;

  if (conversation.phase === 'AWAITING_QUERY_CONFIRMATION') {
    return createChoiceInterrupt({
      conversationId,
      userId,
      expectedPhase: conversation.phase,
      resumePhase: 'AWAITING_QUERY_CONFIRMATION',
      actionType: 'QUERY_CONFIRMATION_REQUIRED',
      request: {
        kind: 'QUERY_CONFIRMATION_REQUIRED',
        question: 'Review the proposed monitor and choose how to continue.',
        field: 'query_confirmation',
        choices: [
          {
            id: 'confirm',
            label: 'Launch live reconnaissance',
            description: 'Accept this draft and start live pre-flight verification.',
          },
          {
            id: 'modify',
            label: 'Modify this task',
            description: 'Keep the task in discovery and tell Sentinel what to change.',
          },
        ],
      },
    });
  }

  if (conversation.phase === 'AWAITING_TRIGGER_MODE') {
    const rules = await ruleRepository.getByConversationId(conversationId);
    const stagedRule = rules.find((candidate) => candidate.status === 'PAUSED') ?? null;
    if (!stagedRule) return null;
    return createChoiceInterrupt({
      conversationId,
      userId,
      ruleId: stagedRule.id,
      expectedPhase: conversation.phase,
      resumePhase: 'AWAITING_TRIGGER_MODE',
      actionType: 'MONITORING_MODE_REQUIRED',
      request: {
        kind: 'MONITORING_MODE_REQUIRED',
        question: 'How should this verified Sentinel task run?',
        field: 'trigger_mode',
        choices: [
          {
            id: 'continuous_monitoring',
            label: 'Continuous monitoring',
            description: 'Keep checking future observations until you pause the task.',
          },
          {
            id: 'one_time_alert',
            label: 'One-time alert',
            description: 'Finish the task after the first committed alert.',
          },
        ],
      },
    });
  }

  return null;
}

function isReadOnlyQuestion(
  category: UserInputCategory,
): category is 'TASK_STATUS_INQUIRY' | 'CONVERSATION_HISTORY_INQUIRY' {
  return category === 'TASK_STATUS_INQUIRY' || category === 'CONVERSATION_HISTORY_INQUIRY';
}

function semanticAgentUnavailableMessage(): string {
  return 'I could not reach the Sentinel reasoning agent, so I have not interpreted or changed your task. Please try that question again in a moment.';
}

function sendAgentActivity(
  socket: WebSocket,
  conversationId: string,
  metricName: string,
  metadata: Record<string, unknown>,
  value = 1,
): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'TELEMETRY_UPDATE',
    payload: {
      id: randomUUID(),
      rule_id: conversationId,
      metric_name: metricName,
      value,
      timestamp: Date.now(),
      metadata: JSON.stringify(metadata),
    },
  }));
}

export function parseAgentToolOutput(event: any): Record<string, unknown> | null {
  const structuredOutput = event?.result?.structuredOutput;
  if (structuredOutput && typeof structuredOutput === 'object' && !Array.isArray(structuredOutput)) {
    return structuredOutput as Record<string, unknown>;
  }
  const content = event?.result?.content;
  const text = Array.isArray(content)
    ? content.map((item: any) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (item?.json && typeof item.json === 'object') return JSON.stringify(item.json);
        return '';
      }).join('')
    : typeof content === 'string'
      ? content
      : content && typeof content === 'object'
        ? JSON.stringify(content)
        : '';
  const parsed = parseJsonValue(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

export type VerifiedToolContract = {
  toolName: string;
  contract: Record<string, unknown>;
};

/**
 * Convert a successful deep-web result into the same durable contract shape
 * used by the typed finance/RSS reconnaissance tools. A web search hit alone
 * is not a verified observation source; only an EXACT_MATCH dossier with a
 * live selector can authorize a WEB_OBSERVER pre-flight.
 */
export function buildVerifiedWebContract(
  toolName: string,
  output: Record<string, unknown> | null,
  toolInput?: Record<string, unknown>,
): Record<string, unknown> | null {
  if (toolName.toLowerCase() !== 'deep_web_research' || output?.status !== 'EXACT_MATCH') {
    return null;
  }
  const source = output.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const dossier = source as Record<string, unknown>;
  const targetSource = stringValue(dossier.url);
  const selector = stringValue(dossier.selector);
  if (!targetSource || !selector || dossier.isAccessible !== true || dossier.hasLiveTargetData !== true) {
    return null;
  }

  const evaluation = output.conditionEvaluation;
  const condition = evaluation && typeof evaluation === 'object' && !Array.isArray(evaluation)
    ? evaluation as Record<string, unknown>
    : dossier.conditionEvaluation && typeof dossier.conditionEvaluation === 'object' && !Array.isArray(dossier.conditionEvaluation)
      ? dossier.conditionEvaluation as Record<string, unknown>
      : undefined;
  return {
    targetType: 'WEB_OBSERVER',
    targetSource,
    selector,
    ...(typeof dossier.attribute === 'string' ? { attribute: dossier.attribute } : {}),
    ...(typeof dossier.valueRegex === 'string' ? { regex: dossier.valueRegex } : {}),
    ...(typeof toolInput?.targetDataKind === 'string' ? { targetDataKind: toolInput.targetDataKind } : {}),
    ...(typeof condition?.expectedOperator === 'string' ? { operator: condition.expectedOperator } : {}),
    ...(typeof condition?.targetValue === 'number' || typeof condition?.targetValue === 'string'
      ? { targetValue: condition.targetValue }
      : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizedIdentity(value: unknown): string | undefined {
  return stringValue(value)?.trim().toLowerCase();
}

/**
 * A pre-flight result is only meaningful when it verifies the same target
 * returned by a typed reconnaissance tool. Without this binding, a model can
 * call the probe on one target and synthesize a rule for another target.
 */
export function isPreflightBoundToVerifiedContract(
  preflight: Record<string, unknown> | undefined,
  verifiedContracts: readonly VerifiedToolContract[],
): boolean {
  if (!preflight || preflight.passed !== true) return false;
  const targetType = normalizedIdentity(preflight.targetType);
  const targetSource = normalizedIdentity(preflight.targetSource);
  if (!targetType || !targetSource) return false;

  return verifiedContracts.some(({ toolName, contract }) => {
    const tool = toolName.toLowerCase();
    const aliases = new Set<string>();
    if (tool === 'crypto_research' && targetType === 'crypto') {
      const asset = normalizedIdentity(contract.assetSymbol);
      if (asset) aliases.add(asset);
    } else if (tool === 'stock_research' && targetType === 'stock') {
      const ticker = normalizedIdentity(contract.ticker);
      if (ticker) aliases.add(ticker);
    } else if (tool === 'prediction_market_research' && targetType === 'prediction_market') {
      const conditionId = normalizedIdentity(contract.conditionId);
      const marketTitle = normalizedIdentity(contract.marketTitle);
      if (conditionId) aliases.add(conditionId);
      if (marketTitle) aliases.add(marketTitle);
    } else if (tool === 'rss_research' && targetType === 'rss_feed') {
      const feedUrl = normalizedIdentity(contract.feedUrl);
      if (feedUrl) aliases.add(feedUrl);
    } else if (tool === 'deep_web_research' && targetType === 'web_observer') {
      const source = normalizedIdentity(contract.targetSource ?? contract.url);
      if (source) aliases.add(source);
    }
    if (!aliases.has(targetSource)) return false;

    if (tool === 'deep_web_research' && targetType === 'web_observer') {
      const contractSelector = normalizedIdentity(contract.selector);
      const probeSelector = normalizedIdentity(preflight.selectorOrCondition);
      if (!contractSelector || !probeSelector || contractSelector !== probeSelector) return false;
    }

    // A successful probe must verify the same quote unit as the typed
    // reconnaissance contract. Otherwise BTC/USD could accidentally approve
    // a BTC/EUR task simply because the asset symbol matched.
    if (tool === 'crypto_research' || tool === 'stock_research') {
      const contractCurrency = normalizedIdentity(contract.currency);
      const probeCurrency = normalizedIdentity(preflight.currency ?? preflight.quoteCurrency);
      if (!contractCurrency || !probeCurrency || contractCurrency !== probeCurrency) return false;
    }
    return true;
  });
}

/**
 * Ensure the persisted synthesis still points at the source that actually
 * passed pre-flight. This protects the final durable boundary from a model
 * changing the target between the tool call and its JSON response.
 */
export function isSynthesisBoundToPreflight(
  subSentinels: readonly Pick<SubSentinel, 'sentinel_type' | 'target_source' | 'threshold'>[],
  preflight: Record<string, unknown> | undefined,
  verifiedContracts: readonly VerifiedToolContract[] = [],
): boolean {
  if (!preflight || preflight.passed !== true) return false;
  const targetType = normalizedIdentity(preflight.targetType);
  const targetSource = normalizedIdentity(preflight.targetSource);
  if (!targetType || !targetSource) return false;

  const expectedType = targetType === 'prediction_market'
    ? 'prediction_market'
    : targetType === 'rss_feed'
      ? 'rss_feed'
      : targetType === 'web_observer'
        ? 'web_observer'
        : targetType;
  return subSentinels.some((sub) => {
    if (normalizedIdentity(sub.sentinel_type) !== expectedType) return false;
    const synthesizedSource = normalizedIdentity(sub.target_source);
    if (synthesizedSource !== targetSource) {
      // Polymarket pre-flight reports the human-readable question while the
      // durable sub-sentinel uses the stable condition id.
      if (expectedType !== 'prediction_market' || !verifiedContracts.some(({ toolName, contract }) =>
        toolName.toLowerCase() === 'prediction_market_research' &&
        normalizedIdentity(contract.conditionId) === synthesizedSource &&
        normalizedIdentity(contract.marketTitle) === targetSource
      )) return false;
    }

    const threshold = parseJsonValue(sub.threshold);
    if (!threshold || typeof threshold !== 'object' || Array.isArray(threshold)) return false;
    const rawThreshold = threshold as Record<string, unknown>;
    if (expectedType === 'web_observer') {
      const thresholdUrl = normalizedIdentity(rawThreshold.url);
      if (thresholdUrl && thresholdUrl !== targetSource) return false;
      const probeSelector = normalizedIdentity(preflight.selectorOrCondition);
      if (probeSelector && normalizedIdentity(rawThreshold.selector) !== probeSelector) return false;
    }
    return true;
  });
}

/**
 * Compare the material fields of a synthesized watcher with the exact
 * reconnaissance contract. Target/source matching alone is insufficient:
 * changing a threshold or quote unit after verification would still create a
 * different task from the one the user approved.
 */
export function isSynthesisBoundToVerifiedContracts(
  subSentinels: readonly Pick<SubSentinel, 'sentinel_type' | 'target_source' | 'operator' | 'threshold'>[],
  verifiedContracts: readonly VerifiedToolContract[],
): boolean {
  if (verifiedContracts.length === 0 || subSentinels.length === 0) return false;
  return subSentinels.every((sub) => {
    const threshold = parseJsonValue(sub.threshold);
    if (!threshold || typeof threshold !== 'object' || Array.isArray(threshold)) return false;
    const rawThreshold = threshold as Record<string, unknown>;
    const subType = normalizedIdentity(sub.sentinel_type);
    const source = normalizedIdentity(sub.target_source);
    const operator = normalizedIdentity(sub.operator);
    return verifiedContracts.some(({ toolName, contract }) => {
      const tool = toolName.toLowerCase();
      const expectedType = tool === 'crypto_research'
        ? 'crypto'
        : tool === 'stock_research'
          ? 'stock'
          : tool === 'prediction_market_research'
            ? 'prediction_market'
            : tool === 'rss_research'
              ? 'rss_feed'
              : tool === 'deep_web_research'
                ? 'web_observer'
              : undefined;
      if (!expectedType || subType !== expectedType) return false;

      const contractSource = expectedType === 'crypto'
        ? normalizedIdentity(contract.assetSymbol)
        : expectedType === 'stock'
          ? normalizedIdentity(contract.ticker)
          : expectedType === 'prediction_market'
            ? normalizedIdentity(contract.conditionId)
            : expectedType === 'rss_feed'
              ? normalizedIdentity(contract.feedUrl)
              : normalizedIdentity(contract.targetSource ?? contract.url);
      if (!contractSource || contractSource !== source) return false;

      const contractEvaluation = contract.conditionEvaluation;
      const expectedOperator = contract.operator ||
        (contractEvaluation && typeof contractEvaluation === 'object'
          ? (contractEvaluation as Record<string, unknown>).expectedOperator
          : undefined);
      if (normalizedIdentity(expectedOperator) !== operator) return false;

      const materialNumber = expectedType === 'prediction_market'
        ? 'targetProbability'
        : 'targetValue';
      const expectedNumber = contract[materialNumber];
      if (typeof expectedNumber === 'number' && rawThreshold[materialNumber] !== expectedNumber) return false;
      if (expectedNumber === undefined && rawThreshold[materialNumber] !== undefined) return false;

      if (expectedType === 'crypto' || expectedType === 'stock') {
        if (typeof contract.currency !== 'string' ||
            normalizedIdentity(rawThreshold.currency) !== normalizedIdentity(contract.currency)) return false;
      }
      if (expectedType === 'web_observer') {
        if (normalizedIdentity(rawThreshold.selector) !== normalizedIdentity(contract.selector)) return false;
        if (contract.attribute !== undefined && rawThreshold.attribute !== contract.attribute) return false;
        if (contract.regex !== undefined && rawThreshold.regex !== contract.regex) return false;
      }
      if (expectedType !== 'web_observer' && typeof contract.targetType === 'string' && rawThreshold.targetType !== contract.targetType) return false;
      if (typeof contract.indicator === 'string' && rawThreshold.indicator !== contract.indicator) return false;
      if (typeof contract.candlestickPattern === 'string' && rawThreshold.candlestickPattern !== contract.candlestickPattern) return false;
      if (typeof contract.timeframe === 'string' && rawThreshold.timeframe !== contract.timeframe) return false;
      for (const field of [
        'venue', 'provider', 'exchange', 'dexContractAddress', 'dexNetwork',
        'marketHoursOnly', 'period', 'fastPeriod', 'slowPeriod', 'signalPeriod',
        'priceType', 'outcome', 'clobTokenId', 'matchMode', 'authorFilter',
        'semanticFilter', 'minViews', 'mediaOnly',
      ]) {
        if (contract[field] !== undefined && rawThreshold[field] !== contract[field]) return false;
      }
      if (expectedType === 'rss_feed' && Array.isArray(contract.keywords)) {
        const expectedKeywords = contract.keywords.map((value) => normalizedIdentity(value)).filter(Boolean).sort();
        const actualKeywords = Array.isArray(rawThreshold.keywords)
          ? rawThreshold.keywords.map((value) => normalizedIdentity(value)).filter(Boolean).sort()
          : [];
        if (JSON.stringify(actualKeywords) !== JSON.stringify(expectedKeywords)) return false;
      }
      return true;
    });
  });
}

function getVerifiedOperator(contract: Record<string, unknown>, toolName: string): string | undefined {
  const evaluation = contract.conditionEvaluation;
  const evaluationOperator = evaluation && typeof evaluation === 'object'
    ? stringValue((evaluation as Record<string, unknown>).expectedOperator)
    : undefined;
  const candidate = stringValue(contract.operator) || evaluationOperator ||
    (toolName === 'rss_research' ? 'KEYWORD_MATCH' : undefined);
  return candidate && SentinelOperatorEnum.safeParse(candidate).success ? candidate : undefined;
}

function isWorkflowChoiceLabel(value?: string): boolean {
  if (!value?.trim()) return false;
  const normalized = value.trim().toLowerCase().replace(/[.!?]+$/g, '');
  return new Set([
    'launch live reconnaissance',
    'modify this task',
    'apply these changes',
    'keep current task',
    'continuous monitoring',
    'one-time alert',
  ]).has(normalized);
}

export function buildVerifiedContractSynthesis(
  verified: VerifiedToolContract,
  userId: string,
  conversationId: string,
  originalIntent: string,
): ReturnType<typeof extractSynthesizedRule> {
  const toolName = verified.toolName.toLowerCase();
  const contract = verified.contract;
  const operator = getVerifiedOperator(contract, toolName);
  let sentinelType: string;
  let category: string;
  let targetSource: string | undefined;
  let title: string;

  switch (toolName) {
    case 'crypto_research': {
      const asset = stringValue(contract.assetSymbol);
      const currency = stringValue(contract.currency);
      if (!asset || !operator || !currency) return {};
      sentinelType = 'CRYPTO';
      category = 'CRYPTO';
      targetSource = asset;
      const target = numberValue(contract.targetValue);
      title = `${asset} ${operator.replaceAll('_', ' ').toLowerCase()} ${target === undefined ? 'live price' : `${target} ${currency}`}`;
      break;
    }
    case 'stock_research': {
      const ticker = stringValue(contract.ticker);
      if (!ticker || !operator) return {};
      sentinelType = 'STOCK';
      category = 'FINANCIAL';
      targetSource = ticker;
      const target = numberValue(contract.targetValue);
      title = `${ticker} ${operator.replaceAll('_', ' ').toLowerCase()} ${target === undefined ? 'live price' : target}`;
      break;
    }
    case 'prediction_market_research': {
      const conditionId = stringValue(contract.conditionId);
      const marketTitle = stringValue(contract.marketTitle) || 'Prediction market';
      if (!conditionId || !operator) return {};
      sentinelType = 'PREDICTION_MARKET';
      category = 'PREDICTION_MARKET';
      targetSource = conditionId;
      const target = numberValue(contract.targetProbability);
      title = `${marketTitle} ${operator.replaceAll('_', ' ').toLowerCase()} ${target === undefined ? 'the target probability' : `${Math.round(target * 100)}%`}`;
      break;
    }
    case 'rss_research': {
      const feedUrl = stringValue(contract.feedUrl);
      const keywords = Array.isArray(contract.keywords)
        ? contract.keywords.filter((keyword): keyword is string => typeof keyword === 'string' && keyword.trim().length > 0)
        : [];
      if (!feedUrl || keywords.length === 0 || !operator) return {};
      sentinelType = 'RSS_FEED';
      category = 'WEB_INTEL';
      targetSource = feedUrl;
      title = `Monitor ${keywords.slice(0, 3).join(', ')}`;
      break;
    }
    default:
      return {};
  }

  // The verified contract is the authoritative representation of the final
  // task after any edits/clarifications. Never let a UI choice label such as
  // "Launch live reconnaissance" become the persisted task intent.
  const contractQuery = stringValue(contract.query);
  const safeContractQuery = !isWorkflowChoiceLabel(contractQuery) ? contractQuery : undefined;
  const safeOriginalIntent = !isWorkflowChoiceLabel(originalIntent) ? originalIntent : undefined;
  const naturalLanguageIntent = safeContractQuery || safeOriginalIntent || title;

  const structured = {
    title: title.slice(0, 200),
    natural_language_intent: naturalLanguageIntent.slice(0, 4000),
    category,
    combinator: 'SINGLE',
    trigger_mode: 'PERSISTENT',
    audio_tone: 'chime',
    sub_sentinels: [{
      condition_key: 'A',
      sentinel_type: sentinelType,
      target_source: targetSource,
      operator,
      threshold: { ...contract, operator },
      ttl_seconds: 300,
    }],
  };

  return extractSynthesizedRule(JSON.stringify(structured), userId, conversationId);
}

/**
 * The Strands SDK wraps provider stream deltas in `event.event.delta` and
 * emits the assembled assistant message as `modelMessageEvent.message`.
 * Keep the transport adapter tolerant of both the current SDK shape and the
 * older flat shape used by local test doubles.
 */
export function extractAgentText(event: any): string {
  const eventType = event?.type;
  const delta = event?.event?.delta ?? event?.delta;
  if (
    (eventType === 'modelStreamUpdateEvent' || eventType === 'modelContentBlockDeltaEvent') &&
    delta?.type === 'textDelta' &&
    typeof delta.text === 'string'
  ) {
    return delta.text;
  }

  if (eventType === 'modelMessageEvent') {
    const content = event?.message?.content;
    if (Array.isArray(content)) {
      return content
        .filter((block: any) => block?.type === 'textBlock' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('');
    }
  }

  if (eventType === 'contentBlockEvent') {
    const contentBlock = event?.contentBlock;
    if (contentBlock?.type === 'textBlock' && typeof contentBlock.text === 'string') {
      return contentBlock.text;
    }
  }

  if (typeof event?.text === 'string') return event.text;
  if (typeof event?.delta?.text === 'string') return event.delta.text;
  return '';
}

const TERMINAL_RECONNAISSANCE_FAILURE_STATUSES = new Set([
  'ERROR',
  'TIMED_OUT',
  'CANCELLED',
]);

type AgentToolFailure = {
  toolName: string;
  message: string;
};

/**
 * Reads only the structured Strands/tool result contract. We deliberately do
 * not infer failure from model-generated text: a model apology is not a
 * workflow event and must never be used as a state-machine signal.
 */
function parseAgentToolFailure(
  event: any,
  toolNamesByUseId: Map<string, string>,
): AgentToolFailure | null {
  if (event?.type !== 'afterToolCallEvent' && event?.type !== 'toolResultEvent') {
    return null;
  }

  const result = event?.result;
  const toolUseId = typeof result?.toolUseId === 'string' ? result.toolUseId : undefined;
  const toolName =
    (typeof event?.toolUse?.name === 'string' && event.toolUse.name) ||
    (typeof event?.toolName === 'string' && event.toolName) ||
    (toolUseId ? toolNamesByUseId.get(toolUseId) : undefined) ||
    'reconnaissance tool';

  const structuredOutput = parseAgentToolOutput(event);
  const outcomeStatus = typeof structuredOutput?.status === 'string'
    ? structuredOutput.status
    : undefined;
  const sdkFailure = result?.status === 'error';
  const harnessFailure = outcomeStatus
    ? TERMINAL_RECONNAISSANCE_FAILURE_STATUSES.has(outcomeStatus)
    : false;

  if (!sdkFailure && !harnessFailure) return null;

  const structuredReason = structuredOutput?.error ?? structuredOutput?.reason;
  const sdkReason = result?.error?.message ?? event?.error?.message;
  const contentReason = Array.isArray(result?.content)
    ? result.content
      .map((item: any) => typeof item?.text === 'string' ? item.text : '')
      .filter(Boolean)
      .join(' ')
    : '';
  const reason = typeof structuredReason === 'string' && structuredReason.trim()
    ? structuredReason
    : typeof sdkReason === 'string' && sdkReason.trim()
      ? sdkReason
      : contentReason.trim()
        ? contentReason
      : 'The live data provider did not return a usable result.';

  return { toolName, message: reason };
}

async function answerReadOnlyQuestion(
  userContent: string,
  context: ConversationStateContext,
  category: 'TASK_STATUS_INQUIRY' | 'CONVERSATION_HISTORY_INQUIRY',
): Promise<string> {
  const answer = await answerConversationQuestion(userContent, context, category);
  if (!answer) return semanticAgentUnavailableMessage();
  if (!context.pendingInterrupt) return answer;

  // The agent owns the explanation, but a pending user action is a durable
  // protocol fact that must never be omitted from a read-only status answer.
  // This is presentation enrichment, not semantic intent classification.
  const lowerAnswer = answer.toLowerCase();
  if (lowerAnswer.includes('interrupt') || lowerAnswer.includes('confirmation') || lowerAnswer.includes('pending')) {
    return answer;
  }
  return `${answer}\n\nA pending interrupt is waiting for your action on the card shown below.`;
}

/**
 * Serialize message processing per conversation.
 * Queues messages so only one handler runs at a time per conversationId.
 */
export function withConversationLock(conversationId: string, fn: () => Promise<void>): Promise<void> {
  const prev = conversationLocks.get(conversationId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // always chain, even if prev rejects
  conversationLocks.set(conversationId, next);
  void next
    .finally(() => {
      if (conversationLocks.get(conversationId) === next) {
        conversationLocks.delete(conversationId);
      }
    })
    .catch(() => undefined);
  return next;
}

async function sendTaskEditFailure(
  socket: WebSocket,
  conversationId: string,
  rule: Rule | null,
  subSentinels: SubSentinel[],
  content: string,
): Promise<void> {
  const messageId = randomUUID();
  await chatMessageRepository.create({
    id: messageId,
    conversation_id: conversationId,
    role: 'assistant',
    content,
    created_at: Date.now(),
  });
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({
      type: 'AGENT_CHAT_DONE',
      payload: { messageId, content, phase: rule ? 'DEPLOYED' : 'DISCOVERY', rule, subSentinels },
    }));
  }
}

/**
 * Runs the semantic edit proposal loop for a deployed task. This function
 * only creates a durable clarification/confirmation card; it never changes
 * the rule or its scheduler state directly.
 */
async function handleTaskEditRequest(
  socket: WebSocket,
  user: User,
  conversationId: string,
  request: string,
): Promise<void> {
  const rules = await ruleRepository.getByConversationId(conversationId);
  const rule = rules.find((candidate) => candidate.user_id === user.id &&
    (candidate.status === 'ACTIVE' || candidate.status === 'TRIGGERED')) ?? null;
  if (!rule) {
    const content = 'I could not find an active Sentinel task to edit. Please open the deployed task and try again.';
    await sendTaskEditFailure(socket, conversationId, null, [], content);
    return;
  }
  const subSentinels = await subSentinelRepository.getByRuleId(rule.id);
  const recentMessages = await chatMessageRepository.getByConversationId(conversationId);
  sendAgentActivity(socket, conversationId, 'TASK_EDIT', {
    stage: 'STARTED',
    message: 'Interpreting the requested task change.',
  });

  const decision = await assessTaskEdit({
    request,
    rule,
    subSentinels,
    recentMessages,
  });
  if (decision.status === 'AI_UNAVAILABLE') {
    sendAgentActivity(socket, conversationId, 'TASK_EDIT', {
      stage: 'FAILED',
      message: 'The reasoning service could not interpret this task change.',
    }, 0);
    await sendTaskEditFailure(socket, conversationId, rule, subSentinels, semanticAgentUnavailableMessage());
    return;
  }

  if (decision.status === 'NEEDS_CLARIFICATION') {
    sendAgentActivity(socket, conversationId, 'TASK_EDIT', {
      stage: 'WAITING_FOR_CHOICE',
      message: 'A clarification choice is required before the task edit can be prepared.',
    });
    const clarification = await createClarificationInterrupt({
      conversationId,
      userId: user.id,
      ruleId: rule.id,
      expectedPhase: 'DEPLOYED',
      resumePhase: 'DEPLOYED',
      request: {
        question: decision.question,
        choices: decision.choices,
        field: 'task_edit_clarification',
        taskEditRequest: request,
      },
    });
    const content = `Before I can prepare that task change, I need one detail:\n\n${decision.question}`;
    const messageId = randomUUID();
    await chatMessageRepository.create({
      id: messageId,
      conversation_id: conversationId,
      role: 'assistant',
      content,
      created_at: Date.now(),
    });
    if (socket.readyState === socket.OPEN) {
      sendInterruptRequest(socket, clarification);
      socket.send(JSON.stringify({
        type: 'AGENT_CHAT_DONE',
        payload: { messageId, content, phase: 'CLARIFICATION_PENDING', rule, subSentinels },
      }));
    }
    return;
  }

  let prepared;
  try {
    prepared = prepareTaskEdit({
      rule,
      subSentinels,
      proposal: decision.proposal,
      now: Date.now(),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The proposed task change is not valid.';
    sendAgentActivity(socket, conversationId, 'TASK_EDIT', {
      stage: 'FAILED_VALIDATION',
      message: reason,
    }, 0);
    await sendTaskEditFailure(socket, conversationId, rule, subSentinels,
      `I understood the requested change, but I could not prepare a safe configuration: ${reason}. Please restate the exact condition change.`);
    return;
  }

  const proposal: TaskEditProposal = {
    ...decision.proposal,
    expected_rule_updated_at: rule.updated_at,
  };
  const editInterrupt = await createChoiceInterrupt({
    conversationId,
    userId: user.id,
    ruleId: rule.id,
    expectedPhase: 'DEPLOYED',
    resumePhase: 'DEPLOYED',
    actionType: 'TASK_EDIT_CONFIRMATION_REQUIRED',
    request: {
      kind: 'TASK_EDIT_CONFIRMATION_REQUIRED',
      question: `Review this change to “${rule.title}”: ${proposal.summary}`,
      field: 'task_edit_confirmation',
      choices: [
        {
          id: 'apply_edit',
          label: 'Apply these changes',
          description: 'Atomically update the task and restart evaluation with the new parameters.',
        },
        {
          id: 'cancel_edit',
          label: 'Keep current task',
          description: 'Discard this proposal and leave the deployed task unchanged.',
        },
      ],
      taskEdit: proposal,
      taskEditRequest: request,
    },
  });
  sendAgentActivity(socket, conversationId, 'TASK_EDIT', {
    stage: 'WAITING_FOR_CONFIRMATION',
    message: 'A task-change confirmation card is ready.',
  });
  const content = `I prepared the requested task change. Review the proposal on the card below and choose whether to apply it.`;
  const messageId = randomUUID();
  await chatMessageRepository.create({
    id: messageId,
    conversation_id: conversationId,
    role: 'assistant',
    content,
    created_at: Date.now(),
  });
  if (socket.readyState === socket.OPEN) {
    sendInterruptRequest(socket, editInterrupt);
    socket.send(JSON.stringify({
      type: 'AGENT_CHAT_DONE',
      payload: { messageId, content, phase: 'CLARIFICATION_PENDING', rule, subSentinels },
    }));
  }
}

export async function handleChatMessage(
  socket: WebSocket,
  user: User,
  conversationId: string,
  userContent: string,
  logger: FastifyBaseLogger,
  options?: {
    clarificationResume?: {
      question: string;
      choiceId: string;
      choiceLabel: string;
      responseText?: string;
      resumePhase: ConversationPhase;
      userMessageAlreadyPersisted?: boolean;
    };
    choiceResolution?: ChoiceResolution;
  }
): Promise<void> {
  const isInternalQueryConfirmation =
    options?.choiceResolution?.actionType === 'QUERY_CONFIRMATION_REQUIRED' &&
    options.choiceResolution.choiceId === 'confirm' &&
    Boolean(options.choiceResolution.interruptId);

  // 1. Quick check for Scouting read-only inquiries before taking the lock
  const conversation = await conversationRepository.getById(conversationId);
  const pendingForConversation = (await interruptActionRepository.getPendingByUserId(user.id))
    .some((interrupt) => interrupt.conversation_id === conversationId);
  if (
    conversation?.phase === 'SCOUTING' &&
    !pendingForConversation &&
    !options?.clarificationResume &&
    !options?.choiceResolution
  ) {
    const rules = await ruleRepository.getByConversationId(conversationId);
    const activeRule = rules[0] ?? null;
    const subSentinels = activeRule
      ? await subSentinelRepository.getByRuleId(activeRule.id)
      : [];
    const recentMessages = await chatMessageRepository.getByConversationId(conversationId);
    const inputCategory = await classifyUserInputWithAgent(userContent, {
      phase: 'SCOUTING',
      activeRule,
      subSentinels,
      recentMessages,
    });
    const isTaskQuestion = isReadOnlyQuestion(inputCategory);
    const content = inputCategory === 'AI_UNAVAILABLE'
      ? semanticAgentUnavailableMessage()
      : isTaskQuestion
      ? await answerReadOnlyQuestion(userContent, {
          phase: 'SCOUTING',
          activeRule,
          subSentinels,
          recentMessages,
        }, inputCategory)
      : generateLockedScopeResponse('SCOUTING');

    if (isTaskQuestion) {
      await chatMessageRepository.create({
        id: randomUUID(),
        conversation_id: conversationId,
        role: 'user',
        content: userContent,
        created_at: Date.now(),
      });
    }

    const messageId = randomUUID();
    await chatMessageRepository.create({
      id: messageId,
      conversation_id: conversationId,
      role: 'assistant',
      content,
      created_at: Date.now(),
    });

    if (socket.readyState === socket.OPEN) {
      socket.send(
        JSON.stringify({
          type: 'AGENT_CHAT_DONE',
          payload: { messageId, content, rule: activeRule, subSentinels },
        })
      );
    }
    return;
  }

  // 2. Serialized message processing
  await withConversationLock(conversationId, async () => {
    await reconcileExpiredInterrupts();

    // Check Interrupt Blockade
    const pendingList = await interruptActionRepository.getPendingByUserId(user.id);
    const activeInterrupt = pendingList.find((i) => i.conversation_id === conversationId);

    const isSameApprovedQueryInterrupt = Boolean(
      isInternalQueryConfirmation &&
      activeInterrupt &&
      activeInterrupt.id === options?.choiceResolution?.interruptId,
    );
    if (activeInterrupt && !isSameApprovedQueryInterrupt) {
      const pendingRule = activeInterrupt.rule_id
        ? await ruleRepository.getById(activeInterrupt.rule_id)
        : null;
      const inputCategory = await classifyUserInputWithAgent(userContent, {
        phase: 'INTERRUPT_PENDING',
        activeRule: pendingRule,
        pendingInterrupt: activeInterrupt,
      });
      const isTaskQuestion =
        inputCategory === 'TASK_STATUS_INQUIRY' ||
        inputCategory === 'CONVERSATION_HISTORY_INQUIRY';

      if (isTaskQuestion) {
        await chatMessageRepository.create({
          id: randomUUID(),
          conversation_id: conversationId,
          role: 'user',
          content: userContent,
          created_at: Date.now(),
        });
        const pendingSubs = pendingRule
          ? await subSentinelRepository.getByRuleId(pendingRule.id)
          : [];
        const summary = await answerReadOnlyQuestion(userContent, {
          phase: 'INTERRUPT_PENDING',
          activeRule: pendingRule,
          subSentinels: pendingSubs,
          pendingInterrupt: activeInterrupt,
          recentMessages: await chatMessageRepository.getByConversationId(conversationId),
        }, inputCategory);
        const assistantMsgId = randomUUID();
        await chatMessageRepository.create({
          id: assistantMsgId,
          conversation_id: conversationId,
          role: 'assistant',
          content: summary,
          created_at: Date.now(),
        });
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: 'AGENT_CHAT_DONE',
              payload: {
                messageId: assistantMsgId,
                content: summary,
                rule: pendingRule,
                subSentinels: pendingSubs,
              },
            })
          );
        }
        return;
      }

      if (isChoiceInterruptActionType(activeInterrupt.action_type)) {
        const blockMsg =
          `⚠️ **Action Required**: Please choose one of the options on the card above before continuing. ` +
          `Free-form task changes are paused until that choice is answered.`;
        const assistantMsgId = randomUUID();
        await chatMessageRepository.create({
          id: assistantMsgId,
          conversation_id: conversationId,
          role: 'assistant',
          content: blockMsg,
          created_at: Date.now(),
        });
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({
            type: 'INTERRUPT_REQUIRED',
            payload: { interruptId: activeInterrupt.id, message: blockMsg },
          }));
          socket.send(JSON.stringify({
            type: 'AGENT_CHAT_DONE',
            payload: { messageId: assistantMsgId, content: blockMsg, phase: 'CLARIFICATION_PENDING', rule: pendingRule, subSentinels: [] },
          }));
        }
        return;
      }

      // Text can never resolve an interrupt. Resolution is an explicit choice
      // action sent through RESOLVE_INTERRUPT, so the server cannot be tricked
      // into deploying from a natural-language message.
      const blockMsg =
        `⚠️ **Action Required**: Sentinel is currently awaiting your confirmation.\n\n` +
        `Please choose an action on the card above before sending new instructions.`;

      const assistantMsgId = randomUUID();
      await chatMessageRepository.create({
        id: assistantMsgId,
        conversation_id: conversationId,
        role: 'assistant',
        content: blockMsg,
        created_at: Date.now(),
      });

      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'INTERRUPT_REQUIRED',
            payload: {
              interruptId: activeInterrupt.id,
              message: blockMsg,
            },
          })
        );
        socket.send(
          JSON.stringify({
            type: 'AGENT_CHAT_DONE',
            payload: {
              messageId: assistantMsgId,
              content: blockMsg,
              rule: null,
              subSentinels: [],
            },
          })
        );
      }
      return;
    }

    // Recover a lifecycle card if an older process left the conversation in
    // AWAITING_TRIGGER_MODE without persisting the durable choice interrupt.
    // New flows create this card in the final pre-flight transaction below.
    const modeConversation = await conversationRepository.getById(conversationId);
    const hasWorkflowResume = Boolean(options?.choiceResolution || options?.clarificationResume);
    if (modeConversation && shouldRecoverQueryConfirmationCard(modeConversation.phase, hasWorkflowResume)) {
      // A card can be missing after a process crash between the phase update
      // and card insertion. Recreate the server-owned gate before any model
      // turn is allowed to run, so a stale phase can never bypass approval.
      const recoveredQueryCard = await ensureWorkflowChoiceInterrupt(conversationId, user.id, {
        allowWhileProcessing: true,
      });
      if (recoveredQueryCard) {
        const content = 'Your proposed monitor is ready for review. Choose an action on the card below.';
        const messageId = randomUUID();
        await chatMessageRepository.create({
          id: messageId,
          conversation_id: conversationId,
          role: 'assistant',
          content,
          created_at: Date.now(),
        });
        if (socket.readyState === socket.OPEN) {
          sendInterruptRequest(socket, recoveredQueryCard);
          socket.send(JSON.stringify({
            type: 'AGENT_CHAT_DONE',
            payload: { messageId, content, phase: 'CLARIFICATION_PENDING', rule: null, subSentinels: [] },
          }));
        }
        return;
      }
    }
    if (modeConversation?.phase === 'CLARIFICATION_PENDING') {
      // Never run a tool-enabled turn while the durable state says a human
      // choice is pending. If the card is gone, fail closed and let the user
      // restart from discovery rather than silently proceeding.
      await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
      const content = 'The previous action card expired or could not be recovered. Please describe the Sentinel task again.';
      const messageId = randomUUID();
      await chatMessageRepository.create({
        id: messageId,
        conversation_id: conversationId,
        role: 'assistant',
        content,
        created_at: Date.now(),
      });
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({
          type: 'AGENT_CHAT_DONE',
          payload: { messageId, content, phase: 'DISCOVERY', rule: null, subSentinels: [], interrupt: null },
        }));
      }
      return;
    }
    if (modeConversation?.phase === 'AWAITING_TRIGGER_MODE') {
      const modeRules = await ruleRepository.getByConversationId(conversationId);
      const stagedRule = modeRules.find((candidate) => candidate.status === 'PAUSED') ?? modeRules[0] ?? null;
      if (!stagedRule) {
        await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
        const recovery = 'The verified draft could not be recovered. Please describe the Sentinel task again.';
        const messageId = randomUUID();
        await chatMessageRepository.create({
          id: messageId,
          conversation_id: conversationId,
          role: 'assistant',
          content: recovery,
          created_at: Date.now(),
        });
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'AGENT_CHAT_DONE', payload: { messageId, content: recovery, phase: 'DISCOVERY', rule: null, subSentinels: [] } }));
        }
        return;
      }

      const modeSubSentinels = await subSentinelRepository.getByRuleId(stagedRule.id);
      const modeInterrupt = await createChoiceInterrupt({
        conversationId,
        userId: user.id,
        ruleId: stagedRule.id,
        expectedPhase: 'AWAITING_TRIGGER_MODE',
        resumePhase: 'AWAITING_TRIGGER_MODE',
        actionType: 'MONITORING_MODE_REQUIRED',
        request: {
          kind: 'MONITORING_MODE_REQUIRED',
          question: 'How should this verified Sentinel task run?',
          field: 'trigger_mode',
          choices: [
            {
              id: 'continuous_monitoring',
              label: 'Continuous monitoring',
              description: 'Keep checking future observations until you pause the task.',
            },
            {
              id: 'one_time_alert',
              label: 'One-time alert',
              description: 'Finish the task after the first committed alert.',
            },
          ],
        },
      });
      const content = 'Live pre-flight is complete. Choose an action on the card below to finish setup.';
      const messageId = randomUUID();
      await chatMessageRepository.create({
        id: messageId,
        conversation_id: conversationId,
        role: 'assistant',
        content,
        created_at: Date.now(),
      });
      if (socket.readyState === socket.OPEN) {
        sendInterruptRequest(socket, modeInterrupt);
        socket.send(JSON.stringify({
          type: 'AGENT_CHAT_DONE',
          payload: { messageId, content, phase: 'CLARIFICATION_PENDING', rule: stagedRule, subSentinels: modeSubSentinels },
        }));
      }
      return;
    }

    // Inspect conversation state and classify input
    const existingRules = await ruleRepository.getByConversationId(conversationId);
    const activeRule = existingRules.length > 0 ? existingRules[0] : null;
    const subSentinels = activeRule
      ? await subSentinelRepository.getByRuleId(activeRule.id)
      : [];
    const recentMessages = await chatMessageRepository.getByConversationId(conversationId);
    const recentAlerts = activeRule
      ? await alertEventRepository.getByUserId(user.id, 5, activeRule.id)
      : [];
    const recentTelemetry = activeRule
      ? await telemetryRepository.getByRuleId(activeRule.id, 10)
      : [];

    const convo = await conversationRepository.getById(conversationId);
    let phase: ConversationPhase = (convo?.phase as ConversationPhase) || 'DISCOVERY';
    // This is the phase that must still be current when the next durable
    // choice card is committed. It is deliberately separate from the local
    // workflow phase used to prompt the agent, so a reconnect cannot observe
    // an in-flight draft as if its confirmation card already existed.
    let expectedChoicePhase: ConversationPhase = phase;

    if (activeRule && (activeRule.status === 'ACTIVE' || activeRule.status === 'TRIGGERED')) {
      phase = 'DEPLOYED';
      if (convo && convo.phase !== 'DEPLOYED') {
        await conversationRepository.updatePhase(conversationId, 'DEPLOYED');
      }
    }

    const context: ConversationStateContext = {
      phase,
      activeRule,
      subSentinels,
      recentMessages,
      lastTelemetrySummary: JSON.stringify({
        recentAlerts: recentAlerts.map((a) => ({ id: a.id, title: a.title, createdAt: a.created_at })),
        recentTelemetry: recentTelemetry.map((t) => ({ metric: t.metric_name, value: t.value, timestamp: t.timestamp })),
      }),
    };

    const clarificationResume = options?.clarificationResume;
    const choiceResolution = options?.choiceResolution;
    if (clarificationResume) {
      sendAgentActivity(socket, conversationId, 'WORKFLOW', {
        stage: 'RESUMING_AFTER_CHOICE',
        message: 'Choice received. Preparing the updated task draft.',
      });
    }
    let inputCategory: UserInputCategory = clarificationResume || isInternalQueryConfirmation
      ? 'SENTINEL_INTENT'
      : await classifyUserInputWithAgent(userContent, context);
    if (inputCategory === 'AI_UNAVAILABLE') {
      const assistantMsgId = randomUUID();
      const content = semanticAgentUnavailableMessage();
      await chatMessageRepository.create({
        id: assistantMsgId,
        conversation_id: conversationId,
        role: 'assistant',
        content,
        created_at: Date.now(),
      });
      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'AGENT_CHAT_DONE',
            payload: {
              messageId: assistantMsgId,
              content,
              rule: activeRule ?? null,
              subSentinels,
            },
          })
        );
      }
      return;
    }

    // Query confirmation is a persisted card action. Free-form text can never
    // approve or reject the pre-scout gate.
    const isQueryConfirmation = isInternalQueryConfirmation;

    const shouldPersistUserMessage =
      inputCategory === 'SENTINEL_INTENT' ||
      inputCategory === 'TASK_MODIFICATION_ATTEMPT' ||
      inputCategory === 'TASK_STATUS_INQUIRY' ||
      inputCategory === 'CONVERSATION_HISTORY_INQUIRY' ||
      Boolean(clarificationResume && !clarificationResume.userMessageAlreadyPersisted) ||
      isQueryConfirmation ||
      (phase === 'AWAITING_QUERY_CONFIRMATION' && inputCategory !== 'OFF_TOPIC_BS');

    if (shouldPersistUserMessage) {
      await chatMessageRepository.create({
        id: randomUUID(),
        conversation_id: conversationId,
        role: 'user',
        content: userContent,
        created_at: Date.now(),
      });
    }

    // The first task draft is gated by a semantic completeness decision. The
    // Strands agent asks only for material missing information (for example a
    // crypto quote currency); it does not perform live/current-value
    // validation. This guarantees a card is persisted whenever a safe draft
    // cannot yet be formed, even if the main drafting agent would otherwise
    // guess a default.
    const shouldCheckCompleteness =
      !clarificationResume &&
      !choiceResolution &&
      (inputCategory === 'SENTINEL_INTENT' || inputCategory === 'TASK_MODIFICATION_ATTEMPT') &&
      (phase === 'DISCOVERY' || phase === 'AWAITING_QUERY_CONFIRMATION');
    if (shouldCheckCompleteness) {
      sendAgentActivity(socket, conversationId, 'INTENT_COMPLETENESS', {
        stage: 'STARTED',
        message: 'Checking whether the task contains all required details.',
      });
      const completeness = await assessIntentCompleteness({
        request: userContent,
        recentMessages,
      });
      if (completeness.status === 'AI_UNAVAILABLE') {
        sendAgentActivity(socket, conversationId, 'INTENT_COMPLETENESS', {
          stage: 'FAILED',
          message: 'The reasoning service could not complete the semantic check.',
        }, 0);
        const content = semanticAgentUnavailableMessage();
        const assistantMsgId = randomUUID();
        await chatMessageRepository.create({
          id: assistantMsgId,
          conversation_id: conversationId,
          role: 'assistant',
          content,
          created_at: Date.now(),
        });
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({
            type: 'AGENT_CHAT_DONE',
            payload: { messageId: assistantMsgId, content, phase, rule: activeRule ?? null, subSentinels },
          }));
        }
        return;
      }
      if (completeness.status === 'NEEDS_CLARIFICATION') {
        sendAgentActivity(socket, conversationId, 'INTENT_COMPLETENESS', {
          stage: 'WAITING_FOR_CHOICE',
          message: 'A clarification choice is required before the task can be drafted.',
        });
        const clarification = await createClarificationInterrupt({
          conversationId,
          userId: user.id,
          ruleId: activeRule?.id ?? null,
          expectedPhase: phase,
          resumePhase: phase,
          request: {
            question: completeness.question,
            choices: completeness.choices,
            field: completeness.field,
          },
        });
        const content = `Before I can prepare the monitor, I need one detail:\n\n${completeness.question}`;
        const assistantMsgId = randomUUID();
        await chatMessageRepository.create({
          id: assistantMsgId,
          conversation_id: conversationId,
          role: 'assistant',
          content,
          created_at: Date.now(),
        });
        if (socket.readyState === socket.OPEN) {
          sendInterruptRequest(socket, clarification);
          socket.send(JSON.stringify({
            type: 'AGENT_CHAT_DONE',
            payload: {
              messageId: assistantMsgId,
              content,
              phase: 'CLARIFICATION_PENDING',
              rule: activeRule ?? null,
              subSentinels,
            },
          }));
        }
        return;
      }
      sendAgentActivity(socket, conversationId, 'INTENT_COMPLETENESS', {
        stage: 'COMPLETE',
        message: 'The task contains enough information to prepare a draft.',
      });
    }

    let isDraftTurn = false;
    let agentInput = userContent;
    if (clarificationResume) {
      const priorTaskContext = recentMessages
        .filter((message) => message.role === 'user')
        .slice(-4)
        .map((message) => message.content)
        .join('\n');
      agentInput =
        `The prior task request was:\n<PRIOR_TASK_CONTEXT>\n${priorTaskContext.slice(0, 6000)}\n</PRIOR_TASK_CONTEXT>\n` +
        `The user answered your clarification question: "${clarificationResume.question}". ` +
        `They selected the choice "${clarificationResume.choiceLabel}" (choice id: ${clarificationResume.choiceId}). ` +
        (clarificationResume.responseText
          ? `Their exact manual response was: "${clarificationResume.responseText.slice(0, 4000)}". `
          : '') +
        `If the clarification field is a quote currency, pass the selected currency explicitly to the crypto_research tool; never substitute USD. ` +
        `Treat this selection as authoritative task context, do not ask the same question again, and continue the suspended workflow.`;
    }

    if (isReadOnlyQuestion(inputCategory)) {
      const summary = await answerReadOnlyQuestion(userContent, context, inputCategory);
      const assistantMsgId = randomUUID();
      await chatMessageRepository.create({
        id: assistantMsgId,
        conversation_id: conversationId,
        role: 'assistant',
        content: summary,
        created_at: Date.now(),
      });

      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'AGENT_CHAT_DONE',
            payload: {
              messageId: assistantMsgId,
              content: summary,
              rule: activeRule ?? null,
              subSentinels,
            },
          })
        );
      }
      return;
    }

    // A deployed task may be edited through a semantic proposal and an
    // explicit confirmation card. This is the only post-deployment write
    // path; all other free-form scope changes remain blocked.
    if (!clarificationResume && phase === 'DEPLOYED' && inputCategory === 'TASK_MODIFICATION_ATTEMPT') {
      await handleTaskEditRequest(socket, user, conversationId, userContent);
      return;
    }

    if (!clarificationResume && !isInternalQueryConfirmation && (phase === 'SCOUTING' || phase === 'INTERRUPT_PENDING' || phase === 'DEPLOYED')) {
      const lockedMsg = generateLockedScopeResponse(phase);
      const assistantMsgId = randomUUID();
      await chatMessageRepository.create({
        id: assistantMsgId,
        conversation_id: conversationId,
        role: 'assistant',
        content: lockedMsg,
        created_at: Date.now(),
      });

      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'AGENT_CHAT_DONE',
            payload: {
              messageId: assistantMsgId,
              content: lockedMsg,
              rule: activeRule ?? null,
              subSentinels,
            },
          })
        );
      }
      return;
    }

    if (!clarificationResume && inputCategory === 'OFF_TOPIC_BS' && !isQueryConfirmation) {
      const steerMsg = generateSteeringResponse(context);
      const assistantMsgId = randomUUID();
      await chatMessageRepository.create({
        id: assistantMsgId,
        conversation_id: conversationId,
        role: 'assistant',
        content: steerMsg,
        created_at: Date.now(),
      });

      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'AGENT_CHAT_DONE',
            payload: {
              messageId: assistantMsgId,
              content: steerMsg,
              rule: activeRule ?? null,
              subSentinels,
            },
          })
        );
      }
      return;
    }

    if (isInternalQueryConfirmation) {
      // Query approval atomically advances the durable conversation to
      // SCOUTING before this resume starts. Keep the explicit choice context
      // here so a reconnect/duplicate request cannot be mistaken for a
      // normal read-only message or a new draft.
      phase = 'SCOUTING';
      expectedChoicePhase = 'SCOUTING';
      const priorTaskContext = recentMessages
        .filter((message) => message.role === 'user')
        .slice(-4)
        .map((message) => message.content)
        .join('\n');
      agentInput =
        'The user confirmed the proposed Sentinel task. Proceed with reconnaissance, invoke the required pre-flight verification, and prepare the verified configuration card. ' +
        `Use this persisted task context as authoritative input:\n<PRIOR_TASK_CONTEXT>\n${priorTaskContext.slice(0, 6000)}\n</PRIOR_TASK_CONTEXT>`;
      await conversationRepository.updatePhase(conversationId, phase);
    } else if (clarificationResume) {
      if (phase === 'DISCOVERY') {
        expectedChoicePhase = clarificationResume.resumePhase;
        phase = 'AWAITING_QUERY_CONFIRMATION';
      }
      if (phase === 'DEPLOYED') {
        const lockedMsg = 'The task is already deployed, so this clarification answer was recorded but cannot change its locked configuration.';
        const assistantMsgId = randomUUID();
        await chatMessageRepository.create({ id: assistantMsgId, conversation_id: conversationId, role: 'assistant', content: lockedMsg, created_at: Date.now() });
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'AGENT_CHAT_DONE', payload: { messageId: assistantMsgId, content: lockedMsg, phase, rule: activeRule, subSentinels } }));
        return;
      }
      isDraftTurn = phase !== 'SCOUTING';
    } else if (phase === 'DISCOVERY') {
      if (inputCategory !== 'SENTINEL_INTENT') {
        const steerMsg = generateSteeringResponse(context);
        const assistantMsgId = randomUUID();
        await chatMessageRepository.create({
          id: assistantMsgId,
          conversation_id: conversationId,
          role: 'assistant',
          content: steerMsg,
          created_at: Date.now(),
        });
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: 'AGENT_CHAT_DONE',
              payload: { messageId: assistantMsgId, content: steerMsg, rule: null, subSentinels: [] },
            })
          );
        }
        return;
      }
      isDraftTurn = true;
      phase = 'AWAITING_QUERY_CONFIRMATION';
    } else if (phase === 'AWAITING_QUERY_CONFIRMATION') {
      if (inputCategory === 'OFF_TOPIC_BS') {
        const steerMsg = generateSteeringResponse(context);
        const assistantMsgId = randomUUID();
        await chatMessageRepository.create({
          id: assistantMsgId,
          conversation_id: conversationId,
          role: 'assistant',
          content: steerMsg,
          created_at: Date.now(),
        });
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: 'AGENT_CHAT_DONE',
              payload: { messageId: assistantMsgId, content: steerMsg, rule: null, subSentinels: [] },
            })
          );
        }
        return;
      } else {
        const blockMsg =
          'Please choose an option on the confirmation card above. The proposed task cannot be changed or resolved with free-form text at this stage.';
        const assistantMsgId = randomUUID();
        await chatMessageRepository.create({
          id: assistantMsgId,
          conversation_id: conversationId,
          role: 'assistant',
          content: blockMsg,
          created_at: Date.now(),
        });
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({
            type: 'AGENT_CHAT_DONE',
            payload: { messageId: assistantMsgId, content: blockMsg, rule: activeRule ?? null, subSentinels },
          }));
        }
        return;
      }
    }

    // Run SentinelAgent via Strands Agents SDK
    let sentinelAgent = isDraftTurn ? undefined : agentCache.get(conversationId);
    if (!sentinelAgent) {
      const sessionManager = new SessionManager({
        storage: getSessionStorage(),
        sessionId: conversationId,
      });
      sentinelAgent = new SentinelAgent({ sessionManager, enableTools: !isDraftTurn });
      if (!isDraftTurn) agentCache.set(conversationId, sentinelAgent);
    }

    let fullAssistantResponse = '';
    let agentStreamFailed = false;
    let agentToolFailure: AgentToolFailure | null = null;
    const invokedTools = new Set<string>();
    const toolNamesByUseId = new Map<string, string>();
    let preflightOutput: Record<string, unknown> | undefined;
    const verifiedToolContracts: VerifiedToolContract[] = [];
    let verifiedToolContract: VerifiedToolContract | undefined;
    let clarificationRequest: { question: string; choices: ClarificationChoice[]; field?: string } | null = null;
    const turnId = randomUUID();
    let streamSequence = 0;
    const streamController = new AbortController();
    const streamTimeout = setTimeout(() => streamController.abort(new Error('SCOUTING_TIMEOUT')), 120_000);
    const cancelStream = () => streamController.abort(new Error('CLIENT_DISCONNECTED'));
    socket.once('close', cancelStream);
    socket.once('error', cancelStream);

    try {
      for await (const event of sentinelAgent.agent.stream(agentInput, {
        cancelSignal: streamController.signal,
      })) {
        if (socket.readyState !== socket.OPEN) break;

        const eventAny = event as any;
        if (eventAny.toolName) invokedTools.add(String(eventAny.toolName));
        if (eventAny.toolUse?.name) {
          const toolName = String(eventAny.toolUse.name);
          invokedTools.add(toolName);
          if (eventAny.toolUse.toolUseId) {
            toolNamesByUseId.set(String(eventAny.toolUse.toolUseId), toolName);
          }
        }

        if (eventAny.type === 'afterToolCallEvent') {
          const toolOutput = parseAgentToolOutput(eventAny);
          const toolName = typeof eventAny.toolUse?.name === 'string'
            ? eventAny.toolUse.name
            : typeof eventAny.toolName === 'string'
              ? eventAny.toolName
              : undefined;
          if (
            toolName &&
            toolOutput?.status === 'EXACT_MATCH' &&
            toolOutput.contract &&
            typeof toolOutput.contract === 'object' &&
            !Array.isArray(toolOutput.contract)
          ) {
            const verified = {
              toolName,
              contract: toolOutput.contract as Record<string, unknown>,
            };
            if (!verifiedToolContracts.some((candidate) =>
              candidate.toolName === verified.toolName &&
              JSON.stringify(candidate.contract) === JSON.stringify(verified.contract)
            )) {
            verifiedToolContracts.push(verified);
            }
            verifiedToolContract = verified;
          } else if (toolName) {
            const webContract = buildVerifiedWebContract(
              toolName,
              toolOutput,
              eventAny.toolUse?.input && typeof eventAny.toolUse.input === 'object'
                ? eventAny.toolUse.input as Record<string, unknown>
                : undefined,
            );
            if (webContract) {
              const verified = { toolName, contract: webContract };
              if (!verifiedToolContracts.some((candidate) =>
                candidate.toolName === verified.toolName &&
                JSON.stringify(candidate.contract) === JSON.stringify(verified.contract)
              )) {
                verifiedToolContracts.push(verified);
              }
              verifiedToolContract = verified;
            }
          }
        }

        const toolFailure = parseAgentToolFailure(eventAny, toolNamesByUseId);
        if (toolFailure) {
          agentToolFailure = toolFailure;
          agentStreamFailed = true;
          logger.error(
            { toolName: toolFailure.toolName, error: toolFailure.message },
            'Reconnaissance tool returned a terminal failure result',
          );
          // Do not allow the model to turn an unavailable/failed live source
          // into a fabricated proposal or a second, unverified approach.
          streamController.abort(new Error('RECONNAISSANCE_TOOL_FAILED'));
          break;
        }

        const completedToolName = typeof eventAny.toolUse?.name === 'string'
          ? eventAny.toolUse.name
          : typeof eventAny.toolName === 'string'
            ? eventAny.toolName
            : undefined;
        if (eventAny.type === 'afterToolCallEvent' && completedToolName === 'request_clarification') {
          const output = parseAgentToolOutput(eventAny);
          const clarificationResult = ClarificationRequestPayloadSchema.safeParse({
            ...output,
            resume_phase: phase,
          });
          if (clarificationResult.success) {
            clarificationRequest = {
              question: clarificationResult.data.question,
              choices: clarificationResult.data.choices,
              field: clarificationResult.data.field,
            };
          } else {
            agentStreamFailed = true;
            logger.error({ error: clarificationResult.error.flatten() }, 'Agent returned an invalid clarification request');
          }
          break;
        }
        if (eventAny.type === 'afterToolCallEvent' && completedToolName === 'pre_flight_dry_run') {
          // Strands may expose a tool result as text, `{ json: ... }`, or a
          // directly structured content object. Use the shared adapter so a
          // successful dry run cannot be mistaken for a missing/failed one.
          preflightOutput = parseAgentToolOutput(eventAny) ?? undefined;
        }
        const modelText = extractAgentText(eventAny);
        const isIncrementalTextEvent =
          eventAny.type === 'modelStreamUpdateEvent' ||
          eventAny.type === 'modelContentBlockDeltaEvent' ||
          !eventAny.type;
        if (modelText && isIncrementalTextEvent) {
          fullAssistantResponse += modelText;
          socket.send(
            JSON.stringify({
              type: 'AGENT_CHAT_CHUNK',
              payload: { chunk: modelText, turnId, sequence: streamSequence++ },
            })
          );
        } else if (modelText && eventAny.type === 'modelMessageEvent' && !fullAssistantResponse) {
          // Some providers/local models do not emit incremental text deltas.
          // Use the assembled message as a single chunk instead of treating a
          // successful draft as an empty response.
          fullAssistantResponse = modelText;
          socket.send(
            JSON.stringify({
              type: 'AGENT_CHAT_CHUNK',
              payload: { chunk: modelText, turnId, sequence: streamSequence++ },
            })
          );
        } else if (event.type === 'beforeToolCallEvent' || event.type === 'toolStreamUpdateEvent') {
          const toolName = eventAny.toolUse?.name || eventAny.toolName || 'RECONNAISSANCE_PROBE';
          const streamData = eventAny.event?.data;
          const activityMetadata = streamData && typeof streamData === 'object'
            ? { ...streamData, stage: 'RUNNING', tool_name: toolName }
            : {
                stage: 'RUNNING',
                tool_name: toolName,
                input: eventAny.toolUse?.input || eventAny.arguments || {},
              };
          if (
            toolName !== 'request_clarification' &&
            ((phase as string) === 'DISCOVERY' || (phase as string) === 'AWAITING_QUERY_CONFIRMATION')
          ) {
            phase = 'SCOUTING';
            expectedChoicePhase = 'SCOUTING';
            await conversationRepository.updatePhase(conversationId, 'SCOUTING');
          }

          sendAgentActivity(socket, conversationId, toolName, activityMetadata);
        }
      }
    } catch (agentErr: any) {
      agentStreamFailed = true;
      logger.error({ err: agentErr }, 'Agent stream execution error');
      fullAssistantResponse += `\n[Agent Fault Recovery]: Handled gracefully (${agentErr.message || 'Stream timeout'}).`;
    } finally {
      clearTimeout(streamTimeout);
      socket.removeListener('close', cancelStream);
      socket.removeListener('error', cancelStream);
    }

    // Rule Synthesis Validation
    let rule: Rule | undefined;
    let synthesizedSubs: SubSentinel[] | undefined;
    let baselineValue: string | undefined;
    let extractedSeeds: string[] | undefined;
    let createdInterrupt: EnrichedInterruptAction | null = null;
    let workflowFailure = agentStreamFailed;

    if (clarificationRequest && !agentStreamFailed) {
      const queryConfirmationRequest = isQueryConfirmationRequest(clarificationRequest, phase);
      if (queryConfirmationRequest) {
        // Some model/provider combinations still call request_clarification
        // for the launch gate. Persist that card under the server-owned
        // workflow type so its approval follows the SCOUTING/tool-enabled
        // path on every client and after reconnects.
        createdInterrupt = await createChoiceInterrupt({
          conversationId,
          userId: user.id,
          ruleId: activeRule?.id ?? null,
          expectedPhase: expectedChoicePhase,
          resumePhase: 'AWAITING_QUERY_CONFIRMATION',
          actionType: 'QUERY_CONFIRMATION_REQUIRED',
          request: {
            ...clarificationRequest,
            kind: 'QUERY_CONFIRMATION_REQUIRED',
            field: 'query_confirmation',
          },
        });
      } else {
        createdInterrupt = await createClarificationInterrupt({
          conversationId,
          userId: user.id,
          ruleId: activeRule?.id ?? null,
          // During a draft turn, `phase` is advanced in memory to
          // AWAITING_QUERY_CONFIRMATION so the resumed agent knows where to
          // continue, while the durable conversation remains DISCOVERY until
          // this card is committed. The transaction must compare against the
          // persisted phase, not the in-memory resume phase.
          expectedPhase: expectedChoicePhase,
          resumePhase: phase,
          request: clarificationRequest,
        });
      }
      phase = 'CLARIFICATION_PENDING';
      const clarificationContent = [fullAssistantResponse.trim(), clarificationRequest.question]
        .filter(Boolean)
        .join('\n\n');
      const assistantMsgId = randomUUID();
      await chatMessageRepository.create({
        id: assistantMsgId,
        conversation_id: conversationId,
        role: 'assistant',
        content: clarificationContent,
        created_at: Date.now(),
      });
      if (socket.readyState === socket.OPEN) {
        sendInterruptRequest(socket, createdInterrupt);
        socket.send(JSON.stringify({
          type: 'AGENT_CHAT_DONE',
          payload: {
            messageId: assistantMsgId,
            content: clarificationContent,
            turnId,
            phase,
            rule: activeRule ?? null,
            subSentinels,
          },
        }));
      }
      return;
    }

    const preflightInvoked = invokedTools.has('pre_flight_dry_run');
    if (isDraftTurn && !agentStreamFailed) {
      const draftText = fullAssistantResponse.trim();
      if (!draftText) {
        // Never expose a confirmation gate without an actual proposal. This
        // can happen when a provider completes a stream without emitting text
        // chunks; the user must be returned to discovery safely.
        await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
        phase = 'DISCOVERY';
        agentCache.delete(conversationId);
        fullAssistantResponse =
          'I could not produce a complete monitor proposal after that choice. No task was changed; please submit the monitoring request again.';
        workflowFailure = true;
      } else {
        createdInterrupt = await createChoiceInterrupt({
          conversationId,
          userId: user.id,
          ruleId: activeRule?.id ?? null,
          expectedPhase: expectedChoicePhase,
          resumePhase: 'AWAITING_QUERY_CONFIRMATION',
          actionType: 'QUERY_CONFIRMATION_REQUIRED',
          request: {
            kind: 'QUERY_CONFIRMATION_REQUIRED',
            question: 'Review the proposed monitor and choose how to continue.',
            field: 'query_confirmation',
            choices: [
              {
                id: 'confirm',
                label: 'Launch live reconnaissance',
                description: 'Accept this draft and start live pre-flight verification.',
              },
              {
                id: 'modify',
                label: 'Modify this task',
                description: 'Keep the task in discovery and tell Sentinel what to change.',
              },
            ],
          },
        });
        phase = 'CLARIFICATION_PENDING';
        fullAssistantResponse =
          `${draftText}\n\n` +
          'Choose an action on the card below to continue.';
      }
    } else if (!agentStreamFailed && !preflightInvoked) {
      await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
      phase = 'DISCOVERY';
      agentCache.delete(conversationId);
      fullAssistantResponse =
        'I could not complete the required live pre-flight verification, so I have not created a deployment card. The task was safely reset and can be retried.';
      workflowFailure = true;
    } else if (!agentStreamFailed && preflightInvoked && preflightOutput?.passed !== true) {
      await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
      phase = 'DISCOVERY';
      agentCache.delete(conversationId);
      fullAssistantResponse =
        'The live pre-flight verification did not pass, so I have not created a deployment card. The task was safely reset and can be retried.';
      workflowFailure = true;
    } else if (!agentStreamFailed && preflightInvoked) {
      const preflightTargetType = stringValue(preflightOutput?.targetType)?.toUpperCase();
      const preflightBound = isPreflightBoundToVerifiedContract(preflightOutput, verifiedToolContracts);
      if (!preflightBound) {
        await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
        phase = 'DISCOVERY';
        agentCache.delete(conversationId);
        fullAssistantResponse =
          'Live verification completed without a verified reconnaissance contract for the same target. No task was deployed; please retry the request.';
        workflowFailure = true;
      }
    }

    if (!agentStreamFailed && !workflowFailure && preflightInvoked) {
      let extracted = extractSynthesizedRule(fullAssistantResponse, user.id, conversationId);
      // Some model providers follow the conversational part of the prompt
      // (for example, asking about monitoring mode) but omit the final JSON
      // bundle even though the reconnaissance tool returned a validated
      // contract. Reconstruct the persistence boundary from that verified
      // contract instead of discarding a successful live pre-flight run.
      const preflightVerifiedContract = verifiedToolContracts.find((candidate) =>
        isPreflightBoundToVerifiedContract(preflightOutput, [candidate])
      );
      if (!extracted.rule && (preflightVerifiedContract || verifiedToolContract)) {
        extracted = buildVerifiedContractSynthesis(
          preflightVerifiedContract || verifiedToolContract!,
          user.id,
          conversationId,
          userContent,
        );
      }
      rule = extracted.rule;
      synthesizedSubs = extracted.subSentinels;
      baselineValue = extracted.baselineValue;
      extractedSeeds = extracted.baselineSeeds;
      const synthesizedContractBound = Boolean(
        synthesizedSubs && isSynthesisBoundToVerifiedContracts(synthesizedSubs, verifiedToolContracts)
      );
      if (!rule || !synthesizedSubs ||
          !isSynthesisBoundToPreflight(synthesizedSubs, preflightOutput, verifiedToolContracts) ||
          !synthesizedContractBound) {
        rule = undefined;
        synthesizedSubs = undefined;
        await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
        phase = 'DISCOVERY';
        agentCache.delete(conversationId);
        fullAssistantResponse =
          'Reconnaissance completed, but the proposed configuration did not match the verified live target. No task was deployed; please retry with the same intent.';
        workflowFailure = true;
      }
      if ((!extractedSeeds || extractedSeeds.length === 0) && Array.isArray(preflightOutput?.baselineSeeds)) {
        extractedSeeds = preflightOutput.baselineSeeds.map(String);
      }
      if (!baselineValue && typeof preflightOutput?.baselineValue === 'string') {
        baselineValue = preflightOutput.baselineValue;
      }
    }

    if (agentStreamFailed) {
      await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
      phase = 'DISCOVERY';
      agentCache.delete(conversationId);
      fullAssistantResponse = agentToolFailure
        ? 'Live reconnaissance could not complete, so I have not changed or deployed the task. The conversation was reset safely and can be retried.'
        : 'Reconnaissance was interrupted before verification completed. No task was deployed; the conversation was reset safely and can be retried.';
      workflowFailure = true;
    }

    if (rule) {
      // The synthesized value is only a schema placeholder. Lifecycle is a
      // user-owned decision and is written only after the mode agent returns a
      // valid PERSISTENT or ONE_SHOT selection.
      const proposalRule: Rule = { ...rule, trigger_mode: 'PERSISTENT', status: 'PAUSED' };
      const baselineSeeds = extractedSeeds?.length
        ? extractedSeeds
        : (baselineValue ? [baselineValue] : []);
      const staged = await stageMonitoringModeProposal({
        rule: proposalRule,
        subSentinels: synthesizedSubs ?? [],
        baselineValue,
        baselineSeeds,
      });
      if (!staged) {
        throw new Error('Unable to atomically stage the monitoring-mode proposal');
      }
      rule = proposalRule;
      // stageMonitoringModeProposal durably advances the conversation to
      // AWAITING_TRIGGER_MODE before the choice card is inserted. Keep the
      // local phase aligned with that transaction boundary; otherwise the
      // card creation compares the database against the stale SCOUTING phase
      // and the user is left waiting with no lifecycle card.
      phase = 'AWAITING_TRIGGER_MODE';
      createdInterrupt = await createChoiceInterrupt({
        conversationId,
        userId: user.id,
        ruleId: proposalRule.id,
        expectedPhase: phase,
        resumePhase: 'AWAITING_TRIGGER_MODE',
        actionType: 'MONITORING_MODE_REQUIRED',
        request: {
          kind: 'MONITORING_MODE_REQUIRED',
          question: 'How should this verified Sentinel task run?',
          field: 'trigger_mode',
          choices: [
            {
              id: 'continuous_monitoring',
              label: 'Continuous monitoring',
              description: 'Keep checking future observations until you pause the task.',
            },
            {
              id: 'one_time_alert',
              label: 'One-time alert',
              description: 'Finish the task after the first committed alert.',
            },
          ],
        },
      });
      phase = 'CLARIFICATION_PENDING';
      const verifiedText = fullAssistantResponse.trim();
      fullAssistantResponse =
        verifiedText
          ? `${verifiedText}\n\nChoose an action on the card below to finish setup. Your choice confirms deployment.`
          : 'Live pre-flight is complete. Choose an action on the card below to finish setup. Your choice confirms deployment.';
    }

    const assistantMsgId = randomUUID();
    const finalAssistantContent = fullAssistantResponse || 'Sentinel standing by.';
    if (phase === 'CLARIFICATION_PENDING' && createdInterrupt?.action_type === 'QUERY_CONFIRMATION_REQUIRED') {
      sendAgentActivity(socket, conversationId, 'WORKFLOW', {
        stage: 'DRAFT_READY',
        message: 'Draft ready. Review the proposed monitor and choose an action on the card.',
      });
    } else if (phase === 'CLARIFICATION_PENDING' && createdInterrupt?.action_type === 'MONITORING_MODE_REQUIRED') {
      sendAgentActivity(socket, conversationId, 'WORKFLOW', {
        stage: 'LIFECYCLE_CHOICE_REQUIRED',
        message: 'Verification complete. Choose continuous monitoring or one-time alert.',
      });
    } else if (workflowFailure) {
      sendAgentActivity(socket, conversationId, 'WORKFLOW', {
        stage: 'FAILED',
        message: agentToolFailure
          ? 'Live reconnaissance failed. No task was changed or deployed.'
          : 'The workflow could not complete. No task was changed or deployed.',
        ...(agentToolFailure ? { tool_name: agentToolFailure.toolName } : {}),
      }, 0);
    }
    await chatMessageRepository.create({
      id: assistantMsgId,
      conversation_id: conversationId,
      role: 'assistant',
      content: finalAssistantContent,
      created_at: Date.now(),
    });

    if (socket.readyState === socket.OPEN) {
      if (createdInterrupt) {
        sendInterruptRequest(socket, createdInterrupt);
      }
      socket.send(
        JSON.stringify({
          type: 'AGENT_CHAT_DONE',
          payload: {
            messageId: assistantMsgId,
            content: finalAssistantContent,
            turnId,
            phase,
            rule: rule ?? null,
            subSentinels: synthesizedSubs ?? [],
          },
        })
      );
    }
  });
}

async function keepInterruptPendingWithFeedback(
  socket: WebSocket,
  conversationId: string,
  interrupt: EnrichedInterruptAction,
  feedback: string,
): Promise<void> {
  const updatedInterrupt = await updateChoiceInterruptFeedback(interrupt, feedback);
  if (!updatedInterrupt) {
    socket.send(JSON.stringify({
      type: 'ERROR',
      payload: { message: 'This interrupt was already resolved or expired. Reconnect to refresh the task.' },
    }));
    return;
  }

  const messageId = randomUUID();
  await chatMessageRepository.create({
    id: messageId,
    conversation_id: conversationId,
    role: 'assistant',
    content: feedback,
    created_at: Date.now(),
  });
  if (socket.readyState !== socket.OPEN) return;
  sendInterruptRequest(socket, updatedInterrupt);
  socket.send(JSON.stringify({
    type: 'AGENT_CHAT_DONE',
    payload: {
      messageId,
      content: feedback,
      phase: 'CLARIFICATION_PENDING',
      rule: null,
      subSentinels: [],
    },
  }));
}

export async function handleResolveInterrupt(
  socket: WebSocket,
  user: User,
  conversationId: string,
  interruptId: string,
  resolution: 'APPROVED' | 'REJECTED',
  choiceId: string,
  responseText: string | undefined,
  logger: FastifyBaseLogger,
): Promise<void> {
  let resumeTask: Promise<void> | undefined;
  await withConversationLock(conversationId, async () => {
    const interrupt = await interruptActionRepository.getById(interruptId);
    if (!interrupt) {
      socket.send(
        JSON.stringify({
          type: 'ERROR',
          payload: { message: 'Interrupt action not found' },
        })
      );
      return;
    }

    if (!choiceId.trim()) {
      socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Choose an action card option to resolve this interrupt' } }));
      return;
    }

    if (isChoiceInterruptActionType(interrupt.action_type)) {
      if (interrupt.conversation_id !== conversationId || interrupt.user_id !== user.id) {
        socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Interrupt action does not belong to this conversation' } }));
        return;
      }
      let selected = resolution === 'APPROVED' && choiceId
        ? findClarificationChoice(interrupt, choiceId)
        : null;
      if (resolution === 'REJECTED' && choiceId !== 'reject') {
        socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Use the dismiss choice on the clarification card' } }));
        return;
      }
      if (resolution === 'APPROVED' && !selected) {
        socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Choose one of the options shown on the clarification card' } }));
        return;
      }
      const payload = selected?.payload ?? parseChoiceInterruptPayload(interrupt);
      if (!payload) {
        socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Clarification payload is invalid or expired' } }));
        return;
      }

      // The shared card also exposes a footer cancel action. Treat it as the
      // explicit "keep current task" choice for edit proposals so both UI
      // affordances follow the same durable cancellation path.
      if (
        interrupt.action_type === 'TASK_EDIT_CONFIRMATION_REQUIRED' &&
        resolution === 'REJECTED' &&
        choiceId === 'reject'
      ) {
        selected = findClarificationChoice(interrupt, 'cancel_edit');
      }

      let resolvedResponseText: string | undefined;
      const manualInput = selected?.choice.input;
      if (manualInput?.kind === 'TEXT') {
        if (resolution !== 'APPROVED') {
          socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Submit the manual response with the approval action' } }));
          return;
        }
        const manualResponse = responseText?.trim() ?? '';
        if (!manualResponse) {
          socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Enter a response in the manual-answer card before submitting' } }));
          return;
        }
        if (manualResponse.length > (manualInput.max_length ?? 4000)) {
          socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'The manual response is longer than the interrupt allows' } }));
          return;
        }

        const assessment = await assessInterruptResponse({
          actionType: interrupt.action_type,
          question: payload.question,
          choices: payload.choices.filter((choice) => choice.id !== choiceId && choice.input?.kind !== 'TEXT'),
          taskContext: (await chatMessageRepository.getByConversationId(conversationId)).map((message) => ({
            role: message.role,
            content: message.content,
          })),
          response: manualResponse,
        });
        if (assessment.status === 'AI_UNAVAILABLE') {
          await keepInterruptPendingWithFeedback(
            socket,
            conversationId,
            interrupt,
            `I could not validate that response because the Sentinel reasoning agent is temporarily unavailable. Please try again; the interrupt is still waiting for your action.`,
          );
          return;
        }
        if (assessment.status === 'UNRESOLVED') {
          await keepInterruptPendingWithFeedback(
            socket,
            conversationId,
            interrupt,
            `Your previous action does not resolve the interrupt, please provide the exact response along with the original interrupt title: ${payload.question}`,
          );
          return;
        }

        resolvedResponseText = assessment.answer || manualResponse;
        if (assessment.choiceId) {
          const mapped = findClarificationChoice(interrupt, assessment.choiceId);
          if (!mapped || mapped.choice.input?.kind === 'TEXT') {
            await keepInterruptPendingWithFeedback(
              socket,
              conversationId,
              interrupt,
              `Your previous action does not resolve the interrupt, please provide the exact response along with the original interrupt title: ${payload.question}`,
            );
            return;
          }
          selected = mapped;
        } else if (interrupt.action_type !== 'CLARIFICATION_REQUIRED') {
          await keepInterruptPendingWithFeedback(
            socket,
            conversationId,
            interrupt,
            `Your previous action does not resolve the interrupt, please provide the exact response along with the original interrupt title: ${payload.question}`,
          );
          return;
        }

        // Keep the manual answer in the durable transcript. The resolved
        // event also carries it so the current device can render it without
        // manufacturing a second optimistic user message.
        await chatMessageRepository.create({
          id: randomUUID(),
          conversation_id: conversationId,
          role: 'user',
          content: resolvedResponseText,
          created_at: Date.now(),
        });
      }

      if (interrupt.action_type === 'TASK_EDIT_CONFIRMATION_REQUIRED') {
        if (!selected || (selected.choice.id !== 'apply_edit' && selected.choice.id !== 'cancel_edit')) {
          socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Choose Apply these changes or Keep current task' } }));
          return;
        }

        const currentRule = interrupt.rule_id
          ? await ruleRepository.getById(interrupt.rule_id)
          : null;
        const currentSubs = currentRule
          ? await subSentinelRepository.getByRuleId(currentRule.id)
          : [];
        const proposal = payload.task_edit;
        if (!currentRule || !proposal || proposal.expected_rule_updated_at === undefined) {
          await keepInterruptPendingWithFeedback(
            socket,
            conversationId,
            interrupt,
            'This task-change proposal is no longer complete. Please retry the edit so Sentinel can prepare a fresh proposal.',
          );
          return;
        }

        if (selected.choice.id === 'cancel_edit') {
          const resolved = await interruptActionRepository.resolveClarification({
            interruptId,
            conversationId,
            userId: user.id,
            resolution: 'REJECTED',
            resumePhase: 'DEPLOYED',
            now: Date.now(),
          });
          if (!resolved) {
            socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'This task-change proposal was already resolved or expired' } }));
            return;
          }
          socket.send(JSON.stringify({
            type: 'INTERRUPT_RESOLVED',
            payload: {
              interruptId,
              resolution: 'REJECTED',
              actionResult: 'Task changes cancelled',
              resolvedAt: Date.now(),
              choiceId: selected.choice.id,
              ...(resolvedResponseText ? { responseText: resolvedResponseText } : {}),
            },
          }));
          const messageId = randomUUID();
          const content = 'No changes were applied. The deployed Sentinel task remains unchanged.';
          await chatMessageRepository.create({
            id: messageId,
            conversation_id: conversationId,
            role: 'assistant',
            content,
            created_at: Date.now(),
          });
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({
              type: 'AGENT_CHAT_DONE',
              payload: { messageId, content, phase: 'DEPLOYED', rule: currentRule, subSentinels: currentSubs, interrupt: null },
            }));
          }
          return;
        }

        if (proposal.expected_rule_updated_at !== currentRule.updated_at) {
          await keepInterruptPendingWithFeedback(
            socket,
            conversationId,
            interrupt,
            'This task changed on another device while the proposal was open. The card is still pending; please cancel it and submit the edit again to review the latest task.',
          );
          return;
        }

        let prepared;
        try {
          prepared = prepareTaskEdit({
            rule: currentRule,
            subSentinels: currentSubs,
            proposal,
            now: Date.now(),
          });
        } catch (error) {
          await keepInterruptPendingWithFeedback(
            socket,
            conversationId,
            interrupt,
            `The task edit could not be applied safely: ${error instanceof Error ? error.message : 'invalid task configuration'}. Please cancel this proposal and try again.`,
          );
          return;
        }

        const committed = await commitTaskEdit({
          interruptId,
          conversationId,
          userId: user.id,
          expectedRuleUpdatedAt: proposal.expected_rule_updated_at,
          prepared,
          now: Date.now(),
        });
        if (!committed) {
          await keepInterruptPendingWithFeedback(
            socket,
            conversationId,
            interrupt,
            'The task changed before this proposal could be committed. The confirmation is still pending; review the latest task and submit a fresh edit.',
          );
          return;
        }

        agentCache.delete(conversationId);
        const updatedRule = await ruleRepository.getById(currentRule.id) ?? prepared.rule;
        const updatedSubs = await subSentinelRepository.getByRuleId(currentRule.id);
        socket.send(JSON.stringify({
          type: 'INTERRUPT_RESOLVED',
          payload: {
            interruptId,
            resolution: 'APPROVED',
            actionResult: `Applied: ${proposal.summary}`,
            resolvedAt: Date.now(),
            choiceId: selected.choice.id,
            ...(resolvedResponseText ? { responseText: resolvedResponseText } : {}),
          },
        }));
        const messageId = randomUUID();
        const content = `✅ **Task updated**\n\n${proposal.summary}\n\nEvaluation has been restarted with the updated parameters.`;
        await chatMessageRepository.create({
          id: messageId,
          conversation_id: conversationId,
          role: 'assistant',
          content,
          created_at: Date.now(),
        });
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({
            type: 'AGENT_CHAT_DONE',
            payload: { messageId, content, phase: 'DEPLOYED', rule: updatedRule, subSentinels: updatedSubs, interrupt: null },
          }));
        }
        return;
      }

      const legacyQueryConfirmationLaunch = isLegacyQueryConfirmationLaunch(
        interrupt.action_type,
        payload,
        selected?.choice,
      );
      const isQueryConfirmationAction =
        interrupt.action_type === 'QUERY_CONFIRMATION_REQUIRED' || legacyQueryConfirmationLaunch;
      const selectedLaunchChoice = Boolean(
        selected && (selected.choice.id === 'confirm' || isLaunchReconnaissanceChoice(selected.choice)),
      );

      // Resolve requests are retried by reconnecting clients. Once a choice
      // card is no longer pending, acknowledge the durable result before any
      // phase-repair logic runs; otherwise a valid duplicate can be rejected
      // as a stale card after the conversation has already entered SCOUTING.
      if (interrupt.status === 'APPROVED' || interrupt.status === 'REJECTED') {
        if (interrupt.status === 'APPROVED' && isQueryConfirmationAction) {
          const currentConversation = await conversationRepository.getById(conversationId);
          if (currentConversation?.phase === 'SCOUTING') {
            const lease = await claimQueryReconnaissanceLease(interruptId);
            if (lease) {
              const selectedLabel = selected?.choice.label ?? 'Launch live reconnaissance';
              resumeTask = startQueryReconnaissanceResume(
                socket,
                user,
                conversationId,
                interruptId,
                selectedLabel,
                responseText?.trim() || undefined,
                logger,
                lease,
              );
            }
          }
        }
        socket.send(JSON.stringify({
          type: 'INTERRUPT_RESOLVED',
          payload: {
            interruptId,
            resolution: interrupt.status,
            actionResult: interrupt.status === 'APPROVED'
              ? 'This action was already approved and is continuing from the existing workflow run.'
              : 'This action was already dismissed; no additional workflow was started.',
            resolvedAt: interrupt.resolved_at ?? Date.now(),
            choiceId,
          },
        }));
        return;
      }

      // Older/local builds could persist the card and then reset the
      // conversation phase when the draft stream failed. Re-open that exact
      // user-owned gate atomically before resolving it; otherwise the resolver
      // correctly rejects the card because it sees DISCOVERY instead of
      // CLARIFICATION_PENDING, which looks like a dead button on mobile.
      const currentConversation = await conversationRepository.getById(conversationId);
      if (currentConversation?.phase !== 'CLARIFICATION_PENDING') {
        if (!currentConversation || !isInterruptRecoveryPhaseAllowed(
          interrupt.action_type,
          payload,
          currentConversation.phase,
        )) {
          socket.send(JSON.stringify({
            type: 'ERROR',
            payload: { message: 'This interrupt is stale for the current workflow phase. Reopen the conversation to receive the current action card.' },
          }));
          return;
        }
        const restored = await interruptActionRepository.restorePendingClarification({
          interruptId,
          conversationId,
          userId: user.id,
          now: Date.now(),
        });
        if (!restored) {
          socket.send(JSON.stringify({
            type: 'ERROR',
            payload: { message: 'This interrupt is no longer attached to an active workflow. Reopen the conversation to receive the current action card.' },
          }));
          return;
        }
      }

      const resumePhase: ConversationPhase = isQueryConfirmationAction
        ? resolution === 'APPROVED' && selectedLaunchChoice
          ? 'SCOUTING'
          : 'DISCOVERY'
        : interrupt.action_type === 'MONITORING_MODE_REQUIRED'
          ? resolution === 'APPROVED'
            ? 'AWAITING_TRIGGER_MODE'
            : 'DISCOVERY'
          : payload.resume_phase;
      const resolved = await interruptActionRepository.resolveClarification({
        interruptId,
        conversationId,
        userId: user.id,
        resolution,
        resumePhase,
        now: Date.now(),
      });
      if (!resolved) {
        // A reconnect or an offline queue can legitimately deliver the same
        // resolution more than once. The first transaction owns the state
        // transition; later deliveries are acknowledged as idempotent no-ops
        // and must never start another agent turn.
        const current = await interruptActionRepository.getById(interruptId);
        if (
          current &&
          current.user_id === user.id &&
          current.conversation_id === conversationId &&
          (current.status === 'APPROVED' || current.status === 'REJECTED')
        ) {
          socket.send(JSON.stringify({
            type: 'INTERRUPT_RESOLVED',
            payload: {
              interruptId,
              resolution: current.status,
              actionResult: current.status === 'APPROVED'
                ? 'This action was already approved and is continuing from the existing workflow run.'
                : 'This action was already dismissed; no additional workflow was started.',
              resolvedAt: current.resolved_at ?? Date.now(),
              choiceId,
            },
          }));
          return;
        }
        socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'This clarification was already resolved or expired' } }));
        return;
      }
      const queryResumeLease = isQueryConfirmationAction && resolution === 'APPROVED' && selectedLaunchChoice
        ? await claimQueryReconnaissanceLease(interruptId)
        : null;
      socket.send(JSON.stringify({
        type: 'INTERRUPT_RESOLVED',
        payload: {
          interruptId,
          resolution,
          actionResult: selected ? `Selected: ${selected.choice.label}` : 'Clarification dismissed',
          resolvedAt: Date.now(),
          choiceId: selected?.choice.id ?? 'reject',
          ...(resolvedResponseText ? { responseText: resolvedResponseText } : {}),
        },
      }));
      // Draft query confirmations do not cache a tool-enabled agent. Preserve
      // an explicitly prepared resume agent so the atomic approval can enter
      // reconnaissance immediately; other card types still invalidate stale
      // agent sessions before resuming.
      if (!isQueryConfirmationAction) agentCache.delete(conversationId);

      if (isQueryConfirmationAction) {
        if (resolution === 'APPROVED' && selectedLaunchChoice) {
          const selectedLabel = selected?.choice.label ?? 'Launch live reconnaissance';
          if (queryResumeLease) {
            resumeTask = startQueryReconnaissanceResume(
              socket,
              user,
              conversationId,
              interruptId,
              selectedLabel,
              resolvedResponseText,
              logger,
              queryResumeLease,
            );
          }
        } else {
          const content = resolution === 'APPROVED'
            ? 'Tell me what you would like to change in the proposed Sentinel task.'
            : 'The proposed Sentinel task was cancelled. Tell me what you would like to monitor.';
          const messageId = randomUUID();
          await chatMessageRepository.create({
            id: messageId,
            conversation_id: conversationId,
            role: 'assistant',
            content,
            created_at: Date.now(),
          });
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({
              type: 'AGENT_CHAT_DONE',
              payload: { messageId, content, phase: 'DISCOVERY', rule: null, subSentinels: [], interrupt: null },
            }));
          }
        }
        return;
      }

      if (interrupt.action_type === 'MONITORING_MODE_REQUIRED') {
        const stagedRule = interrupt.rule_id ? await ruleRepository.getById(interrupt.rule_id) : null;
        if (resolution === 'APPROVED' && selected && stagedRule) {
          const triggerMode = selected.choice.id === 'continuous_monitoring' ? 'PERSISTENT' :
            selected.choice.id === 'one_time_alert' ? 'ONE_SHOT' : null;
          if (!triggerMode) {
            socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Choose one of the monitoring modes shown on the card' } }));
            return;
          }
          let result;
          try {
            result = await deployMonitoringModeProposal({
              conversationId,
              userId: user.id,
              ruleId: stagedRule.id,
              triggerMode,
            });
          } catch (error) {
            // The interrupt and phase transition are durable, but scheduler
            // registration/deployment can still fail after that transaction.
            // Recreate the exact lifecycle card instead of leaving the user
            // with a resolved button and no way to retry.
            logger.error({ err: error, conversationId, ruleId: stagedRule.id }, 'Monitoring-mode deployment failed after choice resolution');
            const retryCard = await ensureWorkflowChoiceInterrupt(conversationId, user.id, {
              allowWhileProcessing: true,
            });
            const currentRule = await ruleRepository.getById(stagedRule.id);
            const currentConversation = await conversationRepository.getById(conversationId);
            const alreadyDeployed = currentRule?.status === 'ACTIVE';
            const retryMessage = alreadyDeployed
              ? `This Sentinel task was already deployed for ${currentRule?.trigger_mode === 'PERSISTENT' ? 'continuous monitoring' : 'one-time alerting'} on another request.`
              : 'The monitoring mode could not be deployed yet. No task was changed; choose a mode again when the execution service is available.';
            const retryMessageId = randomUUID();
            await chatMessageRepository.create({
              id: retryMessageId,
              conversation_id: conversationId,
              role: 'assistant',
              content: retryMessage,
              created_at: Date.now(),
            });
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({
                type: 'AGENT_CHAT_DONE',
                payload: {
                  messageId: retryMessageId,
                  content: retryMessage,
                  phase: alreadyDeployed ? 'DEPLOYED' : retryCard ? 'CLARIFICATION_PENDING' : currentConversation?.phase ?? 'DISCOVERY',
                  rule: currentRule ?? stagedRule,
                  subSentinels: await subSentinelRepository.getByRuleId((currentRule ?? stagedRule).id),
                },
              }));
              if (retryCard) sendInterruptRequest(socket, retryCard);
            }
            return;
          }
          const messageId = randomUUID();
          await chatMessageRepository.create({
            id: messageId,
            conversation_id: conversationId,
            role: 'assistant',
            content: result.message,
            created_at: Date.now(),
          });
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({
              type: 'AGENT_CHAT_DONE',
              payload: {
                messageId,
                content: result.message,
                phase: 'DEPLOYED',
                rule: result.rule,
                subSentinels: result.subSentinels,
                interrupt: null,
              },
            }));
          }
        } else {
          if (stagedRule?.status === 'PAUSED') {
            await ruleRepository.updateStatus(stagedRule.id, 'DISMISSED');
          }
          const content = 'The Sentinel task setup was cancelled. No monitor was deployed.';
          const messageId = randomUUID();
          await chatMessageRepository.create({
            id: messageId,
            conversation_id: conversationId,
            role: 'assistant',
            content,
            created_at: Date.now(),
          });
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({
              type: 'AGENT_CHAT_DONE',
              payload: { messageId, content, phase: 'DISCOVERY', rule: null, subSentinels: [], interrupt: null },
            }));
          }
        }
        return;
      }

      if (payload.field === 'task_edit_clarification' || payload.task_edit_request) {
        if (resolution === 'REJECTED' && !selected) {
          const currentRule = interrupt.rule_id ? await ruleRepository.getById(interrupt.rule_id) : null;
          const currentSubs = currentRule ? await subSentinelRepository.getByRuleId(currentRule.id) : [];
          const messageId = randomUUID();
          const content = 'The task edit was cancelled. The deployed Sentinel task remains unchanged.';
          await chatMessageRepository.create({
            id: messageId,
            conversation_id: conversationId,
            role: 'assistant',
            content,
            created_at: Date.now(),
          });
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({
              type: 'AGENT_CHAT_DONE',
              payload: { messageId, content, phase: 'DEPLOYED', rule: currentRule, subSentinels: currentSubs, interrupt: null },
            }));
          }
          return;
        }
        const clarificationAnswer = resolvedResponseText || selected?.choice.label || '';
        const taskEditRequest = `${payload.task_edit_request || ''}\nThe user clarified: ${clarificationAnswer}`.slice(0, 12000);
        if (!resolvedResponseText && selected) {
          await chatMessageRepository.create({
            id: randomUUID(),
            conversation_id: conversationId,
            role: 'user',
            content: selected.choice.label,
            created_at: Date.now(),
          });
        }
        await handleTaskEditRequest(socket, user, conversationId, taskEditRequest);
        return;
      }

      if (selected) {
        resumeTask = handleChatMessage(
          socket,
          user,
          conversationId,
          resolvedResponseText || selected.choice.label,
          logger,
          {
            clarificationResume: {
              question: payload.question,
              choiceId: selected.choice.id,
              choiceLabel: resolvedResponseText || selected.choice.label,
              responseText: resolvedResponseText,
              resumePhase: payload.resume_phase,
              userMessageAlreadyPersisted: Boolean(resolvedResponseText),
            },
          },
        );
      }
      return;
    }

    if (!interrupt.rule_id) {
      socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'This interrupt is not a deployment action' } }));
      return;
    }

    const expectedChoiceId = resolution === 'APPROVED' ? 'approve' : 'reject';
    if (choiceId !== expectedChoiceId) {
      socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Use one of the action choices shown on the interrupt card' } }));
      return;
    }

    const result = await resolveDeploymentProposal({
      interrupt,
      resolution,
      conversationId,
      userId: user.id,
    });
    agentCache.delete(conversationId);
    emitDeploymentResolution(socket, interrupt, resolution, choiceId, result);
  });
  if (resumeTask) {
    try {
      await resumeTask;
    } catch (error) {
      logger.error({ err: error, conversationId }, 'Interrupt resume workflow failed');
      await conversationRepository.updatePhase(conversationId, 'DISCOVERY');
      sendAgentActivity(socket, conversationId, 'WORKFLOW', {
        stage: 'FAILED',
        message: 'The confirmed workflow could not complete. No task was deployed; you can retry the request.',
      }, 0);
      const messageId = randomUUID();
      const content = 'The confirmed workflow could not complete. No task was deployed; please retry the request.';
      await chatMessageRepository.create({
        id: messageId,
        conversation_id: conversationId,
        role: 'assistant',
        content,
        created_at: Date.now(),
      });
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({
          type: 'AGENT_CHAT_DONE',
          payload: { messageId, content, phase: 'DISCOVERY', rule: null, subSentinels: [], interrupt: null },
        }));
      }
    }
  }
}
