import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { ClarificationChoiceSchema } from '@sentinel/shared';

/**
 * Agent-to-user HITL tool. The callback only returns a typed request; the
 * websocket workflow is responsible for persisting it and pausing the durable
 * conversation state.
 */
export function createClarificationTool() {
  return tool({
    name: 'request_clarification',
    description:
      'Pause the Sentinel conversation and ask the user to choose one of several concrete options when required task information is missing or ambiguous. Use only when the workflow cannot safely proceed without the answer. Provide 2 to 8 mutually exclusive choices and do not guess.',
    inputSchema: z.object({
      question: z.string().min(1).max(4000),
      choices: z.array(ClarificationChoiceSchema).min(2).max(8),
      field: z.string().min(1).max(120).optional(),
    }),
    callback: async (input) => ({
      kind: 'CLARIFICATION_REQUIRED' as const,
      question: input.question,
      choices: input.choices,
      field: input.field,
    }),
  });
}
