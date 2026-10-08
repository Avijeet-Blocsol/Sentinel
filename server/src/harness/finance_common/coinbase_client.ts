import { type OHLCV, ProviderError, type ClientRequestOptions } from './types.js';
import { globalRequestCoalescer } from './request_coalescer.js';

export { ProviderError };

export interface CoinbaseProduct {
  id: string; // e.g. "BTC-USD"
  baseCurrency: string; // e.g. "BTC"
  quoteCurrency: string; // e.g. "USD"
  status: string; // "online"
  displayName: string;
}

export interface CoinbaseSpotQuote {
  productId: string;
  price: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  open24h: number;
  timestamp: number;
}

function buildSignal(options?: number | ClientRequestOptions, defaultTimeout = 8000): AbortSignal {
  const timeoutMs = typeof options === 'number' ? options : (options?.timeoutMs ?? defaultTimeout);
  const parentSignal = typeof options === 'object' ? options?.signal : undefined;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}

export class CoinbaseClient {
  private readonly baseUrl = 'https://api.exchange.coinbase.com';
  private productsCache: CoinbaseProduct[] | null = null;
  private productsCacheTime = 0;

  async getProducts(options?: number | ClientRequestOptions): Promise<CoinbaseProduct[]> {
    // Cache products for 1 hour in memory
    if (this.productsCache && Date.now() - this.productsCacheTime < 3600_000) {
      return this.productsCache;
    }

    return globalRequestCoalescer.coalesce('coinbase:products', async () => {
      const signal = buildSignal(options, 8000);
      try {
        const res = await fetch(`${this.baseUrl}/products`, {
          headers: { 'User-Agent': 'StrandsSentinel/1.0' },
          signal,
        });
        if (!res.ok) {
          if (res.status >= 500 || res.status === 429) {
            throw new ProviderError('COINBASE', res.status, `Failed to fetch products: ${res.statusText}`);
          }
          return [];
        }

        const raw = (await res.json()) as Array<{
          id: string;
          base_currency: string;
          quote_currency: string;
          status: string;
          display_name?: string;
        }>;

        this.productsCache = raw
          .filter((p) => p.status === 'online')
          .map((p) => ({
            id: p.id,
            baseCurrency: p.base_currency,
            quoteCurrency: p.quote_currency,
            status: p.status,
            displayName: p.display_name || p.id,
          }));
        this.productsCacheTime = Date.now();
        return this.productsCache;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || (typeof options === 'object' && options?.signal?.aborted)) {
          throw err;
        }
        if (err instanceof ProviderError) {
          throw err;
        }
        throw new ProviderError('COINBASE', undefined, err instanceof Error ? err.message : String(err), err);
      }
    });
  }

  async resolveProduct(
    symbolOrName: string,
    options?: number | ClientRequestOptions,
    quoteCurrency = 'USD',
  ): Promise<CoinbaseProduct | null> {
    const quote = quoteCurrency.trim().toUpperCase();
    const normalized = symbolOrName.trim().toUpperCase();
    const suffix = `-${quote}`;
    const clean = normalized.endsWith(suffix)
      ? normalized.slice(0, -suffix.length)
      : normalized.replace(/[-_/][A-Z]{3,8}$/, '');
    const products = await this.getProducts(options);

    // 1. Exact base/quote match (e.g. "BTC" + "EUR" -> "BTC-EUR")
    const exact = products.find((p) => p.baseCurrency === clean && p.quoteCurrency === quote);
    if (exact) return exact;

    // 2. Exact product id match
    const idMatch = products.find((p) => p.id === normalized || p.id === `${clean}-${quote}`);
    if (idMatch) return idMatch;

    return null;
  }

  async getSpotPrice(productId: string, options?: number | ClientRequestOptions): Promise<CoinbaseSpotQuote | null> {
    const cleanId = productId.includes('-') ? productId : `${productId.toUpperCase()}-USD`;

    return globalRequestCoalescer.coalesce(`coinbase:spot:${cleanId}`, async () => {
      const signal = buildSignal(options, 8000);
      try {
        // Fetch ticker and 24h stats concurrently
        const [tickerRes, statsRes] = await Promise.all([
          fetch(`${this.baseUrl}/products/${cleanId}/ticker`, {
            headers: { 'User-Agent': 'StrandsSentinel/1.0' },
            signal,
          }),
          fetch(`${this.baseUrl}/products/${cleanId}/stats`, {
            headers: { 'User-Agent': 'StrandsSentinel/1.0' },
            signal,
          }),
        ]);

        if (!tickerRes.ok) {
          if (tickerRes.status === 404) return null;
          if (tickerRes.status >= 500 || tickerRes.status === 429) {
            throw new ProviderError('COINBASE', tickerRes.status, `Ticker request failed with status ${tickerRes.status}: ${tickerRes.statusText}`);
          }
          return null;
        }

        const ticker = (await tickerRes.json()) as { price?: string; time?: string };
        const stats = statsRes.ok
          ? ((await statsRes.json()) as {
              volume?: string;
              high?: string;
              low?: string;
              open?: string;
            })
          : {};

        const price = parseFloat(ticker.price || '0');
        if (price <= 0) return null;

        return {
          productId: cleanId,
          price,
          volume24h: parseFloat(stats.volume || '0'),
          high24h: parseFloat(stats.high || '0'),
          low24h: parseFloat(stats.low || '0'),
          open24h: parseFloat(stats.open || '0'),
          timestamp: ticker.time ? new Date(ticker.time).getTime() : Date.now(),
        };
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || (typeof options === 'object' && options?.signal?.aborted)) {
          throw err;
        }
        if (err instanceof ProviderError) {
          throw err;
        }
        throw new ProviderError('COINBASE', undefined, err instanceof Error ? err.message : String(err), err);
      }
    });
  }

  async getCandles(
    productId: string,
    granularity = 3600, // 3600 = 1h, 86400 = 1d
    options?: number | ClientRequestOptions
  ): Promise<OHLCV[]> {
    const cleanId = productId.includes('-') ? productId : `${productId.toUpperCase()}-USD`;

    return globalRequestCoalescer.coalesce(`coinbase:candles:${cleanId}:${granularity}`, async () => {
      const signal = buildSignal(options, 9000);
      try {
        const url = `${this.baseUrl}/products/${cleanId}/candles?granularity=${granularity}`;

        const res = await fetch(url, {
          headers: { 'User-Agent': 'StrandsSentinel/1.0' },
          signal,
        });
        if (!res.ok) {
          if (res.status === 404) return [];
          if (res.status >= 500 || res.status === 429) {
            throw new ProviderError('COINBASE', res.status, `Candles request failed with status ${res.status}: ${res.statusText}`);
          }
          return [];
        }

        // Raw format: [ [time, low, high, open, close, volume], ... ]
        const raw = (await res.json()) as number[][];
        if (!Array.isArray(raw) || raw.length === 0) return [];

        // Coinbase returns newest first. Reverse to chronological ascending order.
        const candles: OHLCV[] = raw
          .map((c) => ({
            timestamp: c[0] * 1000,
            low: c[1],
            high: c[2],
            open: c[3],
            close: c[4],
            volume: c[5],
          }))
          .reverse();

        return candles;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || (typeof options === 'object' && options?.signal?.aborted)) {
          throw err;
        }
        if (err instanceof ProviderError) {
          throw err;
        }
        throw new ProviderError('COINBASE', undefined, err instanceof Error ? err.message : String(err), err);
      }
    });
  }
}
