import { type ReactNode } from "react";
import PortfolioComparisonCurve from "../features/portfolioBacktest/PortfolioComparisonCurve";
import {
  type PortfolioVsIndexesPageProps,
} from "../features/portfolioBacktest/types";
import { EXAMPLE_ALLOCATIONS, EXAMPLE_BENCHMARKS } from "../features/portfolioBacktest/service";
import { usePortfolioBacktest } from "../features/portfolioBacktest/usePortfolioBacktest";

const inputClass =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";

export default function PortfolioVsSp500Page({
  apiPrefix,
  title,
  description,
  fixedAllocationsText,
  fixedAllocationsSourceLabel,
  benchmarkInputLabel,
  benchmarkInputHint,
  defaultBenchmarkSymbols,
  benchmarkPresets,
}: PortfolioVsIndexesPageProps) {
  const {
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
  } = usePortfolioBacktest({
    apiPrefix,
    fixedAllocationsText,
    defaultBenchmarkSymbols,
    benchmarkPresets,
  });
  const pageTitle = title ?? "Weighted Portfolio Backtest";
  const benchmarkFieldLabel = benchmarkInputLabel ?? "Benchmark Indexes / ETFs";
  const benchmarkFieldHint =
    benchmarkInputHint ??
    "One per line or comma-separated. Example: ^GSPC, ^DJI, QQQ";
  const pageDescription =
    description ??
    "Define stock and ETF percentages, run a weighted portfolio backtest, and compare against one or more benchmark indexes or ETFs.";

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-80 flex-shrink-0 overflow-y-auto border-r border-border p-4 space-y-3">
        <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
          {pageTitle}
        </p>
        <p className="text-[12px] text-text-secondary leading-relaxed">
          {pageDescription}
        </p>

        {hasFixedAllocations ? (
          <Field label="Portfolio Weights (Live)">
            <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
              <p className="text-[11px] text-text-secondary">
                {fixedAllocationsSourceLabel ?? "Using backend-controlled allocations."}
              </p>
              <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words text-[12px] text-text-primary">
                {effectiveAllocationsText || "No allocations loaded from live portfolio."}
              </pre>
            </div>
            {allocationPreview.error ? (
              <p className="mt-1 text-[11px] text-sell">{allocationPreview.error}</p>
            ) : allocationPreview.parsed ? (
              <p className="mt-1 text-[11px] text-text-secondary">
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
            <p className="mt-1 text-[11px] text-text-secondary">
              One per line. Format: <span className="font-mono">SYMBOL: PERCENT</span>
            </p>
            {allocationPreview.error ? (
              <p className="mt-1 text-[11px] text-sell">{allocationPreview.error}</p>
            ) : allocationPreview.parsed ? (
              <p className="mt-1 text-[11px] text-text-secondary">
                {allocationPreview.parsed.allocations.length} symbols, requested total{" "}
                {allocationPreview.parsed.totalRequestedWeightPct.toFixed(2)}%
                {Math.abs(allocationPreview.parsed.totalRequestedWeightPct - 100) > 0.001
                  ? " (auto-normalized to 100%)"
                  : ""}
              </p>
            ) : null}
          </Field>
        )}

        <Field label={benchmarkFieldLabel}>
          <textarea
            className={inputClass}
            rows={3}
            value={form.benchmarkSymbolsText}
            onChange={(event) =>
              setForm((current) => ({ ...current, benchmarkSymbolsText: event.target.value.toUpperCase() }))
            }
            placeholder={EXAMPLE_BENCHMARKS}
          />
          <p className="mt-1 text-[11px] text-text-secondary">
            {benchmarkFieldHint}
          </p>
          {normalizedBenchmarkPresets.length > 0 ? (
            <div className="mt-2 rounded border border-border bg-surface-2 px-2.5 py-2">
              <p className="text-[11px] font-semibold text-text-secondary">Quick Presets</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {normalizedBenchmarkPresets.map((preset) => {
                  const active = activeBenchmarkPreset?.id === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          benchmarkSymbolsText: preset.symbols.join("\n"),
                        }))
                      }
                      className={`rounded border px-2 py-1 text-[11px] font-semibold transition-colors ${
                        active
                          ? "border-accent/50 bg-accent/15 text-accent"
                          : "border-border bg-surface-3 text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
              {activeBenchmarkPreset?.description ? (
                <p className="mt-1.5 text-[11px] text-text-secondary">{activeBenchmarkPreset.description}</p>
              ) : null}
            </div>
          ) : null}
          {benchmarkPreview.error ? (
            <p className="mt-1 text-[11px] text-sell">{benchmarkPreview.error}</p>
          ) : (
            <p className="mt-1 text-[11px] text-text-secondary">
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
        <div className="shrink-0 border-b border-border/70 px-4 py-2 text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
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
                  <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
                    Equity Curve
                  </p>
                </div>
                <PortfolioComparisonCurve
                  portfolioEquityCurve={result.portfolioEquityCurve}
                  benchmarks={result.benchmarks}
                  initialValue={result.portfolioInitialValue}
                  formatUsd={formatUsd}
                />
                <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-text-secondary">
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
              <p className="mb-3 text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
                Benchmark Comparisons
              </p>
              <div className="overflow-auto rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface-1 text-[11px] uppercase tracking-wide text-text-secondary">
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
              <p className="mb-3 text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
                Holdings Breakdown
              </p>
              <div className="overflow-auto rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface-1 text-[11px] uppercase tracking-wide text-text-secondary">
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
      <label className="mb-1 block text-[12px] text-text-secondary">{label}</label>
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
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${colorClass}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-text-secondary">{sub}</p> : null}
    </div>
  );
}

function colorForBenchmark(index: number): string {
  const colors = ["#f59e0b", "#22c55e", "#a78bfa", "#f43f5e", "#14b8a6", "#eab308"];
  return colors[index % colors.length];
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
