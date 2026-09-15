import { tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  TechnicalIndicatorEnum,
  CandlestickPatternEnum,
  SentinelOperatorEnum,
} from '@sentinel/shared';
import { StockResearchHarness } from '../../harness/stocks/harness.js';
import type {
  StockResearchTask,
  StockResearchOutcome,
  StockHarnessConfig,
} from '../../harness/stocks/types.js';
import type { FinanceTelemetryEvent } from '../../harness/finance_common/index.js';

/**
 * Creates a native Strands SDK tool wrapping the Stock Research Harness.
 */
export function createStockResearchTool(config?: StockHarnessConfig) {
  const harness = new StockResearchHarness(config);

  return tool({
    name: 'stock_research',
    description:
      'Autonomously discovers public stocks, validates live market quotes on Finnhub (fallback Yahoo Finance), and computes technical indicators and candlestick patterns.',
    inputSchema: z.object({
      query: z.string().describe('Natural language equity monitoring intent (e.g. "Apple crosses above 240", "TSLA 50-day EMA")'),
      ticker: z.string().optional().describe('Direct ticker symbol if known (e.g. "AAPL", "MSFT", "NVDA")'),
      targetType: z.enum(['PRICE', 'INDICATOR', 'CANDLESTICK']).optional(),
      indicator: TechnicalIndicatorEnum.optional(),
      candlestickPattern: CandlestickPatternEnum.optional(),
      timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']).optional(),
      expectedOperator: SentinelOperatorEnum.optional(),
      targetValue: z.number().optional(),
    }),
    callback: async function* (
      input: {
        query: string;
        ticker?: string;
        targetType?: 'PRICE' | 'INDICATOR' | 'CANDLESTICK';
        indicator?: z.infer<typeof TechnicalIndicatorEnum>;
        candlestickPattern?: z.infer<typeof CandlestickPatternEnum>;
        timeframe?: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';
        expectedOperator?: z.infer<typeof SentinelOperatorEnum>;
        targetValue?: number;
      },
      context?: ToolContext
    ): AsyncGenerator<FinanceTelemetryEvent, StockResearchOutcome, unknown> {
      const taskId = (context?.invocationState?.taskId as string) || `stock-${Date.now()}`;
      const executionId = context?.invocationState?.executionId as string | undefined;
      const task: StockResearchTask = {
        id: taskId,
        query: input.query,
        ticker: input.ticker,
        targetType: input.targetType,
        indicator: input.indicator,
        candlestickPattern: input.candlestickPattern,
        timeframe: input.timeframe,
        expectedOperator: input.expectedOperator,
        targetValue: input.targetValue,
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
