import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { TelegramPublicClient } from '../../harness/telegram_channel/client.js';

/**
 * Creates a lightweight Strands SDK tool for directly inspecting a public Telegram channel.
 * Returns verified channel metadata (title, subscribers, verification status) and recent message feed.
 */
export function createTelegramInspectorTool() {
  const client = new TelegramPublicClient();

  return tool({
    name: 'inspect_telegram_channel',
    description:
      'Directly inspects a public Telegram channel by handle or URL. Returns subscriber count, channel title, description, verified status, and recent broadcast posts.',
    inputSchema: z.object({
      channelHandle: z
        .string()
        .min(1)
        .describe('Telegram channel handle or URL (e.g. "@whale_alert_io" or "t.me/s/durov")'),
      messageLimit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe('Maximum number of recent messages to return (1-20)'),
      beforeMessageId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional message ID offset for historical pagination'),
    }),
    callback: async (input: {
      channelHandle: string;
      messageLimit?: number;
      beforeMessageId?: number;
    }) => {
      try {
        const result = await client.fetchChannel(input.channelHandle, {
          before: input.beforeMessageId,
        });

        const limit = input.messageLimit ?? 5;
        const messages = result.messages.slice(-limit).map((m) => ({
          messageId: m.messageId,
          postId: m.postId,
          text: m.text.slice(0, 300),
          isoDate: m.isoDate,
          views: m.viewsDisplay || `${m.views ?? 0}`,
          hasMedia: m.hasMedia,
          link: m.link,
        }));

        return {
          success: true,
          channel: result.metadata,
          messagesCount: result.messages.length,
          recentMessages: messages,
        };
      } catch (err: unknown) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}
