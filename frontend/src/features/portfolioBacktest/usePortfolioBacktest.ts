import { useMemo, useRef, useState } from "react";
import { defaultMarketBenchmarkSymbols, normalizeBenchmarkSymbolList } from "../../lib/benchmarkPresets";
import type { Bar } from "../../lib/signals";
import { apiFetch } from "../../lib/apiFetch";
import type { BarsApiPayload, FormState, PortfolioBacktestResult } from "./types";
import {
  areSameSymbolSet,
  buildTruncationWarnings,
  computePortfolioBacktest,
  defaultForm,
  normalizeBenchmarkPresets,
  parseAllocationsInput,
  parseBenchmarkSymbolsInput,
} from "./service";

export function usePortfolioBacktest({
  apiPrefix,
  fixedAllocationsText,
  defaultBenchmarkSymbols,
  benchmarkPresets,
}: {
  apiPrefix: string;
  fixedAllocationsText?: string | null;
  defaultBenchmarkSymbols?: string[];
  benchmarkPresets?: { id?: string; label?: string; symbols: string[]; description?: string }[];
}) {
  const normalizedBenchmarkPresets = useMemo(
    () => normalizeBenchmarkPresets(benchmarkPresets),
    [benchmarkPresets]
  );
  const effectiveDefaultBenchmarkSymbols = useMemo(() => {
    const defaults = normalizeBenchmarkSymbolList(defaultBenchmarkSymbols ?? []);
    if (defaults.length > 0) return defaults;
    if (normalizedBenchmarkPresets.length > 0) return normalizedBenchmarkPresets[0].symbols;
    return defaultMarketBenchmarkSymbols();
  }, [defaultBenchmarkSymbols, normalizedBenchmarkPresets]);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runWarnings, setRunWarnings] = useState<string[]>([]);
  const [result, setResult] = useState<PortfolioBacktestResult | null>(null);
  const [selectedBenchmarkSymbol, setSelectedBenchmarkSymbol] = useState("");
  const [form, setForm] = useState<FormState>(() => defaultForm(effectiveDefaultBenchmarkSymbols));
  const barsCacheRef = useRef<Record<string, Bar[]>>({});

  const hasFixedAllocations = fixedAllocationsText !== undefined && fixedAllocationsText !== null;
  const effectiveAllocationsText = hasFixedAllocations ? fixedAllocationsText ?? "" : form.allocationsText;

  const allocationPreview = useMemo(() => {
    try {
      const parsed = parseAllocationsInput(effectiveAllocationsText);
      return { parsed, error: null as string | null };
    } catch (error) {
      return {
        parsed: null,
        error: error instanceof Error ? error.message : "Unable to parse portfolio weights.",
      };
    }
  }, [effectiveAllocationsText]);

  const benchmarkPreview = useMemo(() => {
    try {
      const symbols = parseBenchmarkSymbolsInput(form.benchmarkSymbolsText);
      return { symbols, error: null as string | null };
    } catch (error) {
      return {
        symbols: [] as string[],
        error: error instanceof Error ? error.message : "Unable to parse benchmark indexes.",
      };
    }
  }, [form.benchmarkSymbolsText]);

  const activeBenchmarkPreset = useMemo(() => {
    if (benchmarkPreview.error || benchmarkPreview.symbols.length === 0) return null;
    return (
      normalizedBenchmarkPresets.find((preset) => areSameSymbolSet(preset.symbols, benchmarkPreview.symbols)) ?? null
    );
  }, [benchmarkPreview.error, benchmarkPreview.symbols, normalizedBenchmarkPresets]);

  const selectedBenchmark =
    result?.benchmarks.find((benchmark) => benchmark.symbol === selectedBenchmarkSymbol) ??
    result?.benchmarks[0] ??
    null;

  async function fetchBars(symbol: string, startDate: string): Promise<Bar[]> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const range = rangeForStartDate(startDate);
    const cacheKey = `${normalizedSymbol}::1Day::${range}`;
    const cached = barsCacheRef.current[cacheKey];
    if (cached && cached.length > 0) return cached;

    const params = new URLSearchParams({
      symbol: normalizedSymbol,
      timeframe: "1Day",
      range,
    });
    const response = await apiFetch(`${apiPrefix}/bars?${params.toString()}`);
    const payload = (await response.json().catch(() => ({}))) as BarsApiPayload;
    if (!response.ok) {
      throw new Error(payload.error ?? `Failed to fetch ${normalizedSymbol} bars (HTTP ${response.status}).`);
    }

    const bars = Array.isArray(payload.bars) ? payload.bars : [];
    if (bars.length === 0) {
      throw new Error(`No bars returned for ${normalizedSymbol}.`);
    }

    barsCacheRef.current[cacheKey] = bars;
    return bars;
  }

  async function runBacktest() {
    setRunning(true);
    setRunError(null);
    setRunWarnings([]);
    setResult(null);

    try {
      if (!isIsoDate(form.startDate) || !isIsoDate(form.endDate)) {
        throw new Error("Start and end dates must use YYYY-MM-DD format.");
      }
      if (form.endDate < form.startDate) {
        throw new Error("End date must be on or after start date.");
      }
      if (!Number.isFinite(form.initialCapital) || form.initialCapital <= 0) {
        throw new Error("Initial capital must be greater than 0.");
      }

      const parsedAllocations = parseAllocationsInput(effectiveAllocationsText);
      const benchmarkSymbols = parseBenchmarkSymbolsInput(form.benchmarkSymbolsText);
      const symbols = parsedAllocations.allocations.map((allocation) => allocation.symbol);
      const uniqueSymbols = Array.from(new Set([...symbols, ...benchmarkSymbols]));

      const barsResults = await Promise.allSettled(
        uniqueSymbols.map(async (symbol) => ({
          symbol,
          bars: await fetchBars(symbol, form.startDate),
        }))
      );

      const barsBySymbol = new Map<string, Bar[]>();
      const failedSymbols: Array<{ symbol: string; error: string }> = [];

      for (const settled of barsResults) {
        if (settled.status === "fulfilled") {
          barsBySymbol.set(settled.value.symbol, settled.value.bars);
          continue;
        }
        const reason = settled.reason;
        const message = reason instanceof Error ? reason.message : String(reason);
        const symbolMatch = message.match(/(?:for|:)\s*([A-Z0-9.\^/_-]+)(?:\s|\)|$)/);
        const symbol = symbolMatch?.[1]?.toUpperCase() ?? "UNKNOWN";
        failedSymbols.push({ symbol, error: message });
      }

      const availableAllocations = parsedAllocations.allocations.filter((allocation) => barsBySymbol.has(allocation.symbol));
      const availableAllocationWeightPct = availableAllocations.reduce(
        (sum, allocation) => sum + allocation.requestedWeightPct,
        0
      );
      if (availableAllocations.length === 0 || availableAllocationWeightPct <= 0) {
        throw new Error(
          failedSymbols.length > 0
            ? `No portfolio symbols returned usable market data. First error: ${failedSymbols[0].error}`
            : "No portfolio symbols returned usable market data."
        );
      }

      const normalizedAvailableAllocations = availableAllocations.map((allocation) => ({
        ...allocation,
        normalizedWeight: allocation.requestedWeightPct / availableAllocationWeightPct,
      }));

      const availableBenchmarkSymbols = benchmarkSymbols.filter((symbol) => barsBySymbol.has(symbol));
      if (availableBenchmarkSymbols.length === 0) {
        throw new Error(
          failedSymbols.length > 0
            ? `No benchmark symbols returned usable market data. First error: ${failedSymbols[0].error}`
            : "No benchmark symbols returned usable market data."
        );
      }

      const warnings: string[] = [];
      if (availableAllocations.length < parsedAllocations.allocations.length) {
        const skippedAllocations = parsedAllocations.allocations
          .map((allocation) => allocation.symbol)
          .filter((symbol) => !barsBySymbol.has(symbol));
        warnings.push(
          `Skipped ${skippedAllocations.length} portfolio symbol${
            skippedAllocations.length === 1 ? "" : "s"
          } with no data: ${skippedAllocations.join(", ")}.`
        );
      }
      if (availableBenchmarkSymbols.length < benchmarkSymbols.length) {
        const skippedBenchmarks = benchmarkSymbols.filter((symbol) => !barsBySymbol.has(symbol));
        warnings.push(
          `Skipped ${skippedBenchmarks.length} benchmark symbol${
            skippedBenchmarks.length === 1 ? "" : "s"
          } with no data: ${skippedBenchmarks.join(", ")}.`
        );
      }

      const computed = computePortfolioBacktest({
        allocations: normalizedAvailableAllocations,
        totalRequestedWeightPct: availableAllocationWeightPct,
        barsBySymbol,
        benchmarkSymbols: availableBenchmarkSymbols,
        requestedStartDate: form.startDate,
        requestedEndDate: form.endDate,
        initialCapital: form.initialCapital,
      });

      const truncationWarnings = buildTruncationWarnings(
        computed,
        form.startDate,
        form.endDate,
        normalizedAvailableAllocations,
        barsBySymbol
      );

      if (warnings.length > 0 || truncationWarnings.length > 0) {
        setRunWarnings([...warnings, ...truncationWarnings]);
      }

      setResult(computed);
      setSelectedBenchmarkSymbol((current) =>
        computed.benchmarks.some((benchmark) => benchmark.symbol === current)
          ? current
          : computed.benchmarks[0]?.symbol ?? ""
      );
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Failed to run portfolio backtest.");
    } finally {
      setRunning(false);
    }
  }

  return {
    normalizedBenchmarkPresets,
    running,
    runError,
    runWarnings,
    result,
    selectedBenchmarkSymbol,
    setSelectedBenchmarkSymbol,
    form,
    setForm,
    hasFixedAllocations,
    effectiveAllocationsText,
    allocationPreview,
    benchmarkPreview,
    activeBenchmarkPreset,
    selectedBenchmark,
    runBacktest,
  };
}

function rangeForStartDate(startDate: string): string {
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(startTs)) return "2y";
  const daysBack = (Date.now() - startTs) / 86_400_000;
  if (daysBack > 5 * 365) return "max";
  if (daysBack > 2 * 365) return "5y";
  if (daysBack > 365) return "2y";
  return "1y";
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
