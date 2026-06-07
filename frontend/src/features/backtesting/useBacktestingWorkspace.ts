import { useCallback, useRef, useState } from "react";
import type { BacktestRun } from "../../components/RunQueueBuilder";
import { executeBacktestRun, buildFormFromRun } from "./runner";
import { normalizeSymbol } from "./symbolUtils";
import { fetchMarketBarsCached } from "./marketData";
import type { MarketBarsPayload, RunQueueResult } from "./types";

export function useBacktestingWorkspace(benchmarkSymbol: string) {
  const [runs, setRuns] = useState<BacktestRun[]>([]);
  const [runQueueResults, setRunQueueResults] = useState<RunQueueResult[]>([]);
  const [running, setRunning] = useState(false);
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
    return fetchMarketBarsCached({
      cacheRef: barsCacheRef,
      symbol: normalizedSymbol,
      timeframe: options.timeframe,
      range: options.range,
      startDate: options.startDate,
      endDate: options.endDate,
    });
  }

  async function runQueue(queuedRuns: BacktestRun[]): Promise<RunQueueResult[]> {
    setRunning(true);

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

  const resetWorkspace = useCallback(() => {
    setRuns([]);
    setRunQueueResults([]);
    setRunning(false);
    barsCacheRef.current = {};
  }, []);

  return {
    runs,
    setRuns,
    runQueueResults,
    running,
    handleRunAll,
    resetWorkspace,
  };
}
