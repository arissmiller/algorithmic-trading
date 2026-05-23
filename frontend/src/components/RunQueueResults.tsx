import type { BacktestResult } from "../lib/backtest";
import type { PerpetualBacktestResult } from "../lib/perpetualBacktest";
import type { PerpetualTrade } from "../lib/perpetualBacktest";
import type {
  CryptoAutotraderBacktestResult,
  CryptoAutotraderTrade,
} from "../lib/cryptoAutotraderBacktest";
import type {
  CryptoTrendConfidenceBacktestResult,
  TrendConfidenceRegion,
  TrendRegionDirection,
} from "../lib/cryptoTrendConfidenceBacktest";
import { Bar, EarningsEvent } from "../lib/signals";
import type { MarketConditionRecommendation } from "../lib/marketConditions";
import { STRATEGY_PRESETS } from "./StrategyBuilder";
import type { StrategyForm } from "./StrategyBuilder";
import type { BacktestRun } from "./RunQueueBuilder";
import BacktestChart, { BacktestChartEventMarker } from "./BacktestChart";
import type { BacktestTrade } from "../lib/backtest";
import TradeTable from "./TradeTable";

const BACKTEST_EMA_DAYS = [7];
const POSITION_EPSILON = 1e-9;

export interface RunQueueResult {
  run: BacktestRun;
  form: StrategyForm;
  result: BacktestResult | null;
  perpetualResult?: PerpetualBacktestResult | null;
  autotraderResult?: CryptoAutotraderBacktestResult | null;
  trendConfidenceResult?: CryptoTrendConfidenceBacktestResult | null;
  bars: Bar[];
  earningsEvents: EarningsEvent[];
  marketRecommendation: MarketConditionRecommendation | null;
  error: string | null;
}

function fmtPct(v: number) {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function fmtUsd(v: number) {
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function avg(nums: number[]) {
  return nums.length > 0 ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
}

function winRate(nums: number[]) {
  return nums.length > 0 ? (nums.filter((v) => v > 0).length / nums.length) * 100 : null;
}

/** Convert perpetual trades into the BacktestTrade shape BacktestChart expects. */
function toPerpetualChartTrades(
  trades: PerpetualTrade[],
  side: "buy" | "sell"
): BacktestTrade[] {
  return trades
    .filter((t) => t.side === side)
    .map((t) => ({
      date: t.date,
      price: t.price,
      amountUsd: t.notionalUsd,
      shares: t.qty,
      sharesHeld: t.positionQtyAfter,
      signalScore: t.score,
      rationale: `${t.reason} | score ${t.score.toFixed(2)}`,
      side,
    }));
}

function toAutotraderChartTrades(
  trades: CryptoAutotraderTrade[],
  side: "buy" | "sell"
): BacktestTrade[] {
  return trades
    .filter((trade) => trade.side === side)
    .map((trade) => ({
      date: trade.date,
      price: trade.price,
      amountUsd: trade.notionalUsd,
      shares: trade.qty,
      sharesHeld:
        trade.positionSideAfter === "short"
          ? -trade.positionQtyAfter
          : trade.positionQtyAfter,
      signalScore: trade.score,
      rationale: `${trade.intent} | trend ${trade.trendDirection} | selloff ${trade.selloffScore.toFixed(2)}`,
      side,
    }));
}

type AutotraderRoundTrip = {
  side: "long" | "short";
  entryDate: string;
  exitDate: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryNotionalUsd: number;
  exitNotionalUsd: number;
  pnlUsd: number;
  pnlPct: number;
};

type ShortSaleCoverLeg = {
  date: string;
  qty: number;
  coverPrice: number;
  coverNotionalUsd: number;
  entryBasisUsd: number;
  pnlUsd: number;
  pnlPct: number;
  score: number;
  selloffScore: number;
  trendDirection: "up" | "down" | "neutral";
};

type ShortSaleGroup = {
  id: string;
  entryDate: string;
  entryQty: number;
  entryPrice: number;
  entryNotionalUsd: number;
  coveredQty: number;
  coveredEntryBasisUsd: number;
  coverNotionalUsd: number;
  remainingQty: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  covers: ShortSaleCoverLeg[];
};

function toAutotraderRoundTrips(trades: CryptoAutotraderTrade[]): AutotraderRoundTrip[] {
  const out: AutotraderRoundTrip[] = [];

  let longQty = 0;
  let longCostBasisUsd = 0;
  let longEntryDate: string | null = null;

  let shortQty = 0;
  let shortEntryBasisUsd = 0;
  let shortEntryDate: string | null = null;

  for (const trade of trades) {
    if (trade.intent === "open_long") {
      if (longEntryDate == null) longEntryDate = trade.date;
      longQty += trade.qty;
      longCostBasisUsd += trade.notionalUsd;
      continue;
    }

    if (trade.intent === "close_long" && longQty > POSITION_EPSILON) {
      const closeQty = Math.min(trade.qty, longQty);
      if (closeQty > POSITION_EPSILON) {
        const allocatedBasis = longCostBasisUsd * (closeQty / longQty);
        const proceeds = trade.notionalUsd;
        const pnlUsd = proceeds - allocatedBasis;
        const pnlPct = allocatedBasis > 0 ? (pnlUsd / allocatedBasis) * 100 : 0;
        out.push({
          side: "long",
          entryDate: longEntryDate ?? trade.date,
          exitDate: trade.date,
          qty: closeQty,
          entryPrice: allocatedBasis / Math.max(closeQty, POSITION_EPSILON),
          exitPrice: proceeds / Math.max(closeQty, POSITION_EPSILON),
          entryNotionalUsd: allocatedBasis,
          exitNotionalUsd: proceeds,
          pnlUsd,
          pnlPct,
        });
        longQty -= closeQty;
        longCostBasisUsd -= allocatedBasis;
      }
      if (longQty <= POSITION_EPSILON) {
        longQty = 0;
        longCostBasisUsd = 0;
        longEntryDate = null;
      }
      continue;
    }

    if (trade.intent === "open_short") {
      if (shortEntryDate == null) shortEntryDate = trade.date;
      shortQty += trade.qty;
      shortEntryBasisUsd += trade.notionalUsd;
      continue;
    }

    if (trade.intent === "cover_short" && shortQty > POSITION_EPSILON) {
      const coverQty = Math.min(trade.qty, shortQty);
      if (coverQty > POSITION_EPSILON) {
        const allocatedEntryBasis = shortEntryBasisUsd * (coverQty / shortQty);
        const coverCost = trade.notionalUsd;
        const pnlUsd = allocatedEntryBasis - coverCost;
        const pnlPct = allocatedEntryBasis > 0 ? (pnlUsd / allocatedEntryBasis) * 100 : 0;
        out.push({
          side: "short",
          entryDate: shortEntryDate ?? trade.date,
          exitDate: trade.date,
          qty: coverQty,
          entryPrice: allocatedEntryBasis / Math.max(coverQty, POSITION_EPSILON),
          exitPrice: coverCost / Math.max(coverQty, POSITION_EPSILON),
          entryNotionalUsd: allocatedEntryBasis,
          exitNotionalUsd: coverCost,
          pnlUsd,
          pnlPct,
        });
        shortQty -= coverQty;
        shortEntryBasisUsd -= allocatedEntryBasis;
      }
      if (shortQty <= POSITION_EPSILON) {
        shortQty = 0;
        shortEntryBasisUsd = 0;
        shortEntryDate = null;
      }
    }
  }

  return out;
}

function groupShortSalesByEntry(trades: CryptoAutotraderTrade[]): ShortSaleGroup[] {
  const groups: ShortSaleGroup[] = [];
  const openLots: Array<{
    groupIndex: number;
    remainingQty: number;
    remainingEntryBasisUsd: number;
  }> = [];

  for (const trade of trades) {
    if (trade.intent === "open_short" && trade.qty > POSITION_EPSILON) {
      groups.push({
        id: `short-${groups.length + 1}`,
        entryDate: trade.date,
        entryQty: trade.qty,
        entryPrice: trade.price,
        entryNotionalUsd: trade.notionalUsd,
        coveredQty: 0,
        coveredEntryBasisUsd: 0,
        coverNotionalUsd: 0,
        remainingQty: trade.qty,
        realizedPnlUsd: 0,
        realizedPnlPct: 0,
        covers: [],
      });
      openLots.push({
        groupIndex: groups.length - 1,
        remainingQty: trade.qty,
        remainingEntryBasisUsd: trade.notionalUsd,
      });
      continue;
    }

    if (trade.intent !== "cover_short" || trade.qty <= POSITION_EPSILON) {
      continue;
    }

    let coverQtyRemaining = trade.qty;
    let coverNotionalRemaining = trade.notionalUsd;

    while (coverQtyRemaining > POSITION_EPSILON && openLots.length > 0) {
      const lot = openLots[0];
      const lotQtyBefore = Math.max(lot.remainingQty, POSITION_EPSILON);
      const allocatedQty = Math.min(coverQtyRemaining, lotQtyBefore);
      const allocatedCoverNotional = coverNotionalRemaining * (allocatedQty / coverQtyRemaining);
      const allocatedEntryBasis = lot.remainingEntryBasisUsd * (allocatedQty / lotQtyBefore);

      const group = groups[lot.groupIndex];
      const pnlUsd = allocatedEntryBasis - allocatedCoverNotional;
      const pnlPct = allocatedEntryBasis > POSITION_EPSILON ? (pnlUsd / allocatedEntryBasis) * 100 : 0;

      group.covers.push({
        date: trade.date,
        qty: allocatedQty,
        coverPrice: allocatedCoverNotional / Math.max(allocatedQty, POSITION_EPSILON),
        coverNotionalUsd: allocatedCoverNotional,
        entryBasisUsd: allocatedEntryBasis,
        pnlUsd,
        pnlPct,
        score: trade.score,
        selloffScore: trade.selloffScore,
        trendDirection: trade.trendDirection,
      });
      group.coveredQty += allocatedQty;
      group.coveredEntryBasisUsd += allocatedEntryBasis;
      group.coverNotionalUsd += allocatedCoverNotional;
      group.realizedPnlUsd += pnlUsd;
      group.remainingQty = Math.max(0, group.entryQty - group.coveredQty);
      group.realizedPnlPct =
        group.coveredEntryBasisUsd > POSITION_EPSILON
          ? (group.realizedPnlUsd / group.coveredEntryBasisUsd) * 100
          : 0;

      lot.remainingQty = Math.max(0, lot.remainingQty - allocatedQty);
      lot.remainingEntryBasisUsd = Math.max(0, lot.remainingEntryBasisUsd - allocatedEntryBasis);
      coverNotionalRemaining = Math.max(0, coverNotionalRemaining - allocatedCoverNotional);
      coverQtyRemaining = Math.max(0, coverQtyRemaining - allocatedQty);

      if (lot.remainingQty <= POSITION_EPSILON) {
        openLots.shift();
      }
    }
  }

  return groups;
}

function toTrendRegionMarkers(regions: TrendConfidenceRegion[]): BacktestChartEventMarker[] {
  return regions.map((region) => {
    const directionCode = trendDirectionCode(region.direction);
    const confidencePct = Math.round(region.confidence * 100);
    return {
      date: region.markerDate,
      position: region.direction === "downtrend" ? "aboveBar" : region.direction === "uptrend" ? "belowBar" : "inBar",
      shape: "square",
      color: trendDirectionColor(region.direction, region.status),
      size: 0.95,
      text: `${region.id} ${region.status === "forming" ? "~" : ""}${directionCode} ${confidencePct}%`,
    };
  });
}

type SymbolRunGroup = {
  symbol: string;
  runs: RunQueueResult[];
};

function groupResultsBySymbol(results: RunQueueResult[]): SymbolRunGroup[] {
  const groupsBySymbol = new Map<string, SymbolRunGroup>();
  const orderedGroups: SymbolRunGroup[] = [];

  for (const result of results) {
    const symbol = result.run.symbol.trim().toUpperCase();
    const existing = groupsBySymbol.get(symbol);
    if (existing) {
      existing.runs.push(result);
      continue;
    }
    const group: SymbolRunGroup = { symbol, runs: [result] };
    groupsBySymbol.set(symbol, group);
    orderedGroups.push(group);
  }

  return orderedGroups;
}

export default function RunQueueResults({ results }: { results: RunQueueResult[] }) {
  if (results.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-secondary">
        Add runs to the queue and click Run to see results here.
      </div>
    );
  }

  const symbolGroups = groupResultsBySymbol(results);
  const hasMultipleSymbols = symbolGroups.length > 1;
  const runIndexById = new Map(results.map((runResult, idx) => [runResult.run.id, idx]));

  const renderRunSection = (runResult: RunQueueResult, fallbackIndex: number) => {
    const index = runIndexById.get(runResult.run.id) ?? fallbackIndex;
    if (
      runResult.run.presetKey === "perpetual" ||
      runResult.run.presetKey === "crypto_perpetual_selloff_protection"
    ) {
      return <PerpetualRunSection key={runResult.run.id} r={runResult} index={index} />;
    }
    if (
      runResult.run.presetKey === "crypto_autotrader" ||
      runResult.run.presetKey === "crypto_short_selloff"
    ) {
      return <CryptoAutotraderRunSection key={runResult.run.id} r={runResult} index={index} />;
    }
    if (runResult.run.presetKey === "crypto_trend_confidence") {
      return <CryptoTrendConfidenceRunSection key={runResult.run.id} r={runResult} index={index} />;
    }
    return <RunSection key={runResult.run.id} r={runResult} index={index} />;
  };

  return (
    <div className="h-full overflow-y-auto">
      {symbolGroups.map((group, groupIndex) => {
        const successful = group.runs.filter((runResult) => runResult.result);

        const inVsLumpVals = successful
          .map((runResult) => runResult.result!.scaleIn?.comparison.smartVsLumpPct)
          .filter((v): v is number => v !== undefined);
        const inVsRandVals = successful
          .map((runResult) => runResult.result!.scaleIn?.comparison.smartVsRandomPct)
          .filter((v): v is number => v !== undefined);
        const outVsLumpVals = successful
          .map((runResult) => runResult.result!.scaleOut?.comparison.smartVsLumpPct)
          .filter((v): v is number => v !== undefined);
        const outVsRandVals = successful
          .map((runResult) => runResult.result!.scaleOut?.comparison.smartVsRandomPct)
          .filter((v): v is number => v !== undefined);

        const avgInVsLump = avg(inVsLumpVals);
        const avgInVsRand = avg(inVsRandVals);
        const avgOutVsLump = avg(outVsLumpVals);
        const avgOutVsRand = avg(outVsRandVals);

        const chartBars = successful.find((runResult) => runResult.bars.length > 0)?.bars ?? [];
        const chartEarningsEvents =
          successful.find((runResult) => runResult.bars.length > 0)?.earningsEvents ?? [];
        const allBuyTrades = successful.flatMap((runResult) => runResult.result!.scaleIn?.trades ?? []);
        const allSellTrades = successful.flatMap((runResult) => runResult.result!.scaleOut?.trades ?? []);

        return (
          <section
            key={group.symbol}
            className={groupIndex > 0 ? "border-t-2 border-border" : undefined}
          >
            {hasMultipleSymbols && (
              <div className="border-b border-border bg-surface-1 px-4 py-2">
                <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
                  Symbol: {group.symbol}
                </p>
                <p className="mt-0.5 text-[11px] text-text-secondary">
                  {group.runs.length} run{group.runs.length !== 1 ? "s" : ""} queued
                </p>
              </div>
            )}

            {/* Cumulative stats — only shown when there are non-perpetual runs */}
            {successful.length > 0 && (
              <section className="border-b border-border bg-surface-1 px-4 py-3">
                <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold mb-2">
                  Avg Strategy Edge
                </p>
                <div className="grid grid-cols-4 gap-3">
                  <ComparisonChip
                    label="Buy vs Lump Sum"
                    value={avgInVsLump}
                    winRate={winRate(inVsLumpVals)}
                    n={inVsLumpVals.length}
                  />
                  <ComparisonChip
                    label="Buy vs Random"
                    value={avgInVsRand}
                    winRate={winRate(inVsRandVals)}
                    n={inVsRandVals.length}
                  />
                  <ComparisonChip
                    label="Sell vs Lump Sum"
                    value={avgOutVsLump}
                    winRate={winRate(outVsLumpVals)}
                    n={outVsLumpVals.length}
                  />
                  <ComparisonChip
                    label="Sell vs Random"
                    value={avgOutVsRand}
                    winRate={winRate(outVsRandVals)}
                    n={outVsRandVals.length}
                  />
                </div>
                <p className="mt-2 text-[11px] text-text-secondary">
                  {successful.length}/{group.runs.length} runs succeeded
                </p>
              </section>
            )}

            {/* Combined chart for non-perpetual runs */}
            {chartBars.length > 0 && (allBuyTrades.length > 0 || allSellTrades.length > 0) && (
              <section className="border-b border-border">
                <div className="px-4 py-2 text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
                  All Trades
                </div>
                <div className="h-64">
                  <BacktestChart
                    bars={chartBars}
                    scaleInTrades={allBuyTrades}
                    scaleOutTrades={allSellTrades}
                    earningsEvents={chartEarningsEvents}
                    movingAverageDays={BACKTEST_EMA_DAYS}
                  />
                </div>
              </section>
            )}

            {/* Per-run sections */}
            {group.runs.map((runResult, runIndex) => renderRunSection(runResult, runIndex))}
          </section>
        );
      })}
    </div>
  );
}

// ── Perpetual run section ─────────────────────────────────────────────────────

function PerpetualEquityCurve({
  equityCurve,
  initialAmount,
}: {
  equityCurve: PerpetualBacktestResult["equityCurve"];
  initialAmount: number;
}) {
  if (equityCurve.length < 2) return null;
  const W = 600;
  const H = 80;
  const equities = equityCurve.map((p) => p.equity);
  const minEq = Math.min(...equities, initialAmount * 0.95);
  const maxEq = Math.max(...equities, initialAmount * 1.05);
  const range = maxEq - minEq || 1;

  const toX = (i: number) => (i / (equityCurve.length - 1)) * W;
  const toY = (eq: number) => H - ((eq - minEq) / range) * H;

  const points = equityCurve.map((p, i) => `${toX(i).toFixed(1)},${toY(p.equity).toFixed(1)}`).join(" ");
  const posPoints = equityCurve.map((p, i) => `${toX(i).toFixed(1)},${toY(p.positionValue).toFixed(1)}`).join(" ");
  const baselineY = toY(initialAmount).toFixed(1);

  // Build buy-pause shading rectangles from consecutive paused bars
  const pauseRects: { x: number; width: number }[] = [];
  let pauseStart: number | null = null;
  equityCurve.forEach((p, i) => {
    if (p.buyPaused && pauseStart === null) {
      pauseStart = i;
    } else if (!p.buyPaused && pauseStart !== null) {
      pauseRects.push({ x: toX(pauseStart), width: toX(i) - toX(pauseStart) });
      pauseStart = null;
    }
  });
  if (pauseStart !== null) {
    pauseRects.push({ x: toX(pauseStart), width: W - toX(pauseStart) });
  }

  return (
    <div className="px-4 py-2 border-b border-border/50">
      <p className="text-[11px] text-text-secondary mb-1">Equity curve — cash + position value</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
        {/* Buy-paused period shading */}
        {pauseRects.map((r, i) => (
          <rect key={i} x={r.x} y={0} width={r.width} height={H} fill="#f59e0b22" />
        ))}
        {/* Baseline (initial capital) */}
        <line x1={0} y1={baselineY} x2={W} y2={baselineY} stroke="#333" strokeWidth={1} strokeDasharray="4 3" />
        {/* Position value */}
        <polyline points={posPoints} fill="none" stroke="#5b8dee33" strokeWidth={1} />
        {/* Total equity */}
        <polyline points={points} fill="none" stroke="#5b8dee" strokeWidth={1.5} />
      </svg>
      <div className="flex gap-4 mt-1 text-[11px] text-text-secondary">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 border-t border-accent" />
          Total equity
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 border-t border-accent/20" />
          Position value
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 border-t border-border border-dashed" />
          Starting capital
        </span>
        {pauseRects.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-2 rounded-sm" style={{ background: "#f59e0b33" }} />
            Buy paused
          </span>
        )}
      </div>
    </div>
  );
}

function PerpetualRunSection({ r, index }: { r: RunQueueResult; index: number }) {
  const pr = r.perpetualResult ?? null;
  const preset = STRATEGY_PRESETS.find((p) => p.key === r.run.presetKey);

  const buyTrades = pr ? toPerpetualChartTrades(pr.trades, "buy") : [];
  const sellTrades = pr ? toPerpetualChartTrades(pr.trades, "sell") : [];

  return (
    <div className="border-b border-border">
      {/* Header */}
      <div className="px-4 py-2 bg-surface-1 border-b border-border/70 flex items-center gap-3">
        <span className="text-[11px] text-text-secondary uppercase tracking-wide">#{index + 1}</span>
        <span className="text-sm font-semibold text-text-primary">{r.run.symbol}</span>
        <span className="text-[11px] text-text-secondary">{preset?.label ?? r.run.presetKey}</span>
        <span className="text-[11px] text-text-secondary tabular-nums ml-auto">
          {r.run.startDate} · {r.run.durationDays}d · {fmtUsd(r.run.totalAmount)}
        </span>
      </div>

      {r.error && <div className="px-4 py-3 text-xs text-sell">{r.error}</div>}

      {pr && (
        <>
          {/* P&L stats */}
          <div className="px-4 py-3 grid grid-cols-4 gap-3 border-b border-border/50">
            <StatCell
              label="Total P&L"
              value={fmtUsd(pr.totalPnlUsd)}
              sub={fmtPct(pr.totalPnlPct)}
              positive={pr.totalPnlUsd >= 0}
            />
            <StatCell
              label="Realized P&L"
              value={fmtUsd(pr.realizedPnlUsd)}
              positive={pr.realizedPnlUsd >= 0}
            />
            <StatCell
              label="Unrealized P&L"
              value={fmtUsd(pr.unrealizedPnlUsd)}
              positive={pr.unrealizedPnlUsd >= 0}
            />
            <StatCell
              label="Max Drawdown"
              value={fmtPct(-pr.maxDrawdownPct)}
              positive={false}
            />
          </div>

          {/* Position summary */}
          <div className="px-4 py-2 flex gap-6 text-[12px] border-b border-border/50 flex-wrap">
            <MoneyPill label="Invested" value={pr.totalInvested} />
            <MoneyPill label="Proceeds" value={pr.totalProceeds} />
            <MoneyPill label="Final Cash" value={pr.finalCash} />
            <MoneyPill label="Final Position" value={pr.finalPositionValue} />
            <MoneyPill label="Total Equity" value={pr.totalEquity} />
            <span className="text-text-secondary">
              Trades{" "}
              <span className="font-semibold text-text-primary">
                {pr.buyCount}B / {pr.sellCount}S
              </span>
            </span>
            {pr.buyPauseCount > 0 && (
              <span className="text-text-secondary">
                Buy pauses{" "}
                <span className="font-semibold text-text-primary">{pr.buyPauseCount}</span>
              </span>
            )}
          </div>

          {/* Equity curve */}
          <PerpetualEquityCurve equityCurve={pr.equityCurve} initialAmount={r.run.totalAmount} />

          {/* Price chart with trade markers */}
          {r.bars.length > 0 && (buyTrades.length > 0 || sellTrades.length > 0) && (
            <div className="h-64 border-b border-border/50">
              <BacktestChart
                bars={r.bars}
                scaleInTrades={buyTrades}
                scaleOutTrades={sellTrades}
                earningsEvents={r.earningsEvents}
                movingAverageDays={BACKTEST_EMA_DAYS}
              />
            </div>
          )}

          {/* Trade log */}
          {pr.trades.length > 0 && (
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-surface-1 text-[11px] uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Date</th>
                    <th className="px-3 py-1.5 text-left font-medium">Side</th>
                    <th className="px-3 py-1.5 text-right font-medium">Price</th>
                    <th className="px-3 py-1.5 text-right font-medium">Notional</th>
                    <th className="px-3 py-1.5 text-right font-medium">Score</th>
                    <th className="px-3 py-1.5 text-right font-medium">Position After</th>
                    <th className="px-3 py-1.5 text-right font-medium">Cash After</th>
                    <th className="px-3 py-1.5 text-right font-medium">Avg Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {pr.trades.map((t, idx) => (
                    <tr key={idx} className="border-t border-border/40 hover:bg-surface-2/40">
                      <td className="px-3 py-1 tabular-nums text-text-secondary">
                        {t.date.slice(0, 10)}
                      </td>
                      <td className={`px-3 py-1 font-semibold ${t.side === "buy" ? "text-buy" : "text-sell"}`}>
                        {t.side.toUpperCase()}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(t.price)}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(t.notionalUsd)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">
                        {(t.score * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">
                        {t.positionQtyAfter.toFixed(4)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(t.cashAfter)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">
                        {fmtUsd(t.avgCostBasis)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CryptoAutotraderEquityCurve({
  equityCurve,
  initialAmount,
}: {
  equityCurve: CryptoAutotraderBacktestResult["equityCurve"];
  initialAmount: number;
}) {
  if (equityCurve.length < 2) return null;
  const W = 600;
  const H = 80;
  const equities = equityCurve.map((p) => p.equity);
  const minEq = Math.min(...equities, initialAmount * 0.9);
  const maxEq = Math.max(...equities, initialAmount * 1.1);
  const range = maxEq - minEq || 1;
  const toX = (i: number) => (i / (equityCurve.length - 1)) * W;
  const toY = (eq: number) => H - ((eq - minEq) / range) * H;

  const points = equityCurve
    .map((p, i) => `${toX(i).toFixed(1)},${toY(p.equity).toFixed(1)}`)
    .join(" ");
  const exposurePoints = equityCurve
    .map((p, i) => `${toX(i).toFixed(1)},${toY(initialAmount + p.positionValueSigned).toFixed(1)}`)
    .join(" ");
  const baselineY = toY(initialAmount).toFixed(1);

  return (
    <div className="px-4 py-2 border-b border-border/50">
      <p className="text-[11px] text-text-secondary mb-1">
        Equity curve — includes long/short position exposure
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
        <line
          x1={0}
          y1={baselineY}
          x2={W}
          y2={baselineY}
          stroke="#333"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        <polyline points={exposurePoints} fill="none" stroke="#22c55e66" strokeWidth={1} />
        <polyline points={points} fill="none" stroke="#5b8dee" strokeWidth={1.5} />
      </svg>
      <div className="flex gap-4 mt-1 text-[11px] text-text-secondary">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 border-t border-accent" />
          Total equity
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 border-t border-buy/50" />
          Initial + exposure
        </span>
      </div>
    </div>
  );
}

function CryptoAutotraderRunSection({ r, index }: { r: RunQueueResult; index: number }) {
  const ar = r.autotraderResult ?? null;
  const preset = STRATEGY_PRESETS.find((p) => p.key === r.run.presetKey);

  const buyTrades = ar ? toAutotraderChartTrades(ar.trades, "buy") : [];
  const sellTrades = ar ? toAutotraderChartTrades(ar.trades, "sell") : [];
  const roundTrips = ar ? toAutotraderRoundTrips(ar.trades) : [];
  const shortSaleGroups = ar ? groupShortSalesByEntry(ar.trades) : [];

  return (
    <div className="border-b border-border">
      <div className="px-4 py-2 bg-surface-1 border-b border-border/70 flex items-center gap-3">
        <span className="text-[11px] text-text-secondary uppercase tracking-wide">#{index + 1}</span>
        <span className="text-sm font-semibold text-text-primary">{r.run.symbol}</span>
        <span className="text-[11px] text-text-secondary">{preset?.label ?? r.run.presetKey}</span>
        <span className="text-[11px] text-text-secondary tabular-nums ml-auto">
          {r.run.startDate} · {r.run.durationDays}d · {fmtUsd(r.run.totalAmount)}
        </span>
      </div>

      {r.error && <div className="px-4 py-3 text-xs text-sell">{r.error}</div>}

      {ar && (
        <>
          <div className="px-4 py-3 grid grid-cols-4 gap-3 border-b border-border/50">
            <StatCell
              label="Total P&L"
              value={fmtUsd(ar.totalPnlUsd)}
              sub={fmtPct(ar.totalPnlPct)}
              positive={ar.totalPnlUsd >= 0}
            />
            <StatCell
              label="Realized P&L"
              value={fmtUsd(ar.realizedPnlUsd)}
              positive={ar.realizedPnlUsd >= 0}
            />
            <StatCell
              label="Unrealized P&L"
              value={fmtUsd(ar.unrealizedPnlUsd)}
              positive={ar.unrealizedPnlUsd >= 0}
            />
            <StatCell
              label="Max Drawdown"
              value={fmtPct(-ar.maxDrawdownPct)}
              positive={false}
            />
          </div>

          <div className="px-4 py-2 flex gap-6 text-[12px] border-b border-border/50 flex-wrap">
            <MoneyPill label="Final Cash" value={ar.finalCash} />
            <MoneyPill label="Total Equity" value={ar.totalEquity} />
            <MoneyPill label="Final Exposure" value={ar.finalPositionValueSigned} />
            <span className="text-text-secondary">
              Final position{" "}
              <span className="font-semibold text-text-primary">
                {ar.finalPositionSide === "flat"
                  ? "flat"
                  : `${ar.finalPositionSide} ${ar.finalPositionQty.toFixed(4)}`}
              </span>
            </span>
            <span className="text-text-secondary">
              Trades{" "}
              <span className="font-semibold text-text-primary">
                L {ar.openLongCount}/{ar.closeLongCount} · S {ar.openShortCount}/{ar.coverShortCount}
              </span>
            </span>
          </div>

          <CryptoAutotraderEquityCurve
            equityCurve={ar.equityCurve}
            initialAmount={r.run.totalAmount}
          />

          {r.bars.length > 0 && (buyTrades.length > 0 || sellTrades.length > 0) && (
            <div className="h-64 border-b border-border/50">
              <BacktestChart
                bars={r.bars}
                scaleInTrades={buyTrades}
                scaleOutTrades={sellTrades}
                earningsEvents={r.earningsEvents}
                movingAverageDays={BACKTEST_EMA_DAYS}
              />
            </div>
          )}

          {roundTrips.length > 0 && (
            <div className="max-h-72 overflow-auto border-t border-border/40">
              <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-text-secondary bg-surface-1 sticky top-0 z-[1]">
                Closed Trades (Round Trips)
              </div>
              <table className="w-full text-[12px]">
                <thead className="sticky top-7 bg-surface-1 text-[11px] uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Side</th>
                    <th className="px-3 py-1.5 text-left font-medium">Entry</th>
                    <th className="px-3 py-1.5 text-left font-medium">Exit</th>
                    <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                    <th className="px-3 py-1.5 text-right font-medium">Entry Px</th>
                    <th className="px-3 py-1.5 text-right font-medium">Exit Px</th>
                    <th className="px-3 py-1.5 text-right font-medium">Entry $</th>
                    <th className="px-3 py-1.5 text-right font-medium">Exit $</th>
                    <th className="px-3 py-1.5 text-right font-medium">P&L</th>
                    <th className="px-3 py-1.5 text-right font-medium">P&L %</th>
                  </tr>
                </thead>
                <tbody>
                  {roundTrips.map((trade, idx) => (
                    <tr key={`${trade.side}-${trade.entryDate}-${trade.exitDate}-${idx}`} className="border-t border-border/40 hover:bg-surface-2/40">
                      <td
                        className={`px-3 py-1 font-semibold ${
                          trade.side === "long" ? "text-buy" : "text-sell"
                        }`}
                      >
                        {trade.side.toUpperCase()}
                      </td>
                      <td className="px-3 py-1 tabular-nums text-text-secondary">
                        {trade.entryDate.slice(0, 10)}
                      </td>
                      <td className="px-3 py-1 tabular-nums text-text-secondary">
                        {trade.exitDate.slice(0, 10)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-primary">
                        {trade.qty.toFixed(4)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-primary">
                        {fmtUsd(trade.entryPrice)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-primary">
                        {fmtUsd(trade.exitPrice)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">
                        {fmtUsd(trade.entryNotionalUsd)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">
                        {fmtUsd(trade.exitNotionalUsd)}
                      </td>
                      <td
                        className={`px-3 py-1 text-right tabular-nums font-semibold ${
                          trade.pnlUsd >= 0 ? "text-buy" : "text-sell"
                        }`}
                      >
                        {fmtUsd(trade.pnlUsd)}
                      </td>
                      <td
                        className={`px-3 py-1 text-right tabular-nums font-semibold ${
                          trade.pnlPct >= 0 ? "text-buy" : "text-sell"
                        }`}
                      >
                        {fmtPct(trade.pnlPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {shortSaleGroups.length > 0 && (
            <div className="max-h-80 overflow-auto border-t border-border/40">
              <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-text-secondary bg-surface-1 sticky top-0 z-[1]">
                Short Sales Grouped With Covers
              </div>
              <table className="w-full text-[12px]">
                <thead className="sticky top-7 bg-surface-1 text-[11px] uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Short</th>
                    <th className="px-3 py-1.5 text-left font-medium">Leg</th>
                    <th className="px-3 py-1.5 text-left font-medium">Date</th>
                    <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                    <th className="px-3 py-1.5 text-right font-medium">Price</th>
                    <th className="px-3 py-1.5 text-right font-medium">Notional</th>
                    <th className="px-3 py-1.5 text-right font-medium">P&L</th>
                    <th className="px-3 py-1.5 text-right font-medium">P&L %</th>
                    <th className="px-3 py-1.5 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shortSaleGroups.flatMap((group, groupIdx) => {
                    const entryRow = (
                      <tr
                        key={`${group.id}-entry`}
                        className="border-t border-border/40 bg-surface-2/20 hover:bg-surface-2/40"
                      >
                        <td className="px-3 py-1 font-semibold text-text-primary">
                          Short #{groupIdx + 1}
                        </td>
                        <td className="px-3 py-1 text-sell font-semibold">entry</td>
                        <td className="px-3 py-1 tabular-nums text-text-secondary">
                          {group.entryDate.slice(0, 16)}
                        </td>
                        <td className="px-3 py-1 text-right tabular-nums">{group.entryQty.toFixed(4)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(group.entryPrice)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(group.entryNotionalUsd)}</td>
                        <td
                          className={`px-3 py-1 text-right tabular-nums font-semibold ${
                            group.realizedPnlUsd >= 0 ? "text-buy" : "text-sell"
                          }`}
                        >
                          {group.coveredQty > POSITION_EPSILON ? fmtUsd(group.realizedPnlUsd) : "—"}
                        </td>
                        <td
                          className={`px-3 py-1 text-right tabular-nums font-semibold ${
                            group.realizedPnlPct >= 0 ? "text-buy" : "text-sell"
                          }`}
                        >
                          {group.coveredQty > POSITION_EPSILON ? fmtPct(group.realizedPnlPct) : "—"}
                        </td>
                        <td className="px-3 py-1 text-text-secondary">
                          {group.covers.length} cover{group.covers.length === 1 ? "" : "s"} ·{" "}
                          {group.remainingQty <= POSITION_EPSILON
                            ? "closed"
                            : `open ${group.remainingQty.toFixed(4)}`}
                        </td>
                      </tr>
                    );

                    const coverRows = group.covers.map((cover, coverIdx) => (
                      <tr
                        key={`${group.id}-cover-${coverIdx}`}
                        className="border-t border-border/30 hover:bg-surface-2/40"
                      >
                        <td className="px-3 py-1 text-text-secondary"></td>
                        <td className="px-3 py-1 text-buy font-semibold">cover {coverIdx + 1}</td>
                        <td className="px-3 py-1 tabular-nums text-text-secondary">
                          {cover.date.slice(0, 16)}
                        </td>
                        <td className="px-3 py-1 text-right tabular-nums">{cover.qty.toFixed(4)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(cover.coverPrice)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(cover.coverNotionalUsd)}</td>
                        <td
                          className={`px-3 py-1 text-right tabular-nums font-semibold ${
                            cover.pnlUsd >= 0 ? "text-buy" : "text-sell"
                          }`}
                        >
                          {fmtUsd(cover.pnlUsd)}
                        </td>
                        <td
                          className={`px-3 py-1 text-right tabular-nums font-semibold ${
                            cover.pnlPct >= 0 ? "text-buy" : "text-sell"
                          }`}
                        >
                          {fmtPct(cover.pnlPct)}
                        </td>
                        <td className="px-3 py-1 text-text-secondary">
                          {cover.trendDirection} · selloff {(cover.selloffScore * 100).toFixed(0)}%
                        </td>
                      </tr>
                    ));

                    return [entryRow, ...coverRows];
                  })}
                </tbody>
              </table>
            </div>
          )}

          {ar.trades.length > 0 && (
            <div className="max-h-72 overflow-auto border-t border-border/40">
              <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-text-secondary bg-surface-1 sticky top-0 z-[1]">
                Execution Log
              </div>
              <table className="w-full text-[12px]">
                <thead className="sticky top-7 bg-surface-1 text-[11px] uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Date</th>
                    <th className="px-3 py-1.5 text-left font-medium">Side</th>
                    <th className="px-3 py-1.5 text-left font-medium">Intent</th>
                    <th className="px-3 py-1.5 text-left font-medium">EMA Slope</th>
                    <th className="px-3 py-1.5 text-right font-medium">Price</th>
                    <th className="px-3 py-1.5 text-right font-medium">Notional</th>
                    <th className="px-3 py-1.5 text-right font-medium">Score</th>
                    <th className="px-3 py-1.5 text-right font-medium">Selloff</th>
                    <th className="px-3 py-1.5 text-right font-medium">Position After</th>
                    <th className="px-3 py-1.5 text-right font-medium">Cash After</th>
                  </tr>
                </thead>
                <tbody>
                  {ar.trades.map((trade, idx) => (
                    <tr key={idx} className="border-t border-border/40 hover:bg-surface-2/40">
                      <td className="px-3 py-1 tabular-nums text-text-secondary">
                        {trade.date.slice(0, 10)}
                      </td>
                      <td
                        className={`px-3 py-1 font-semibold ${
                          trade.side === "buy" ? "text-buy" : "text-sell"
                        }`}
                      >
                        {trade.side.toUpperCase()}
                      </td>
                      <td className="px-3 py-1 text-text-secondary">{trade.intent}</td>
                      <td
                        className={`px-3 py-1 font-medium ${
                          trade.trendDirection === "up"
                            ? "text-buy"
                            : trade.trendDirection === "down"
                              ? "text-sell"
                              : "text-text-secondary"
                        }`}
                      >
                        {trade.trendDirection}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(trade.price)}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(trade.notionalUsd)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">
                        {(trade.score * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">
                        {(trade.selloffScore * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">
                        {trade.positionSideAfter === "short"
                          ? `-${trade.positionQtyAfter.toFixed(4)}`
                          : trade.positionQtyAfter.toFixed(4)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(trade.cashAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CryptoTrendConfidenceRunSection({ r, index }: { r: RunQueueResult; index: number }) {
  const tr = r.trendConfidenceResult ?? null;
  const preset = STRATEGY_PRESETS.find((p) => p.key === r.run.presetKey);
  const markers = tr ? toTrendRegionMarkers(tr.regions) : [];
  const current = tr?.currentTrend ?? null;

  return (
    <div className="border-b border-border">
      <div className="px-4 py-2 bg-surface-1 border-b border-border/70 flex items-center gap-3">
        <span className="text-[11px] text-text-secondary uppercase tracking-wide">#{index + 1}</span>
        <span className="text-sm font-semibold text-text-primary">{r.run.symbol}</span>
        <span className="text-[11px] text-text-secondary">{preset?.label ?? r.run.presetKey}</span>
        <span className="text-[11px] text-text-secondary tabular-nums ml-auto">
          {r.run.startDate} · {r.run.durationDays}d · {fmtUsd(r.run.totalAmount)}
        </span>
      </div>

      {r.error && <div className="px-4 py-3 text-xs text-sell">{r.error}</div>}

      {tr && (
        <>
          <div className="px-4 py-2 flex gap-6 text-[12px] border-b border-border/50 flex-wrap">
            <span className="text-text-secondary">
              EMA pair{" "}
              <span className="font-semibold text-text-primary">
                {tr.fastEmaPeriod}/{tr.slowEmaPeriod}
              </span>
            </span>
            <span className="text-text-secondary">
              Realized regions{" "}
              <span className="font-semibold text-text-primary">{tr.realizedRegionCount}</span>
            </span>
            <span className="text-text-secondary">
              Avg realized confidence{" "}
              <span className="font-semibold text-text-primary">
                {(tr.averageRealizedConfidence * 100).toFixed(0)}%
              </span>
            </span>
            {current && (
              <span className="text-text-secondary">
                Current trend guess{" "}
                <span className={`font-semibold ${trendDirectionClass(current.direction)}`}>
                  {formatTrendDirection(current.direction)}
                </span>{" "}
                <span className="font-semibold text-text-primary">
                  {(current.confidence * 100).toFixed(0)}%
                </span>
              </span>
            )}
          </div>

          {r.bars.length > 0 && markers.length > 0 && (
            <div className="h-64 border-b border-border/50">
              <BacktestChart
                bars={r.bars}
                scaleInTrades={[]}
                scaleOutTrades={[]}
                earningsEvents={r.earningsEvents}
                eventMarkers={markers}
                movingAverageDays={BACKTEST_EMA_DAYS}
              />
            </div>
          )}

          <div className="max-h-72 overflow-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-surface-1 text-[11px] uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Region</th>
                  <th className="px-3 py-1.5 text-left font-medium">Status</th>
                  <th className="px-3 py-1.5 text-left font-medium">Trend</th>
                  <th className="px-3 py-1.5 text-right font-medium">Confidence</th>
                  <th className="px-3 py-1.5 text-right font-medium">Bars</th>
                  <th className="px-3 py-1.5 text-right font-medium">Return</th>
                  <th className="px-3 py-1.5 text-left font-medium">Start</th>
                  <th className="px-3 py-1.5 text-left font-medium">End</th>
                </tr>
              </thead>
              <tbody>
                {tr.regions.map((region) => (
                  <tr key={region.id} className="border-t border-border/40 hover:bg-surface-2/40">
                    <td className="px-3 py-1 font-semibold text-text-primary">{region.id}</td>
                    <td className="px-3 py-1 text-text-secondary">
                      {region.status === "forming" ? "forming (guess)" : "realized"}
                    </td>
                    <td className={`px-3 py-1 font-semibold ${trendDirectionClass(region.direction)}`}>
                      {formatTrendDirection(region.direction)}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums text-text-primary">
                      {(region.confidence * 100).toFixed(0)}%
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums text-text-secondary">
                      {region.barCount.toLocaleString()}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums text-text-secondary">
                      {fmtPct(region.returnPct)}
                    </td>
                    <td className="px-3 py-1 tabular-nums text-text-secondary">
                      {region.startDate.slice(0, 10)}
                    </td>
                    <td className="px-3 py-1 tabular-nums text-text-secondary">
                      {region.endDate.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function trendDirectionCode(direction: TrendRegionDirection): string {
  if (direction === "uptrend") return "UP";
  if (direction === "downtrend") return "DOWN";
  return "RANGE";
}

function formatTrendDirection(direction: TrendRegionDirection): string {
  if (direction === "uptrend") return "uptrend";
  if (direction === "downtrend") return "downtrend";
  return "range";
}

function trendDirectionClass(direction: TrendRegionDirection): string {
  if (direction === "uptrend") return "text-buy";
  if (direction === "downtrend") return "text-sell";
  return "text-yellow-400";
}

function trendDirectionColor(direction: TrendRegionDirection, status: TrendConfidenceRegion["status"]): string {
  if (direction === "uptrend") return status === "forming" ? "#22c55eAA" : "#22c55e";
  if (direction === "downtrend") return status === "forming" ? "#ef4444AA" : "#ef4444";
  return status === "forming" ? "#f59e0bAA" : "#f59e0b";
}

function StatCell({
  label,
  value,
  sub,
  positive,
}: {
  label: string;
  value: string;
  sub?: string;
  positive: boolean;
}) {
  return (
    <div className="rounded border border-border bg-surface-2 px-3 py-2">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-sm font-semibold tabular-nums mt-0.5 ${positive ? "text-buy" : "text-sell"}`}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-text-secondary tabular-nums mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Standard (non-perpetual) run section ─────────────────────────────────────

function RunSection({ r, index }: { r: RunQueueResult; index: number }) {
  const res = r.result;
  const phase = res?.phase;
  const preset = STRATEGY_PRESETS.find((p) => p.key === r.run.presetKey);
  const recommendation = r.marketRecommendation;

  const inComp = res?.scaleIn?.comparison;
  const outComp = res?.scaleOut?.comparison;

  return (
    <div className="border-b border-border">
      <div className="px-4 py-2 bg-surface-1 border-b border-border/70 flex items-center gap-3">
        <span className="text-[11px] text-text-secondary uppercase tracking-wide">#{index + 1}</span>
        <span className="text-sm font-semibold text-text-primary">{r.run.symbol}</span>
        <span className="text-[11px] text-text-secondary">{preset?.label ?? r.run.presetKey}</span>
        <span className="text-[11px] text-text-secondary tabular-nums ml-auto">
          {r.run.startDate} · {r.run.durationDays}d · {fmtUsd(r.run.totalAmount)}
        </span>
      </div>

      {r.error && (
        <div className="px-4 py-3 text-xs text-sell">{r.error}</div>
      )}

      {recommendation && (
        <div className="px-4 py-2 border-b border-border/50 bg-surface-1/50">
          <p className="text-[11px] uppercase tracking-widest text-text-secondary">Market condition</p>
          <p className="mt-0.5 text-xs text-text-primary">
            {formatConditionLabel(recommendation.condition)} · confidence {fmtPct(recommendation.confidence * 100)}
          </p>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            Recommended strategy: <span className="text-text-primary">{recommendation.recommendation.label}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-text-secondary">{recommendation.recommendation.note}</p>
        </div>
      )}

      {res && (
        <>
          {/* Comparison metrics */}
          <div className="px-4 py-2 flex gap-6 text-[12px] border-b border-border/50 flex-wrap">
            {inComp && phase !== "scale_out" && (
              <>
                <ComparisonPill
                  label="Buy vs Lump"
                  value={inComp.smartVsLumpPct}
                  trades={res.scaleIn!.trades.length}
                  direction="buy"
                />
                <ComparisonPill
                  label="Buy vs Random"
                  value={inComp.smartVsRandomPct}
                  trades={null}
                  direction="buy"
                />
              </>
            )}
            {outComp && phase !== "scale_in" && (
              <>
                <ComparisonPill
                  label="Sell vs Lump"
                  value={outComp.smartVsLumpPct}
                  trades={res.scaleOut!.trades.length}
                  direction="sell"
                />
                <ComparisonPill
                  label="Sell vs Random"
                  value={outComp.smartVsRandomPct}
                  trades={null}
                  direction="sell"
                />
              </>
            )}
            <MoneyPill label="Total Cost" value={res.performance.investedAmount} />
            <MoneyPill label="Proceeds" value={res.performance.proceeds} />
          </div>

          {res.scaleIn && phase !== "scale_out" && (
            <div className="max-h-56 overflow-auto">
              <TradeTable trades={res.scaleIn.trades} direction="scale_in" compact />
            </div>
          )}

          {res.scaleOut && phase !== "scale_in" && (
            <div className="max-h-56 overflow-auto">
              <TradeTable trades={res.scaleOut.trades} direction="scale_out" compact />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function formatConditionLabel(condition: MarketConditionRecommendation["condition"]): string {
  if (condition === "high_volatility_selloff") return "High-volatility selloff";
  if (condition === "bullish_trend") return "Bullish trend";
  if (condition === "pullback_mean_reversion") return "Pullback / mean-reversion";
  return "Range-bound";
}

function ComparisonChip({
  label,
  value,
  winRate: wr,
  n,
}: {
  label: string;
  value: number | null;
  winRate: number | null;
  n: number;
}) {
  if (value === null || n === 0) {
    return (
      <div className="rounded border border-border bg-surface-2 px-3 py-2">
        <p className="text-[11px] text-text-secondary">{label}</p>
        <p className="text-sm font-semibold text-text-secondary mt-0.5">—</p>
      </div>
    );
  }
  const positive = value >= 0;
  return (
    <div className="rounded border border-border bg-surface-2 px-3 py-2">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-sm font-semibold tabular-nums mt-0.5 ${positive ? "text-buy" : "text-sell"}`}>
        {fmtPct(value)}
      </p>
      {wr !== null && (
        <p className="text-[11px] text-text-secondary mt-0.5 tabular-nums">
          {wr.toFixed(0)}% win · {n} run{n !== 1 ? "s" : ""}
        </p>
      )}
    </div>
  );
}

function ComparisonPill({
  label,
  value,
  trades,
  direction,
}: {
  label: string;
  value: number;
  trades: number | null;
  direction: "buy" | "sell";
}) {
  const positive = value >= 0;
  const color = positive ? "text-buy" : "text-sell";
  return (
    <span className="text-text-secondary">
      {label}{" "}
      <span className={`font-semibold tabular-nums ${color}`}>{fmtPct(value)}</span>
      {trades !== null && (
        <span className="ml-1.5 text-text-secondary/70">
          · {trades} {direction === "buy" ? "buys" : "sells"}
        </span>
      )}
    </span>
  );
}

function MoneyPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-text-secondary">
      {label}{" "}
      <span className="font-semibold tabular-nums text-text-primary">{fmtUsd(value)}</span>
    </span>
  );
}
