import { useMemo, useRef, useState } from "react";
import { STRATEGY_PRESETS, type StrategyPreset } from "./StrategyBuilder";
import type { Bar, SignalWeight } from "../lib/signals";
import BacktestChart from "./BacktestChart";
import TradeTable from "./TradeTable";
import type { BacktestTrade } from "../lib/backtest";
import { runBacktest } from "../lib/backtest";
import { apiFetch } from "../lib/apiFetch";

type FormState = {
  symbols: string;
  buyStartDate: string;
  buyDurationDays: number;
  sellStartDate: string;
  sellDurationDays: number;
  buyAlgorithmKey: string;
  sellAlgorithmKey: string;
  capitalPerStock: number;
};

type StockBacktestRow = {
  symbol: string;
  startDate: string;
  endDate: string;
  stockAlgorithmReturnPct: number;
  stockAlgorithmProfitUsd: number;
  stockBuyHoldReturnPct: number;
  sp500HoldReturnPct: number;
  sp500AlgorithmReturnPct: number;
  vsSp500HoldPct: number;
  vsSp500AlgorithmPct: number;
  buyTrades: number;
  sellTrades: number;
};

type BarsApiPayload = {
  bars?: Bar[];
  error?: string;
};

type TwoPhaseResult = {
  returnPct: number;
  profitUsd: number;
  buyTrades: number;
  sellTrades: number;
  scaleInTrades: BacktestTrade[];
  scaleOutTrades: BacktestTrade[];
};

type SymbolChartRun = {
  symbol: string;
  startDate: string;
  endDate: string;
  symbolBars: Bar[];
  symbolScaleInTrades: BacktestTrade[];
  symbolScaleOutTrades: BacktestTrade[];
  sp500Bars: Bar[];
  sp500ScaleInTrades: BacktestTrade[];
  sp500ScaleOutTrades: BacktestTrade[];
};

const inputClass =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";

const MAG7_DEFAULT = "AAPL, MSFT, NVDA, AMZN, META, GOOGL, TSLA";
const STOCK_BENCHMARK_SYMBOL = "^GSPC";
const DURATION_OPTIONS = [7, 14, 21, 30, 45, 60, 90, 120, 180, 252, 365];
const BACKTEST_EMA_DAYS = [7];

export default function AlgorithmVsSp500Page({ apiPrefix }: { apiPrefix: string }) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [rows, setRows] = useState<StockBacktestRow[]>([]);
  const [chartRuns, setChartRuns] = useState<SymbolChartRun[]>([]);
  const [form, setForm] = useState<FormState>(() => defaultForm());

  const barsCacheRef = useRef<Record<string, Bar[]>>({});

  const buyAlgorithmPresets = useMemo(
    () => STRATEGY_PRESETS.filter((preset) => isBuyAlgorithmPreset(preset)),
    []
  );

  const sellAlgorithmPresets = useMemo(
    () => STRATEGY_PRESETS.filter((preset) => isSellAlgorithmPreset(preset)),
    []
  );

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

  async function runBacktests() {
    setRunning(true);
    setRunError(null);
    setRows([]);
    setChartRuns([]);

    try {
      const symbols = parseSymbolList(form.symbols);
      if (symbols.length === 0) {
        throw new Error("Enter at least one stock symbol.");
      }
      if (!isIsoDate(form.buyStartDate) || !isIsoDate(form.sellStartDate)) {
        throw new Error("Buy and sell start dates must be valid YYYY-MM-DD values.");
      }
      if (form.sellStartDate < form.buyStartDate) {
        throw new Error("Sell-off start date must be on or after the buy-in start date.");
      }
      if (form.buyDurationDays < 1 || form.sellDurationDays < 1) {
        throw new Error("Buy and scale-out durations must be at least 1 day.");
      }
      if (form.capitalPerStock <= 0) {
        throw new Error("Capital per stock must be greater than 0.");
      }

      const buyPreset = buyAlgorithmPresets.find((preset) => preset.key === form.buyAlgorithmKey);
      const sellPreset = sellAlgorithmPresets.find((preset) => preset.key === form.sellAlgorithmKey);
      if (!buyPreset || !sellPreset) {
        throw new Error("Select valid buy and sell algorithms.");
      }

      const benchmarkBars = await fetchBars(STOCK_BENCHMARK_SYMBOL, form.buyStartDate);
      const computedRows: StockBacktestRow[] = [];
      const computedChartRuns: SymbolChartRun[] = [];
      const requestedEndDate = addDaysIso(form.sellStartDate, form.sellDurationDays - 1);

      for (const symbol of symbols) {
        const symbolBars = await fetchBars(symbol, form.buyStartDate);
        const comparisonEndDate = determineComparisonEndDate(
          symbolBars,
          benchmarkBars,
          form.sellStartDate,
          requestedEndDate
        );

        const stockAlgorithm = runTwoPhaseAlgorithm({
          symbol,
          bars: symbolBars,
          buyPreset,
          sellPreset,
          buyStartDate: form.buyStartDate,
          buyDurationDays: form.buyDurationDays,
          sellStartDate: form.sellStartDate,
          sellDurationDays: form.sellDurationDays,
          capital: form.capitalPerStock,
        });

        const sp500Algorithm = runTwoPhaseAlgorithm({
          symbol: STOCK_BENCHMARK_SYMBOL,
          bars: benchmarkBars,
          buyPreset,
          sellPreset,
          buyStartDate: form.buyStartDate,
          buyDurationDays: form.buyDurationDays,
          sellStartDate: form.sellStartDate,
          sellDurationDays: form.sellDurationDays,
          capital: form.capitalPerStock,
        });

        const symbolChartBars = sliceBarsForWindow(symbolBars, form.buyStartDate, comparisonEndDate);
        const sp500ChartBars = sliceBarsForWindow(benchmarkBars, form.buyStartDate, comparisonEndDate);

        const stockBuyHold = computeBuyHoldReturn(
          symbolBars,
          form.buyStartDate,
          comparisonEndDate,
          form.capitalPerStock
        );
        const sp500Hold = computeBuyHoldReturn(
          benchmarkBars,
          form.buyStartDate,
          comparisonEndDate,
          form.capitalPerStock
        );

        computedRows.push({
          symbol,
          startDate: form.buyStartDate,
          endDate: comparisonEndDate,
          stockAlgorithmReturnPct: stockAlgorithm.returnPct,
          stockAlgorithmProfitUsd: stockAlgorithm.profitUsd,
          stockBuyHoldReturnPct: stockBuyHold.profitPct,
          sp500HoldReturnPct: sp500Hold.profitPct,
          sp500AlgorithmReturnPct: sp500Algorithm.returnPct,
          vsSp500HoldPct: stockAlgorithm.returnPct - sp500Hold.profitPct,
          vsSp500AlgorithmPct: stockAlgorithm.returnPct - sp500Algorithm.returnPct,
          buyTrades: stockAlgorithm.buyTrades,
          sellTrades: stockAlgorithm.sellTrades,
        });

        computedChartRuns.push({
          symbol,
          startDate: form.buyStartDate,
          endDate: comparisonEndDate,
          symbolBars: symbolChartBars,
          symbolScaleInTrades: stockAlgorithm.scaleInTrades,
          symbolScaleOutTrades: stockAlgorithm.scaleOutTrades,
          sp500Bars: sp500ChartBars,
          sp500ScaleInTrades: sp500Algorithm.scaleInTrades,
          sp500ScaleOutTrades: sp500Algorithm.scaleOutTrades,
        });
      }

      computedRows.sort((a, b) => b.vsSp500HoldPct - a.vsSp500HoldPct);
      const chartRunsBySymbol = new Map(computedChartRuns.map((run) => [run.symbol, run] as const));
      const orderedChartRuns = computedRows
        .map((row) => chartRunsBySymbol.get(row.symbol))
        .filter((run): run is SymbolChartRun => Boolean(run));
      setRows(computedRows);
      setChartRuns(orderedChartRuns);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Failed to run backtest.");
      setChartRuns([]);
    } finally {
      setRunning(false);
    }
  }

  const summary = useMemo(() => {
    if (rows.length === 0) return null;
    const avgStockAlgorithm = avg(rows.map((row) => row.stockAlgorithmReturnPct));
    const avgSp500Hold = avg(rows.map((row) => row.sp500HoldReturnPct));
    const avgSp500Algorithm = avg(rows.map((row) => row.sp500AlgorithmReturnPct));
    const avgVsSp500Hold = avg(rows.map((row) => row.vsSp500HoldPct));
    const beatSp500HoldCount = rows.filter((row) => row.vsSp500HoldPct > 0).length;
    return {
      avgStockAlgorithm,
      avgSp500Hold,
      avgSp500Algorithm,
      avgVsSp500Hold,
      beatSp500HoldCount,
    };
  }, [rows]);

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-80 flex-shrink-0 overflow-y-auto border-r border-border p-4 space-y-3">
        <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
          Algorithm vs SP500
        </p>
        <p className="text-[12px] text-text-secondary leading-relaxed">
          Runs your buy and sell algorithms independently for each stock in the list, then compares each
          strategy result to S&amp;P 500 buy-and-hold and S&amp;P 500 with the same algorithms.
        </p>

        <Field label="Stock List">
          <textarea
            className={inputClass}
            rows={3}
            value={form.symbols}
            onChange={(event) => setForm((current) => ({ ...current, symbols: event.target.value.toUpperCase() }))}
            placeholder={MAG7_DEFAULT}
          />
          <p className="mt-1 text-[11px] text-text-secondary">Comma, space, or newline separated symbols.</p>
        </Field>

        <Field label="Capital Per Stock ($)">
          <input
            type="number"
            min={100}
            className={inputClass}
            value={form.capitalPerStock}
            onChange={(event) =>
              setForm((current) => ({ ...current, capitalPerStock: Math.max(0, Number(event.target.value) || 0) }))
            }
          />
        </Field>

        <Field label="Buy-In Start Date">
          <input
            type="date"
            className={inputClass}
            value={form.buyStartDate}
            onChange={(event) => setForm((current) => ({ ...current, buyStartDate: event.target.value }))}
          />
        </Field>

        <Field label="Buy-In Duration (days)">
          <select
            className={inputClass}
            value={form.buyDurationDays}
            onChange={(event) =>
              setForm((current) => ({ ...current, buyDurationDays: Number(event.target.value) }))
            }
          >
            {DURATION_OPTIONS.map((days) => (
              <option key={`buy-duration-${days}`} value={days}>
                {days} days
              </option>
            ))}
          </select>
          <DurationChips
            value={form.buyDurationDays}
            options={[30, 60, 90, 120, 180, 252]}
            onChange={(days) => setForm((current) => ({ ...current, buyDurationDays: days }))}
          />
        </Field>

        <Field label="Buy-In Algorithm (Stock Preset)">
          <select
            className={inputClass}
            value={form.buyAlgorithmKey}
            onChange={(event) => setForm((current) => ({ ...current, buyAlgorithmKey: event.target.value }))}
          >
            {buyAlgorithmPresets.map((preset) => (
              <option key={`buy-${preset.key}`} value={preset.key}>
                {preset.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Sell-Off Start Date">
          <input
            type="date"
            className={inputClass}
            value={form.sellStartDate}
            onChange={(event) => setForm((current) => ({ ...current, sellStartDate: event.target.value }))}
          />
        </Field>

        <Field label="Scale-Out Duration (days)">
          <select
            className={inputClass}
            value={form.sellDurationDays}
            onChange={(event) =>
              setForm((current) => ({ ...current, sellDurationDays: Number(event.target.value) }))
            }
          >
            {DURATION_OPTIONS.map((days) => (
              <option key={`sell-duration-${days}`} value={days}>
                {days} days
              </option>
            ))}
          </select>
          <DurationChips
            value={form.sellDurationDays}
            options={[14, 30, 45, 60, 90, 120]}
            onChange={(days) => setForm((current) => ({ ...current, sellDurationDays: days }))}
          />
        </Field>

        <Field label="Sell-Off Algorithm (Stock Preset)">
          <select
            className={inputClass}
            value={form.sellAlgorithmKey}
            onChange={(event) => setForm((current) => ({ ...current, sellAlgorithmKey: event.target.value }))}
          >
            {sellAlgorithmPresets.map((preset) => (
              <option key={`sell-${preset.key}`} value={preset.key}>
                {preset.label}
              </option>
            ))}
          </select>
        </Field>

        <button
          type="button"
          onClick={() => void runBacktests()}
          disabled={running}
          className="w-full rounded bg-accent py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {running ? "Running..." : "Run Backtests"}
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

        {running ? (
          <div className="shrink-0 border-b border-border/40 px-4 py-2 text-xs text-text-secondary">
            Running multi-symbol backtests...
          </div>
        ) : null}

        {summary ? (
          <div className="shrink-0 grid grid-cols-2 gap-3 border-b border-border/50 bg-surface-1 px-4 py-3 text-xs md:grid-cols-5">
            <SummaryTile label="Avg Stock Algorithm" value={formatSignedPct(summary.avgStockAlgorithm)} />
            <SummaryTile label="Avg S&P 500 Hold" value={formatSignedPct(summary.avgSp500Hold)} />
            <SummaryTile label="Avg S&P 500 Algorithm" value={formatSignedPct(summary.avgSp500Algorithm)} />
            <SummaryTile label="Avg Edge vs S&P Hold" value={formatSignedPct(summary.avgVsSp500Hold)} />
            <SummaryTile
              label="Beat S&P Hold"
              value={`${summary.beatSp500HoldCount}/${rows.length}`}
            />
          </div>
        ) : null}

        {rows.length === 0 && !running ? (
          <div className="flex-1 p-4 text-xs text-text-secondary">
            No runs yet. Configure inputs on the left and run the backtest.
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-surface-1 text-[11px] uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Symbol</th>
                  <th className="px-3 py-2 text-left font-medium">Window</th>
                  <th className="px-3 py-2 text-right font-medium">Stock Algorithm</th>
                  <th className="px-3 py-2 text-right font-medium">Stock Buy &amp; Hold</th>
                  <th className="px-3 py-2 text-right font-medium">S&amp;P 500 Hold</th>
                  <th className="px-3 py-2 text-right font-medium">S&amp;P 500 Algorithm</th>
                  <th className="px-3 py-2 text-right font-medium">Vs S&amp;P Hold</th>
                  <th className="px-3 py-2 text-right font-medium">Vs S&amp;P Algorithm</th>
                  <th className="px-3 py-2 text-right font-medium">Buy/Sell Trades</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.symbol} className="border-b border-border/40 hover:bg-surface-2">
                    <td className="px-3 py-2 font-medium text-text-primary">{row.symbol}</td>
                    <td className="px-3 py-2 text-text-secondary">
                      {row.startDate} → {row.endDate}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${valueColor(row.stockAlgorithmReturnPct)}`}>
                      {formatSignedPct(row.stockAlgorithmReturnPct)}
                      <span className="ml-1 text-[11px] text-text-secondary">
                        ({formatSignedUsd(row.stockAlgorithmProfitUsd)})
                      </span>
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${valueColor(row.stockBuyHoldReturnPct)}`}>
                      {formatSignedPct(row.stockBuyHoldReturnPct)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${valueColor(row.sp500HoldReturnPct)}`}>
                      {formatSignedPct(row.sp500HoldReturnPct)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${valueColor(row.sp500AlgorithmReturnPct)}`}>
                      {formatSignedPct(row.sp500AlgorithmReturnPct)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${valueColor(row.vsSp500HoldPct)}`}>
                      {formatSignedPct(row.vsSp500HoldPct)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${valueColor(row.vsSp500AlgorithmPct)}`}>
                      {formatSignedPct(row.vsSp500AlgorithmPct)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                      {row.buyTrades}/{row.sellTrades}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {chartRuns.length > 0 ? (
              <section className="border-t border-border/60 bg-surface-1 px-4 py-4">
                <p className="mb-3 text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
                  Individual Trade Charts
                </p>

                <div className="space-y-4">
                  {chartRuns.map((chartRun) => (
                    <div key={`chart-${chartRun.symbol}`} className="rounded border border-border bg-surface">
                      <div className="border-b border-border/60 px-3 py-2 text-[12px] text-text-secondary">
                        <span className="font-semibold text-text-primary">{chartRun.symbol}</span>
                        <span className="ml-2 tabular-nums">
                          {chartRun.startDate} → {chartRun.endDate}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 gap-3 p-3 xl:grid-cols-2">
                        <div className="rounded border border-border/60 bg-surface-2">
                          <div className="border-b border-border/50 px-3 py-2 text-[11px] uppercase tracking-wide text-text-secondary">
                            {chartRun.symbol} Algorithm Trades
                          </div>
                          <div className="h-64">
                            <BacktestChart
                              bars={chartRun.symbolBars}
                              scaleInTrades={chartRun.symbolScaleInTrades}
                              scaleOutTrades={chartRun.symbolScaleOutTrades}
                              earningsEvents={[]}
                              movingAverageDays={BACKTEST_EMA_DAYS}
                            />
                          </div>
                          <ChartTradeLists
                            buyTrades={chartRun.symbolScaleInTrades}
                            sellTrades={chartRun.symbolScaleOutTrades}
                          />
                        </div>

                        <div className="rounded border border-border/60 bg-surface-2">
                          <div className="border-b border-border/50 px-3 py-2 text-[11px] uppercase tracking-wide text-text-secondary">
                            SP500 Algorithm Trades
                          </div>
                          <div className="h-64">
                            <BacktestChart
                              bars={chartRun.sp500Bars}
                              scaleInTrades={chartRun.sp500ScaleInTrades}
                              scaleOutTrades={chartRun.sp500ScaleOutTrades}
                              earningsEvents={[]}
                              movingAverageDays={BACKTEST_EMA_DAYS}
                            />
                          </div>
                          <ChartTradeLists
                            buyTrades={chartRun.sp500ScaleInTrades}
                            sellTrades={chartRun.sp500ScaleOutTrades}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-surface px-2.5 py-2">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-text-primary">{value}</p>
    </div>
  );
}

function ChartTradeLists({
  buyTrades,
  sellTrades,
}: {
  buyTrades: BacktestTrade[];
  sellTrades: BacktestTrade[];
}) {
  return (
    <div className="border-t border-border/50 p-2">
      <p className="mb-2 px-1 text-[11px] uppercase tracking-wide text-text-secondary">
        Trade List
      </p>

      <div className="grid grid-cols-1 gap-2 2xl:grid-cols-2">
        <div className="rounded border border-border/60 bg-surface-1">
          <div className="border-b border-border/50 px-2.5 py-1.5 text-[11px] text-text-secondary">
            Buys ({buyTrades.length})
          </div>
          <div className="h-44">
            {buyTrades.length > 0 ? (
              <TradeTable trades={buyTrades} direction="scale_in" compact />
            ) : (
              <div className="p-3 text-[12px] text-text-secondary">No buy trades.</div>
            )}
          </div>
        </div>

        <div className="rounded border border-border/60 bg-surface-1">
          <div className="border-b border-border/50 px-2.5 py-1.5 text-[11px] text-text-secondary">
            Sells ({sellTrades.length})
          </div>
          <div className="h-44">
            {sellTrades.length > 0 ? (
              <TradeTable trades={sellTrades} direction="scale_out" compact />
            ) : (
              <div className="p-3 text-[12px] text-text-secondary">No sell trades.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[12px] text-text-secondary">{label}</label>
      {children}
    </div>
  );
}

function DurationChips({
  value,
  options,
  onChange,
}: {
  value: number;
  options: number[];
  onChange: (days: number) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {options.map((days) => {
        const isActive = days === value;
        return (
          <button
            key={`duration-chip-${days}`}
            type="button"
            onClick={() => onChange(days)}
            className={`rounded border px-2 py-1 text-[11px] transition-colors ${
              isActive
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-border bg-surface-2 text-text-secondary hover:text-text-primary"
            }`}
          >
            {days}d
          </button>
        );
      })}
    </div>
  );
}

function defaultForm(): FormState {
  const buyStartDate = addDaysIso(todayIsoDate(), -365);
  const buyDurationDays = 90;
  const sellStartDate = addDaysIso(buyStartDate, buyDurationDays);
  const sellDurationDays = 60;

  return {
    symbols: MAG7_DEFAULT,
    buyStartDate,
    buyDurationDays,
    sellStartDate,
    sellDurationDays,
    buyAlgorithmKey: "scale_in",
    sellAlgorithmKey: "selloff",
    capitalPerStock: 10_000,
  };
}

function runTwoPhaseAlgorithm(config: {
  symbol: string;
  bars: Bar[];
  buyPreset: StrategyPreset;
  sellPreset: StrategyPreset;
  buyStartDate: string;
  buyDurationDays: number;
  sellStartDate: string;
  sellDurationDays: number;
  capital: number;
}): TwoPhaseResult {
  const scaleInWindowDays = Math.max(1, Math.round(config.buyDurationDays));
  const scaleOutWindowDays = Math.max(1, Math.round(config.sellDurationDays));

  const scaleInResult = runBacktest({
    symbol: config.symbol,
    bars: config.bars,
    startDate: config.buyStartDate,
    scaleOutStartDate: config.sellStartDate,
    scaleInWindowDays,
    scaleOutWindowDays: 1,
    phase: "scale_in",
    cadenceDays: Math.max(1, config.buyPreset.config.cadenceDays),
    totalAmount: config.capital,
    aggressiveness: config.buyPreset.config.aggressiveness,
    signals: cloneSignalWeights(config.buyPreset.config.signals),
    randomEnsembleSamples: 400,
  });

  if (!scaleInResult?.scaleIn) {
    throw new Error(`No buy trades generated for ${config.symbol}. Try another buy algorithm or date range.`);
  }

  const scaleOutResult = runBacktest({
    symbol: config.symbol,
    bars: config.bars,
    startDate: config.sellStartDate,
    scaleOutStartDate: config.sellStartDate,
    scaleInWindowDays: 1,
    scaleOutWindowDays,
    phase: "scale_out",
    cadenceDays: Math.max(1, config.sellPreset.config.cadenceDays),
    totalAmount: config.capital,
    aggressiveness: config.sellPreset.config.aggressiveness,
    signals: cloneSignalWeights(config.sellPreset.config.signals),
    randomEnsembleSamples: 400,
  });

  if (!scaleOutResult?.scaleOut) {
    throw new Error(`No sell trades generated for ${config.symbol}. Try another sell algorithm or date range.`);
  }

  const investedAmount = scaleInResult.scaleIn.totalAmount;
  const sharesBought = scaleInResult.scaleIn.totalShares;
  const avgSellPrice = scaleOutResult.scaleOut.avgExecutionPrice;
  const proceeds = sharesBought * avgSellPrice;
  const profitUsd = proceeds - investedAmount;
  const returnPct = investedAmount > 0 ? (profitUsd / investedAmount) * 100 : 0;

  return {
    returnPct,
    profitUsd,
    buyTrades: scaleInResult.scaleIn.trades.length,
    sellTrades: scaleOutResult.scaleOut.trades.length,
    scaleInTrades: scaleInResult.scaleIn.trades,
    scaleOutTrades: scaleOutResult.scaleOut.trades,
  };
}

function computeBuyHoldReturn(
  bars: Bar[],
  startDate: string,
  endDate: string,
  capital: number
): { profitPct: number; profitUsd: number } {
  const startBar = bars.find((bar) => toUtcDate(bar.t) >= startDate && bar.c > 0);
  const endBar = [...bars].reverse().find((bar) => toUtcDate(bar.t) <= endDate && bar.c > 0);

  if (!startBar || !endBar) {
    throw new Error("Unable to compute buy-and-hold return for selected date range.");
  }

  const shares = capital / startBar.c;
  const finalValue = shares * endBar.c;
  const profitUsd = finalValue - capital;
  const profitPct = capital > 0 ? (profitUsd / capital) * 100 : 0;

  return { profitPct, profitUsd };
}

function determineComparisonEndDate(
  symbolBars: Bar[],
  benchmarkBars: Bar[],
  sellStartDate: string,
  requestedEndDate: string
): string {
  const symbolLast = toUtcDate(symbolBars[symbolBars.length - 1]?.t ?? "");
  const benchmarkLast = toUtcDate(benchmarkBars[benchmarkBars.length - 1]?.t ?? "");
  const today = todayIsoDate();

  const maxAvailableEnd = minIsoDate([symbolLast, benchmarkLast, today].filter(Boolean));
  if (!maxAvailableEnd || maxAvailableEnd < sellStartDate) {
    throw new Error("Selected sell-off start date is after available market data.");
  }
  if (requestedEndDate > maxAvailableEnd) {
    throw new Error(
      `Not enough market data for the selected scale-out duration. Latest common date is ${maxAvailableEnd}.`
    );
  }
  return requestedEndDate;
}

function parseSymbolList(input: string): string[] {
  const tokens = input
    .split(/[\s,]+/)
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(tokens));
}

function sliceBarsForWindow(bars: Bar[], startDate: string, endDate: string): Bar[] {
  return bars.filter((bar) => {
    const barDate = toUtcDate(bar.t);
    return barDate >= startDate && barDate <= endDate;
  });
}

function isStockAlgorithmPreset(preset: StrategyPreset): boolean {
  if (preset.key.startsWith("crypto_")) return false;
  if (preset.key === "perpetual") return false;
  if (preset.key === "stock_mean_reversion_swing") return false;
  return true;
}

function isBuyAlgorithmPreset(preset: StrategyPreset): boolean {
  return isStockAlgorithmPreset(preset) && preset.phase === "scale_in";
}

function isSellAlgorithmPreset(preset: StrategyPreset): boolean {
  return isStockAlgorithmPreset(preset) && preset.phase === "scale_out";
}

function cloneSignalWeights(signals: SignalWeight[]): SignalWeight[] {
  return signals.map((signalWeight) => ({
    ...signalWeight,
    signal: { ...signalWeight.signal },
  }));
}

function todayIsoDate(): string {
  return new Date().toISOString().split("T")[0];
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

function addDaysIso(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map((value) => Number(value));
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return dt.toISOString().split("T")[0];
}

function rangeForStartDate(startDate: string): string {
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(startTs)) return "2y";
  const warmupDays = 90;
  const daysBack = (Date.now() - startTs) / 86_400_000;
  if (daysBack > 5 * 365 - warmupDays) return "max";
  if (daysBack > 2 * 365 - warmupDays) return "5y";
  if (daysBack > 365 - warmupDays) return "2y";
  return "1y";
}

function minIsoDate(values: string[]): string | null {
  if (values.length === 0) return null;
  return values.reduce((min, current) => (current < min ? current : min));
}

function formatSignedPct(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const sign = value >= 0 ? "+" : "-";
  const abs = Math.abs(value).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${abs}`;
}

function valueColor(value: number): string {
  return value >= 0 ? "text-buy" : "text-sell";
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
