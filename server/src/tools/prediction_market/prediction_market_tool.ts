import { tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import { SentinelOperatorEnum } from '@sentinel/shared';
import { PredictionMarketHarness } from '../../harness/prediction_market/harness.js';
import type {
  PredictionMarketTask,
  PredictionMarketOutcome,
  PredictionMarketHarnessConfig,
} from '../../harness/prediction_market/types.js';
import type { FinanceTelemetryEvent } from '../../harness/finance_common/index.js';

/**
 * Creates a native Strands SDK tool wrapping the Prediction Market Research Harness.
 */
export function createPredictionMarketTool(config?: PredictionMarketHarnessConfig) {
  const harness = new PredictionMarketHarness(config);

  return tool({
    name: 'prediction_market_research',
    description:
      'Autonomously discovers live prediction contracts on Polymarket, maps questions to YES/NO token IDs, and verifies live orderbook probabilities.',
    inputSchema: z.object({
      query: z.string().describe('Natural language prediction monitoring intent (e.g. "Trump win Pennsylvania > 45%", "Fed rate cut")'),
      conditionId: z.string().optional().describe('Direct Polymarket conditionId if known'),
      desiredOutcome: z.enum(['YES', 'NO']).optional(),
      targetProbability: z.number().min(0).max(1).optional().describe('Target odds between 0.0 and 1.0 (e.g. 0.45)'),
      expectedOperator: SentinelOperatorEnum.optional(),
    }),
    callback: async function* (
      input: {
        query: string;
        conditionId?: string;
        desiredOutcome?: 'YES' | 'NO';
        targetProbability?: number;
        expectedOperator?: z.infer<typeof SentinelOperatorEnum>;
      },
      context?: ToolContext
    ): AsyncGenerator<FinanceTelemetryEvent, PredictionMarketOutcome, unknown> {
      const taskId = (context?.invocationState?.taskId as string) || `pm-${Date.now()}`;
      const task: PredictionMarketTask = {
        id: taskId,
        query: input.query,
        conditionId: input.conditionId,
        desiredOutcome: input.desiredOutcome,
        targetProbability: input.targetProbability,
        expectedOperator: input.expectedOperator,
      };

      const stream = harness.stream(task, { signal: context?.cancelSignal });
      let next = await stream.next();
      while (!next.done) {
        yield next.value;
        next = await stream.next();
      }
      return next.value;
    },
  });
}
