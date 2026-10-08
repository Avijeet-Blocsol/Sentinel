import { randomUUID } from 'node:crypto';
import {
  ChoiceInterruptPayloadSchema,
  isChoiceInterruptActionType,
  type ChoiceInterruptActionType,
  type ChoiceInterruptKind,
  type ClarificationChoice,
  type EnrichedInterruptAction,
  type InterruptAction,
  type TaskEditProposal,
} from '@sentinel/shared';
import { interruptActionRepository, ruleRepository } from '../db/index.js';
import type { ConversationPhase } from '../agent/state_machine.js';
import { parseJsonValue } from '../agent/structured_output.js';

export interface ClarificationRequest {
  question: string;
  choices: ClarificationChoice[];
  field?: string;
  taskEditRequest?: string;
}

export interface ChoiceInterruptRequest extends ClarificationRequest {
  kind: ChoiceInterruptKind;
  taskEdit?: TaskEditProposal;
  taskEditRequest?: string;
}

const MANUAL_RESPONSE_CHOICE_ID = 'manual_response';

function withManualResponseChoice(choices: ClarificationChoice[]): ClarificationChoice[] {
  const existingManualChoice = choices.find((choice) => choice.id === MANUAL_RESPONSE_CHOICE_ID);
  if (existingManualChoice?.input?.kind === 'TEXT') return choices;
  return [
    ...choices.filter((choice) => choice.id !== MANUAL_RESPONSE_CHOICE_ID),
    {
      id: MANUAL_RESPONSE_CHOICE_ID,
      label: 'Provide another answer',
      description: 'Type the exact response that should resolve this interrupt.',
      input: {
        kind: 'TEXT',
        placeholder: 'Type your exact response…',
        submit_label: 'Submit response',
        max_length: 4000,
      },
    },
  ];
}

/**
 * Persists any user-choice workflow gate as the same durable interrupt
 * envelope. The action type identifies the workflow purpose while the
 * payload carries the user-facing question and selectable choices.
 */
export async function createChoiceInterrupt(input: {
  conversationId: string;
  userId: string;
  ruleId?: string | null;
  /** The phase the conversation must be in before this gate is created. */
  expectedPhase: ConversationPhase;
  /** The phase the resolver should restore before resuming the workflow. */
  resumePhase: ConversationPhase;
  actionType: ChoiceInterruptActionType;
  request: ChoiceInterruptRequest;
}): Promise<EnrichedInterruptAction> {
  if (input.actionType !== input.request.kind) {
    throw new Error('Choice interrupt action type and payload kind must match');
  }
  const now = Date.now();
  const choices = withManualResponseChoice(input.request.choices);
  const choiceIds = choices.map((choice) => choice.id);
  if (new Set(choiceIds).size !== choiceIds.length) {
    throw new Error('Choice interrupt options must have unique ids');
  }
  const payloadResult = ChoiceInterruptPayloadSchema.safeParse({
    kind: input.request.kind,
    question: input.request.question,
    choices,
    field: input.request.field,
    resume_phase: input.resumePhase,
    task_edit: input.request.taskEdit,
    task_edit_request: input.request.taskEditRequest,
  });
  if (!payloadResult.success) {
    throw new Error(`Invalid choice interrupt request: ${payloadResult.error.message}`);
  }

  const action: InterruptAction = {
    id: randomUUID(),
    alert_id: null,
    rule_id: input.ruleId ?? null,
    conversation_id: input.conversationId,
    user_id: input.userId,
    action_type: input.actionType,
    action_payload: JSON.stringify(payloadResult.data),
    status: 'PENDING',
    expires_at: now + 15 * 60 * 1000,
    created_at: now,
    resolved_at: null,
  };

  const created = await interruptActionRepository.createClarification({
    action,
    conversationId: input.conversationId,
    userId: input.userId,
    expectedPhase: input.expectedPhase,
    now,
  });
  if (!created) {
    // A reconnect or another device may have won the same phase transition.
    // Reuse its durable card instead of surfacing a generic workflow error to
    // the client. Only reuse the card when its purpose matches exactly; a
    // different pending action must remain a hard conflict.
    const existing = (await interruptActionRepository.getPendingByUserId(input.userId))
      .find((candidate) =>
        candidate.conversation_id === input.conversationId &&
        candidate.action_type === input.actionType
      );
    if (existing) return existing;
    throw new Error('The conversation changed before the choice interrupt could be saved');
  }

  const rule = input.ruleId ? await ruleRepository.getById(input.ruleId) : null;
  return {
    ...action,
    conversation_id: input.conversationId,
    rule_title: rule?.title ?? null,
  };
}

/**
 * Converts an agent tool result into a durable, user-scoped interrupt. The
 * database transaction also moves the conversation into CLARIFICATION_PENDING
 * so reconnects cannot accidentally resume the agent without an answer.
 */
export async function createClarificationInterrupt(input: {
  conversationId: string;
  userId: string;
  ruleId?: string | null;
  expectedPhase: ConversationPhase;
  resumePhase: ConversationPhase;
  request: ClarificationRequest;
}): Promise<EnrichedInterruptAction> {
  return createChoiceInterrupt({
    ...input,
    actionType: 'CLARIFICATION_REQUIRED',
    request: { ...input.request, kind: 'CLARIFICATION_REQUIRED' },
  });
}

export function parseChoiceInterruptPayload(action: InterruptAction): ReturnType<typeof ChoiceInterruptPayloadSchema.parse> | null {
  if (!isChoiceInterruptActionType(action.action_type)) return null;
  const parsed = parseJsonValue(action.action_payload);
  const result = ChoiceInterruptPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export const parseClarificationPayload = parseChoiceInterruptPayload;

export function findClarificationChoice(action: InterruptAction, choiceId: string): {
  payload: ReturnType<typeof ChoiceInterruptPayloadSchema.parse>;
  choice: ClarificationChoice;
} | null {
  const payload = parseChoiceInterruptPayload(action);
  if (!payload) return null;
  const choice = payload.choices.find((candidate) => candidate.id === choiceId);
  return choice ? { payload, choice } : null;
}

/**
 * Keeps a pending card authoritative while giving the user precise feedback
 * after a manual answer does not satisfy the agent's semantic check.
 */
export async function updateChoiceInterruptFeedback(
  action: EnrichedInterruptAction,
  retryMessage: string,
): Promise<EnrichedInterruptAction | null> {
  const payload = parseChoiceInterruptPayload(action);
  if (!payload) return null;

  const nextPayload = {
    ...payload,
    retry_message: retryMessage,
  };
  const updated = await interruptActionRepository.updateActionPayload(
    action.id,
    JSON.stringify(nextPayload),
  );
  if (!updated) return null;

  return {
    ...action,
    action_payload: JSON.stringify(nextPayload),
  };
}
