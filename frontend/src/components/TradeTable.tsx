import { BacktestTrade } from "../lib/backtest";
import { Direction } from "../lib/dca";

export default function TradeTable({
  trades,
  direction,
}: {
  trades: BacktestTrade[];
  direction: Direction;
}) {
  const isScaleOut = direction === "scale_out";
  const totalAmount = trades.reduce((s, t) => s + t.amountUsd, 0);
  const totalShares = trades.reduce((s, t) => s + t.shares, 0);

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface-1">
          <tr className="border-b border-border text-text-secondary">
            <th className="px-4 py-2 text-left w-6">#</th>
            <th className="px-4 py-2 text-left">Date</th>
            <th className="px-4 py-2 text-right">{isScaleOut ? "Proceeds" : "Amount"}</th>
            <th className="px-4 py-2 text-right">Price</th>
            <th className="px-4 py-2 text-right">Shares</th>
            <th className="px-4 py-2 text-right w-28">Score</th>
            <th className="px-4 py-2 text-left">Signals</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={t.date + i} className="border-b border-border/40 hover:bg-surface-2">
              <td className="px-4 py-2 text-text-secondary">{i + 1}</td>
              <td className="px-4 py-2 font-mono text-text-primary">{t.date}</td>
              <td className="px-4 py-2 text-right tabular-nums text-text-primary">
                ${t.amountUsd.toFixed(2)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-text-primary">
                ${t.price.toFixed(2)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-text-primary">
                {t.shares.toFixed(4)}
              </td>
              <td className="px-4 py-2 text-right">
                <ScoreBar score={t.signalScore} isScaleOut={isScaleOut} />
              </td>
              <td className="px-4 py-2 text-text-secondary max-w-xs truncate">
                {t.rationale}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-semibold text-text-primary">
            <td colSpan={2} className="px-4 py-2 text-text-secondary">
              {trades.length} {isScaleOut ? "sells" : "buys"}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              ${totalAmount.toFixed(2)}
            </td>
            <td className="px-4 py-2 text-right text-text-secondary">avg</td>
            <td className="px-4 py-2 text-right tabular-nums">
              {totalShares.toFixed(4)}
            </td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ScoreBar({ score, isScaleOut }: { score: number; isScaleOut: boolean }) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3">
        <div
          className={`h-full rounded-full ${isScaleOut ? "bg-sell" : "bg-buy"}`}
          style={{ width: `${Math.round(score * 100)}%` }}
        />
      </div>
      <span className={`tabular-nums ${isScaleOut ? "text-sell" : "text-buy"}`}>
        {Math.round(score * 100)}%
      </span>
    </div>
  );
}
