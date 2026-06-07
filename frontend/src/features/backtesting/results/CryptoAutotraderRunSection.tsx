import BacktestChart from "../../../components/BacktestChart";
import type { CryptoAutotraderBacktestResult } from "../../../lib/cryptoAutotraderBacktest";
import type { RunQueueResult } from "../types";
import { fmtPct, fmtUsd } from "./formatters";
import { BACKTEST_EMA_DAYS, MoneyPill, RunSectionHeader, StatCell } from "./shared";
import {
  groupShortSalesByEntry,
  toAutotraderChartTrades,
  toAutotraderRoundTrips,
} from "./transforms";

function CryptoAutotraderEquityCurve({
  equityCurve,
  initialAmount,
}: {
  equityCurve: CryptoAutotraderBacktestResult["equityCurve"];
  initialAmount: number;
}) {
  if (equityCurve.length < 2) return null;

  const width = 600;
  const height = 80;
  const equities = equityCurve.map((point) => point.equity);
  const minEquity = Math.min(...equities, initialAmount * 0.9);
  const maxEquity = Math.max(...equities, initialAmount * 1.1);
  const range = maxEquity - minEquity || 1;
  const toX = (index: number) => (index / (equityCurve.length - 1)) * width;
  const toY = (equity: number) => height - ((equity - minEquity) / range) * height;
  const points = equityCurve
    .map((point, index) => `${toX(index).toFixed(1)},${toY(point.equity).toFixed(1)}`)
    .join(" ");
  const exposurePoints = equityCurve
    .map((point, index) => `${toX(index).toFixed(1)},${toY(initialAmount + point.positionValueSigned).toFixed(1)}`)
    .join(" ");
  const baselineY = toY(initialAmount).toFixed(1);

  return (
    <div className="px-4 py-2 border-b border-border/50">
      <p className="text-[11px] text-text-secondary mb-1">Equity curve — includes long/short position exposure</p>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-20" preserveAspectRatio="none">
        <line x1={0} y1={baselineY} x2={width} y2={baselineY} stroke="#333" strokeWidth={1} strokeDasharray="4 3" />
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

export function CryptoAutotraderRunSection({ r, index }: { r: RunQueueResult; index: number }) {
  const result = r.autotraderResult ?? null;
  const buyTrades = result ? toAutotraderChartTrades(result.trades, "buy") : [];
  const sellTrades = result ? toAutotraderChartTrades(result.trades, "sell") : [];
  const roundTrips = result ? toAutotraderRoundTrips(result.trades) : [];
  const shortSaleGroups = result ? groupShortSalesByEntry(result.trades) : [];

  return (
    <div className="border-b border-border">
      <RunSectionHeader r={r} index={index} />
      {r.error ? <div className="px-4 py-3 text-xs text-sell">{r.error}</div> : null}
      {result ? (
        <>
          <div className="px-4 py-3 grid grid-cols-4 gap-3 border-b border-border/50">
            <StatCell label="Total P&L" value={fmtUsd(result.totalPnlUsd)} sub={fmtPct(result.totalPnlPct)} positive={result.totalPnlUsd >= 0} />
            <StatCell label="Realized P&L" value={fmtUsd(result.realizedPnlUsd)} positive={result.realizedPnlUsd >= 0} />
            <StatCell label="Unrealized P&L" value={fmtUsd(result.unrealizedPnlUsd)} positive={result.unrealizedPnlUsd >= 0} />
            <StatCell label="Max Drawdown" value={fmtPct(-result.maxDrawdownPct)} positive={false} />
          </div>

          <div className="px-4 py-2 flex gap-6 text-[12px] border-b border-border/50 flex-wrap">
            <MoneyPill label="Final Cash" value={result.finalCash} />
            <MoneyPill label="Total Equity" value={result.totalEquity} />
            <MoneyPill label="Final Exposure" value={result.finalPositionValueSigned} />
            <span className="text-text-secondary">
              Final position{" "}
              <span className="font-semibold text-text-primary">
                {result.finalPositionSide === "flat"
                  ? "flat"
                  : `${result.finalPositionSide} ${result.finalPositionQty.toFixed(4)}`}
              </span>
            </span>
            <span className="text-text-secondary">
              Trades{" "}
              <span className="font-semibold text-text-primary">
                L {result.openLongCount}/{result.closeLongCount} · S {result.openShortCount}/{result.coverShortCount}
              </span>
            </span>
          </div>

          <CryptoAutotraderEquityCurve equityCurve={result.equityCurve} initialAmount={r.run.totalAmount} />

          {r.bars.length > 0 && (buyTrades.length > 0 || sellTrades.length > 0) ? (
            <div className="h-64 border-b border-border/50">
              <BacktestChart
                bars={r.bars}
                scaleInTrades={buyTrades}
                scaleOutTrades={sellTrades}
                earningsEvents={r.earningsEvents}
                movingAverageDays={BACKTEST_EMA_DAYS}
              />
            </div>
          ) : null}

          {roundTrips.length > 0 ? (
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
                  {roundTrips.map((trade, tradeIndex) => (
                    <tr key={`${trade.side}-${trade.entryDate}-${trade.exitDate}-${tradeIndex}`} className="border-t border-border/40 hover:bg-surface-2/40">
                      <td className={`px-3 py-1 font-semibold ${trade.side === "long" ? "text-buy" : "text-sell"}`}>{trade.side.toUpperCase()}</td>
                      <td className="px-3 py-1 tabular-nums text-text-secondary">{trade.entryDate.slice(0, 10)}</td>
                      <td className="px-3 py-1 tabular-nums text-text-secondary">{trade.exitDate.slice(0, 10)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-primary">{trade.qty.toFixed(4)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-primary">{fmtUsd(trade.entryPrice)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-primary">{fmtUsd(trade.exitPrice)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">{fmtUsd(trade.entryNotionalUsd)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">{fmtUsd(trade.exitNotionalUsd)}</td>
                      <td className={`px-3 py-1 text-right tabular-nums font-semibold ${trade.pnlUsd >= 0 ? "text-buy" : "text-sell"}`}>{fmtUsd(trade.pnlUsd)}</td>
                      <td className={`px-3 py-1 text-right tabular-nums font-semibold ${trade.pnlPct >= 0 ? "text-buy" : "text-sell"}`}>{fmtPct(trade.pnlPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {shortSaleGroups.length > 0 ? (
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
                  {shortSaleGroups.flatMap((group, groupIndex) => {
                    const entryRow = (
                      <tr key={`${group.id}-entry`} className="border-t border-border/40 bg-surface-2/20 hover:bg-surface-2/40">
                        <td className="px-3 py-1 font-semibold text-text-primary">Short #{groupIndex + 1}</td>
                        <td className="px-3 py-1 text-sell font-semibold">entry</td>
                        <td className="px-3 py-1 tabular-nums text-text-secondary">{group.entryDate.slice(0, 16)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{group.entryQty.toFixed(4)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(group.entryPrice)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(group.entryNotionalUsd)}</td>
                        <td className={`px-3 py-1 text-right tabular-nums font-semibold ${group.realizedPnlUsd >= 0 ? "text-buy" : "text-sell"}`}>
                          {group.coveredQty > 1e-9 ? fmtUsd(group.realizedPnlUsd) : "—"}
                        </td>
                        <td className={`px-3 py-1 text-right tabular-nums font-semibold ${group.realizedPnlPct >= 0 ? "text-buy" : "text-sell"}`}>
                          {group.coveredQty > 1e-9 ? fmtPct(group.realizedPnlPct) : "—"}
                        </td>
                        <td className="px-3 py-1 text-text-secondary">
                          {group.covers.length} cover{group.covers.length === 1 ? "" : "s"} ·{" "}
                          {group.remainingQty <= 1e-9 ? "closed" : `open ${group.remainingQty.toFixed(4)}`}
                        </td>
                      </tr>
                    );

                    const coverRows = group.covers.map((cover, coverIndex) => (
                      <tr key={`${group.id}-cover-${coverIndex}`} className="border-t border-border/30 hover:bg-surface-2/40">
                        <td className="px-3 py-1 text-text-secondary"></td>
                        <td className="px-3 py-1 text-buy font-semibold">cover {coverIndex + 1}</td>
                        <td className="px-3 py-1 tabular-nums text-text-secondary">{cover.date.slice(0, 16)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{cover.qty.toFixed(4)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(cover.coverPrice)}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(cover.coverNotionalUsd)}</td>
                        <td className={`px-3 py-1 text-right tabular-nums font-semibold ${cover.pnlUsd >= 0 ? "text-buy" : "text-sell"}`}>{fmtUsd(cover.pnlUsd)}</td>
                        <td className={`px-3 py-1 text-right tabular-nums font-semibold ${cover.pnlPct >= 0 ? "text-buy" : "text-sell"}`}>{fmtPct(cover.pnlPct)}</td>
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
          ) : null}

          {result.trades.length > 0 ? (
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
                  {result.trades.map((trade, tradeIndex) => (
                    <tr key={tradeIndex} className="border-t border-border/40 hover:bg-surface-2/40">
                      <td className="px-3 py-1 tabular-nums text-text-secondary">{trade.date.slice(0, 10)}</td>
                      <td className={`px-3 py-1 font-semibold ${trade.side === "buy" ? "text-buy" : "text-sell"}`}>
                        {trade.side.toUpperCase()}
                      </td>
                      <td className="px-3 py-1 text-text-secondary">{trade.intent}</td>
                      <td className={`px-3 py-1 font-medium ${trade.trendDirection === "up" ? "text-buy" : trade.trendDirection === "down" ? "text-sell" : "text-text-secondary"}`}>
                        {trade.trendDirection}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(trade.price)}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(trade.notionalUsd)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">{(trade.score * 100).toFixed(0)}%</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">{(trade.selloffScore * 100).toFixed(0)}%</td>
                      <td className="px-3 py-1 text-right tabular-nums">
                        {trade.positionSideAfter === "short" ? `-${trade.positionQtyAfter.toFixed(4)}` : trade.positionQtyAfter.toFixed(4)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(trade.cashAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
