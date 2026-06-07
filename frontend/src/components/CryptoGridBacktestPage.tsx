import { ReactNode, useMemo, useRef, useState } from "react";
import BacktestChart, {
  BacktestChartEventMarker,
  BacktestChartHorizontalSegment,
} from "./BacktestChart";
import EquityCurveChart from "./EquityCurveChart";
import {
  runCryptoGridBacktest,
  GridBacktestResult,
  GridBacktestTrade,
} from "../lib/cryptoGridBacktest";
import type { MarketBarsPayload } from "../features/backtesting/types";
import { fetchMarketBarsCached } from "../features/backtesting/marketData";
import { normalizeCryptoSymbol } from "../features/backtesting/symbolUtils";
import {
  normalizeIsoDateInput,
  todayIsoDate,
  yearsAgoIso,
} from "../features/backtesting/dateUtils";
import { rangeForStartDate } from "../features/backtesting/rangeUtils";

type RangeMode = "auto" | "manual";

type FormState = {
  symbol: string;
  timeframe: "1Hour" | "1Day";
  startDate: string;
  endDate: string;
  rangeMode: RangeMode;
  rangePctAbove: number;
  rangePctBelow: number;
  lowerBound: string;
  upperBound: string;
  gridCount: number;
  spacing: "arithmetic" | "geometric";
  gridType: "long" | "neutral";
  totalCapital: number;
  feeBps: number;
  slippageBps: number;
};

const inputClass =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";

export default function CryptoGridBacktestPage({ apiPrefix }: { apiPrefix: string }) {
  const [form, setForm] = useState<FormState>(defaultForm);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<GridBacktestResult | null>(null);
  const barsCacheRef = useRef<Record<string, MarketBarsPayload>>({});

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function runBacktest() {
    setRunning(true);
    setRunError(null);

    try {
      const symbol = normalizeCryptoSymbol(form.symbol);
      const startDate = normalizeIsoDateInput(form.startDate);
      const endDate = normalizeIsoDateInput(form.endDate);
      if (!startDate) throw new Error("Start date must be YYYY-MM-DD.");
      if (!endDate) throw new Error("End date must be YYYY-MM-DD.");
      if (startDate >= endDate) throw new Error("Start date must be before end date.");
      if (form.gridCount < 2 || form.gridCount > 100)
        throw new Error("Grid count must be between 2 and 100.");
      if (form.totalCapital <= 0) throw new Error("Total capital must be positive.");

      const range = rangeForStartDate(startDate);
      const { bars } = await fetchMarketBarsCached({
        apiPrefix,
        cacheRef: barsCacheRef,
        symbol,
        timeframe: form.timeframe,
        range,
      });

      if (bars.length < 10) throw new Error("Not enough market data for this symbol/timeframe.");

      const startBars = bars.filter((b) => b.t >= startDate);
      if (startBars.length === 0) throw new Error("No bars found at or after start date.");
      const entryPrice = startBars[0].c;

      let lowerBound: number;
      let upperBound: number;

      if (form.rangeMode === "auto") {
        if (form.rangePctAbove <= 0 || form.rangePctBelow <= 0)
          throw new Error("Range percentages must be positive.");
        lowerBound = entryPrice * (1 - form.rangePctBelow / 100);
        upperBound = entryPrice * (1 + form.rangePctAbove / 100);
      } else {
        lowerBound = parseFloat(form.lowerBound);
        upperBound = parseFloat(form.upperBound);
        if (!isFinite(lowerBound) || lowerBound <= 0)
          throw new Error("Lower bound must be a positive number.");
        if (!isFinite(upperBound) || upperBound <= lowerBound)
          throw new Error("Upper bound must be greater than lower bound.");
      }

      const computed = runCryptoGridBacktest({
        symbol,
        bars,
        startDate,
        endDate,
        lowerBound,
        upperBound,
        gridCount: form.gridCount,
        spacing: form.spacing,
        gridType: form.gridType,
        totalCapital: form.totalCapital,
        feeBps: form.feeBps,
        slippageBps: form.slippageBps,
      });

      setResult(computed);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Failed to run grid backtest.");
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  const eventMarkers = useMemo<BacktestChartEventMarker[]>(() => {
    if (!result) return [];
    return result.trades.map((trade) => ({
      date: trade.t,
      position: trade.side === "buy" ? ("belowBar" as const) : ("aboveBar" as const),
      shape: trade.side === "buy" ? ("arrowUp" as const) : ("arrowDown" as const),
      color: trade.side === "buy" ? "#22c55e" : "#f97316",
      size: 1,
      text: trade.side === "buy" ? "B" : "S",
    }));
  }, [result]);

  const horizontalSegments = useMemo<BacktestChartHorizontalSegment[]>(() => {
    if (!result || result.barsUsed.length === 0) return [];
    const firstT = result.barsUsed[0].t;
    const lastT = result.barsUsed[result.barsUsed.length - 1].t;
    return result.gridLevels.map((price) => ({
      startDate: firstT,
      endDate: lastT,
      price,
      color: "#64748b",
      lineWidth: 1 as const,
    }));
  }, [result]);

  const { summary } = result ?? {};

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-80 flex-shrink-0 border-r border-border overflow-y-auto p-4 space-y-3">
        <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
          Fixed Grid Backtest
        </p>
        <p className="text-[12px] text-text-secondary leading-relaxed">
          Places buy and sell orders at fixed price levels computed once from the entry price.
          Grid levels never move. Profits from oscillation within the static range.
        </p>

        <Field label="Symbol">
          <input
            className={inputClass}
            value={form.symbol}
            onChange={(e) => setField("symbol", normalizeCryptoSymbol(e.target.value))}
            placeholder="BTC/USD"
          />
        </Field>

        <Field label="Timeframe">
          <select
            className={inputClass}
            value={form.timeframe}
            onChange={(e) =>
              setField("timeframe", e.target.value === "1Day" ? "1Day" : "1Hour")
            }
          >
            <option value="1Hour">1 Hour</option>
            <option value="1Day">1 Day</option>
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Start Date">
            <input
              type="date"
              className={inputClass}
              value={form.startDate}
              onChange={(e) => setField("startDate", e.target.value)}
            />
          </Field>
          <Field label="End Date">
            <input
              type="date"
              className={inputClass}
              value={form.endDate}
              onChange={(e) => setField("endDate", e.target.value)}
            />
          </Field>
        </div>

        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
            Grid Range
          </p>

          <Field label="Range Mode">
            <select
              className={inputClass}
              value={form.rangeMode}
              onChange={(e) => setField("rangeMode", e.target.value as RangeMode)}
            >
              <option value="auto">Auto (% from entry price)</option>
              <option value="manual">Manual (absolute prices)</option>
            </select>
          </Field>

          {form.rangeMode === "auto" ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Below Entry (%)">
                <input
                  type="number"
                  className={inputClass}
                  value={form.rangePctBelow}
                  min={1}
                  max={99}
                  step={1}
                  onChange={(e) => setField("rangePctBelow", Number(e.target.value))}
                />
              </Field>
              <Field label="Above Entry (%)">
                <input
                  type="number"
                  className={inputClass}
                  value={form.rangePctAbove}
                  min={1}
                  max={200}
                  step={1}
                  onChange={(e) => setField("rangePctAbove", Number(e.target.value))}
                />
              </Field>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Lower Bound ($)">
                <input
                  type="number"
                  className={inputClass}
                  value={form.lowerBound}
                  min={0}
                  step="any"
                  onChange={(e) => setField("lowerBound", e.target.value)}
                  placeholder="e.g. 80000"
                />
              </Field>
              <Field label="Upper Bound ($)">
                <input
                  type="number"
                  className={inputClass}
                  value={form.upperBound}
                  min={0}
                  step="any"
                  onChange={(e) => setField("upperBound", e.target.value)}
                  placeholder="e.g. 120000"
                />
              </Field>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Field label="Grid Count">
              <input
                type="number"
                className={inputClass}
                value={form.gridCount}
                min={2}
                max={100}
                step={1}
                onChange={(e) => setField("gridCount", Number(e.target.value))}
              />
            </Field>
            <Field label="Spacing">
              <select
                className={inputClass}
                value={form.spacing}
                onChange={(e) =>
                  setField("spacing", e.target.value as "arithmetic" | "geometric")
                }
              >
                <option value="geometric">Geometric (%)</option>
                <option value="arithmetic">Arithmetic ($)</option>
              </select>
            </Field>
          </div>

          <Field label="Grid Type">
            <select
              className={inputClass}
              value={form.gridType}
              onChange={(e) => setField("gridType", e.target.value as "long" | "neutral")}
            >
              <option value="long">Long — buys only below entry, no inventory</option>
              <option value="neutral">Neutral — buys below + inventory pre-loaded above</option>
            </select>
          </Field>
        </div>

        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
            Capital &amp; Fees
          </p>
          <Field label="Total Capital ($)">
            <input
              type="number"
              className={inputClass}
              value={form.totalCapital}
              min={1}
              step={100}
              onChange={(e) => setField("totalCapital", Number(e.target.value))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Fee (bps)">
              <input
                type="number"
                className={inputClass}
                value={form.feeBps}
                min={0}
                max={100}
                step={1}
                onChange={(e) => setField("feeBps", Number(e.target.value))}
              />
            </Field>
            <Field label="Slippage (bps)">
              <input
                type="number"
                className={inputClass}
                value={form.slippageBps}
                min={0}
                max={100}
                step={1}
                onChange={(e) => setField("slippageBps", Number(e.target.value))}
              />
            </Field>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void runBacktest()}
          disabled={running}
          className="w-full rounded bg-accent py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-60"
        >
          {running ? "Running…" : "Run Fixed Grid Backtest"}
        </button>

        {runError ? (
          <div className="rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
            {runError}
          </div>
        ) : null}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="shrink-0 px-4 py-2 border-b border-border/70 text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
          Results
        </div>

        {!result ? (
          <div className="flex-1 flex items-center justify-center text-xs text-text-secondary">
            Configure a grid and run to see results.
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {summary ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 border-b border-border">
                <StatCard
                  label="Total PnL"
                  value={formatUsd(summary.totalPnL)}
                  sub={`${formatSignedPct(summary.totalPnLPct)} of capital`}
                  positive={summary.totalPnL >= 0}
                />
                <StatCard
                  label="Realized PnL"
                  value={formatUsd(summary.realizedPnL)}
                  sub={`${summary.gridCyclesCompleted} completed cycles`}
                  positive={summary.realizedPnL >= 0}
                />
                <StatCard
                  label="Unrealized PnL"
                  value={formatUsd(summary.unrealizedPnL)}
                  sub="open position mark-to-market"
                  positive={summary.unrealizedPnL >= 0}
                />
                <StatCard
                  label="Buy &amp; Hold"
                  value={formatUsd(summary.buyAndHoldReturn)}
                  sub={`${formatSignedPct(summary.buyAndHoldReturnPct)} if held`}
                  positive={summary.buyAndHoldReturn >= 0}
                />
                <StatCard
                  label="Fees Paid"
                  value={formatUsd(summary.totalFeesPaid)}
                  sub={`${result.trades.length} total fills`}
                  positive={null}
                />
                <StatCard
                  label="Avg PnL / Cycle"
                  value={formatUsd(summary.avgPnLPerCycle)}
                  sub="realized only"
                  positive={summary.avgPnLPerCycle >= 0}
                />
                <StatCard
                  label="Max Drawdown"
                  value={`${summary.maxDrawdownPct.toFixed(2)}%`}
                  sub="from equity peak"
                  positive={null}
                />
                <StatCard
                  label="Grid"
                  value={`${result.gridLevels.length - 1} cells`}
                  sub={`${formatPrice(result.gridLevels[0])} – ${formatPrice(result.gridLevels[result.gridLevels.length - 1])}`}
                  positive={null}
                />
              </div>
            ) : null}

            <div className="shrink-0 px-4 py-1.5 border-b border-border/50 text-[11px] text-text-secondary">
              Price chart — grid levels (gray lines) and fills (green = buy, orange = sell)
            </div>
            <div className="h-60 border-b border-border">
              <BacktestChart
                bars={result.barsUsed}
                scaleInTrades={[]}
                scaleOutTrades={[]}
                earningsEvents={[]}
                eventMarkers={eventMarkers}
                horizontalSegments={horizontalSegments}
              />
            </div>

            <div className="shrink-0 px-4 py-1.5 border-b border-border/50 text-[11px] text-text-secondary">
              Equity curve — green above starting capital, red below
            </div>
            <div className="h-48 border-b border-border">
              <EquityCurveChart
                data={result.equityCurve}
                baselineValue={result.summary.totalCapital}
              />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface-1 border-b border-border text-text-secondary">
                  <tr>
                    <th className="px-3 py-2 text-left">Time</th>
                    <th className="px-3 py-2 text-left">Side</th>
                    <th className="px-3 py-2 text-right">Grid Level</th>
                    <th className="px-3 py-2 text-right">Exec Price</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Notional</th>
                    <th className="px-3 py-2 text-right">Cash After</th>
                    <th className="px-3 py-2 text-right">Position After</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.length === 0 ? (
                    <tr>
                      <td className="px-3 py-3 text-text-secondary" colSpan={8}>
                        No trades — price may not have moved through any grid levels.
                      </td>
                    </tr>
                  ) : (
                    result.trades.map((trade, idx) => (
                      <TradeRow key={idx} trade={trade} />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function TradeRow({ trade }: { trade: GridBacktestTrade }) {
  const isBuy = trade.side === "buy";
  return (
    <tr className="border-b border-border/50">
      <td className="px-3 py-2 font-mono text-text-primary">
        {trade.t.slice(0, 16).replace("T", " ")}
      </td>
      <td className={`px-3 py-2 font-semibold ${isBuy ? "text-buy" : "text-sell"}`}>
        {isBuy ? "Buy" : "Sell"}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
        {formatPrice(trade.gridLevel)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
        {formatPrice(trade.execPrice)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
        {trade.qty.toFixed(6)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
        {formatUsd(trade.notionalUsd)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
        {formatUsd(trade.cashAfter)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">
        {trade.positionQtyAfter.toFixed(6)}
      </td>
    </tr>
  );
}

function defaultForm(): FormState {
  return {
    symbol: "BTC/USD",
    timeframe: "1Hour",
    startDate: yearsAgoIso(1),
    endDate: todayIsoDate(),
    rangeMode: "auto",
    rangePctAbove: 20,
    rangePctBelow: 20,
    lowerBound: "",
    upperBound: "",
    gridCount: 10,
    spacing: "geometric",
    gridType: "long",
    totalCapital: 10000,
    feeBps: 10,
    slippageBps: 5,
  };
}

function formatUsd(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPrice(value: number): string {
  if (value >= 1000) {
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function formatSignedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function StatCard({
  label,
  value,
  sub,
  positive,
}: {
  label: string;
  value: string;
  sub: string;
  positive: boolean | null;
}) {
  const valueClass =
    positive === null ? "text-text-primary" : positive ? "text-buy" : "text-sell";
  return (
    <div className="rounded border border-border bg-surface-1 px-3 py-2">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${valueClass}`}>{value}</p>
      <p className="text-[11px] text-text-secondary">{sub}</p>
    </div>
  );
}
