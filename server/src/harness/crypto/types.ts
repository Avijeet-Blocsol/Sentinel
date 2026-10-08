import type {
  CryptoThreshold,
  TechnicalIndicator,
  CandlestickPattern,
  SentinelOperator,
} from '@sentinel/shared';
import type {
  FinanceOutcome,
  CommonFinanceConfig,
  OHLCV,
} from '../finance_common/index.js';

export interface CryptoResearchTask {
  id: string;
  query: string;
  assetSymbol?: string;
  currency?: string;
  targetType?: 'PRICE' | 'INDICATOR' | 'CANDLESTICK';
  indicator?: TechnicalIndicator;
  candlestickPattern?: CandlestickPattern;
  period?: number;
  timeframe?: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';
  expectedOperator?: SentinelOperator;
  targetValue?: number;
  dexContractAddress?: string;
  dexNetwork?: string;
}

export interface CryptoDossier {
  assetSymbol: string;
  name: string;
  venue: 'COINBASE' | 'DEXSCREENER';
  dexContractAddress?: string;
  dexNetwork?: string;
  currentPrice: number;
  volume24h?: number;
  indicatorDisplay?: string;
  verifiedCandlesCount: number;
  contract: CryptoThreshold;
}

export type CryptoResearchOutcome = FinanceOutcome<CryptoThreshold>;

export interface CryptoHarnessConfig extends CommonFinanceConfig {
  maxCandidates?: number;
}
