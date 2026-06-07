import BacktestChart from "../../../components/BacktestChart";
import type { PerpetualBacktestResult } from "../../../lib/perpetualBacktest";
import type { RunQueueResult } from "../types";
import { fmtPct, fmtUsd } from "./formatters";
import { BACKTEST_EMA_DAYS, MoneyPill, RunSectionHeader, StatCell } from "./shared";
import { toPerpetualChartTrades } from "./transforms";

function PerpetualEquityCurve({
  equityCurve,
  initialAmount,
}: {
  equityCurve: PerpetualBacktestResult["equityCurve"];
  initialAmount: number;
}) {
  if (equityCurve.length < 2) return null;

  const width = 600;
  const height = 80;
  const equities = equityCurve.map((point) => point.equity);
  const minEquity = Math.min(...equities, initialAmount * 0.95);
  const maxEquity = Math.max(...equities, initialAmount * 1.05);
  const range = maxEquity - minEquity || 1;
  const toX = (index: number) => (index / (equityCurve.length - 1)) * width;
  const toY = (equity: number) => height - ((equity - minEquity) / range) * height;
  const points = equityCurve
    .map((point, index) => `${toX(index).toFixed(1)},${toY(point.equity).toFixed(1)}`)
    .join(" ");
  const positionPoints = equityCurve
    .map((point, index) => `${toX(index).toFixed(1)},${toY(point.positionValue).toFixed(1)}`)
    .join(" ");
  const baselineY = toY(initialAmount).toFixed(1);

  const pauseRects: { x: number; width: number }[] = [];
  let pauseStart: number | null = null;
  equityCurve.forEach((point, index) => {
    if (point.buyPaused && pauseStart === null) {
      pauseStart = index;
    } else if (!point.buyPaused && pauseStart !== null) {
      pauseRects.push({ x: toX(pauseStart), width: toX(index) - toX(pauseStart) });
      pauseStart = null;
    }
  });
  if (pauseStart !== null) {
    pauseRects.push({ x: toX(pauseStart), width: width - toX(pauseStart) });
  }

  return (
    <div className="px-4 py-2 border-b border-border/50">
      <p className="text-[11px] text-text-secondary mb-1">Equity curve — cash + position value</p>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-20" preserveAspectRatio="none">
        {pauseRects.map((rect, index) => (
          <rect key={index} x={rect.x} y={0} width={rect.width} height={height} fill="#f59e0b22" />
        ))}
        <line x1={0} y1={baselineY} x2={width} y2={baselineY} stroke="#333" strokeWidth={1} strokeDasharray="4 3" />
        <polyline points={positionPoints} fill="none" stroke="#5b8dee33" strokeWidth={1} />
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
        {pauseRects.length > 0 ? (
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-2 rounded-sm" style={{ background: "#f59e0b33" }} />
            Buy paused
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function PerpetualRunSection({ r, index }: { r: RunQueueResult; index: number }) {
  const result = r.perpetualResult ?? null;
  const buyTrades = result ? toPerpetualChartTrades(result.trades, "buy") : [];
  const sellTrades = result ? toPerpetualChartTrades(result.trades, "sell") : [];

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
            <MoneyPill label="Invested" value={result.totalInvested} />
            <MoneyPill label="Proceeds" value={result.totalProceeds} />
            <MoneyPill label="Final Cash" value={result.finalCash} />
            <MoneyPill label="Final Position" value={result.finalPositionValue} />
            <MoneyPill label="Total Equity" value={result.totalEquity} />
            <span className="text-text-secondary">
              Trades <span className="font-semibold text-text-primary">{result.buyCount}B / {result.sellCount}S</span>
            </span>
            {result.buyPauseCount > 0 ? (
              <span className="text-text-secondary">
                Buy pauses <span className="font-semibold text-text-primary">{result.buyPauseCount}</span>
              </span>
            ) : null}
          </div>

          <PerpetualEquityCurve equityCurve={result.equityCurve} initialAmount={r.run.totalAmount} />

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

          {result.trades.length > 0 ? (
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
                  {result.trades.map((trade, tradeIndex) => (
                    <tr key={tradeIndex} className="border-t border-border/40 hover:bg-surface-2/40">
                      <td className="px-3 py-1 tabular-nums text-text-secondary">{trade.date.slice(0, 10)}</td>
                      <td className={`px-3 py-1 font-semibold ${trade.side === "buy" ? "text-buy" : "text-sell"}`}>
                        {trade.side.toUpperCase()}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(trade.price)}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(trade.notionalUsd)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">{(trade.score * 100).toFixed(0)}%</td>
                      <td className="px-3 py-1 text-right tabular-nums">{trade.positionQtyAfter.toFixed(4)}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{fmtUsd(trade.cashAfter)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-text-secondary">{fmtUsd(trade.avgCostBasis)}</td>
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
