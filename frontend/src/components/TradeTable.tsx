import { BacktestTrade } from "../lib/backtest";
import { Direction } from "../lib/dca";

export default function TradeTable({
  trades,
  direction,
  compact = false,
}: {
  trades: BacktestTrade[];
  direction: Direction;
  compact?: boolean;
}) {
  const isScaleOut = direction === "scale_out";
  const showTaxColumns = isScaleOut && trades.some((t) => t.tax !== undefined);
  const totalAmount = trades.reduce((s, t) => s + t.amountUsd, 0);
  const totalShares = trades.reduce((s, t) => s + t.shares, 0);
  const rowPadding = compact ? "px-2.5 py-1.5" : "px-4 py-2";
  const scoreColWidth = compact ? "w-24" : "w-28";
  const indexColWidth = compact ? "w-5" : "w-6";

  return (
    <div className="overflow-auto h-full">
      <table className={`w-full ${compact ? "text-[12px]" : "text-xs"}`}>
        <thead className="sticky top-0 bg-surface-1">
          <tr className="border-b border-border text-text-secondary">
            <th className={`${rowPadding} text-left ${indexColWidth}`}>#</th>
            <th className={`${rowPadding} text-left`}>Date</th>
            <th className={`${rowPadding} text-right`}>{isScaleOut ? "Proceeds" : "Amount"}</th>
            <th className={`${rowPadding} text-right`}>Price</th>
            <th className={`${rowPadding} text-right`}>Shares</th>
            <th className={`${rowPadding} text-right`}>Position</th>
            {showTaxColumns && (
              <>
                <th className={`${rowPadding} text-right`}>Realized P/L</th>
                <th className={`${rowPadding} text-right`}>Tax Adj</th>
                <th className={`${rowPadding} text-right`}>Deferred</th>
              </>
            )}
            <th className={`${rowPadding} text-right ${scoreColWidth}`}>Score</th>
            <th className={`${rowPadding} text-left`}>Signals</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={t.date + i} className="border-b border-border/40 hover:bg-surface-2">
              <td className={`${rowPadding} text-text-secondary`}>{i + 1}</td>
              <td className={`${rowPadding} font-mono text-text-primary`}>{t.date}</td>
              <td className={`${rowPadding} text-right tabular-nums text-text-primary`}>
                ${t.amountUsd.toFixed(2)}
              </td>
              <td className={`${rowPadding} text-right tabular-nums text-text-primary`}>
                ${t.price.toFixed(2)}
              </td>
              <td className={`${rowPadding} text-right tabular-nums text-text-primary`}>
                {t.shares.toLocaleString()}
              </td>
              <td className={`${rowPadding} text-right tabular-nums ${isScaleOut ? "text-sell" : "text-buy"}`}>
                {t.sharesHeld.toLocaleString()}
              </td>
              {showTaxColumns && (
                <>
                  <td
                    className={`${rowPadding} text-right tabular-nums ${
                      (t.tax?.realizedPnL ?? 0) >= 0 ? "text-buy" : "text-sell"
                    }`}
                  >
                    {t.tax ? `$${t.tax.realizedPnL.toFixed(2)}` : "—"}
                  </td>
                  <td
                    className={`${rowPadding} text-right tabular-nums ${
                      (t.tax?.washAdjustedPnL ?? 0) >= 0 ? "text-buy" : "text-sell"
                    }`}
                  >
                    {t.tax ? `$${t.tax.washAdjustedPnL.toFixed(2)}` : "—"}
                  </td>
                  <td className={`${rowPadding} text-right tabular-nums text-sell`}>
                    {t.tax ? `$${t.tax.disallowedLoss.toFixed(2)}` : "—"}
                  </td>
                </>
              )}
              <td className={`${rowPadding} text-right`}>
                <ScoreBar score={t.signalScore} isScaleOut={isScaleOut} compact={compact} />
              </td>
              <td className={`${rowPadding} text-text-secondary max-w-xs truncate`}>
                {t.rationale}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-semibold text-text-primary">
            <td colSpan={2} className={`${rowPadding} text-text-secondary`}>
              {trades.length} {isScaleOut ? "sells" : "buys"}
            </td>
            <td className={`${rowPadding} text-right tabular-nums`}>
              ${totalAmount.toFixed(2)}
            </td>
            <td className={`${rowPadding} text-right text-text-secondary`}>avg</td>
            <td className={`${rowPadding} text-right tabular-nums`}>
              {totalShares.toLocaleString()}
            </td>
            <td className={`${rowPadding} text-right tabular-nums text-text-secondary`}>
              {trades.length > 0 ? trades[trades.length - 1].sharesHeld.toLocaleString() : "—"}
            </td>
            <td colSpan={showTaxColumns ? 4 : 1} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ScoreBar({
  score,
  isScaleOut,
  compact = false,
}: {
  score: number;
  isScaleOut: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`flex items-center justify-end ${compact ? "gap-1" : "gap-1.5"}`}>
      <div
        className={`${compact ? "h-1 w-12" : "h-1.5 w-16"} overflow-hidden rounded-full bg-surface-3`}
      >
        <div
          className={`h-full rounded-full ${isScaleOut ? "bg-sell" : "bg-buy"}`}
          style={{ width: `${Math.round(score * 100)}%` }}
        />
      </div>
      <span className={`tabular-nums ${compact ? "text-[11px]" : ""} ${isScaleOut ? "text-sell" : "text-buy"}`}>
        {Math.round(score * 100)}%
      </span>
    </div>
  );
}
