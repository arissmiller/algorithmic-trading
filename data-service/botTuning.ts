import { SignalWeight } from "./botSignals";

export type BotTuningProfileKey =
  | "long_term_scale_in"
  | "short_term_scale_in"
  | "long_term_selloff"
  | "short_term_selloff"
  | "crash_buy_in"
  | "crash_selloff_detected"
  | "hourly_breakout"
  | "hourly_trend_continuation"
  | "hourly_squeeze_breakout"
  | "hourly_impulse_buy";

export interface BotTuningProfile {
  key: BotTuningProfileKey;
  label: string;
  summary: string;
  timeframe: "1Day" | "1Hour";
  objective: "scale_in" | "selloff";
  durationDays: number;
  buyThreshold: number;
  sellThreshold: number;
  signals: SignalWeight[];
  crashDetection?: {
    enabled: boolean;
    threshold: number;
    signals: SignalWeight[];
  };
}

export const BOT_TUNING = {
  cadence: {
    minDays: 10,
    maxDays: 30,
    // Duration is divided by this to derive a target cadence before min/max clamp.
    durationDivisor: 8,
  },
  historyWeighting: {
    // Use only the most recent window for adaptive weighting.
    lookbackBars: 300,
    // Require enough samples before adapting, otherwise keep base weights.
    minSamples: 40,
    // Blend factor between configured weights and history-adapted weights.
    // 0 = configured weights only, 1 = adapted weights only.
    blend: 0.65,
    // Keep each adapted signal multiplier bounded.
    minMultiplier: 0.6,
    maxMultiplier: 1.8,
    // Correlation strength to multiplier scaling.
    correlationScale: 1.5,
  },
  defaults: {
    profile: "long_term_scale_in" as BotTuningProfileKey,
    objective: "scale_in" as const,
    durationDays: 90,
    buyThreshold: 0.67,
    sellThreshold: 0.33,
  },
  crashDetection: {
    defaultThreshold: 0.75,
  },
  risk: {
    // Backend-managed defaults for autotrader risk controls.
    stopLossPct: 0.06,
    trailingStopPct: 0.02,
  },
} as const;

export const BOT_TUNING_PROFILES: Record<BotTuningProfileKey, BotTuningProfile> = {
  long_term_scale_in: {
    key: "long_term_scale_in",
    label: "Long-Term Scale-In (6-12m)",
    summary: "Gradual accumulation with slower signal profile.",
    timeframe: "1Day",
    objective: "scale_in",
    durationDays: 270,
    buyThreshold: 0.64,
    sellThreshold: 0.33,
    signals: [
      { signal: { type: "price_vs_sma", period: 40 }, weight: 0.35 },
      { signal: { type: "rsi", period: 14 }, weight: 0.25 },
      { signal: { type: "bollinger_band", period: 30, std_dev: 2 }, weight: 0.15 },
      { signal: { type: "momentum", period: 30 }, weight: 0.15 },
      { signal: { type: "volume", period: 20 }, weight: 0.1 },
    ],
  },
  short_term_scale_in: {
    key: "short_term_scale_in",
    label: "Short-Term Scale-In (2-8w)",
    summary: "Faster accumulation tuned to shorter pullback cycles.",
    timeframe: "1Hour",
    objective: "scale_in",
    durationDays: 42,
    buyThreshold: 0.69,
    sellThreshold: 0.33,
    signals: [
      { signal: { type: "rsi", period: 10 }, weight: 0.3 },
      { signal: { type: "bollinger_band", period: 20, std_dev: 2.2 }, weight: 0.3 },
      { signal: { type: "momentum", period: 7 }, weight: 0.25 },
      { signal: { type: "volume", period: 20 }, weight: 0.15 },
    ],
  },
  long_term_selloff: {
    key: "long_term_selloff",
    label: "Long-Term Selloff (6-12m)",
    summary: "Measured distribution over an extended window.",
    timeframe: "1Day",
    objective: "selloff",
    durationDays: 270,
    buyThreshold: 0.67,
    sellThreshold: 0.42,
    signals: [
      { signal: { type: "price_vs_sma", period: 40 }, weight: 0.4 },
      { signal: { type: "momentum", period: 30 }, weight: 0.3 },
      { signal: { type: "rsi", period: 14 }, weight: 0.2 },
      { signal: { type: "volume", period: 20 }, weight: 0.1 },
    ],
  },
  short_term_selloff: {
    key: "short_term_selloff",
    label: "Short-Term Selloff (2-8w)",
    summary: "Faster distribution with more reactive thresholds.",
    timeframe: "1Hour",
    objective: "selloff",
    durationDays: 42,
    buyThreshold: 0.67,
    sellThreshold: 0.46,
    signals: [
      { signal: { type: "momentum", period: 10 }, weight: 0.35 },
      { signal: { type: "price_vs_sma", period: 20 }, weight: 0.3 },
      { signal: { type: "rsi", period: 14 }, weight: 0.25 },
      { signal: { type: "volume", period: 20 }, weight: 0.1 },
    ],
  },
  crash_buy_in: {
    key: "crash_buy_in",
    label: "Crash Buy-In",
    summary: "Aggressive entries during capitulation-like moves.",
    timeframe: "1Hour",
    objective: "scale_in",
    durationDays: 30,
    buyThreshold: 0.75,
    sellThreshold: 0.33,
    signals: [
      { signal: { type: "volume", period: 20 }, weight: 0.35 },
      { signal: { type: "rsi", period: 7 }, weight: 0.25 },
      { signal: { type: "bollinger_band", period: 20, std_dev: 2.5 }, weight: 0.25 },
      { signal: { type: "momentum", period: 5 }, weight: 0.15 },
    ],
  },
  crash_selloff_detected: {
    key: "crash_selloff_detected",
    label: "Crash Selloff (Detection)",
    summary: "Defensive selloff with explicit crash trigger.",
    timeframe: "1Hour",
    objective: "selloff",
    durationDays: 30,
    buyThreshold: 0.67,
    sellThreshold: 0.45,
    signals: [
      { signal: { type: "price_vs_sma", period: 20 }, weight: 0.4 },
      { signal: { type: "momentum", period: 10 }, weight: 0.35 },
      { signal: { type: "rsi", period: 14 }, weight: 0.15 },
      { signal: { type: "volume", period: 20 }, weight: 0.1 },
    ],
    crashDetection: {
      enabled: true,
      threshold: 0.70,
      signals: [
        { signal: { type: "selloff_pressure", period: 8 }, weight: 0.55 },
        { signal: { type: "volume", period: 20 }, weight: 0.22 },
        { signal: { type: "rsi", period: 7 }, weight: 0.10 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2.5 }, weight: 0.13 },
      ],
    },
  },
  hourly_breakout: {
    key: "hourly_breakout",
    label: "Hourly Breakout (N-Bar High)",
    summary: "Buys when price breaks above the 20-bar high with volume confirmation — rides supply zone absorptions.",
    timeframe: "1Hour",
    objective: "scale_in",
    durationDays: 14,
    buyThreshold: 0.72,
    sellThreshold: 0.30,
    signals: [
      { signal: { type: "breakout_momentum", period: 20 }, weight: 0.50 },
      { signal: { type: "volume", period: 20 }, weight: 0.30 },
      { signal: { type: "rsi", period: 14 }, weight: 0.20 },
    ],
  },
  hourly_trend_continuation: {
    key: "hourly_trend_continuation",
    label: "Hourly Trend Continuation (Bar Streak)",
    summary: "Buys after 3–5 consecutive bullish hourly bars each closing near their high — momentum continuation.",
    timeframe: "1Hour",
    objective: "scale_in",
    durationDays: 7,
    buyThreshold: 0.68,
    sellThreshold: 0.35,
    signals: [
      { signal: { type: "bar_streak", period: 5 }, weight: 0.45 },
      { signal: { type: "volume", period: 20 }, weight: 0.30 },
      { signal: { type: "momentum_rsi", period: 14 }, weight: 0.25 },
    ],
  },
  hourly_squeeze_breakout: {
    key: "hourly_squeeze_breakout",
    label: "Hourly Squeeze Breakout (BB Expansion)",
    summary: "Detects Bollinger Band compression then buys the first candle that breaks above the upper band.",
    timeframe: "1Hour",
    objective: "scale_in",
    durationDays: 10,
    buyThreshold: 0.70,
    sellThreshold: 0.28,
    signals: [
      { signal: { type: "squeeze_breakout", period: 20 }, weight: 0.55 },
      { signal: { type: "volume", period: 20 }, weight: 0.25 },
      { signal: { type: "bar_streak", period: 5 }, weight: 0.20 },
    ],
  },
  hourly_impulse_buy: {
    key: "hourly_impulse_buy",
    label: "Hourly Impulse Buy (Large Candle + Volume)",
    summary: "Buys on large bullish candle bodies paired with a volume surge — demand impulse entries.",
    timeframe: "1Hour",
    objective: "scale_in",
    durationDays: 7,
    buyThreshold: 0.73,
    sellThreshold: 0.32,
    signals: [
      { signal: { type: "bullish_impulse", period: 20 }, weight: 0.50 },
      { signal: { type: "volume", period: 20 }, weight: 0.25 },
      { signal: { type: "rsi", period: 14 }, weight: 0.25 },
    ],
  },
};
