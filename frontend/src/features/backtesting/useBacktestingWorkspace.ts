import { useRef, useState } from "react";
import type { BacktestRun } from "../../components/RunQueueBuilder";
import { API_PREFIX } from "../../app/constants";
import { apiFetch } from "../../lib/apiFetch";
import type { Bar, EarningsEvent } from "../../lib/signals";
import { executeBacktestRun, buildFormFromRun } from "./runner";
import { normalizeSymbol } from "./symbolUtils";
import type { MarketBarsPayload, RunQueueResult } from "./types";

export function useBacktestingWorkspace(benchmarkSymbol: string) {
  const [runs, setRuns] = useState<BacktestRun[]>([]);
  const [runQueueResults, setRunQueueResults] = useState<RunQueueResult[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const barsCacheRef = useRef<Record<string, MarketBarsPayload>>({});

  async function fetchBars(
    symbol: string,
    options: {
      timeframe?: "1Day" | "1Hour" | "15Min" | "5Min";
      startDate?: string;
      endDate?: string;
      range?: string;
    }
  ): Promise<MarketBarsPayload> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const timeframe = options.timeframe ?? "1Day";
    const range = options.range ?? "2y";
    const intradayWindowKey =
      timeframe === "15Min" || timeframe === "5Min"
        ? `${options.startDate ?? "none"}::${options.endDate ?? "none"}`
        : "all";
    const cacheKey = `${normalizedSymbol}::${timeframe}::${range}::${intradayWindowKey}`;
    const cached = barsCacheRef.current[cacheKey];
    if (cached && cached.bars.length > 0) {
      return cached;
    }

    const params = new URLSearchParams({ symbol: normalizedSymbol, range });
    if (timeframe !== "1Day") params.set("timeframe", timeframe);
    if (timeframe === "15Min" || timeframe === "5Min") {
      if (!options.startDate || !options.endDate) {
        throw new Error(`${timeframe} backtests require start and end dates.`);
      }
      params.set("startDate", options.startDate);
      params.set("endDate", options.endDate);
    }

    const response = await apiFetch(`${API_PREFIX}/bars?${params.toString()}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }

    const json = await response.json();
    const payload: MarketBarsPayload = {
      bars: (json.bars as Bar[]) ?? [],
      earningsEvents: (json.earningsEvents as EarningsEvent[] | undefined) ?? [],
    };
    barsCacheRef.current[cacheKey] = payload;
    return payload;
  }

  async function runQueue(queuedRuns: BacktestRun[]): Promise<RunQueueResult[]> {
    setRunning(true);
    setRunError(null);

    try {
      const results: RunQueueResult[] = [];

      for (const run of queuedRuns) {
        const form = buildFormFromRun(run);

        try {
          results.push(
            await executeBacktestRun({
              run,
              form,
              benchmarkSymbol,
              fetchBars,
            })
          );
        } catch (error) {
          results.push({
            run,
            form,
            result: null,
            bars: [],
            earningsEvents: [],
            marketRecommendation: null,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      return results;
    } finally {
      setRunning(false);
    }
  }

  async function handleRunAll() {
    if (runs.length === 0) {
      return;
    }

    const results = await runQueue(runs);
    setRunQueueResults(results);
  }

  return {
    runs,
    setRuns,
    runQueueResults,
    running,
    runError,
    handleRunAll,
  };
}
