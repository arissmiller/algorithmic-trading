import { ColorType, createChart, type IChartApi, LineSeries, LineStyle, type Time } from "lightweight-charts";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Bar } from "../lib/signals";

const DEFAULT_BENCHMARK_SYMBOLS = ["^DJI", "^GSPC"];
const BENCHMARK_LINE_COLORS = ["#f59e0b", "#22c55e", "#a78bfa", "#f43f5e", "#14b8a6", "#eab308"];

const inputClass =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";

type FormState = {
  allocationsText: string;
  benchmarkSymbolsText: string;
  initialCapital: number;
  startDate: string;
  endDate: string;
};

type BarsApiPayload = {
  bars?: Bar[];
  error?: string;
};

type ParsedAllocation = {
  symbol: string;
  requestedWeightPct: number;
  normalizedWeight: number;
};

type ParsedAllocationSet = {
  allocations: ParsedAllocation[];
  totalRequestedWeightPct: number;
};

type PortfolioEquityPoint = {
  date: string;
  portfolioValue: number;
};

type BenchmarkEquityPoint = {
  date: string;
  portfolioValue: number;
  benchmarkValue: number;
};

type HoldingResult = {
  symbol: string;
  requestedWeightPct: number;
  normalizedWeightPct: number;
  startPrice: number;
  endPrice: number;
  priceReturnPct: number;
  finalValue: number;
  finalWeightPct: number;
};

type BenchmarkComparisonResult = {
  symbol: string;
  actualStartDate: string;
  actualEndDate: string;
  tradingDays: number;
  benchmarkInitialValue: number;
  benchmarkFinalValue: number;
  benchmarkReturnPct: number;
  benchmarkCagrPct: number | null;
  benchmarkMaxDrawdownPct: number;
  portfolioReturnAlignedPct: number;
  edgeVsBenchmarkPct: number;
  equityCurve: BenchmarkEquityPoint[];
};

type PortfolioBacktestResult = {
  requestedStartDate: string;
  requestedEndDate: string;
  actualStartDate: string;
  actualEndDate: string;
  tradingDays: number;
  totalRequestedWeightPct: number;
  holdings: HoldingResult[];
  portfolioEquityCurve: PortfolioEquityPoint[];
  portfolioInitialValue: number;
  portfolioFinalValue: number;
  portfolioReturnPct: number;
  portfolioCagrPct: number | null;
  portfolioMaxDrawdownPct: number;
  benchmarks: BenchmarkComparisonResult[];
};

type PortfolioBacktestInput = {
  allocations: ParsedAllocation[];
  totalRequestedWeightPct: number;
  barsBySymbol: Map<string, Bar[]>;
  benchmarkSymbols: string[];
  requestedStartDate: string;
  requestedEndDate: string;
  initialCapital: number;
};

const EXAMPLE_ALLOCATIONS = "VOO: 40\nQQQ: 25\nSCHD: 20\nTLT: 15";
const EXAMPLE_BENCHMARKS = DEFAULT_BENCHMARK_SYMBOLS.join("\n");

type PortfolioVsIndexesPageProps = {
  apiPrefix: string;
  title?: string;
  description?: string;
  fixedAllocationsText?: string | null;
  fixedAllocationsSourceLabel?: string;
};

export default function PortfolioVsSp500Page({
  apiPrefix,
  title,
  description,
  fixedAllocationsText,
  fixedAllocationsSourceLabel,
}: PortfolioVsIndexesPageProps) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runWarnings, setRunWarnings] = useState<string[]>([]);
  const [result, setResult] = useState<PortfolioBacktestResult | null>(null);
  const [selectedBenchmarkSymbol, setSelectedBenchmarkSymbol] = useState<string>("");
  const [form, setForm] = useState<FormState>(() => defaultForm());
  const hasFixedAllocations = fixedAllocationsText !== undefined && fixedAllocationsText !== null;
  const effectiveAllocationsText = hasFixedAllocations
    ? fixedAllocationsText ?? ""
    : form.allocationsText;
  const pageTitle = title ?? "Weighted Portfolio Backtest";
  const pageDescription =
    description ??
    "Define stock and ETF percentages, run a weighted portfolio backtest, and compare against one or more benchmark indexes (default: DJI and SP500).";

  const barsCacheRef = useRef<Record<string, Bar[]>>({});

  const allocationPreview = useMemo(() => {
    try {
      const parsed = parseAllocationsInput(effectiveAllocationsText);
      return { parsed, error: null as string | null };
    } catch (error) {
      return {
        parsed: null as ParsedAllocationSet | null,
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
    const response = await fetch(`${apiPrefix}/bars?${params.toString()}`);
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

      for (const result of barsResults) {
        if (result.status === "fulfilled") {
          barsBySymbol.set(result.value.symbol, result.value.bars);
          continue;
        }
        const reason = result.reason;
        const message = reason instanceof Error ? reason.message : String(reason);
        const symbolMatch = message.match(/(?:for|:)\s*([A-Z0-9.\^/_-]+)(?:\s|\)|$)/);
        const symbol = symbolMatch?.[1]?.toUpperCase() ?? "UNKNOWN";
        failedSymbols.push({ symbol, error: message });
      }

      const availableAllocations = parsedAllocations.allocations.filter((allocation) =>
        barsBySymbol.has(allocation.symbol)
      );
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
      if (warnings.length > 0) {
        setRunWarnings(warnings);
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

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-80 flex-shrink-0 overflow-y-auto border-r border-border p-4 space-y-3">
        <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
          {pageTitle}
        </p>
        <p className="text-[11px] text-text-secondary leading-relaxed">
          {pageDescription}
        </p>

        {hasFixedAllocations ? (
          <Field label="Portfolio Weights (Live)">
            <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
              <p className="text-[10px] text-text-secondary">
                {fixedAllocationsSourceLabel ?? "Using backend-controlled allocations."}
              </p>
              <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words text-[11px] text-text-primary">
                {effectiveAllocationsText || "No allocations loaded from live portfolio."}
              </pre>
            </div>
            {allocationPreview.error ? (
              <p className="mt-1 text-[10px] text-sell">{allocationPreview.error}</p>
            ) : allocationPreview.parsed ? (
              <p className="mt-1 text-[10px] text-text-secondary">
                {allocationPreview.parsed.allocations.length} symbols, requested total{" "}
                {allocationPreview.parsed.totalRequestedWeightPct.toFixed(2)}%
                {Math.abs(allocationPreview.parsed.totalRequestedWeightPct - 100) > 0.001
                  ? " (auto-normalized to 100%)"
                  : ""}
              </p>
            ) : null}
          </Field>
        ) : (
          <Field label="Portfolio Weights">
            <textarea
              className={inputClass}
              rows={7}
              value={form.allocationsText}
              onChange={(event) =>
                setForm((current) => ({ ...current, allocationsText: event.target.value.toUpperCase() }))
              }
              placeholder={EXAMPLE_ALLOCATIONS}
            />
            <p className="mt-1 text-[10px] text-text-secondary">
              One per line. Format: <span className="font-mono">SYMBOL: PERCENT</span>
            </p>
            {allocationPreview.error ? (
              <p className="mt-1 text-[10px] text-sell">{allocationPreview.error}</p>
            ) : allocationPreview.parsed ? (
              <p className="mt-1 text-[10px] text-text-secondary">
                {allocationPreview.parsed.allocations.length} symbols, requested total{" "}
                {allocationPreview.parsed.totalRequestedWeightPct.toFixed(2)}%
                {Math.abs(allocationPreview.parsed.totalRequestedWeightPct - 100) > 0.001
                  ? " (auto-normalized to 100%)"
                  : ""}
              </p>
            ) : null}
          </Field>
        )}

        <Field label="Benchmark Indexes">
          <textarea
            className={inputClass}
            rows={3}
            value={form.benchmarkSymbolsText}
            onChange={(event) =>
              setForm((current) => ({ ...current, benchmarkSymbolsText: event.target.value.toUpperCase() }))
            }
            placeholder={EXAMPLE_BENCHMARKS}
          />
          <p className="mt-1 text-[10px] text-text-secondary">
            One per line or comma-separated. Example: <span className="font-mono">^DJI, ^GSPC</span>
          </p>
          {benchmarkPreview.error ? (
            <p className="mt-1 text-[10px] text-sell">{benchmarkPreview.error}</p>
          ) : (
            <p className="mt-1 text-[10px] text-text-secondary">
              {benchmarkPreview.symbols.length} benchmark
              {benchmarkPreview.symbols.length === 1 ? "" : "s"}
            </p>
          )}
        </Field>

        <Field label="Initial Capital ($)">
          <input
            type="number"
            min={100}
            step={100}
            className={inputClass}
            value={form.initialCapital}
            onChange={(event) =>
              setForm((current) => ({ ...current, initialCapital: Math.max(0, Number(event.target.value) || 0) }))
            }
          />
        </Field>

        <Field label="Start Date">
          <input
            type="date"
            className={inputClass}
            value={form.startDate}
            onChange={(event) => setForm((current) => ({ ...current, startDate: event.target.value }))}
          />
        </Field>

        <Field label="End Date">
          <input
            type="date"
            className={inputClass}
            value={form.endDate}
            onChange={(event) => setForm((current) => ({ ...current, endDate: event.target.value }))}
          />
        </Field>

        <button
          type="button"
          onClick={() => void runBacktest()}
          disabled={running || Boolean(allocationPreview.error) || Boolean(benchmarkPreview.error)}
          className="w-full rounded bg-accent py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {running ? "Running..." : "Run Portfolio Backtest"}
        </button>
      </aside>

      <div className="flex flex-1 min-w-0 flex-col">
        <div className="shrink-0 border-b border-border/70 px-4 py-2 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
          Results
        </div>

        {runError ? (
          <div className="shrink-0 border-b border-sell/20 bg-sell/10 px-4 py-2 text-xs text-sell">
            {runError}
          </div>
        ) : null}

        {runWarnings.length > 0 ? (
          <div className="shrink-0 border-b border-yellow-300/30 bg-yellow-300/10 px-4 py-2 text-xs text-yellow-100">
            {runWarnings.join(" ")}
          </div>
        ) : null}

        {running ? (
          <div className="shrink-0 border-b border-border/40 px-4 py-2 text-xs text-text-secondary">
            Running portfolio backtest...
          </div>
        ) : null}

        {!result && !running ? (
          <div className="flex-1 p-4 text-xs text-text-secondary">
            No run yet. Configure inputs on the left, then run the backtest.
          </div>
        ) : null}

        {result ? (
          <div className="flex-1 min-h-0 overflow-auto">
            <div className="grid grid-cols-2 gap-3 border-b border-border/50 bg-surface-1 px-4 py-3 text-xs lg:grid-cols-6">
              <SummaryTile
                label="Portfolio Return"
                value={formatSignedPct(result.portfolioReturnPct)}
                colorClass={valueColor(result.portfolioReturnPct)}
                sub={`${formatSignedUsd(result.portfolioFinalValue - result.portfolioInitialValue)} · ${formatUsd(result.portfolioFinalValue)}`}
              />
              <SummaryTile
                label="Portfolio Max Drawdown"
                value={`-${result.portfolioMaxDrawdownPct.toFixed(2)}%`}
                colorClass="text-sell"
                sub="Buy-and-hold weights"
              />
              <SummaryTile
                label="Portfolio CAGR"
                value={formatMaybePct(result.portfolioCagrPct)}
                colorClass={valueColor(result.portfolioCagrPct ?? 0)}
                sub={`Capital ${formatUsd(result.portfolioInitialValue)}`}
              />
              <SummaryTile
                label="Window"
                value={`${result.tradingDays} days`}
                sub={`${result.actualStartDate} → ${result.actualEndDate}`}
              />
              <SummaryTile
                label="Benchmarks"
                value={String(result.benchmarks.length)}
                sub={result.benchmarks.map((benchmark) => benchmark.symbol).join(", ")}
              />
              {selectedBenchmark ? (
                <SummaryTile
                  label={`Edge vs ${selectedBenchmark.symbol}`}
                  value={formatSignedPct(selectedBenchmark.edgeVsBenchmarkPct)}
                  colorClass={valueColor(selectedBenchmark.edgeVsBenchmarkPct)}
                  sub={`Benchmark return ${formatSignedPct(selectedBenchmark.benchmarkReturnPct)}`}
                />
              ) : (
                <SummaryTile label="Edge" value="-" sub="No benchmark selected" />
              )}
            </div>

            {result.benchmarks.length > 0 ? (
              <section className="border-b border-border/60 bg-surface-1 px-4 py-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
                    Equity Curve
                  </p>
                </div>
                <PortfolioComparisonCurve
                  portfolioEquityCurve={result.portfolioEquityCurve}
                  benchmarks={result.benchmarks}
                  initialValue={result.portfolioInitialValue}
                />
                <div className="mt-2 flex flex-wrap gap-4 text-[10px] text-text-secondary">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 border-t border-accent" />
                    Portfolio
                  </span>
                  {result.benchmarks.map((benchmark, index) => (
                    <span key={`equity-legend-${benchmark.symbol}`} className="flex items-center gap-1">
                      <span
                        className="inline-block w-3 border-t"
                        style={{ borderTopColor: colorForBenchmark(index) }}
                      />
                      {benchmark.symbol}
                    </span>
                  ))}
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 border-t border-border border-dashed" />
                    Starting capital
                  </span>
                  <span>
                    Window: {result.actualStartDate} → {result.actualEndDate}
                  </span>
                </div>
              </section>
            ) : null}

            <section className="border-b border-border/60 px-4 py-4">
              <p className="mb-3 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
                Benchmark Comparisons
              </p>
              <div className="overflow-auto rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface-1 text-[10px] uppercase tracking-wide text-text-secondary">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Benchmark</th>
                      <th className="px-3 py-2 text-right font-medium">Return</th>
                      <th className="px-3 py-2 text-right font-medium">Portfolio Return (Aligned)</th>
                      <th className="px-3 py-2 text-right font-medium">Edge vs Benchmark</th>
                      <th className="px-3 py-2 text-right font-medium">Max Drawdown</th>
                      <th className="px-3 py-2 text-right font-medium">CAGR</th>
                      <th className="px-3 py-2 text-right font-medium">Final Value</th>
                      <th className="px-3 py-2 text-right font-medium">Window</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.benchmarks.map((benchmark) => (
                      <tr key={benchmark.symbol} className="border-t border-border/50 hover:bg-surface-2">
                        <td className="px-3 py-2 font-medium text-text-primary">{benchmark.symbol}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${valueColor(benchmark.benchmarkReturnPct)}`}>
                          {formatSignedPct(benchmark.benchmarkReturnPct)}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${valueColor(benchmark.portfolioReturnAlignedPct)}`}>
                          {formatSignedPct(benchmark.portfolioReturnAlignedPct)}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${valueColor(benchmark.edgeVsBenchmarkPct)}`}>
                          {formatSignedPct(benchmark.edgeVsBenchmarkPct)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-sell">
                          -{benchmark.benchmarkMaxDrawdownPct.toFixed(2)}%
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${valueColor(benchmark.benchmarkCagrPct ?? 0)}`}>
                          {formatMaybePct(benchmark.benchmarkCagrPct)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                          {formatUsd(benchmark.benchmarkFinalValue)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                          {benchmark.actualStartDate} → {benchmark.actualEndDate}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="px-4 py-4">
              <p className="mb-3 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
                Holdings Breakdown
              </p>
              <div className="overflow-auto rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface-1 text-[10px] uppercase tracking-wide text-text-secondary">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Symbol</th>
                      <th className="px-3 py-2 text-right font-medium">Requested Weight</th>
                      <th className="px-3 py-2 text-right font-medium">Normalized Weight</th>
                      <th className="px-3 py-2 text-right font-medium">Start Price</th>
                      <th className="px-3 py-2 text-right font-medium">End Price</th>
                      <th className="px-3 py-2 text-right font-medium">Price Return</th>
                      <th className="px-3 py-2 text-right font-medium">Final Value</th>
                      <th className="px-3 py-2 text-right font-medium">Final Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.holdings.map((holding) => (
                      <tr key={holding.symbol} className="border-t border-border/50 hover:bg-surface-2">
                        <td className="px-3 py-2 font-medium text-text-primary">{holding.symbol}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                          {holding.requestedWeightPct.toFixed(2)}%
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                          {holding.normalizedWeightPct.toFixed(2)}%
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                          {formatUsd(holding.startPrice)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                          {formatUsd(holding.endPrice)}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${valueColor(holding.priceReturnPct)}`}>
                          {formatSignedPct(holding.priceReturnPct)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                          {formatUsd(holding.finalValue)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                          {holding.finalWeightPct.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] text-text-secondary">{label}</label>
      {children}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  sub,
  colorClass = "text-text-primary",
}: {
  label: string;
  value: string;
  sub?: string;
  colorClass?: string;
}) {
  return (
    <div className="rounded border border-border bg-surface px-2.5 py-2">
      <p className="text-[10px] text-text-secondary">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${colorClass}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-[10px] text-text-secondary">{sub}</p> : null}
    </div>
  );
}

function PortfolioComparisonCurve({
  portfolioEquityCurve,
  benchmarks,
  initialValue,
}: {
  portfolioEquityCurve: PortfolioEquityPoint[];
  benchmarks: BenchmarkComparisonResult[];
  initialValue: number;
}) {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineSeriesRef = useRef<Array<ReturnType<IChartApi["addSeries"]>>>([]);

  const chartData = useMemo(() => {
    const toLineTime = (isoDate: string): Time | null => {
      const utcDate = parseIsoDateToUtc(isoDate);
      if (!utcDate) return null;
      return Math.floor(utcDate.getTime() / 1000) as Time;
    };

    const portfolioSeries = portfolioEquityCurve
      .map((point) => {
        const time = toLineTime(point.date);
        if (time === null || !Number.isFinite(point.portfolioValue)) return null;
        return { time, value: point.portfolioValue };
      })
      .filter((point): point is { time: Time; value: number } => point !== null)
      .sort((a, b) => (a.time as number) - (b.time as number));

    const benchmarkSeries = benchmarks
      .map((benchmark, benchmarkIndex) => {
        const points = benchmark.equityCurve
          .map((point) => {
            const time = toLineTime(point.date);
            if (time === null || !Number.isFinite(point.benchmarkValue)) return null;
            return { time, value: point.benchmarkValue };
          })
          .filter((point): point is { time: Time; value: number } => point !== null)
          .sort((a, b) => (a.time as number) - (b.time as number));
        return {
          symbol: benchmark.symbol,
          color: colorForBenchmark(benchmarkIndex),
          points,
        };
      })
      .filter((series) => series.points.length >= 2);

    const firstPortfolioPoint = portfolioSeries[0];
    const lastPortfolioPoint = portfolioSeries[portfolioSeries.length - 1];
    const baselineSeries =
      firstPortfolioPoint && lastPortfolioPoint
        ? [
            { time: firstPortfolioPoint.time, value: initialValue },
            { time: lastPortfolioPoint.time, value: initialValue },
          ]
        : [];

    const values = [
      initialValue,
      ...portfolioSeries.map((point) => point.value),
      ...benchmarkSeries.flatMap((series) => series.points.map((point) => point.value)),
    ].filter((value) => Number.isFinite(value));

    const minValue = values.length > 0 ? Math.min(...values) : initialValue;
    const maxValue = values.length > 0 ? Math.max(...values) : initialValue;
    const hasData = portfolioSeries.length >= 2 && benchmarkSeries.length > 0;

    return {
      portfolioSeries,
      benchmarkSeries,
      baselineSeries,
      minValue,
      maxValue,
      firstDate: portfolioEquityCurve[0]?.date ?? "",
      lastDate: portfolioEquityCurve[portfolioEquityCurve.length - 1]?.date ?? "",
      hasData,
    };
  }, [benchmarks, initialValue, portfolioEquityCurve]);

  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#151515" },
        textColor: "#9ca3af",
      },
      grid: { vertLines: { color: "#24262b" }, horzLines: { color: "#24262b" } },
      rightPriceScale: { borderColor: "#2a2a2a" },
      timeScale: { borderColor: "#2a2a2a", timeVisible: false, secondsVisible: false },
      crosshair: {
        vertLine: { color: "#5b8dee", labelBackgroundColor: "#5b8dee" },
        horzLine: { color: "#5b8dee", labelBackgroundColor: "#5b8dee" },
      },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    chartRef.current = chart;
    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      lineSeriesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const series of lineSeriesRef.current) {
      chart.removeSeries(series);
    }
    lineSeriesRef.current = [];

    if (!chartData.hasData) return;

    const baselineSeries = chart.addSeries(LineSeries, {
      color: "#71717a",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    baselineSeries.setData(chartData.baselineSeries);
    lineSeriesRef.current.push(baselineSeries);

    for (const benchmark of chartData.benchmarkSeries) {
      const benchmarkLine = chart.addSeries(LineSeries, {
        color: benchmark.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      benchmarkLine.setData(benchmark.points);
      lineSeriesRef.current.push(benchmarkLine);
    }

    const portfolioLine = chart.addSeries(LineSeries, {
      color: "#5b8dee",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    portfolioLine.setData(chartData.portfolioSeries);
    lineSeriesRef.current.push(portfolioLine);

    chart.timeScale().fitContent();
  }, [chartData]);

  if (!chartData.hasData) return null;

  return (
    <div className="rounded border border-border bg-surface-2 p-2">
      <div ref={chartContainerRef} className="h-56 w-full" />
      <div className="mt-1 flex justify-between text-[10px] text-text-secondary">
        <span>{chartData.firstDate}</span>
        <span>{chartData.lastDate}</span>
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-text-secondary">
        <span>Min: {formatUsd(chartData.minValue)}</span>
        <span>Max: {formatUsd(chartData.maxValue)}</span>
      </div>
    </div>
  );
}

function colorForBenchmark(index: number): string {
  return BENCHMARK_LINE_COLORS[index % BENCHMARK_LINE_COLORS.length];
}

function defaultForm(): FormState {
  const endDate = todayIsoDate();
  const startDate = addDaysIso(endDate, -365 * 3);
  return {
    allocationsText: EXAMPLE_ALLOCATIONS,
    benchmarkSymbolsText: EXAMPLE_BENCHMARKS,
    initialCapital: 10_000,
    startDate,
    endDate,
  };
}

function parseAllocationsInput(input: string): ParsedAllocationSet {
  const entries = input
    .replace(/\r/g, "\n")
    .split("\n")
    .flatMap((line) => line.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error("Enter at least one allocation.");
  }

  const weightsBySymbol = new Map<string, number>();
  for (const entry of entries) {
    const match = entry.match(/^([A-Z0-9.\^/_-]+)\s*(?::|=|\s)\s*([0-9]*\.?[0-9]+)\s*%?$/i);
    if (!match) {
      throw new Error(`Could not parse "${entry}". Use format like VOO: 40`);
    }

    const symbol = match[1].trim().toUpperCase();
    const weight = Number(match[2]);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`Weight for ${symbol} must be greater than 0.`);
    }

    weightsBySymbol.set(symbol, (weightsBySymbol.get(symbol) ?? 0) + weight);
  }

  if (weightsBySymbol.size === 0) {
    throw new Error("No valid symbols found.");
  }

  const totalRequestedWeightPct = Array.from(weightsBySymbol.values()).reduce((sum, value) => sum + value, 0);
  if (totalRequestedWeightPct <= 0) {
    throw new Error("Total allocation must be greater than 0%.");
  }

  const allocations = Array.from(weightsBySymbol.entries()).map(([symbol, requestedWeightPct]) => ({
    symbol,
    requestedWeightPct,
    normalizedWeight: requestedWeightPct / totalRequestedWeightPct,
  }));

  return { allocations, totalRequestedWeightPct };
}

function parseBenchmarkSymbolsInput(input: string): string[] {
  const entries = input
    .replace(/\r/g, "\n")
    .split("\n")
    .flatMap((line) => line.split(","))
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error("Enter at least one benchmark index symbol.");
  }

  const unique = new Set<string>();
  for (const symbol of entries) {
    if (!/^[A-Z0-9.\^/_-]+$/.test(symbol)) {
      throw new Error(`Invalid benchmark symbol "${symbol}".`);
    }
    unique.add(symbol);
  }

  if (unique.size === 0) {
    throw new Error("No valid benchmark symbols found.");
  }

  return Array.from(unique);
}

function computePortfolioBacktest(input: PortfolioBacktestInput): PortfolioBacktestResult {
  const symbols = input.allocations.map((allocation) => allocation.symbol);
  if (symbols.length === 0) {
    throw new Error("Portfolio must include at least one symbol.");
  }
  if (input.benchmarkSymbols.length === 0) {
    throw new Error("At least one benchmark index is required.");
  }

  const closeBySymbol = new Map<string, Map<string, number>>();
  const allSymbols = [...symbols, ...input.benchmarkSymbols];
  for (const symbol of allSymbols) {
    const bars = input.barsBySymbol.get(symbol);
    if (!bars || bars.length === 0) {
      throw new Error(`Missing market data for ${symbol}.`);
    }
    closeBySymbol.set(symbol, buildDailyCloseMap(bars));
  }

  const sets = symbols.map((symbol) => new Set(closeBySymbol.get(symbol)?.keys() ?? []));
  const firstSet = sets[0];
  if (!firstSet || firstSet.size === 0) {
    throw new Error("No market data available for the selected symbols.");
  }

  const commonPortfolioDates = Array.from(firstSet)
    .filter((date) => {
      if (date < input.requestedStartDate || date > input.requestedEndDate) return false;
      return sets.every((set) => set.has(date));
    })
    .sort((a, b) => (a < b ? -1 : 1));

  if (commonPortfolioDates.length < 2) {
    throw new Error(
      "Not enough overlapping portfolio data across selected symbols for that date range. Try fewer symbols or a wider window."
    );
  }

  const actualStartDate = commonPortfolioDates[0];
  const actualEndDate = commonPortfolioDates[commonPortfolioDates.length - 1];

  const sharesBySymbol = new Map<string, number>();
  for (const allocation of input.allocations) {
    const closeMap = closeBySymbol.get(allocation.symbol);
    const startPrice = closeMap?.get(actualStartDate);
    if (!closeMap || !startPrice || startPrice <= 0) {
      throw new Error(`Unable to initialize ${allocation.symbol} at ${actualStartDate}.`);
    }
    const allocatedCapital = input.initialCapital * allocation.normalizedWeight;
    sharesBySymbol.set(allocation.symbol, allocatedCapital / startPrice);
  }

  const portfolioEquityCurve: PortfolioEquityPoint[] = [];
  for (let index = 0; index < commonPortfolioDates.length; index += 1) {
    const date = commonPortfolioDates[index];
    let portfolioValue = 0;

    for (const allocation of input.allocations) {
      const close = closeBySymbol.get(allocation.symbol)?.get(date);
      const shares = sharesBySymbol.get(allocation.symbol);
      if (!close || close <= 0 || !shares) {
        throw new Error(`Missing ${allocation.symbol} price data on ${date}.`);
      }
      portfolioValue += shares * close;
    }

    portfolioEquityCurve.push({ date, portfolioValue });
  }

  const finalPoint = portfolioEquityCurve[portfolioEquityCurve.length - 1];
  if (!finalPoint) {
    throw new Error("No equity curve points computed.");
  }

  const portfolioFinalValue = finalPoint.portfolioValue;

  const holdings: HoldingResult[] = input.allocations.map((allocation) => {
    const closeMap = closeBySymbol.get(allocation.symbol);
    const startPrice = closeMap?.get(actualStartDate);
    const endPrice = closeMap?.get(actualEndDate);
    const shares = sharesBySymbol.get(allocation.symbol);

    if (!closeMap || !startPrice || !endPrice || !shares) {
      throw new Error(`Could not compute holding summary for ${allocation.symbol}.`);
    }

    const finalValue = shares * endPrice;
    const priceReturnPct = ((endPrice - startPrice) / startPrice) * 100;
    return {
      symbol: allocation.symbol,
      requestedWeightPct: allocation.requestedWeightPct,
      normalizedWeightPct: allocation.normalizedWeight * 100,
      startPrice,
      endPrice,
      priceReturnPct,
      finalValue,
      finalWeightPct: portfolioFinalValue > 0 ? (finalValue / portfolioFinalValue) * 100 : 0,
    };
  });

  holdings.sort((a, b) => b.finalWeightPct - a.finalWeightPct);

  const portfolioReturnPct = ((portfolioFinalValue - input.initialCapital) / input.initialCapital) * 100;

  const benchmarks = input.benchmarkSymbols.map((benchmarkSymbol) => {
    const benchmarkCloseMap = closeBySymbol.get(benchmarkSymbol);
    if (!benchmarkCloseMap) {
      throw new Error(`Missing benchmark data for ${benchmarkSymbol}.`);
    }
    return computeBenchmarkComparison({
      benchmarkSymbol,
      benchmarkCloseMap,
      portfolioEquityCurve,
      initialCapital: input.initialCapital,
    });
  });

  return {
    requestedStartDate: input.requestedStartDate,
    requestedEndDate: input.requestedEndDate,
    actualStartDate,
    actualEndDate,
    tradingDays: commonPortfolioDates.length,
    totalRequestedWeightPct: input.totalRequestedWeightPct,
    holdings,
    portfolioEquityCurve,
    portfolioInitialValue: input.initialCapital,
    portfolioFinalValue,
    portfolioReturnPct,
    portfolioCagrPct: computeCagrPct(input.initialCapital, portfolioFinalValue, actualStartDate, actualEndDate),
    portfolioMaxDrawdownPct: computeMaxDrawdownPct(portfolioEquityCurve.map((point) => point.portfolioValue)),
    benchmarks,
  };
}

function computeBenchmarkComparison(input: {
  benchmarkSymbol: string;
  benchmarkCloseMap: Map<string, number>;
  portfolioEquityCurve: PortfolioEquityPoint[];
  initialCapital: number;
}): BenchmarkComparisonResult {
  const alignedPoints = input.portfolioEquityCurve
    .map((point) => {
      const close = input.benchmarkCloseMap.get(point.date);
      if (!close || close <= 0) return null;
      return { date: point.date, portfolioValue: point.portfolioValue, benchmarkClose: close };
    })
    .filter((point): point is { date: string; portfolioValue: number; benchmarkClose: number } => point !== null);

  if (alignedPoints.length < 2) {
    throw new Error(
      `Not enough overlapping data between portfolio symbols and ${input.benchmarkSymbol}.`
    );
  }

  const actualStartDate = alignedPoints[0].date;
  const actualEndDate = alignedPoints[alignedPoints.length - 1].date;
  const benchmarkStartPrice = alignedPoints[0].benchmarkClose;
  const benchmarkShares = input.initialCapital / benchmarkStartPrice;

  const equityCurve = alignedPoints.map((point) => ({
    date: point.date,
    portfolioValue: point.portfolioValue,
    benchmarkValue: benchmarkShares * point.benchmarkClose,
  }));

  const benchmarkFinalValue = equityCurve[equityCurve.length - 1].benchmarkValue;
  const benchmarkReturnPct = ((benchmarkFinalValue - input.initialCapital) / input.initialCapital) * 100;

  const alignedPortfolioInitial = alignedPoints[0].portfolioValue;
  const alignedPortfolioFinal = alignedPoints[alignedPoints.length - 1].portfolioValue;
  const portfolioReturnAlignedPct =
    ((alignedPortfolioFinal - alignedPortfolioInitial) / alignedPortfolioInitial) * 100;

  return {
    symbol: input.benchmarkSymbol,
    actualStartDate,
    actualEndDate,
    tradingDays: equityCurve.length,
    benchmarkInitialValue: input.initialCapital,
    benchmarkFinalValue,
    benchmarkReturnPct,
    benchmarkCagrPct: computeCagrPct(input.initialCapital, benchmarkFinalValue, actualStartDate, actualEndDate),
    benchmarkMaxDrawdownPct: computeMaxDrawdownPct(equityCurve.map((point) => point.benchmarkValue)),
    portfolioReturnAlignedPct,
    edgeVsBenchmarkPct: portfolioReturnAlignedPct - benchmarkReturnPct,
    equityCurve,
  };
}

function buildDailyCloseMap(bars: Bar[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const bar of bars) {
    const day = toUtcDate(bar.t);
    if (!day) continue;
    if (!Number.isFinite(bar.c) || bar.c <= 0) continue;
    out.set(day, bar.c);
  }
  return out;
}

function computeMaxDrawdownPct(values: number[]): number {
  if (values.length === 0) return 0;
  let peak = values[0];
  let maxDrawdown = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak <= 0) continue;
    const drawdown = ((peak - value) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return maxDrawdown;
}

function computeCagrPct(
  initialValue: number,
  finalValue: number,
  startDateIso: string,
  endDateIso: string
): number | null {
  if (!Number.isFinite(initialValue) || !Number.isFinite(finalValue) || initialValue <= 0 || finalValue <= 0) {
    return null;
  }
  const startDate = parseIsoDateToUtc(startDateIso);
  const endDate = parseIsoDateToUtc(endDateIso);
  if (!startDate || !endDate) return null;
  const years = (endDate.getTime() - startDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(years) || years <= 0) return null;
  return (Math.pow(finalValue / initialValue, 1 / years) - 1) * 100;
}

function todayIsoDate(): string {
  return new Date().toISOString().split("T")[0];
}

function parseIsoDateToUtc(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  return Number.isFinite(date.getTime()) ? date : null;
}

function addDaysIso(isoDate: string, days: number): string {
  const date = parseIsoDateToUtc(isoDate);
  if (!date) return isoDate;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split("T")[0];
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toUtcDate(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toISOString().split("T")[0];
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

function valueColor(value: number): string {
  return value >= 0 ? "text-buy" : "text-sell";
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatUsd(Math.abs(value))}`;
}

function formatSignedPct(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatMaybePct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return formatSignedPct(value);
}
