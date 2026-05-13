import { BacktestResult } from "../lib/backtest";

export default function PerformanceSummary({
  result,
  compact = false,
}: {
  result: BacktestResult;
  compact?: boolean;
}) {
  const perf = result.performance;
  const bench = result.benchmark;
  const returns = perf.returnComparison;
  const tax = perf.tax;
  const phase = result.phase;

  const alphaUsd = bench ? perf.profitUsd - bench.profitUsd : null;
  const alphaPct = bench ? perf.profitPct - bench.profitPct : null;

  const benchmarkLabel = bench?.symbol === "^GSPC" ? "S&P 500" : bench?.symbol;

  const cycleLabel =
    phase === "scale_in"
      ? `Buying: ${perf.startDate} → ${perf.endDate}`
      : phase === "scale_out"
        ? `Selling: ${perf.scaleOutStartDate} → ${perf.endDate}`
        : `Cycle: ${perf.startDate} → ${perf.scaleOutStartDate} (scale-out starts) → ${perf.endDate}`;

  return (
    <section className="border-b border-border bg-surface-1">
      <div className="px-4 py-2 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
        Performance Summary
      </div>

      <div
        className={`grid grid-cols-1 gap-2 ${
          compact ? "p-3 md:grid-cols-3 lg:grid-cols-4" : "p-4 md:grid-cols-2 lg:grid-cols-3"
        }`}
      >
        {phase !== "scale_out" && (
          <Card label="Avg Cost" value={`$${fmt2(perf.avgCost)}`} compact={compact} />
        )}
        {phase !== "scale_in" && (
          <Card
            label="Avg Sale Price"
            value={`$${fmt2(perf.avgSalePrice)}`}
            pos={phase === "scale_out" ? undefined : perf.avgSalePrice >= perf.avgCost}
            compact={compact}
          />
        )}
        {phase === "scale_in" && (
          <Card
            label="Amount Invested"
            value={`$${fmt2(perf.investedAmount)}`}
            sub={`${perf.sharesBought.toFixed(4)} shares accumulated`}
            compact={compact}
          />
        )}
        {phase === "scale_out" && (
          <Card
            label="Proceeds"
            value={`$${fmt2(perf.proceeds)}`}
            compact={compact}
          />
        )}
        {!phase && (
          <>
            <Card
              label="Strategy Profit ($)"
              value={`$${fmt2(perf.profitUsd)}`}
              pos={perf.profitUsd >= 0}
              sub={`Proceeds $${fmt2(perf.proceeds)} on $${fmt2(perf.investedAmount)} invested`}
              compact={compact}
            />
            <Card
              label="Strategy Return (%)"
              value={`${signedPct(perf.profitPct)}`}
              pos={perf.profitPct >= 0}
              compact={compact}
            />
            <Card
              label="Gross Realized P/L ($)"
              value={`$${fmt2(tax.grossRealizedPnL)}`}
              pos={tax.grossRealizedPnL >= 0}
              sub={formatAccountType(tax.accountType, tax.washRuleEligibleAsset)}
              compact={compact}
            />
            <Card
              label="Wash Loss Deferred ($)"
              value={`$${fmt2(tax.disallowedLossDeferred)}`}
              pos={tax.disallowedLossDeferred <= 0}
              sub={
                tax.washRuleApplied
                  ? `${tax.washSaleWindowDays}-day window`
                  : tax.washRuleEligibleAsset
                    ? "Wash-sale rule not applied in tax-advantaged mode"
                    : "Wash-sale rule not applied for crypto spot assets"
              }
              compact={compact}
            />
            <Card
              label="Wash-Adjusted Realized ($)"
              value={`$${fmt2(tax.washAdjustedRealizedPnL)}`}
              pos={tax.washAdjustedRealizedPnL >= 0}
              sub={
                tax.washRuleApplied
                  ? `${tax.washSaleEventCount} wash-sale event${tax.washSaleEventCount === 1 ? "" : "s"}`
                  : "No wash-sale adjustments applied"
              }
              compact={compact}
            />
            <Card
              label="Lump Sum Return (%)"
              value={signedPct(returns.lumpSum.profitPct)}
              pos={returns.lumpSum.profitPct >= 0}
              sub={`Strategy ${signedPct(returns.strategyVsLumpPct)} vs lump`}
              compact={compact}
            />
            <Card
              label="Random Return (%)"
              value={signedPct(returns.randomEnsemble.profitPct)}
              pos={returns.randomEnsemble.profitPct >= 0}
              sub={`Strategy ${signedPct(returns.strategyVsRandomPct)} vs random`}
              compact={compact}
            />
          </>
        )}
        <Card
          label="Smart vs Lump Sum (%)"
          value={signedPct(returns.strategyVsLumpPct)}
          pos={returns.strategyVsLumpPct >= 0}
          sub={phase === "scale_in" ? "buy price improvement" : phase === "scale_out" ? "sell price improvement" : undefined}
          compact={compact}
        />
        <Card
          label="Smart vs Random (%)"
          value={signedPct(returns.strategyVsRandomPct)}
          pos={returns.strategyVsRandomPct >= 0}
          compact={compact}
        />
        <Card
          label={bench ? `${benchmarkLabel} Return (%)` : "S&P 500 Return (%)"}
          value={bench ? signedPct(bench.profitPct) : "n/a"}
          pos={bench ? bench.profitPct >= 0 : undefined}
          sub={bench ? `$${fmt2(bench.profitUsd)} profit` : "Benchmark unavailable for this run"}
          compact={compact}
        />
        {!phase && (
          <Card
            label={bench ? `Alpha vs ${benchmarkLabel}` : "Alpha vs S&P 500"}
            value={bench && alphaPct !== null ? signedPct(alphaPct) : "n/a"}
            pos={bench && alphaPct !== null ? alphaPct >= 0 : undefined}
            sub={bench && alphaUsd !== null ? `$${fmt2(alphaUsd)} relative` : "Run benchmark data to compare"}
            compact={compact}
          />
        )}
      </div>

      <div className={`px-4 ${compact ? "pb-2 text-[10px]" : "pb-3 text-[11px]"} text-text-secondary`}>
        {cycleLabel}
      </div>

      <div className={`border-t border-border px-4 ${compact ? "py-2" : "py-3"}`}>
        <div className="mb-1.5 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
          Wash Sale Events
        </div>
        {tax.washSaleEvents.length === 0 ? (
          <p className="text-[10px] text-text-secondary">
            {tax.washRuleApplied
              ? "No disallowed losses detected for this cycle."
              : tax.washRuleEligibleAsset
                ? "Wash-sale checks are disabled in tax-advantaged mode."
                : "Wash-sale checks are not applied for crypto spot assets in this model."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead className="text-text-secondary">
                <tr>
                  <th className="py-1 text-left font-medium">Sale Date</th>
                  <th className="py-1 text-right font-medium">Loss/Share</th>
                  <th className="py-1 text-right font-medium">Loss Shares</th>
                  <th className="py-1 text-right font-medium">Replacement Shares</th>
                  <th className="py-1 text-right font-medium">Disallowed Loss</th>
                </tr>
              </thead>
              <tbody>
                {tax.washSaleEvents.map((event, idx) => (
                  <tr key={`${event.saleDate}-${idx}`} className="border-t border-border/50">
                    <td className="py-1 text-text-primary font-mono">{event.saleDate}</td>
                    <td className="py-1 text-right tabular-nums text-text-primary">
                      ${fmt2(event.lossPerShare)}
                    </td>
                    <td className="py-1 text-right tabular-nums text-text-primary">
                      {fmt4(event.lossShares)}
                    </td>
                    <td className="py-1 text-right tabular-nums text-text-primary">
                      {fmt4(event.replacementShares)}
                    </td>
                    <td className="py-1 text-right tabular-nums text-sell">
                      ${fmt2(event.disallowedLoss)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Card({
  label,
  value,
  sub,
  pos,
  compact = false,
}: {
  label: string;
  value: string;
  sub?: string;
  pos?: boolean;
  compact?: boolean;
}) {
  const color = pos === undefined ? "text-text-primary" : pos ? "text-buy" : "text-sell";

  return (
    <div className={`rounded-lg border border-border bg-surface-2 ${compact ? "p-2.5" : "p-3"}`}>
      <p className="text-[11px] text-text-secondary mb-1">{label}</p>
      <p className={`${compact ? "text-sm" : "text-base"} font-semibold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-text-secondary mt-0.5">{sub}</p>}
    </div>
  );
}

function fmt2(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmt4(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

function signedPct(n: number): string {
  const prefix = n >= 0 ? "+" : "";
  return `${prefix}${fmt2(n)}%`;
}

function formatAccountType(
  accountType: "taxable" | "tax_advantaged",
  washRuleEligibleAsset: boolean
): string {
  if (accountType === "tax_advantaged") return "Tax-advantaged account mode";
  if (!washRuleEligibleAsset) return "Taxable crypto mode (no wash-sale deferral)";
  return "Taxable account mode";
}
