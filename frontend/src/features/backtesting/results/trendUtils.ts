import type { TrendConfidenceRegion, TrendRegionDirection } from "../../../lib/cryptoTrendConfidenceBacktest";

export function trendDirectionCode(direction: TrendRegionDirection): string {
  if (direction === "uptrend") return "UP";
  if (direction === "downtrend") return "DOWN";
  return "RANGE";
}

export function formatTrendDirection(direction: TrendRegionDirection): string {
  if (direction === "uptrend") return "uptrend";
  if (direction === "downtrend") return "downtrend";
  return "range";
}

export function trendDirectionClass(direction: TrendRegionDirection): string {
  if (direction === "uptrend") return "text-buy";
  if (direction === "downtrend") return "text-sell";
  return "text-yellow-400";
}

export function trendDirectionColor(
  direction: TrendRegionDirection,
  status: TrendConfidenceRegion["status"]
): string {
  if (direction === "uptrend") return status === "forming" ? "#22c55eAA" : "#22c55e";
  if (direction === "downtrend") return status === "forming" ? "#ef4444AA" : "#ef4444";
  return status === "forming" ? "#f59e0bAA" : "#f59e0b";
}
