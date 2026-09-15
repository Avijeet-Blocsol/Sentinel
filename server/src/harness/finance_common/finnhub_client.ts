import { type OHLCV, ProviderError, type ClientRequestOptions } from './types.js';
import { globalRequestCoalescer } from './request_coalescer.js';

export { ProviderError };

export interface FinnhubSearchResult {
  description: string;
  displaySymbol: string;
  symbol: string;
  type: string;
}

export interface FinnhubQuote {
  currentPrice: number;
  change: number;
  percentChange: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  currency?: string;
  timestamp: number;
}

export function inferCurrencyFromSymbol(symbol: string): string {
  const clean = symbol.trim().toUpperCase();
  if (clean.endsWith('.L') || clean.endsWith('.IL')) return 'GBP';
  if (clean.endsWith('.TO') || clean.endsWith('.V') || clean.endsWith('.CN')) return 'CAD';
  if (clean.endsWith('.DE') || clean.endsWith('.PA') || clean.endsWith('.AS') || clean.endsWith('.MC') || clean.endsWith('.MI')) return 'EUR';
  if (clean.endsWith('.T') || clean.endsWith('.TYO')) return 'JPY';
  if (clean.endsWith('.HK')) return 'HKD';
  if (clean.endsWith('.AX')) return 'AUD';
  if (clean.endsWith('.SW')) return 'CHF';
  if (clean.endsWith('.SS') || clean.endsWith('.SZ')) return 'CNY';
  if (clean.endsWith('.NS') || clean.endsWith('.BO')) return 'INR';
  return 'USD';
}

function buildCoalescedSignal(coalescedSignal?: AbortSignal, timeoutMs = 8000): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return coalescedSignal ? AbortSignal.any([coalescedSignal, timeoutSignal]) : timeoutSignal;
}

export class FinnhubClient {
  private readonly apiKey: string;
  private readonly baseUrl = 'https://finnhub.io/api/v1';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.FINNHUB_API_KEY || '';
  }

  isConfigured(): boolean {
    return !!this.apiKey && this.apiKey.trim().length > 0;
  }

  async searchSymbols(query: string, options?: number | ClientRequestOptions): Promise<FinnhubSearchResult[]> {
    if (!this.isConfigured()) return [];
    const clean = query.trim().toUpperCase();
    const parentSignal = typeof options === 'object' ? options?.signal : undefined;
    const timeoutMs = typeof options === 'number' ? options : (options?.timeoutMs ?? 8000);

    return globalRequestCoalescer.coalesce(`finnhub:search:${clean}`, async (coalescedSignal) => {
      const signal = buildCoalescedSignal(coalescedSignal, timeoutMs);
      try {
        const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&token=${this.apiKey}`;
        const res = await fetch(url, { signal });
        if (!res.ok) {
          if (res.status === 404) return [];
          if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403) {
            throw new ProviderError('FINNHUB', res.status, `Symbol search failed with status ${res.status}: ${res.statusText}`);
          }
          return [];
        }

        const data = (await res.json()) as { count: number; result: FinnhubSearchResult[] };
        return (data.result || [])
          .filter((r) => !r.symbol.includes('.')) // Prefer primary symbols over complex OTC
          .slice(0, 10);
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err;
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('FINNHUB', undefined, (err as Error)?.message || 'Network error during search', err);
      }
    }, parentSignal);
  }

  async getQuote(symbol: string, options?: number | ClientRequestOptions): Promise<FinnhubQuote | null> {
    if (!this.isConfigured()) return null;
    const clean = symbol.trim().toUpperCase();
    const parentSignal = typeof options === 'object' ? options?.signal : undefined;
    const timeoutMs = typeof options === 'number' ? options : (options?.timeoutMs ?? 8000);

    return globalRequestCoalescer.coalesce(`finnhub:quote:${clean}`, async (coalescedSignal) => {
      const signal = buildCoalescedSignal(coalescedSignal, timeoutMs);
      try {
        const url = `${this.baseUrl}/quote?symbol=${encodeURIComponent(symbol)}&token=${this.apiKey}`;
        const res = await fetch(url, { signal });
        if (!res.ok) {
          if (res.status === 404) return null;
          if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403) {
            throw new ProviderError('FINNHUB', res.status, `Quote request failed with status ${res.status}: ${res.statusText}`);
          }
          return null;
        }

        const data = (await res.json()) as {
          c: number;
          d: number;
          dp: number;
          h: number;
          l: number;
          o: number;
          pc: number;
          t: number;
        };

        if (!data || !Number.isFinite(data.c) || data.c <= 0) return null;

        const currentPrice = data.c;
        const prevClose = Number.isFinite(data.pc) && data.pc > 0 ? data.pc : currentPrice;
        const change = Number.isFinite(data.d) ? data.d : currentPrice - prevClose;
        const percentChange = Number.isFinite(data.dp) ? data.dp : prevClose > 0 ? (change / prevClose) * 100 : 0;
        const high = Number.isFinite(data.h) ? data.h : currentPrice;
        const low = Number.isFinite(data.l) ? data.l : currentPrice;
        const open = Number.isFinite(data.o) ? data.o : currentPrice;
        const timestamp = Number.isFinite(data.t) && data.t > 0 ? data.t * 1000 : Date.now();

        return {
          currentPrice,
          change,
          percentChange,
          high,
          low,
          open,
          previousClose: prevClose,
          currency: inferCurrencyFromSymbol(symbol),
          timestamp,
        };
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err;
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('FINNHUB', undefined, (err as Error)?.message || 'Network error during quote', err);
      }
    }, parentSignal);
  }

  async getCandles(
    symbol: string,
    resolution: string,
    limit: number = 50,
    options?: number | ClientRequestOptions
  ): Promise<OHLCV[]> {
    if (!this.isConfigured()) return [];
    const clean = symbol.trim().toUpperCase();
    const parentSignal = typeof options === 'object' ? options?.signal : undefined;
    const timeoutMs = typeof options === 'number' ? options : (options?.timeoutMs ?? 9000);

    const is4h = resolution === '4h';
    const finnhubRes =
      resolution === '1m' ? '1'
      : resolution === '5m' ? '5'
      : resolution === '15m' ? '15'
      : resolution === '30m' ? '30'
      : resolution === '1h' || is4h ? '60'
      : resolution === '1d' ? 'D'
      : resolution === '1w' ? 'W'
      : resolution;

    return globalRequestCoalescer.coalesce(`finnhub:candles:${clean}:${finnhubRes}:${limit}:${is4h}`, async (coalescedSignal) => {
      const signal = buildCoalescedSignal(coalescedSignal, timeoutMs);
      try {
        const to = Math.floor(Date.now() / 1000);
        // Rough time window estimation based on resolution
        const secondsPerCandle =
          finnhubRes === '1' ? 60
          : finnhubRes === '5' ? 300
          : finnhubRes === '15' ? 900
          : finnhubRes === '30' ? 1800
          : finnhubRes === '60' ? 3600
          : finnhubRes === 'D' ? 86400
          : 604800;

        const effectiveLimit = is4h ? limit * 4 : limit;
        const from = to - effectiveLimit * secondsPerCandle * 1.5; // add buffer for weekends

        const url = `${this.baseUrl}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${finnhubRes}&from=${Math.floor(from)}&to=${to}&token=${this.apiKey}`;
        const res = await fetch(url, { signal });
        if (!res.ok) {
          if (res.status === 404) return [];
          if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403) {
            throw new ProviderError('FINNHUB', res.status, `Candle request failed with status ${res.status}: ${res.statusText}`);
          }
          return [];
        }

        const data = (await res.json()) as {
          c: number[];
          h: number[];
          l: number[];
          o: number[];
          s: string;
          t: number[];
          v: number[];
        };

        if (data.s !== 'ok' || !data.c || data.c.length === 0) return [];

        const rawCandles: OHLCV[] = [];
        for (let i = 0; i < data.t.length; i++) {
          const ts = data.t[i];
          const close = data.c[i];
          if (!Number.isFinite(ts) || !Number.isFinite(close)) continue;

          const open = Number.isFinite(data.o?.[i]) ? (data.o[i] as number) : close;
          const high = Number.isFinite(data.h?.[i]) ? Math.max(data.h[i], open, close) : Math.max(open, close);
          const low = Number.isFinite(data.l?.[i]) ? Math.min(data.l[i], open, close) : Math.min(open, close);
          const volume = Number.isFinite(data.v?.[i]) && data.v[i] >= 0 ? data.v[i] : 0;

          rawCandles.push({
            timestamp: ts * 1000,
            open,
            high,
            low,
            close,
            volume,
          });
        }

        if (is4h && rawCandles.length > 0) {
          const aggregated: OHLCV[] = [];
          for (let i = 0; i < rawCandles.length; i += 4) {
            const chunk = rawCandles.slice(i, i + 4);
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

        return rawCandles;
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err;
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('FINNHUB', undefined, (err as Error)?.message || 'Network error fetching candles', err);
      }
    }, parentSignal);
  }
}
