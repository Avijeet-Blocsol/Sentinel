import { tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import { SentinelOperatorEnum } from '@sentinel/shared';
import { RssResearchHarness } from '../../harness/rss/harness.js';
import type {
  RssResearchTask,
  RssResearchOutcome,
  RssHarnessConfig,
  RssTelemetryEvent,
} from '../../harness/rss/types.js';

/**
 * Creates a native Strands SDK tool wrapping the RSS Feed Research Harness.
 */
export function createRssResearchTool(config?: RssHarnessConfig) {
  const harness = new RssResearchHarness(config);

  return tool({
    name: 'rss_research',
    description:
      'Autonomously discovers RSS/Atom feeds from natural language queries, resolves curated registries and HTML link headers, inspects feed validity, and simulates keyword matching against recent articles.',
    inputSchema: z.object({
      query: z.string().describe('Natural language feed monitoring intent (e.g. "OpenAI blog updates", "Tesla SEC 8-K filings", "Hacker News AI agents")'),
      feedUrl: z.string().url().optional().describe('Direct RSS/Atom feed URL or blog website URL if known'),
      keywords: z.array(z.string()).optional().describe('Keywords to filter incoming feed items against'),
      matchMode: z.enum(['ANY', 'ALL', 'EXACT']).optional().describe('Keyword matching mode (default ANY)'),
      authorFilter: z.string().optional().describe('Filter articles by specific author name'),
      semanticFilter: z.string().optional().describe('Natural language semantic filter prompt for Bedrock evaluation'),
      expectedOperator: SentinelOperatorEnum.optional(),
    }),
    callback: async function* (
      input: {
        query: string;
        feedUrl?: string;
        keywords?: string[];
        matchMode?: 'ANY' | 'ALL' | 'EXACT';
        authorFilter?: string;
        semanticFilter?: string;
        expectedOperator?: z.infer<typeof SentinelOperatorEnum>;
      },
      context?: ToolContext
    ): AsyncGenerator<RssTelemetryEvent, RssResearchOutcome, unknown> {
      const taskId = (context?.invocationState?.taskId as string) || `rss-${Date.now()}`;
      const executionId = context?.invocationState?.executionId as string | undefined;
      const task: RssResearchTask = {
        id: taskId,
        query: input.query,
        feedUrl: input.feedUrl,
        keywords: input.keywords,
        matchMode: input.matchMode,
        authorFilter: input.authorFilter,
        semanticFilter: input.semanticFilter,
        expectedOperator: input.expectedOperator,
      };

      const stream = harness.stream(task, { signal: context?.cancelSignal, executionId });
      let next = await stream.next();
      while (!next.done) {
        yield next.value;
        next = await stream.next();
      }
      return next.value;
    },
  });
}
