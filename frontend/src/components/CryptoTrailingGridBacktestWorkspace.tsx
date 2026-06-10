import { ReactNode, useMemo, useRef, useState } from "react";
import BacktestChart, {
  BacktestChartEventMarker,
  BacktestChartHorizontalSegment,
  BacktestChartLineOverlay,
} from "./BacktestChart";
import EquityCurveChart from "./EquityCurveChart";
import {
  runCryptoTrailingGridBacktest,
  SelloffProtectionConfig,
  TrailingGridBacktestResult,
  TrailingGridTrade,
} from "../lib/cryptoTrailingGridBacktest";
import type { MarketBarsPayload } from "../features/backtesting/types";
import { fetchMarketBarsCached } from "../features/backtesting/marketData";
import { normalizeCryptoSymbol } from "../features/backtesting/symbolUtils";
import {
  normalizeIsoDateInput,
  todayIsoDate,
  yearsAgoIso,
} from "../features/backtesting/dateUtils";
import { rangeForStartDate } from "../features/backtesting/rangeUtils";

type StrategyVariant = "sma" | "linearRegression";

type FormState = {
  symbol: string;
  timeframe: "1Hour" | "1Day";
  startDate: string;
  endDate: string;
  maPeriod: number;
  regressionResetSigmaThreshold: number;
  regressionMaxResidualPct: number;
  rebalanceThresholdPct: number;
  halfRangePct: number;
  gridCount: number;
  spacing: "arithmetic" | "geometric";
  totalCapital: number;
  feeBps: number;
  slippageBps: number;
  protectionEnabled: boolean;
  protectionStartThreshold: number;
  protectionEndThreshold: number;
  protectionLiquidate: boolean;
  protectionCooldownBars: number;
};

type ChartVisibilityState = {
  centerLine: boolean;
  gridTemplate: boolean;
  buyOrders: boolean;
  sellTargets: boolean;
  tradeFills: boolean;
  rebalances: boolean;
  protectionMarkers: boolean;
};

type Props = {
  apiPrefix: string;
  strategyVariant?: StrategyVariant;
};

const inputClass =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";

export default function CryptoTrailingGridBacktestWorkspace({
  apiPrefix,
  strategyVariant = "sma",
}: Props) {
  const isRegression = strategyVariant === "linearRegression";
  const [form, setForm] = useState<FormState>(() => defaultForm());
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<TrailingGridBacktestResult | null>(null);
  const [chartVisibility, setChartVisibility] = useState<ChartVisibilityState>(() =>
    defaultChartVisibility()
  );
  const barsCacheRef = useRef<Record<string, MarketBarsPayload>>({});

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setChartVisibilityField<K extends keyof ChartVisibilityState>(
    key: K,
    value: ChartVisibilityState[K]
  ) {
    setChartVisibility((prev) => ({ ...prev, [key]: value }));
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
      if (isRegression && form.regressionResetSigmaThreshold <= 0)
        throw new Error("Reset sigma must be positive.");
      if (isRegression && form.regressionMaxResidualPct <= 0)
        throw new Error("Max residual % must be positive.");
      const warmupDays = Math.ceil(form.maPeriod / 24) + 5;
      const range = rangeForStartDate(startDate, { warmupDays });
      const { bars } = await fetchMarketBarsCached({
        apiPrefix,
        cacheRef: barsCacheRef,
        symbol,
        timeframe: form.timeframe,
        range,
      });

      if (bars.length < form.maPeriod + 5)
        throw new Error("Not enough market data for the selected MA period.");

      const protection: SelloffProtectionConfig | undefined = form.protectionEnabled
        ? {
            enabled: true,
            selloffStartThreshold: form.protectionStartThreshold,
            selloffEndThreshold: form.protectionEndThreshold,
            liquidateOnSelloff: form.protectionLiquidate,
            cooldownBarsAfterEnd: form.protectionCooldownBars,
          }
        : undefined;

      const computed = runCryptoTrailingGridBacktest({
        symbol,
        bars,
        startDate,
        endDate,
        maPeriod: form.maPeriod,
        centerMode: strategyVariant,
        regressionResetSigmaThreshold: form.regressionResetSigmaThreshold,
        regressionMaxResidualPct: form.regressionMaxResidualPct,
        rebalanceThresholdPct: form.rebalanceThresholdPct,
        halfRangePct: form.halfRangePct,
        gridCount: form.gridCount,
        spacing: form.spacing,
        totalCapital: form.totalCapital,
        feeBps: form.feeBps,
        slippageBps: form.slippageBps,
        selloffProtection: protection,
      });

      setResult(computed);
    } catch (err) {
      setRunError(
        err instanceof Error
          ? err.message
          : `Failed to run ${
              isRegression ? "linear regression trailing grid" : "trailing grid"
            } backtest.`
      );
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  const eventMarkers = useMemo<BacktestChartEventMarker[]>(() => {
    if (!result) return [];
    const tradeMarkers: BacktestChartEventMarker[] = chartVisibility.tradeFills
      ? result.trades.map((trade) => ({
          date: trade.t,
          position: trade.side === "buy" ? ("belowBar" as const) : ("aboveBar" as const),
          shape: trade.side === "buy" ? ("arrowUp" as const) : ("arrowDown" as const),
          color: trade.side === "buy" ? "#22c55e" : "#f97316",
          size: 1,
          text: trade.side === "buy" ? "B" : "S",
        }))
      : [];
    const rebalanceMarkers: BacktestChartEventMarker[] = chartVisibility.rebalances
      ? result.rebalanceEvents.map((ev) => ({
          date: ev.t,
          position: "inBar" as const,
          shape: "square" as const,
          color: "#60a5fa",
          size: 0.8,
          text: "R",
        }))
      : [];
    const protectionMarkers: BacktestChartEventMarker[] = chartVisibility.protectionMarkers
      ? result.protectionEvents.map((ev) => ({
          date: ev.date,
          position: ev.type === "selloff_started" ? ("aboveBar" as const) : ("belowBar" as const),
          shape: ev.type === "selloff_started" ? ("arrowDown" as const) : ("arrowUp" as const),
          color: ev.type === "selloff_started" ? "#ef4444" : "#a3e635",
          size: 1.2,
          text: ev.type === "selloff_started" ? "P" : "U",
        }))
      : [];
    return [...tradeMarkers, ...rebalanceMarkers, ...protectionMarkers];
  }, [chartVisibility, result]);

  const horizontalSegments = useMemo<BacktestChartHorizontalSegment[]>(() => {
    if (!result) return [];
    const segs: BacktestChartHorizontalSegment[] = [];
    if (chartVisibility.gridTemplate) {
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
    }
    result.orderSegments.forEach((segment) => {
      if (segment.kind === "buy" && !chartVisibility.buyOrders) return;
      if (segment.kind === "sell" && !chartVisibility.sellTargets) return;
      segs.push({
        startDate: segment.startDate,
        endDate: segment.endDate,
        price: segment.price,
        color: segment.kind === "buy" ? "#22c55e" : "#f97316",
        lineWidth: 2 as const,
      });
    });
    return segs;
  }, [chartVisibility, result]);

  const lineOverlays = useMemo<BacktestChartLineOverlay[]>(() => {
    if (!result || !chartVisibility.centerLine || result.movingAveragePoints.length === 0) {
      return [];
    }
    return [
      {
        id: isRegression ? "strategy-regression" : "strategy-sma",
        color: "#f59e0b",
        lineWidth: 2,
        points: result.movingAveragePoints.map((point) => ({
          time: point.t,
          value: point.value,
        })),
      },
    ];
  }, [chartVisibility.centerLine, isRegression, result]);

  const { summary } = result ?? {};
  const title = isRegression ? "Linear Regression Trailing Grid Backtest" : "Trailing Grid Backtest";
  const idleCopy = isRegression
    ? "Configure the linear regression trailing grid and run to see results."
    : "Configure the trailing grid and run to see results.";
  const runLabel = isRegression
    ? "Run Linear Regression Trailing Grid Backtest"
    : "Run Trailing Grid Backtest";
  const setupCopy = isRegression
    ? "Grid levels follow a rolling linear regression center. When the fitted trend line shifts by the rebalance threshold, buy orders are repositioned around the new center. Existing open positions still sell at their original targets."
    : "Grid levels follow a moving average. When the MA shifts by the rebalance threshold, buy orders are repositioned around the new center. Existing open positions sell at their original targets. Adapts to trending markets.";
  const trendFieldLabel = isRegression ? "Regression Lookback" : "MA Period";
  const trendFieldHelp = isRegression
    ? "Regression lookback: how many bars the rolling linear regression uses to estimate the grid center. Rebalance threshold: % the fitted center must shift before repositioning buy orders."
    : "MA period: how many bars the SMA uses to track grid center. Rebalance threshold: % the MA must shift before repositioning buy orders.";
  const rangeHelp = isRegression
    ? "Grid spans regression center +/- half-range%. E.g. 10% with BTC at $100k -> $90k-$110k range."
    : "Grid spans MA +/- half-range%. E.g. 10% with BTC at $100k -> $90k-$110k range.";
  const chartCenterLabel = isRegression ? "exact strategy regression line" : "exact strategy SMA";

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-80 flex-shrink-0 border-r border-border overflow-y-auto p-4 space-y-3">
        <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
          {title}
        </p>
        <p className="text-[12px] text-text-secondary leading-relaxed">{setupCopy}</p>

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
            <Field label={trendFieldLabel}>
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
          <p className="text-[11px] text-text-secondary">{trendFieldHelp}</p>

          {isRegression ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Reset Sigma">
                  <input
                    type="number"
                    className={inputClass}
                    value={form.regressionResetSigmaThreshold}
                    min={0.5}
                    max={10}
                    step={0.25}
                    onChange={(e) =>
                      setField("regressionResetSigmaThreshold", Number(e.target.value))
                    }
                  />
                </Field>
                <Field label="Max Residual (%)">
                  <input
                    type="number"
                    className={inputClass}
                    value={form.regressionMaxResidualPct}
                    min={0.5}
                    max={50}
                    step={0.5}
                    onChange={(e) =>
                      setField("regressionMaxResidualPct", Number(e.target.value))
                    }
                  />
                </Field>
              </div>
              <p className="text-[11px] text-text-secondary">
                Restart the regression regime when price drifts too many residual standard
                deviations from the fit, or when the residual spread grows too wide as a percent
                of the fitted center.
              </p>
            </>
          ) : null}

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
          <p className="text-[11px] text-text-secondary">{rangeHelp}</p>

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

        <div className="border-t border-border pt-3 space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.protectionEnabled}
              onChange={(e) => setField("protectionEnabled", e.target.checked)}
              className="accent-accent"
            />
            <span className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
              Selloff Protection
            </span>
          </label>

          {form.protectionEnabled ? (
            <div className="space-y-3">
              <p className="text-[11px] text-text-secondary">
                Pauses new buys when a selloff is detected. Resumes after a cooldown. Red P
                markers = protect, green U markers = resume.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Start Threshold">
                  <input
                    type="number"
                    className={inputClass}
                    value={form.protectionStartThreshold}
                    min={0.1}
                    max={1}
                    step={0.01}
                    onChange={(e) =>
                      setField("protectionStartThreshold", Number(e.target.value))
                    }
                  />
                </Field>
                <Field label="End Threshold">
                  <input
                    type="number"
                    className={inputClass}
                    value={form.protectionEndThreshold}
                    min={0.1}
                    max={1}
                    step={0.01}
                    onChange={(e) => setField("protectionEndThreshold", Number(e.target.value))}
                  />
                </Field>
              </div>
              <Field label="Cooldown Bars After End">
                <input
                  type="number"
                  className={inputClass}
                  value={form.protectionCooldownBars}
                  min={0}
                  max={50}
                  step={1}
                  onChange={(e) => setField("protectionCooldownBars", Number(e.target.value))}
                />
              </Field>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.protectionLiquidate}
                  onChange={(e) => setField("protectionLiquidate", e.target.checked)}
                  className="accent-accent"
                />
                <span className="text-[11px] text-text-secondary">
                  Liquidate open positions on selloff start
                </span>
              </label>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => void runBacktest()}
          disabled={running}
          className="w-full rounded bg-accent py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-60"
        >
          {running ? "Running..." : runLabel}
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
            {idleCopy}
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
                  sub={
                    isRegression
                      ? `LR-${form.maPeriod} · ±${form.halfRangePct}% range`
                      : `SMA-${form.maPeriod} · ±${form.halfRangePct}% range`
                  }
                  positive={null}
                />
                {form.protectionEnabled ? (
                  <StatCard
                    label="Protections"
                    value={String(summary.protectionEventsCount)}
                    sub="selloff pauses triggered"
                    positive={null}
                  />
                ) : null}
                {isRegression ? (
                  <StatCard
                    label="Regime Resets"
                    value={String(summary.regimeResetCount)}
                    sub={`${form.regressionResetSigmaThreshold} sigma · ${form.regressionMaxResidualPct}% max residual`}
                    positive={null}
                  />
                ) : null}
              </div>
            ) : null}

            <div className="shrink-0 px-4 py-2 border-b border-border/50 bg-surface-1">
              <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
                Chart Indicators
              </p>
              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] text-text-secondary">
                <TogglePill
                  label={isRegression ? "Regression Line" : "SMA Line"}
                  checked={chartVisibility.centerLine}
                  onChange={(checked) => setChartVisibilityField("centerLine", checked)}
                />
                <TogglePill
                  label="Grid Template"
                  checked={chartVisibility.gridTemplate}
                  onChange={(checked) => setChartVisibilityField("gridTemplate", checked)}
                />
                <TogglePill
                  label="Buy Orders"
                  checked={chartVisibility.buyOrders}
                  onChange={(checked) => setChartVisibilityField("buyOrders", checked)}
                />
                <TogglePill
                  label="Sell Targets"
                  checked={chartVisibility.sellTargets}
                  onChange={(checked) => setChartVisibilityField("sellTargets", checked)}
                />
                <TogglePill
                  label="Trade Fills"
                  checked={chartVisibility.tradeFills}
                  onChange={(checked) => setChartVisibilityField("tradeFills", checked)}
                />
                <TogglePill
                  label="Rebalances"
                  checked={chartVisibility.rebalances}
                  onChange={(checked) => setChartVisibilityField("rebalances", checked)}
                />
                <TogglePill
                  label="Protection"
                  checked={chartVisibility.protectionMarkers}
                  onChange={(checked) => setChartVisibilityField("protectionMarkers", checked)}
                />
              </div>
            </div>

            <div className="shrink-0 px-4 py-1.5 border-b border-border/50 text-[11px] text-text-secondary">
              Price chart - yellow = {chartCenterLabel}, gray = grid template for each rebalance
              epoch, green = active buy orders, orange = active sell targets, blue squares = rebalances, green/orange arrows = fills
              {form.protectionEnabled ? ", red P = selloff protect, green U = resume" : ""}
            </div>
            <div className="h-60 border-b border-border">
              <BacktestChart
                bars={result.barsUsed}
                scaleInTrades={[]}
                scaleOutTrades={[]}
                earningsEvents={[]}
                eventMarkers={eventMarkers}
                horizontalSegments={horizontalSegments}
                lineOverlays={lineOverlays}
              />
            </div>

            <div className="shrink-0 px-4 py-1.5 border-b border-border/50 text-[11px] text-text-secondary">
              Equity curve - green above starting capital, red below
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
                        No trades - try a smaller rebalance threshold or wider half-range.
                      </td>
                    </tr>
                  ) : (
                    result.trades.map((trade, idx) => <TradeRow key={idx} trade={trade} />)
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
        {trade.isProtectionLiquidation ? (
          <span className="ml-1 text-[10px] font-normal text-text-secondary">[P]</span>
        ) : null}
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
    regressionResetSigmaThreshold: 3,
    regressionMaxResidualPct: 8,
    rebalanceThresholdPct: 3,
    halfRangePct: 10,
    gridCount: 10,
    spacing: "geometric",
    totalCapital: 10000,
    feeBps: 10,
    slippageBps: 5,
    protectionEnabled: false,
    protectionStartThreshold: 0.74,
    protectionEndThreshold: 0.56,
    protectionLiquidate: false,
    protectionCooldownBars: 3,
  };
}

function defaultChartVisibility(): ChartVisibilityState {
  return {
    centerLine: true,
    gridTemplate: true,
    buyOrders: true,
    sellTargets: true,
    tradeFills: true,
    rebalances: true,
    protectionMarkers: true,
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

function TogglePill({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded border border-border bg-surface-2 px-2.5 py-1.5 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      <span>{label}</span>
    </label>
  );
}
