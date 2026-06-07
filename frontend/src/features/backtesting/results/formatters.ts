import type { MarketConditionRecommendation } from "../../../lib/marketConditions";

export function fmtPct(value: number) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

export function fmtUsd(value: number) {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export function avg(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function winRate(values: number[]) {
  return values.length > 0 ? (values.filter((value) => value > 0).length / values.length) * 100 : null;
}

export function formatConditionLabel(condition: MarketConditionRecommendation["condition"]): string {
  if (condition === "high_volatility_selloff") return "High-volatility selloff";
  if (condition === "bullish_trend") return "Bullish trend";
  if (condition === "pullback_mean_reversion") return "Pullback / mean-reversion";
  return "Range-bound";
}
