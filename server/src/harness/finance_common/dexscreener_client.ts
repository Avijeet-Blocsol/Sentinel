import { globalRequestCoalescer } from './request_coalescer.js';
import { ProviderError } from './types.js';

export { ProviderError };

export interface DexPairResult {
  chainId: string; // e.g. "solana", "ethereum", "base"
  dexId: string; // e.g. "raydium", "uniswap"
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    symbol: string;
  };
  priceUsd: string;
  liquidityUsd?: number;
  volume24h?: number;
  url: string;
}

export interface DexSearchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  symbol?: string;
  contractAddress?: string;
  network?: string;
  maxCandidates?: number;
}

function buildSignal(options?: number | DexSearchOptions, defaultTimeout = 8000): AbortSignal {
  const timeoutMs = typeof options === 'number' ? options : (options?.timeoutMs ?? defaultTimeout);
  const parentSignal = typeof options === 'object' ? options?.signal : undefined;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}

export class DexScreenerClient {
  private readonly baseUrl = 'https://api.dexscreener.com/latest/dex';

  async searchPairs(query: string, options?: number | DexSearchOptions): Promise<DexPairResult[]> {
    const clean = query.trim().toLowerCase();
    const maxCandidates = typeof options === 'object' ? (options?.maxCandidates ?? 8) : 8;

    return globalRequestCoalescer.coalesce(`dexscreener:search:${clean}`, async () => {
      const signal = buildSignal(options, 8000);
      try {
        const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'StrandsSentinel/1.0' },
          signal,
        });
        if (!res.ok) {
          if (res.status >= 500 || res.status === 429) {
            throw new ProviderError('DEXSCREENER', res.status, `DexScreener API error ${res.status}: ${res.statusText}`);
          }
          return [];
        }

        const data = (await res.json()) as { pairs?: Array<any> };
        if (!data.pairs || !Array.isArray(data.pairs)) return [];

        let filtered = data.pairs.filter((p) => p.liquidity && p.liquidity.usd > 1000);

        // Verification against requested token parameters (Item 6)
        if (typeof options === 'object') {
          if (options.contractAddress) {
            const targetAddr = options.contractAddress.toLowerCase();
            filtered = filtered.filter(
              (p) =>
                p.baseToken?.address?.toLowerCase() === targetAddr ||
                p.pairAddress?.toLowerCase() === targetAddr
            );
          }
          if (options.network) {
            const targetNet = options.network.toLowerCase();
            filtered = filtered.filter((p) => p.chainId?.toLowerCase() === targetNet);
          }
          if (options.symbol) {
            const targetSym = options.symbol.toUpperCase();
            filtered = filtered.filter(
              (p) =>
                p.baseToken?.symbol?.toUpperCase() === targetSym ||
                p.baseToken?.name?.toLowerCase() === options.symbol?.toLowerCase()
            );
          }
        }

        return filtered
          .slice(0, maxCandidates)
          .map((p) => ({
            chainId: p.chainId,
            dexId: p.dexId,
            pairAddress: p.pairAddress,
            baseToken: {
              address: p.baseToken?.address || '',
              name: p.baseToken?.name || '',
              symbol: p.baseToken?.symbol || '',
            },
            quoteToken: {
              symbol: p.quoteToken?.symbol || 'USD',
            },
            priceUsd: p.priceUsd || '0',
            liquidityUsd: p.liquidity?.usd,
            volume24h: p.volume?.h24,
            url: p.url || '',
          }));
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || (typeof options === 'object' && options?.signal?.aborted)) {
          throw err;
        }
        if (err instanceof ProviderError) {
          throw err;
        }
        throw new ProviderError('DEXSCREENER', undefined, err instanceof Error ? err.message : String(err), err);
      }
    });
  }

  async getPair(pairAddress: string, options?: number | { timeoutMs?: number; signal?: AbortSignal }): Promise<DexPairResult | null> {
    const clean = pairAddress.trim().toLowerCase();

    return globalRequestCoalescer.coalesce(`dexscreener:pair:${clean}`, async () => {
      const signal = buildSignal(options, 8000);
      try {
        const url = `${this.baseUrl}/pairs/${encodeURIComponent(pairAddress)}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'StrandsSentinel/1.0' },
          signal,
        });
        if (!res.ok) {
          if (res.status >= 500 || res.status === 429) {
            throw new ProviderError('DEXSCREENER', res.status, `DexScreener API error ${res.status}: ${res.statusText}`);
          }
          return null;
        }

        const data = (await res.json()) as { pair?: any };
        if (!data.pair) return null;

        const p = data.pair;
        return {
          chainId: p.chainId,
          dexId: p.dexId,
          pairAddress: p.pairAddress,
          baseToken: {
            address: p.baseToken?.address || '',
            name: p.baseToken?.name || '',
            symbol: p.baseToken?.symbol || '',
          },
          quoteToken: {
            symbol: p.quoteToken?.symbol || 'USD',
          },
          priceUsd: p.priceUsd || '0',
          liquidityUsd: p.liquidity?.usd,
          volume24h: p.volume?.h24,
          url: p.url || '',
        };
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || (typeof options === 'object' && options?.signal?.aborted)) {
          throw err;
        }
        if (err instanceof ProviderError) {
          throw err;
        }
        throw new ProviderError('DEXSCREENER', undefined, err instanceof Error ? err.message : String(err), err);
      }
    });
  }
}
