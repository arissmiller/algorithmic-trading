import type { MutableRefObject } from "react";
import { API_PREFIX } from "../../app/constants";
import { apiFetch } from "../../lib/apiFetch";
import type { Bar, EarningsEvent } from "../../lib/signals";
import type { MarketBarsPayload } from "./types";

export type BarsTimeframe = "1Day" | "1Hour" | "15Min" | "5Min";

export type BarsCacheRef = MutableRefObject<Record<string, MarketBarsPayload>>;

export async function fetchMarketBarsCached({
  apiPrefix = API_PREFIX,
  cacheRef,
  symbol,
  timeframe = "1Day",
  range = "2y",
  startDate,
  endDate,
}: {
  apiPrefix?: string;
  cacheRef: BarsCacheRef;
  symbol: string;
  timeframe?: BarsTimeframe;
  range?: string;
  startDate?: string;
  endDate?: string;
}): Promise<MarketBarsPayload> {
  const intradayWindowKey =
    timeframe === "15Min" || timeframe === "5Min"
      ? `${startDate ?? "none"}::${endDate ?? "none"}`
      : "all";
  const cacheKey = `${apiPrefix}::${symbol}::${timeframe}::${range}::${intradayWindowKey}`;
  const cached = cacheRef.current[cacheKey];
  if (cached) {
    return cached;
  }

  const params = new URLSearchParams({ symbol, range });
  if (timeframe !== "1Day") params.set("timeframe", timeframe);
  if (timeframe === "15Min" || timeframe === "5Min") {
    if (!startDate || !endDate) {
      throw new Error(`${timeframe} backtests require start and end dates.`);
    }
    params.set("startDate", startDate);
    params.set("endDate", endDate);
  }

  const response = await apiFetch(`${apiPrefix}/bars?${params.toString()}`);
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    bars?: Bar[];
    earningsEvents?: EarningsEvent[];
  };
  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }

  const payload: MarketBarsPayload = {
    bars: Array.isArray(body.bars) ? body.bars : [],
    earningsEvents: Array.isArray(body.earningsEvents) ? body.earningsEvents : [],
  };
  cacheRef.current[cacheKey] = payload;
  return payload;
}
