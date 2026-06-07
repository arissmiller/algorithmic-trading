import type { BacktestRun } from "../../components/RunQueueBuilder";
import type { StrategyForm } from "../../components/StrategyBuilder";
import type { BacktestResult } from "../../lib/backtest";
import type { CryptoAutotraderBacktestResult } from "../../lib/cryptoAutotraderBacktest";
import type { MarketConditionRecommendation } from "../../lib/marketConditions";
import type { PerpetualBacktestResult } from "../../lib/perpetualBacktest";
import type { Bar, EarningsEvent } from "../../lib/signals";
import type { CryptoTrendConfidenceBacktestResult } from "../../lib/cryptoTrendConfidenceBacktest";

export type MarketBarsPayload = {
  bars: Bar[];
  earningsEvents: EarningsEvent[];
};

export interface RunQueueResult {
  run: BacktestRun;
  form: StrategyForm;
  result: BacktestResult | null;
  perpetualResult?: PerpetualBacktestResult | null;
  autotraderResult?: CryptoAutotraderBacktestResult | null;
  trendConfidenceResult?: CryptoTrendConfidenceBacktestResult | null;
  bars: Bar[];
  earningsEvents: EarningsEvent[];
  marketRecommendation: MarketConditionRecommendation | null;
  error: string | null;
}

export type FetchBars = (
  symbol: string,
  options: {
    timeframe?: "1Day" | "1Hour" | "15Min" | "5Min";
    startDate?: string;
    endDate?: string;
    range?: string;
  }
) => Promise<MarketBarsPayload>;

export type BuildFormFromRun = (run: BacktestRun) => StrategyForm;

export type RunExecutor = (run: BacktestRun, form: StrategyForm) => Promise<RunQueueResult>;
