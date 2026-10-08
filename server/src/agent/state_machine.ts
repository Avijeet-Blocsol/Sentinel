/**
 * Strands Sentinel - Conversation Lifecycle State Machine & Input Classifier
 * Manages the strict state transitions across the 9-step Golden Onboarding Loop.
 */

import type { InterruptAction, Rule, SubSentinel, ChatMessage } from '@sentinel/shared';

export type ConversationPhase =
  | 'DISCOVERY'
  | 'AWAITING_QUERY_CONFIRMATION'
  | 'SCOUTING'
  | 'AWAITING_TRIGGER_MODE'
  | 'CLARIFICATION_PENDING'
  | 'INTERRUPT_PENDING'
  | 'DEPLOYED';

export type UserInputCategory =
  | 'TASK_STATUS_INQUIRY'
  | 'CONVERSATION_HISTORY_INQUIRY'
  | 'INTERRUPT_RESOLUTION'
  | 'TASK_MODIFICATION_ATTEMPT'
  | 'SENTINEL_INTENT'
  | 'OFF_TOPIC_BS'
  | 'AI_UNAVAILABLE';

export interface ConversationStateContext {
  phase: ConversationPhase;
  activeRule?: Rule | null;
  subSentinels?: SubSentinel[];
  pendingInterrupt?: InterruptAction | null;
  recentMessages?: ChatMessage[];
  lastTelemetrySummary?: string;
}

/**
 * Compatibility stub. Interrupts are resolved only through typed choice-card
 * actions, never by interpreting free-form text.
 */
export function isInterruptResolutionText(text: string): {
  isResolution: boolean;
  resolution?: 'APPROVED' | 'REJECTED';
} {
  // Interrupts are resolved exclusively by persisted choice-card actions.
  // Free-form text must never become an implicit approval or rejection.
  return { isResolution: false };
}

/** Deprecated text-resolution compatibility stub; card actions are authoritative. */
export function isQueryConfirmationText(text: string): boolean {
  return false;
}

/** Deprecated text-resolution compatibility stub; card actions are authoritative. */
export function isQueryRejectionText(text: string): boolean {
  return false;
}

/** Deprecated semantic compatibility stub; use the Strands intent classifier. */
export function isTaskStatusInquiry(text: string): boolean {
  return false;
}

/** Deprecated semantic compatibility stub; use the Strands intent classifier. */
export function isConversationHistoryInquiry(text: string): boolean {
  return false;
}

/** Deprecated semantic compatibility stub; use the Strands intent classifier. */
export function isTaskContextQuestion(
  text: string,
  context?: Pick<ConversationStateContext, 'phase' | 'activeRule'>
): boolean {
  return false;
}

/** Deprecated semantic compatibility stub; use the Strands intent classifier. */
export function isTaskModificationAttempt(text: string): boolean {
  return false;
}

/**
 * Classifies an incoming message based on current conversation context.
 */
export function classifyUserInput(
  text: string,
  context: ConversationStateContext
): UserInputCategory {
  // This synchronous compatibility API cannot perform semantic intent
  // classification. The live workflow must use classifyUserInputWithAgent.
  return 'AI_UNAVAILABLE';
}

/**
 * Generates a polite steering message when user asks off-topic or BS questions.
 */
export function generateSteeringResponse(context: ConversationStateContext): string {
  if (context.phase === 'DEPLOYED' && context.activeRule) {
    return (
      `I am dedicated to your Sentinel surveillance. Your task **"${context.activeRule.title}"** is currently actively running in the background. ` +
      `You can ask for a status update, or create a new Sentinel Task if you wish to monitor another asset.`
    );
  }

  if (context.phase === 'INTERRUPT_PENDING' && context.pendingInterrupt) {
    return (
      `⚠️ **Action Required**: Sentinel is currently awaiting your decision on the confirmation card above. ` +
      `Please tap one of the choices on the card before proceeding.`
    );
  }

  if (context.phase === 'SCOUTING') {
    return (
      `I am currently running reconnaissance and live pre-flight verification on your task. ` +
      `This task is locked. Once verification completes, you'll choose continuous monitoring or a one-time alert to deploy it.`
    );
  }

  if (context.phase === 'AWAITING_TRIGGER_MODE') {
    return (
      `The task passed live pre-flight verification. Choose **continuous monitoring** to keep watching for future matches, ` +
      `or **one-time alert** to stop after the first alert. Your choice confirms deployment.`
    );
  }

  // Discovery phase
  return (
    `I specialize exclusively in autonomous monitoring, market intelligence, and real-time alerts. ` +
    `Tell me what asset, ticker, prediction market, or news event you'd like me to watch for you!`
  );
}

/**
 * A deterministic response for text received while a lifecycle gate is
 * active. Deployed-task edits are handled by the semantic task-edit agent
 * before this fallback is reached.
 */
export function generateLockedScopeResponse(phase: Extract<ConversationPhase, 'SCOUTING' | 'AWAITING_TRIGGER_MODE' | 'INTERRUPT_PENDING' | 'DEPLOYED'>): string {
  if (phase === 'AWAITING_TRIGGER_MODE') {
    return (
      `✅ **Pre-flight verification complete**\n\n` +
      `Choose **continuous monitoring** to keep watching, or **one-time alert** to finish after the first alert. ` +
      `Your lifecycle choice confirms deployment.`
    );
  }
  if (phase === 'DEPLOYED') {
    return (
      `The Sentinel task is deployed. You can ask me to remove a condition, ` +
      `change a condition's schedule or trigger, or switch between one-time ` +
      `alerting and continuous monitoring. I will prepare a change card for ` +
      `you to review before anything is updated.`
    );
  }
  return (
    `⚠️ **Task Scope Locked**\n\n` +
    `This Sentinel Task is locked while live reconnaissance is in progress; do not modify active tasks mid-flight. ` +
    `Ask for a status update or resolve the pending confirmation card before continuing.`
  );
}

/**
 * Generates an execution stack status summary when user asks for task information.
 */
export function generateTaskStatusSummary(context: ConversationStateContext): string {
  const parts: string[] = [];

  parts.push(`🛡️ **Sentinel Task Execution Status**`);

  if (context.activeRule) {
    parts.push(`• **Task**: ${context.activeRule.title}`);
    parts.push(`• **Intent**: "${context.activeRule.natural_language_intent}"`);
    parts.push(`• **Lifecycle Phase**: \`${context.phase}\``);
    parts.push(`• **Status**: \`${context.activeRule.status}\``);
    parts.push(`• **Audio Signature**: \`${context.activeRule.audio_tone}\``);
  } else {
    parts.push(`• **Lifecycle Phase**: \`${context.phase}\``);
  }

  if (context.subSentinels && context.subSentinels.length > 0) {
    parts.push(`\n**Active Watchers (${context.subSentinels.length}):**`);
    for (const sub of context.subSentinels) {
      parts.push(
        `  - \`${sub.sentinel_type}\` on **${sub.target_source}** (Operator: \`${sub.operator}\`, Satisfied: ${Boolean(sub.is_satisfied)})`
      );
    }
  }

  if (context.pendingInterrupt) {
    parts.push(`\n⚠️ **Pending Interrupt**: Visual Confirmation Card awaiting your approval (Type: \`${context.pendingInterrupt.action_type}\`).`);
  }

  if (context.lastTelemetrySummary) {
    parts.push(`\n**Recent Telemetry:**\n${context.lastTelemetrySummary}`);
  }

  return parts.join('\n');
}

/**
 * Produces a faithful recap from durable conversation messages. The stored
 * transcript is the source of truth; this helper does not invent facts or run
 * a second model pass.
 */
export function generateConversationHistorySummary(context: ConversationStateContext): string {
  const parts: string[] = ['🧾 **Conversation Summary**'];

  if (context.activeRule) {
    parts.push(`• **Current task**: ${context.activeRule.title}`);
    parts.push(`• **Lifecycle phase**: \`${context.phase}\``);
  } else {
    parts.push(`• **Lifecycle phase**: \`${context.phase}\``);
  }

  const messages = (context.recentMessages ?? []).slice(-8);
  if (messages.length === 0) {
    parts.push('\nThere are no earlier messages recorded for this conversation yet.');
    return parts.join('\n');
  }

  parts.push('\n**Recent discussion:**');
  for (const message of messages) {
    const speaker = message.role === 'user' ? 'You' : 'Sentinel';
    const content = message.content.replace(/\s+/g, ' ').trim().slice(0, 320);
    if (content) parts.push(`• **${speaker}**: ${content}`);
  }

  if (context.pendingInterrupt) {
    parts.push('\n⚠️ A confirmation interrupt is currently waiting for your decision.');
  }

  return parts.join('\n');
}
