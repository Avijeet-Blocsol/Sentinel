import type {
  StockThreshold,
  TechnicalIndicator,
  CandlestickPattern,
  SentinelOperator,
} from '@sentinel/shared';
import type {
  FinanceOutcome,
  CommonFinanceConfig,
} from '../finance_common/index.js';

export interface StockResearchTask {
  id: string;
  query: string;
  ticker?: string;
  targetType?: 'PRICE' | 'INDICATOR' | 'CANDLESTICK';
  indicator?: TechnicalIndicator;
  candlestickPattern?: CandlestickPattern;
  period?: number;
  timeframe?: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';
  expectedOperator?: SentinelOperator;
  targetValue?: number;
  marketHoursOnly?: boolean;
  currency?: string;
}

export interface StockDossier {
  ticker: string;
  name: string;
  exchange: string;
  provider: 'FINNHUB' | 'YAHOO';
  currentPrice: number;
  previousClose: number;
  marketHoursOnly: boolean;
  indicatorDisplay?: string;
  contract: StockThreshold;
}

export type StockResearchOutcome = FinanceOutcome<StockThreshold>;

export interface StockHarnessConfig extends CommonFinanceConfig {
  preferProvider?: 'FINNHUB' | 'YAHOO';
  maxCandidates?: number;
}
