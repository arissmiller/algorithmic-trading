import { ReactNode, useMemo, useRef, useState } from "react";
import BacktestChart, {
  BacktestChartEventMarker,
  BacktestChartHorizontalSegment,
} from "./BacktestChart";
import EquityCurveChart from "./EquityCurveChart";
import {
  runCryptoTrailingGridBacktest,
  TrailingGridBacktestResult,
  TrailingGridTrade,
} from "../lib/cryptoTrailingGridBacktest";
import type { Bar } from "../lib/signals";
import { apiFetch } from "../lib/apiFetch";

type FormState = {
  symbol: string;
  timeframe: "1Hour" | "1Day";
  startDate: string;
  endDate: string;
  maPeriod: number;
  rebalanceThresholdPct: number;
  halfRangePct: number;
  gridCount: number;
  spacing: "arithmetic" | "geometric";
  totalCapital: number;
  feeBps: number;
  slippageBps: number;
};

const inputClass =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";

export default function CryptoTrailingGridBacktestPage({ apiPrefix }: { apiPrefix: string }) {
  const [form, setForm] = useState<FormState>(defaultForm);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<TrailingGridBacktestResult | null>(null);
  const barsCacheRef = useRef<Record<string, Bar[]>>({});

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
      if (form.maPeriod < 2) throw new Error("MA period must be at least 2.");
      if (form.halfRangePct <= 0) throw new Error("Half-range % must be positive.");
      if (form.totalCapital <= 0) throw new Error("Total capital must be positive.");

      const range = rangeForStartDate(startDate, form.maPeriod);
      const params = new URLSearchParams({ symbol, range });
      if (form.timeframe !== "1Day") params.set("timeframe", form.timeframe);

      const cacheKey = `${apiPrefix}::${symbol}::${form.timeframe}::${range}`;
      let bars = barsCacheRef.current[cacheKey];
      if (!bars) {
        const res = await apiFetch(`${apiPrefix}/bars?${params.toString()}`);
        const body = (await res.json().catch(() => ({}))) as { error?: string; bars?: Bar[] };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        bars = Array.isArray(body.bars) ? body.bars : [];
        barsCacheRef.current[cacheKey] = bars;
      }

      if (bars.length < form.maPeriod + 5)
        throw new Error("Not enough market data for the selected MA period.");

      const computed = runCryptoTrailingGridBacktest({
        symbol,
        bars,
        startDate,
        endDate,
        maPeriod: form.maPeriod,
        rebalanceThresholdPct: form.rebalanceThresholdPct,
        halfRangePct: form.halfRangePct,
        gridCount: form.gridCount,
        spacing: form.spacing,
        totalCapital: form.totalCapital,
        feeBps: form.feeBps,
        slippageBps: form.slippageBps,
      });

      setResult(computed);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Failed to run trailing grid backtest.");
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  const eventMarkers = useMemo<BacktestChartEventMarker[]>(() => {
    if (!result) return [];
    const tradeMarkers: BacktestChartEventMarker[] = result.trades.map((trade) => ({
      date: trade.t,
      position: trade.side === "buy" ? ("belowBar" as const) : ("aboveBar" as const),
      shape: trade.side === "buy" ? ("arrowUp" as const) : ("arrowDown" as const),
      color: trade.side === "buy" ? "#22c55e" : "#f97316",
      size: 1,
      text: trade.side === "buy" ? "B" : "S",
    }));
    const rebalanceMarkers: BacktestChartEventMarker[] = result.rebalanceEvents.map((ev) => ({
      date: ev.t,
      position: "inBar" as const,
      shape: "square" as const,
      color: "#60a5fa",
      size: 0.8,
      text: "R",
    }));
    return [...tradeMarkers, ...rebalanceMarkers];
  }, [result]);

  // Build horizontal segments for each epoch's grid levels
  const horizontalSegments = useMemo<BacktestChartHorizontalSegment[]>(() => {
    if (!result || result.rebalanceEvents.length === 0) return [];
    const segs: BacktestChartHorizontalSegment[] = [];
    result.rebalanceEvents.forEach((event, i) => {
      const endT =
        result.rebalanceEvents[i + 1]?.t ??
        result.barsUsed[result.barsUsed.length - 1]?.t ??
        result.endDate;
      event.newLevels.forEach((price) => {
        segs.push({
          startDate: event.t,
          endDate: endT,
          price,
          color: "#64748b",
          lineWidth: 1 as const,
        });
      });
    });
    return segs;
  }, [result]);

  const { summary } = result ?? {};

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-80 flex-shrink-0 border-r border-border overflow-y-auto p-4 space-y-3">
        <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
          Trailing Grid Backtest
        </p>
        <p className="text-[12px] text-text-secondary leading-relaxed">
          Grid levels follow a moving average. When the MA shifts by the rebalance threshold,
          buy orders are repositioned around the new center. Existing open positions sell at
          their original targets. Adapts to trending markets.
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
            Trailing Parameters
          </p>

          <div className="grid grid-cols-2 gap-2">
            <Field label="MA Period">
              <input
                type="number"
                className={inputClass}
                value={form.maPeriod}
                min={2}
                max={200}
                step={1}
                onChange={(e) => setField("maPeriod", Number(e.target.value))}
              />
            </Field>
            <Field label="Rebalance Threshold (%)">
              <input
                type="number"
                className={inputClass}
                value={form.rebalanceThresholdPct}
                min={0.5}
                max={50}
                step={0.5}
                onChange={(e) => setField("rebalanceThresholdPct", Number(e.target.value))}
              />
            </Field>
          </div>
          <p className="text-[11px] text-text-secondary">
            MA period: how many bars the SMA uses to track grid center.
            Rebalance threshold: % the MA must shift before repositioning buy orders.
          </p>

          <Field label="Half-Range (%)">
            <input
              type="number"
              className={inputClass}
              value={form.halfRangePct}
              min={1}
              max={50}
              step={1}
              onChange={(e) => setField("halfRangePct", Number(e.target.value))}
            />
          </Field>
          <p className="text-[11px] text-text-secondary">
            Grid spans MA ± half-range%. E.g. 10% with BTC at $100k → $90k–$110k range.
          </p>

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
          {running ? "Running…" : "Run Trailing Grid Backtest"}
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
            Configure the trailing grid and run to see results.
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
                  label="Rebalances"
                  value={String(summary.rebalanceCount)}
                  sub={`SMA-${form.maPeriod} · ±${form.halfRangePct}% range`}
                  positive={null}
                />
              </div>
            ) : null}

            <div className="shrink-0 px-4 py-1.5 border-b border-border/50 text-[11px] text-text-secondary">
              Price chart — gray lines = grid levels per epoch, blue squares = rebalances, green/orange = fills
            </div>
            <div className="h-60 border-b border-border">
              <BacktestChart
                bars={result.barsUsed}
                scaleInTrades={[]}
                scaleOutTrades={[]}
                earningsEvents={[]}
                eventMarkers={eventMarkers}
                horizontalSegments={horizontalSegments}
                movingAverageDays={[form.maPeriod]}
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
                        No trades — try a smaller rebalance threshold or wider half-range.
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

function TradeRow({ trade }: { trade: TrailingGridTrade }) {
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
    maPeriod: 20,
    rebalanceThresholdPct: 3,
    halfRangePct: 10,
    gridCount: 10,
    spacing: "geometric",
    totalCapital: 10000,
    feeBps: 10,
    slippageBps: 5,
  };
}

function normalizeCryptoSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/[-_]/g, "/");
}

function normalizeIsoDateInput(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ts = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  return trimmed;
}

function rangeForStartDate(startDate: string, maPeriod: number): string {
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(startTs)) return "2y";
  // Extra warmup for MA
  const warmupDays = Math.ceil(maPeriod / 24) + 5;
  const daysBack = (Date.now() - startTs) / 86_400_000;
  if (daysBack + warmupDays > 5 * 365) return "max";
  if (daysBack + warmupDays > 2 * 365) return "5y";
  if (daysBack + warmupDays > 365) return "2y";
  return "1y";
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearsAgoIso(years: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate())
  ).toISOString().slice(0, 10);
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
