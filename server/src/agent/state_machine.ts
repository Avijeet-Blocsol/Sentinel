/**
 * Strands Sentinel - Conversation Lifecycle State Machine & Input Classifier
 * Manages the strict state transitions across the 9-step Golden Onboarding Loop.
 */

import type { InterruptAction, Rule, SubSentinel, ChatMessage } from '@sentinel/shared';

export type ConversationPhase =
  | 'DISCOVERY'
  | 'AWAITING_QUERY_CONFIRMATION'
  | 'SCOUTING'
  | 'INTERRUPT_PENDING'
  | 'DEPLOYED';

export type UserInputCategory =
  | 'TASK_STATUS_INQUIRY'
  | 'INTERRUPT_RESOLUTION'
  | 'TASK_MODIFICATION_ATTEMPT'
  | 'SENTINEL_INTENT'
  | 'OFF_TOPIC_BS';

export interface ConversationStateContext {
  phase: ConversationPhase;
  activeRule?: Rule | null;
  subSentinels?: SubSentinel[];
  pendingInterrupt?: InterruptAction | null;
  recentMessages?: ChatMessage[];
  lastTelemetrySummary?: string;
}

/**
 * Checks if text is an explicit natural-language resolution to a pending interrupt.
 */
export function isInterruptResolutionText(text: string): {
  isResolution: boolean;
  resolution?: 'APPROVED' | 'REJECTED';
} {
  const normalized = text.trim().toLowerCase();

  const approvalPatterns = [
    /^(confirm|approve|deploy|confirm\s*&\s*deploy|looks\s*good|proceed|go\s*ahead|yes|lgtm|accept|do\s*it|ready)$/i,
    /^i\s*(confirm|approve|accept|agree)$/i,
    /^(yes,?\s*confirm|yes,?\s*deploy|yes,?\s*proceed)$/i,
  ];

  const rejectionPatterns = [
    /^(reject|cancel|dismiss|no|stop|discard|abort|nevermind|don't\s*deploy)$/i,
    /^i\s*(reject|cancel|dismiss)$/i,
    /^(no,?\s*cancel|no,?\s*stop)$/i,
  ];

  for (const pattern of approvalPatterns) {
    if (pattern.test(normalized)) {
      return { isResolution: true, resolution: 'APPROVED' };
    }
  }

  for (const pattern of rejectionPatterns) {
    if (pattern.test(normalized)) {
      return { isResolution: true, resolution: 'REJECTED' };
    }
  }

  return { isResolution: false };
}

/**
 * Query confirmation is deliberately stricter than ordinary conversation.
 * This is used by the deterministic router before any scouting tool can run.
 */
export function isQueryConfirmationText(text: string): boolean {
  const resolution = isInterruptResolutionText(text);
  return resolution.isResolution && resolution.resolution === 'APPROVED';
}

/** A negative answer at the pre-scout review cancels the draft safely. */
export function isQueryRejectionText(text: string): boolean {
  const resolution = isInterruptResolutionText(text);
  return resolution.isResolution && resolution.resolution === 'REJECTED';
}

/**
 * Checks if user input is asking about task execution history, status, or progress.
 */
export function isTaskStatusInquiry(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const statusPatterns = [
    /status/i,
    /what('?s|\s+is)\s+happening/i,
    /how('?s|\s+is)\s+(the|my)?\s*(task|watcher|sentinel|monitoring)\s*(going|doing)?/i,
    /what\s+has\s+happened/i,
    /summary\s+of\s+what\s+has\s+happened/i,
    /did\s+(it|the\s+watcher)\s+trigger/i,
    /is\s+(it|the\s+watcher|sentinel)\s+running/i,
    /show\s+(me\s+)?(the\s+)?(progress|history|execution|logs)/i,
    /current\s+execution\s+stack/i,
    /what\s+did\s+you\s+find/i,
  ];

  return statusPatterns.some((p) => p.test(normalized));
}

/**
 * Checks if user is attempting to modify or add tasks after the scout phase has locked the intent.
 */
export function isTaskModificationAttempt(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const modPatterns = [
    /\b(change|update|modify|alter|edit|set|use)\s+(the\s+)?(price|threshold|condition|ticker|symbol|rule|source|cadence|frequency|interval|tone|sound|alert)/i,
    /\balso\s+(monitor|watch|track|check)/i,
    /\binstead\s+(of|monitor|watch|track)/i,
    /\b(add|remove|drop|exclude|include)\s+(another\s+|the\s+)?(condition|ticker|stock|rule|sentinel|source|channel|feed|website|alert)/i,
    /\bmake\s+it\s+(above|below|different)/i,
    /\bswitch\s+(to|the)\s/i,
    /\bcan\s+you\s+(change|update|modify|also|add|switch)/i,
    /\b(every|once\s+every)\s+\d+\s*(second|minute|hour|day)s?\b/i,
    /\b(only|don'?t)\s+(alert|notify|monitor|watch|track)\b/i,
  ];

  return modPatterns.some((p) => p.test(normalized));
}

/**
 * Classifies an incoming message based on current conversation context.
 */
export function classifyUserInput(
  text: string,
  context: ConversationStateContext
): UserInputCategory {
  // If there's a pending interrupt, resolution check takes top priority
  if (context.pendingInterrupt) {
    const res = isInterruptResolutionText(text);
    if (res.isResolution) return 'INTERRUPT_RESOLUTION';
  }

  if (isTaskStatusInquiry(text)) {
    return 'TASK_STATUS_INQUIRY';
  }

  // Edits are valid during the explicit review phase and are rejected after
  // scouting starts. Classify both cases accurately so the phase handler can
  // decide whether to redraft or return the locked-scope response.
  if (
    context.phase === 'AWAITING_QUERY_CONFIRMATION' ||
    context.phase === 'SCOUTING' ||
    context.phase === 'INTERRUPT_PENDING' ||
    context.phase === 'DEPLOYED'
  ) {
    if (isTaskModificationAttempt(text)) {
      return 'TASK_MODIFICATION_ATTEMPT';
    }
  }

  // Check for surveillance / monitoring keywords
  // Require co-occurrence: monitoring verb + domain entity, or explicit conditional phrases
  const sentinelPatterns = [
    /\b(watch|monitor|track|alert|notify|observe)\b.*\b(stock|ticker|price|crypto|bitcoin|btc|eth|market|polymarket|prediction|rss|feed|website|url|page|site|product|listing|telegram|channel|news|keyword|event)\b/i,
    /\b(stock|ticker|price|crypto|bitcoin|btc|eth|market|polymarket|prediction|rss|feed|website|url|page|site|product|listing|telegram|channel|news|keyword|event)\b.*\b(watch|monitor|track|alert|notify|observe)\b/i,
    /\bif\s+.+\s+(drops|rises|breaks|hits|falls|reaches|goes\s+(above|below)|exceeds|crosses)\b/i,
    /\b(sentinel|watcher)\b/i,
    /\balert\s+me\b/i,
    /\bnotify\s+me\b/i,
    /\bwatch\s+for\b/i,
    /\bkeep\s+(an\s+)?eye\s+on\b/i,
  ];

  if (sentinelPatterns.some((p) => p.test(text))) {
    return 'SENTINEL_INTENT';
  }

  return 'OFF_TOPIC_BS';
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
      `Please tap **Confirm & Deploy** or **Dismiss** (or type "confirm" / "cancel") before proceeding.`
    );
  }

  if (context.phase === 'SCOUTING') {
    return (
      `I am currently running reconnaissance and live pre-flight verification on your task. ` +
      `This task is locked. Once the verification card is presented, you'll be able to confirm and deploy it.`
    );
  }

  // Discovery phase
  return (
    `I specialize exclusively in autonomous monitoring, market intelligence, and real-time alerts. ` +
    `Tell me what asset, ticker, prediction market, or news event you'd like me to watch for you!`
  );
}

/**
 * A deterministic response for text received after reconnaissance starts.
 * It deliberately never offers in-place task edits: those would invalidate
 * the pre-flight evidence and the approval boundary.
 */
export function generateLockedScopeResponse(phase: Extract<ConversationPhase, 'SCOUTING' | 'INTERRUPT_PENDING' | 'DEPLOYED'>): string {
  return (
    `⚠️ **Task Scope Locked**\n\n` +
    `This Sentinel Task is already locked and ${phase === 'DEPLOYED' ? 'actively monitoring in the background' : 'executing live reconnaissance'}. ` +
    `We do not modify active tasks mid-flight. Ask for a status update, resolve the pending confirmation, or create a new Sentinel Task.`
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
