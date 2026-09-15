import { tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import { SentinelOperatorEnum, type SentinelOperator } from '@sentinel/shared';
import { TelegramChannelHarness } from '../../harness/telegram_channel/harness.js';
import type {
  TelegramResearchTask,
  TelegramResearchOutcome,
  TelegramHarnessConfig,
  TelegramTelemetryEvent,
} from '../../harness/telegram_channel/types.js';

/**
 * Creates a native Strands SDK tool wrapping the Telegram Channel Research Harness.
 * Provides autonomous discovery, validation, sample extraction, and threshold contract assembly.
 */
export function createTelegramChannelTool(config?: TelegramHarnessConfig) {
  const harness = new TelegramChannelHarness(config);

  return tool({
    name: 'telegram_channel_research',
    description:
      'Discovers and validates public Telegram broadcast channels, checks channel health, follower counts, and tests keyword/semantic triggers against recent broadcast messages.',
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'Natural language monitoring intent (e.g. "Alert when @whale_alert_io posts any transaction over 1000 BTC")'
        ),
      channelHandle: z
        .string()
        .optional()
        .describe('Direct channel handle if known (e.g. "@whale_alert_io" or "durov")'),
      keywords: z
        .array(z.string())
        .optional()
        .describe('List of keywords to filter for in incoming posts'),
      matchMode: z
        .enum(['ANY', 'ALL', 'EXACT'])
        .optional()
        .describe('Keyword matching mode: ANY (OR), ALL (AND), EXACT (phrased sequence)'),
      minViews: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Minimum view count threshold for alerts'),
      mediaOnly: z
        .boolean()
        .optional()
        .describe('Whether to only match posts with photo/video attachments'),
      semanticFilter: z
        .string()
        .optional()
        .describe(
          'Natural language condition evaluated by Bedrock Haiku semantic gate'
        ),
      expectedOperator: SentinelOperatorEnum.optional().describe(
        'Operator classification (KEYWORD_MATCH or SEMANTIC_MATCH)'
      ),
    }),
    callback: async function* (
      input: {
        query: string;
        channelHandle?: string;
        keywords?: string[];
        matchMode?: 'ANY' | 'ALL' | 'EXACT';
        minViews?: number;
        mediaOnly?: boolean;
        semanticFilter?: string;
        expectedOperator?: SentinelOperator;
      },
      context?: ToolContext
    ): AsyncGenerator<TelegramTelemetryEvent, TelegramResearchOutcome, unknown> {
      const taskId =
        (context?.invocationState?.taskId as string) || `tg-${Date.now()}`;
      const executionId =
        (context?.invocationState?.executionId as string) ||
        (context as any)?.executionId;
      const task: TelegramResearchTask = {
        id: taskId,
        query: input.query,
        channelHandle: input.channelHandle,
        keywords: input.keywords,
        matchMode: input.matchMode,
        minViews: input.minViews,
        mediaOnly: input.mediaOnly,
        semanticFilter: input.semanticFilter,
        expectedOperator: input.expectedOperator,
      };

      const stream = harness.stream(task, {
        signal: context?.cancelSignal,
        executionId,
      });
      let next = await stream.next();
      while (!next.done) {
        yield next.value;
        next = await stream.next();
      }
      return next.value;
    },
  });
}
