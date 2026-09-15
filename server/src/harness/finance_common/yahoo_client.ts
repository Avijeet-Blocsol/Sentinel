import { type OHLCV, ProviderError, type ClientRequestOptions } from './types.js';
import { globalRequestCoalescer } from './request_coalescer.js';

export { ProviderError };

export interface YahooSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
}

export interface YahooQuote {
  currentPrice: number;
  previousClose: number;
  change: number;
  percentChange: number;
  high?: number;
  low?: number;
  open?: number;
  volume?: number;
  currency: string;
  exchange?: string;
  timestamp: number;
}

function buildCoalescedSignal(coalescedSignal?: AbortSignal, timeoutMs = 8000): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return coalescedSignal ? AbortSignal.any([coalescedSignal, timeoutSignal]) : timeoutSignal;
}

export class YahooFinanceClient {
  private readonly userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

  async searchSymbols(query: string, options?: number | ClientRequestOptions): Promise<YahooSearchResult[]> {
    const clean = query.trim().toUpperCase();
    const parentSignal = typeof options === 'object' ? options?.signal : undefined;
    const timeoutMs = typeof options === 'number' ? options : (options?.timeoutMs ?? 8000);

    return globalRequestCoalescer.coalesce(`yahoo:search:${clean}`, async (coalescedSignal) => {
      const signal = buildCoalescedSignal(coalescedSignal, timeoutMs);
      try {
        const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
        const res = await fetch(url, {
          headers: { 'User-Agent': this.userAgent },
          signal,
        });
        if (!res.ok) {
          if (res.status === 404) return [];
          if (res.status === 429 || res.status >= 500) {
            throw new ProviderError('YAHOO', res.status, `Symbol search failed with status ${res.status}: ${res.statusText}`);
          }
          return [];
        }

        const data = (await res.json()) as {
          quotes?: Array<{
            symbol: string;
            shortname?: string;
            longname?: string;
            exchange?: string;
            quoteType?: string;
          }>;
        };

        if (!data.quotes || !Array.isArray(data.quotes)) return [];

        return data.quotes
          .filter((q) => q.quoteType === 'EQUITY' || q.quoteType === 'ETF')
          .map((q) => ({
            symbol: q.symbol,
            name: q.shortname || q.longname || q.symbol,
            exchange: q.exchange || 'US',
            type: q.quoteType || 'EQUITY',
          }));
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err;
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('YAHOO', undefined, (err as Error)?.message || 'Network error during search', err);
      }
    }, parentSignal);
  }

  async getQuote(symbol: string, options?: number | ClientRequestOptions): Promise<YahooQuote | null> {
    const clean = symbol.trim().toUpperCase();
    const parentSignal = typeof options === 'object' ? options?.signal : undefined;
    const timeoutMs = typeof options === 'number' ? options : (options?.timeoutMs ?? 8000);

    return globalRequestCoalescer.coalesce(`yahoo:quote:${clean}`, async (coalescedSignal) => {
      const signal = buildCoalescedSignal(coalescedSignal, timeoutMs);
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
        const res = await fetch(url, {
          headers: { 'User-Agent': this.userAgent },
          signal,
        });
        if (!res.ok) {
          if (res.status === 404) return null;
          if (res.status === 429 || res.status >= 500) {
            throw new ProviderError('YAHOO', res.status, `Quote request failed with status ${res.status}: ${res.statusText}`);
          }
          return null;
        }

        const data = (await res.json()) as {
          chart?: {
            result?: Array<{
              meta?: {
                currency?: string;
                exchangeName?: string;
                regularMarketPrice?: number;
                chartPreviousClose?: number;
                previousClose?: number;
              };
              indicators?: {
                quote?: Array<{
                  close?: Array<number | null>;
                  open?: Array<number | null>;
                  high?: Array<number | null>;
                  low?: Array<number | null>;
                  volume?: Array<number | null>;
                }>;
              };
              timestamp?: number[];
            }>;
          };
        };

        const result = data.chart?.result?.[0];
        if (!result || !result.meta) return null;

        const currentPrice = result.meta.regularMarketPrice;
        if (!Number.isFinite(currentPrice) || currentPrice! <= 0) return null;

        const prevCloseRaw = result.meta.chartPreviousClose ?? result.meta.previousClose;
        const prevClose = Number.isFinite(prevCloseRaw) && prevCloseRaw! > 0 ? prevCloseRaw! : currentPrice!;
        const change = currentPrice! - prevClose;
        const percentChange = prevClose > 0 ? (change / prevClose) * 100 : 0;

        const quoteData = result.indicators?.quote?.[0];
        const highs = quoteData?.high?.filter((v): v is number => v !== null && Number.isFinite(v)) || [];
        const lows = quoteData?.low?.filter((v): v is number => v !== null && Number.isFinite(v)) || [];
        const opens = quoteData?.open?.filter((v): v is number => v !== null && Number.isFinite(v)) || [];
        const volumes = quoteData?.volume?.filter((v): v is number => v !== null && Number.isFinite(v)) || [];

        return {
          currentPrice: currentPrice!,
          change,
          percentChange,
          high: highs.length > 0 ? Math.max(...highs) : currentPrice!,
          low: lows.length > 0 ? Math.min(...lows) : currentPrice!,
          open: opens.length > 0 ? opens[opens.length - 1] : currentPrice!,
          previousClose: prevClose,
          volume: volumes.length > 0 ? volumes[volumes.length - 1] : 0,
          currency: result.meta.currency || 'USD',
          exchange: result.meta.exchangeName || 'US',
          timestamp: Date.now(),
        };
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err;
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('YAHOO', undefined, (err as Error)?.message || 'Network error fetching quote', err);
      }
    }, parentSignal);
  }

  async getCandles(
    symbol: string,
    interval = '1d',
    range = '3mo',
    options?: number | ClientRequestOptions
  ): Promise<OHLCV[]> {
    const clean = symbol.trim().toUpperCase();
    const parentSignal = typeof options === 'object' ? options?.signal : undefined;
    const timeoutMs = typeof options === 'number' ? options : (options?.timeoutMs ?? 9000);

    // Map input timeframe/interval to standard Yahoo intervals and sensible ranges
    let fetchInterval = interval;
    let fetchRange = range;
    let aggregate4h = false;

    if (interval === '1m') {
      fetchInterval = '1m';
      fetchRange = range === '3mo' ? '5d' : range;
    } else if (interval === '5m') {
      fetchInterval = '5m';
      fetchRange = range === '3mo' ? '1mo' : range;
    } else if (interval === '15m') {
      fetchInterval = '15m';
      fetchRange = range === '3mo' ? '1mo' : range;
    } else if (interval === '30m') {
      fetchInterval = '30m';
      fetchRange = range === '3mo' ? '1mo' : range;
    } else if (interval === '1h') {
      fetchInterval = '1h';
      fetchRange = range === '3mo' ? '1mo' : range;
    } else if (interval === '4h') {
      fetchInterval = '1h';
      fetchRange = range === '3mo' ? '3mo' : range;
      aggregate4h = true;
    } else if (interval === '1w') {
      fetchInterval = '1wk';
      fetchRange = range === '3mo' ? '1y' : range;
    }

    return globalRequestCoalescer.coalesce(`yahoo:candles:${clean}:${fetchInterval}:${fetchRange}:${aggregate4h}`, async (coalescedSignal) => {
      const signal = buildCoalescedSignal(coalescedSignal, timeoutMs);
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${fetchInterval}&range=${fetchRange}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': this.userAgent },
          signal,
        });
        if (!res.ok) {
          if (res.status === 404) return [];
          if (res.status === 429 || res.status >= 500) {
            throw new ProviderError('YAHOO', res.status, `Candle request failed with status ${res.status}: ${res.statusText}`);
          }
          return [];
        }

        const data = (await res.json()) as {
          chart?: {
            result?: Array<{
              timestamp?: number[];
              indicators?: {
                quote?: Array<{
                  open?: (number | null)[];
                  high?: (number | null)[];
                  low?: (number | null)[];
                  close?: (number | null)[];
                  volume?: (number | null)[];
                }>;
              };
            }>;
          };
        };

        const result = data.chart?.result?.[0];
        if (!result || !result.timestamp || !result.indicators?.quote?.[0]) return [];

        const ts = result.timestamp;
        const quote = result.indicators.quote[0];
        const candles: OHLCV[] = [];

        for (let i = 0; i < ts.length; i++) {
          const timestamp = ts[i];
          const close = quote.close?.[i];
          if (!Number.isFinite(timestamp) || !Number.isFinite(close)) continue;

          const open = Number.isFinite(quote.open?.[i]) ? (quote.open![i] as number) : (close as number);
          const high = Number.isFinite(quote.high?.[i]) ? Math.max(quote.high![i] as number, open, close as number) : Math.max(open, close as number);
          const low = Number.isFinite(quote.low?.[i]) ? Math.min(quote.low![i] as number, open, close as number) : Math.min(open, close as number);
          const volume = Number.isFinite(quote.volume?.[i]) && quote.volume![i]! >= 0 ? (quote.volume![i] as number) : 0;

          candles.push({
            timestamp: timestamp * 1000,
            open,
            high,
            low,
            close: close as number,
            volume,
          });
        }

        if (aggregate4h && candles.length > 0) {
          const aggregated: OHLCV[] = [];
          for (let i = 0; i < candles.length; i += 4) {
            const chunk = candles.slice(i, i + 4);
            aggregated.push({
              timestamp: chunk[0].timestamp,
              open: chunk[0].open,
              high: Math.max(...chunk.map((c) => c.high)),
              low: Math.min(...chunk.map((c) => c.low)),
              close: chunk[chunk.length - 1].close,
              volume: chunk.reduce((acc, c) => acc + c.volume, 0),
            });
          }
          return aggregated;
        }

        return candles;
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err;
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('YAHOO', undefined, (err as Error)?.message || 'Network error fetching candles', err);
      }
    }, parentSignal);
  }
}
