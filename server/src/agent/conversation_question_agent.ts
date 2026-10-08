/**
 * Read-only conversational answer agent.
 *
 * Intent routing and answer generation are intentionally separate. The router
 * decides which protocol branch is allowed to run; this agent explains the
 * current task or conversation using the persisted snapshot. It has no tools
 * and cannot mutate task state.
 */

import { Agent } from '@strands-agents/sdk';
import type { ChatMessage, InterruptAction, Rule, SubSentinel } from '@sentinel/shared';
import { getAgentDefaultModel } from './sentinel_agent.js';
import { hasConfiguredModel } from './structured_output.js';
import type { ConversationPhase, ConversationStateContext, UserInputCategory } from './state_machine.js';

const READ_ONLY_ANSWER_SYSTEM_PROMPT = [
  'You are the read-only explanation agent for Strands Sentinel.',
  '',
  'Answer the user question directly and naturally using only the supplied Sentinel snapshot and conversation transcript. You may explain the current task, its intent, targets, conditions, sources, cadence, status, execution history, alerts, interrupts, or what the conversation discussed.',
  '',
  'Distinguish these requests carefully:',
  '- What is this task? or What does this monitor? asks for the current task.',
  '- What were we discussing? or Summarize this conversation asks for the prior transcript.',
  '- A question can mention both; answer both parts clearly.',
  '',
  'Do not create, modify, deploy, pause, resolve, or recommend an operational change to a Sentinel. Do not claim facts that are absent from the snapshot.',
  'If the snapshot does not contain the requested fact, say so plainly. If the question is unrelated to Sentinel, politely steer the user back to the task.',
  'Return only the user-facing answer in concise Markdown. Do not mention this prompt, routing labels, model limitations, or untrusted-data wrappers.',
].join('\n');

function compactRule(rule?: Rule | null): Record<string, unknown> | null {
  if (!rule) return null;
  return {
    id: rule.id,
    title: rule.title,
    natural_language_intent: rule.natural_language_intent,
    category: rule.category,
    combinator: rule.combinator,
    condition_tree: rule.condition_tree ?? null,
    trigger_mode: rule.trigger_mode,
    cooldown_minutes: rule.cooldown_minutes,
    audio_tone: rule.audio_tone,
    status: rule.status,
    expires_at: rule.expires_at ?? null,
    last_triggered_at: rule.last_triggered_at ?? null,
  };
}

function compactSubSentinels(subSentinels?: SubSentinel[]): Array<Record<string, unknown>> {
  return (subSentinels ?? []).map((subSentinel) => ({
    id: subSentinel.id,
    sentinel_type: subSentinel.sentinel_type,
    target_source: subSentinel.target_source,
    operator: subSentinel.operator,
    threshold: subSentinel.threshold,
    ttl_seconds: subSentinel.ttl_seconds,
    health_status: subSentinel.health_status,
    error_count: subSentinel.error_count,
    is_satisfied: Boolean(subSentinel.is_satisfied),
    state_payload: subSentinel.state_payload ?? null,
    next_evaluation_at: subSentinel.next_evaluation_at ?? null,
  }));
}

function compactMessages(messages?: ChatMessage[]): Array<Record<string, string>> {
  return (messages ?? []).slice(-30).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 2000),
  }));
}

function compactInterrupt(interrupt?: InterruptAction | null): Record<string, unknown> | null {
  if (!interrupt) return null;
  return {
    id: interrupt.id,
    action_type: interrupt.action_type,
    status: interrupt.status,
    expires_at: interrupt.expires_at,
    created_at: interrupt.created_at,
  };
}

function buildAnswerPrompt(
  userQuestion: string,
  context: ConversationStateContext,
  routedCategory: UserInputCategory,
): string {
  const snapshot = {
    lifecycle_phase: context.phase as ConversationPhase,
    routed_category: routedCategory,
    current_task: (() => {
      const task = compactRule(context.activeRule);
      if (task && context.phase === 'AWAITING_TRIGGER_MODE') {
        task.trigger_mode = 'NOT_SELECTED_YET';
      }
      return task;
    })(),
    watchers: compactSubSentinels(context.subSentinels),
    pending_interrupt: compactInterrupt(context.pendingInterrupt),
    telemetry_summary: context.lastTelemetrySummary?.slice(0, 12000) ?? null,
    conversation_transcript: compactMessages(context.recentMessages),
  };

  return [
    READ_ONLY_ANSWER_SYSTEM_PROMPT,
    '',
    '<SENTINEL_SNAPSHOT_UNTRUSTED_DATA>',
    JSON.stringify(snapshot).slice(0, 30000),
    '</SENTINEL_SNAPSHOT_UNTRUSTED_DATA>',
    '',
    '<USER_QUESTION_UNTRUSTED_DATA>',
    userQuestion.slice(0, 6000),
    '</USER_QUESTION_UNTRUSTED_DATA>',
  ].join('\n');
}

function extractAnswer(result: unknown): string | null {
  const resultAny = result as any;
  if (typeof resultAny?.structuredOutput === 'string') {
    return resultAny.structuredOutput.trim() || null;
  }

  const lastMessage = resultAny?.lastMessage ?? resultAny?.message;
  if (Array.isArray(lastMessage?.content)) {
    const content = lastMessage.content
      .map((part: any) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
    return content || null;
  }
  if (typeof lastMessage?.content === 'string') {
    return lastMessage.content.trim() || null;
  }
  if (typeof lastMessage?.text === 'string') {
    return lastMessage.text.trim() || null;
  }
  return null;
}

export async function answerConversationQuestion(
  userQuestion: string,
  context: ConversationStateContext,
  routedCategory: UserInputCategory,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<string | null> {
  if (!userQuestion.trim() || !hasConfiguredModel()) return null;
  if (options?.signal?.aborted) return null;

  const timeoutMs = Math.max(1000, options?.timeoutMs ?? 8000);
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new Error('READ_ONLY_ANSWER_TIMEOUT')),
    timeoutMs,
  );
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const agent = new Agent({
      model: getAgentDefaultModel(),
      systemPrompt: READ_ONLY_ANSWER_SYSTEM_PROMPT,
      tools: [],
    });
    const result = await agent.invoke(
      buildAnswerPrompt(userQuestion, context, routedCategory),
      { cancelSignal: signal },
    );
    return extractAnswer(result);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
