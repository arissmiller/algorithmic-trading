import { Bar, SignalWeight, compositeScore } from "./signals";

export type MarketCondition =
  | "high_volatility_selloff"
  | "bullish_trend"
  | "pullback_mean_reversion"
  | "range_bound";

export interface MarketConditionRecommendation {
  condition: MarketCondition;
  confidence: number;
  recommendation: {
    strategyId: string;
    label: string;
    implementationStatus: "placeholder";
    note: string;
  };
  diagnostics: {
    panicScore: number;
    trendScore: number;
    pullbackScore: number;
  };
}

const PANIC_SIGNALS: SignalWeight[] = [
  { signal: { type: "rsi", period: 14 }, weight: 0.35 },
  { signal: { type: "volume", period: 20 }, weight: 0.35 },
  { signal: { type: "momentum", period: 10 }, weight: 0.3 },
];

const TREND_SIGNALS: SignalWeight[] = [
  { signal: { type: "price_vs_sma", period: 50 }, weight: 0.45 },
  { signal: { type: "momentum", period: 20 }, weight: 0.55 },
];

const PULLBACK_SIGNALS: SignalWeight[] = [
  { signal: { type: "price_vs_sma", period: 20 }, weight: 0.3 },
  { signal: { type: "rsi", period: 14 }, weight: 0.4 },
  { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.3 },
];

export function analyzeMarketCondition(bars: Bar[]): MarketConditionRecommendation {
  const last = bars.length - 1;
  if (last < 0) {
    return buildRecommendation("range_bound", 0.1, {
      panicScore: 0.5,
      trendScore: 0.5,
      pullbackScore: 0.5,
    });
  }

  const panicScore = compositeScore(PANIC_SIGNALS, bars, last);
  const trendScore = 1 - compositeScore(TREND_SIGNALS, bars, last);
  const pullbackScore = compositeScore(PULLBACK_SIGNALS, bars, last);

  if (panicScore >= 0.67) {
    return buildRecommendation("high_volatility_selloff", panicScore, {
      panicScore,
      trendScore,
      pullbackScore,
    });
  }

  if (trendScore >= 0.62) {
    return buildRecommendation("bullish_trend", trendScore, {
      panicScore,
      trendScore,
      pullbackScore,
    });
  }

  if (pullbackScore >= 0.6) {
    return buildRecommendation("pullback_mean_reversion", pullbackScore, {
      panicScore,
      trendScore,
      pullbackScore,
    });
  }

  const confidence = clamp(1 - Math.abs(0.5 - pullbackScore) * 2, 0.25, 0.75);
  return buildRecommendation("range_bound", confidence, {
    panicScore,
    trendScore,
    pullbackScore,
  });
}

function buildRecommendation(
  condition: MarketCondition,
  confidence: number,
  diagnostics: MarketConditionRecommendation["diagnostics"]
): MarketConditionRecommendation {
  switch (condition) {
    case "high_volatility_selloff":
      return {
        condition,
        confidence,
        diagnostics,
        recommendation: {
          strategyId: "volatility-defense-v1",
          label: "Volatility Defense (placeholder)",
          implementationStatus: "placeholder",
          note: "Placeholder strategy: prioritize defensive scaling and risk reduction during stress.",
        },
      };
    case "bullish_trend":
      return {
        condition,
        confidence,
        diagnostics,
        recommendation: {
          strategyId: "trend-rider-v1",
          label: "Trend Rider (placeholder)",
          implementationStatus: "placeholder",
          note: "Placeholder strategy: bias entries toward momentum continuation with tighter pullback filters.",
        },
      };
    case "pullback_mean_reversion":
      return {
        condition,
        confidence,
        diagnostics,
        recommendation: {
          strategyId: "pullback-accumulator-v1",
          label: "Pullback Accumulator (placeholder)",
          implementationStatus: "placeholder",
          note: "Placeholder strategy: scale in aggressively on oversold pullbacks while trend remains intact.",
        },
      };
    case "range_bound":
      return {
        condition,
        confidence,
        diagnostics,
        recommendation: {
          strategyId: "range-oscillator-v1",
          label: "Range Oscillator (placeholder)",
          implementationStatus: "placeholder",
          note: "Placeholder strategy: mean-reversion entries/exits around support and resistance zones.",
        },
      };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
