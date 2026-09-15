import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { YahooFinanceClient } from '../harness/finance_common/yahoo_client.js';
import { CoinbaseClient } from '../harness/finance_common/coinbase_client.js';
import { PolymarketClient } from '../harness/finance_common/polymarket_client.js';
import { safeFetch } from '../harness/deep_web_search/security/safe_fetch.js';
import { parseRawFeed } from '../harness/rss/feed_parser.js';
import * as cheerio from 'cheerio';

/**
 * Pre-Flight Dry Run Tool
 * Step 4 of the Golden Onboarding Loop.
 * Tests live endpoints, DOM selectors, or market quotes to ensure zero false alarms,
 * confirm data extraction viability, and record baseline values prior to synthesis.
 */
export function createPreFlightProbeTool() {
  const yahoo = new YahooFinanceClient();
  const coinbase = new CoinbaseClient();
  const polymarket = new PolymarketClient();

  return tool({
    name: 'pre_flight_dry_run',
    description:
      'Runs a 1-second live dry-run verification of a target monitoring source. Confirms HTTP 200, validates data extraction, and captures initial baseline reading.',
    inputSchema: z.object({
      targetType: z
        .enum(['STOCK', 'CRYPTO', 'PREDICTION_MARKET', 'WEB_OBSERVER', 'RSS_FEED'])
        .describe('Type of watcher to dry-run test'),
      targetSource: z
        .string()
        .describe('Target identifier: ticker symbol, URL, Polymarket slug, or RSS feed link'),
      selectorOrCondition: z
        .string()
        .optional()
        .describe('Optional CSS selector for web pages or threshold query'),
    }),
    callback: async (input: {
      targetType: 'STOCK' | 'CRYPTO' | 'PREDICTION_MARKET' | 'WEB_OBSERVER' | 'RSS_FEED';
      targetSource: string;
      selectorOrCondition?: string;
    }) => {
      const startTime = Date.now();

      try {
        switch (input.targetType) {
          case 'STOCK': {
            const quote = await yahoo.getQuote(input.targetSource.toUpperCase());
            if (!quote || typeof quote.currentPrice !== 'number') {
              return {
                passed: false,
                reason: `Unable to verify stock ticker "${input.targetSource}". Ticker not found or delisted.`,
                latencyMs: Date.now() - startTime,
              };
            }
            return {
              passed: true,
              targetType: 'STOCK',
              targetSource: input.targetSource.toUpperCase(),
              baselineValue: `$${quote.currentPrice.toFixed(2)}`,
              currentNumericValue: quote.currentPrice,
              latencyMs: Date.now() - startTime,
              details: `Live quote verified via Yahoo Finance. Current price: $${quote.currentPrice.toFixed(2)} (${quote.percentChange >= 0 ? '+' : ''}${quote.percentChange.toFixed(2)}%).`,
            };
          }

          case 'CRYPTO': {
            const quote = await coinbase.getSpotPrice(input.targetSource.toUpperCase());
            if (!quote || typeof quote.price !== 'number') {
              return {
                passed: false,
                reason: `Unable to verify crypto token "${input.targetSource}". Quote returned invalid price.`,
                latencyMs: Date.now() - startTime,
              };
            }
            return {
              passed: true,
              targetType: 'CRYPTO',
              targetSource: input.targetSource.toUpperCase(),
              baselineValue: `$${quote.price.toLocaleString()}`,
              currentNumericValue: quote.price,
              latencyMs: Date.now() - startTime,
              details: `Live crypto spot verified via Coinbase. Current price: $${quote.price.toLocaleString()}.`,
            };
          }

          case 'PREDICTION_MARKET': {
            const markets = await polymarket.searchMarkets(input.targetSource, 1);
            if (!markets || markets.length === 0) {
              return {
                passed: false,
                reason: `Polymarket contract for "${input.targetSource}" could not be resolved.`,
                latencyMs: Date.now() - startTime,
              };
            }
            const market = markets[0];
            if (
              market.closed ||
              market.active !== true ||
              !Array.isArray(market.outcomes) ||
              market.outcomes.length !== 2 ||
              !Array.isArray(market.clobTokenIds) ||
              market.clobTokenIds.length !== 2 ||
              !Array.isArray(market.outcomePrices) ||
              market.outcomePrices.length !== 2 ||
              (market.endDate && Date.parse(market.endDate) <= Date.now())
            ) {
              return {
                passed: false,
                reason: 'Resolved Polymarket contract is closed, expired, or missing a valid binary CLOB quote.',
                latencyMs: Date.now() - startTime,
              };
            }
            const requestedOutcome = input.selectorOrCondition?.match(/\b(yes|no)\b/i)?.[1]?.toUpperCase();
            if (requestedOutcome && !market.outcomes.some((outcome) => outcome.toUpperCase() === requestedOutcome)) {
              return {
                passed: false,
                reason: 'Resolved market does not contain the requested ' + requestedOutcome + ' outcome.',
                latencyMs: Date.now() - startTime,
              };
            }
            const prob = Number(market.outcomePrices[0]);
            if (!Number.isFinite(prob) || prob < 0 || prob > 1) {
              return {
                passed: false,
                reason: 'Polymarket returned an invalid probability quote.',
                latencyMs: Date.now() - startTime,
              };
            }
            const probability = Math.round(prob * 100);
            return {
              passed: true,
              targetType: 'PREDICTION_MARKET',
              targetSource: market.question,
              baselineValue: `${probability}% probability`,
              currentNumericValue: prob,
              latencyMs: Date.now() - startTime,
              details: `Polymarket contract resolved: "${market.question}". Current implied probability: ${probability}%.`,
            };
          }

          case 'WEB_OBSERVER': {
            const res = await safeFetch(input.targetSource, { timeoutMs: 6000 });
            if (res.status < 200 || res.status >= 300) {
              return {
                passed: false,
                reason: `Target URL returned HTTP ${res.status}. Server error or blocked.`,
                latencyMs: Date.now() - startTime,
              };
            }

            const html = await res.text();
            const contentType = res.headers.get('content-type') || '';
            if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
              return {
                passed: false,
                reason: 'Target URL returned unsupported content type "' + contentType + '".',
                latencyMs: Date.now() - startTime,
              };
            }
            const $ = cheerio.load(html);
            let extractedText = '';

            if (input.selectorOrCondition) {
              extractedText = $(input.selectorOrCondition).text().trim();
            } else {
              extractedText = $('title').text().trim() || $('h1').first().text().trim();
            }

            if (!extractedText) {
              return {
                passed: false,
                reason: input.selectorOrCondition
                  ? 'Configured selector "' + input.selectorOrCondition + '" did not match any content.'
                  : 'Page returned no title, heading, or extractable body text.',
                latencyMs: Date.now() - startTime,
              };
            }
            return {
              passed: true,
              targetType: 'WEB_OBSERVER',
              targetSource: input.targetSource,
              baselineValue: extractedText.slice(0, 150) || 'Page loaded cleanly (HTTP 200)',
              latencyMs: Date.now() - startTime,
              details: `Web observer verified HTTP 200. Extracted initial text: "${extractedText.slice(0, 80)}..."`,
            };
          }

          case 'RSS_FEED': {
            const res = await safeFetch(input.targetSource, { timeoutMs: 6000 });
            if (res.status < 200 || res.status >= 300) {
              return {
                passed: false,
                reason: `RSS URL returned HTTP ${res.status}.`,
                latencyMs: Date.now() - startTime,
              };
            }
            const xml = await res.text();
            const parsed = parseRawFeed(xml, input.targetSource);
            const items = parsed.items || [];
            if (!parsed.title || !parsed.format || items.length === 0) {
              return {
                passed: false,
                reason: 'RSS/Atom feed did not contain a valid title and at least one baseline item.',
                latencyMs: Date.now() - startTime,
              };
            }
            const topItem = items[0]?.title || 'No items';
            const baselineSeeds = items
              .map((item) => item.id || item.link || item.title)
              .filter((seed): seed is string => typeof seed === 'string' && seed.length > 0);
            return {
              passed: true,
              targetType: 'RSS_FEED',
              targetSource: input.targetSource,
              baselineValue: `${items.length} items present. Latest: "${topItem.slice(0, 60)}"`,
              seedCount: items.length,
              baselineSeeds,
              latencyMs: Date.now() - startTime,
              details: `RSS feed verified. Found ${items.length} existing items to seed into baseline cache.`,
            };
          }

          default:
            return {
              passed: false,
              reason: `Unsupported dry-run target: ${input.targetType}`,
            };
        }
      } catch (err: any) {
        return {
          passed: false,
          reason: `Dry-run failed with error: ${err?.message || String(err)}`,
          latencyMs: Date.now() - startTime,
        };
      }
    },
  });
}
