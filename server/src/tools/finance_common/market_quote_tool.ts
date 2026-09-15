import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { FinnhubClient } from '../../harness/finance_common/finnhub_client.js';
import { YahooFinanceClient } from '../../harness/finance_common/yahoo_client.js';
import { CoinbaseClient } from '../../harness/finance_common/coinbase_client.js';
import { DexScreenerClient } from '../../harness/finance_common/dexscreener_client.js';
import { PolymarketClient } from '../../harness/finance_common/polymarket_client.js';

/**
 * Creates a native Strands SDK tool for retrieving unified market price quotes
 * across equities, crypto, DEX liquidity pools, and prediction markets.
 */
export function createMarketQuoteTool() {
  const finnhub = new FinnhubClient();
  const yahoo = new YahooFinanceClient();
  const coinbase = new CoinbaseClient();
  const dexscreener = new DexScreenerClient();
  const polymarket = new PolymarketClient();

  return tool({
    name: 'get_market_quote',
    description:
      'Queries live price quotes, bid/ask spreads, or odds across US stocks, cryptocurrencies, DEX pairs, and Polymarket prediction contracts.',
    inputSchema: z.object({
      assetType: z
        .enum(['STOCK', 'CRYPTO', 'DEX', 'PREDICTION_MARKET'])
        .describe('Asset classification to inspect'),
      symbolOrQuery: z
        .string()
        .min(1)
        .describe('Ticker symbol, token, contract address, or prediction question (e.g. "AAPL", "BTC", "Trump 2028")'),
    }),
    callback: async (input: {
      assetType: 'STOCK' | 'CRYPTO' | 'DEX' | 'PREDICTION_MARKET';
      symbolOrQuery: string;
    }) => {
      switch (input.assetType) {
        case 'STOCK': {
          if (finnhub.isConfigured()) {
            const fhQuote = await finnhub.getQuote(input.symbolOrQuery);
            if (fhQuote && fhQuote.currentPrice > 0) {
              return {
                success: true,
                assetType: 'STOCK',
                provider: 'FINNHUB',
                symbol: input.symbolOrQuery.toUpperCase(),
                quote: fhQuote,
              };
            }
          }
          const yhQuote = await yahoo.getQuote(input.symbolOrQuery);
          return {
            success: yhQuote !== null,
            assetType: 'STOCK',
            provider: 'YAHOO',
            symbol: input.symbolOrQuery.toUpperCase(),
            quote: yhQuote,
          };
        }

        case 'CRYPTO': {
          const cbSpot = await coinbase.getSpotPrice(input.symbolOrQuery);
          if (cbSpot && cbSpot.price > 0) {
            return {
              success: true,
              assetType: 'CRYPTO',
              provider: 'COINBASE',
              symbol: input.symbolOrQuery.toUpperCase(),
              quote: cbSpot,
            };
          }
          const dexPairs = await dexscreener.searchPairs(input.symbolOrQuery);
          return {
            success: dexPairs.length > 0,
            assetType: 'CRYPTO',
            provider: 'DEXSCREENER',
            symbol: input.symbolOrQuery.toUpperCase(),
            quote: dexPairs[0] || null,
          };
        }

        case 'DEX': {
          const pairs = await dexscreener.searchPairs(input.symbolOrQuery);
          return {
            success: pairs.length > 0,
            assetType: 'DEX',
            provider: 'DEXSCREENER',
            query: input.symbolOrQuery,
            pairs: pairs.slice(0, 3),
          };
        }

        case 'PREDICTION_MARKET': {
          const markets = await polymarket.searchMarkets(input.symbolOrQuery);
          return {
            success: markets.length > 0,
            assetType: 'PREDICTION_MARKET',
            provider: 'POLYMARKET',
            query: input.symbolOrQuery,
            markets: markets.slice(0, 3),
          };
        }
      }
    },
  });
}
