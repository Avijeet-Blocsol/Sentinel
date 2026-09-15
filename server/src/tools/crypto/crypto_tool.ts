import { tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  TechnicalIndicatorEnum,
  CandlestickPatternEnum,
  SentinelOperatorEnum,
} from '@sentinel/shared';
import { CryptoResearchHarness } from '../../harness/crypto/harness.js';
import type {
  CryptoResearchTask,
  CryptoResearchOutcome,
  CryptoHarnessConfig,
} from '../../harness/crypto/types.js';
import type { FinanceTelemetryEvent } from '../../harness/finance_common/index.js';

/**
 * Creates a native Strands SDK tool wrapping the Crypto Research Harness.
 */
export function createCryptoResearchTool(config?: CryptoHarnessConfig) {
  const harness = new CryptoResearchHarness(config);

  return tool({
    name: 'crypto_research',
    description:
      'Autonomously discovers crypto trading pairs, validates live liquidity on Coinbase and DexScreener, and computes mathematical indicators and candlestick patterns.',
    inputSchema: z.object({
      query: z.string().describe('Natural language crypto monitoring intent (e.g. "BTC under 60k", "SOL 4h RSI oversold")'),
      assetSymbol: z.string().optional().describe('Direct token symbol if known (e.g. "BTC", "SOL", "PEPE")'),
      targetType: z.enum(['PRICE', 'INDICATOR', 'CANDLESTICK']).optional(),
      indicator: TechnicalIndicatorEnum.optional(),
      candlestickPattern: CandlestickPatternEnum.optional(),
      timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']).optional(),
      expectedOperator: SentinelOperatorEnum.optional(),
      targetValue: z.number().optional(),
      dexContractAddress: z.string().optional().describe('On-chain token or pair contract address for DEX resolution (e.g. 0x..., Solana base58)'),
      dexNetwork: z.string().optional().describe('Target blockchain network (e.g. "ethereum", "solana", "base", "bsc", "polygon")'),
    }),
    callback: async function* (
      input: {
        query: string;
        assetSymbol?: string;
        targetType?: 'PRICE' | 'INDICATOR' | 'CANDLESTICK';
        indicator?: z.infer<typeof TechnicalIndicatorEnum>;
        candlestickPattern?: z.infer<typeof CandlestickPatternEnum>;
        timeframe?: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';
        expectedOperator?: z.infer<typeof SentinelOperatorEnum>;
        targetValue?: number;
        dexContractAddress?: string;
        dexNetwork?: string;
      },
      context?: ToolContext
    ): AsyncGenerator<FinanceTelemetryEvent, CryptoResearchOutcome, unknown> {
      const taskId = (context?.invocationState?.taskId as string) || `crypto-${Date.now()}`;
      const executionId = context?.invocationState?.executionId as string | undefined;
      const task: CryptoResearchTask = {
        id: taskId,
        query: input.query,
        assetSymbol: input.assetSymbol,
        targetType: input.targetType,
        indicator: input.indicator,
        candlestickPattern: input.candlestickPattern,
        timeframe: input.timeframe,
        expectedOperator: input.expectedOperator,
        targetValue: input.targetValue,
        dexContractAddress: input.dexContractAddress,
        dexNetwork: input.dexNetwork,
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
