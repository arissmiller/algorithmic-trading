import { BacktestResult } from "../lib/backtest";

export default function PerformanceSummary({ result }: { result: BacktestResult }) {
  const perf = result.performance;
  const bench = result.benchmark;
  const returns = perf.returnComparison;

  const alphaUsd = bench ? perf.profitUsd - bench.profitUsd : null;
  const alphaPct = bench ? perf.profitPct - bench.profitPct : null;

  const benchmarkLabel = bench?.symbol === "^GSPC" ? "S&P 500" : bench?.symbol;

  return (
    <section className="border-b border-border bg-surface-1">
      <div className="px-4 py-2 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
        Performance Summary
      </div>

      <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 lg:grid-cols-3">
        <Card label="Avg Cost" value={`$${fmt2(perf.avgCost)}`} />
        <Card
          label="Avg Sale Price"
          value={`$${fmt2(perf.avgSalePrice)}`}
          pos={perf.avgSalePrice >= perf.avgCost}
        />
        <Card
          label="Strategy Profit ($)"
          value={`$${fmt2(perf.profitUsd)}`}
          pos={perf.profitUsd >= 0}
          sub={`Proceeds $${fmt2(perf.proceeds)} on $${fmt2(perf.investedAmount)} invested`}
        />
        <Card label="Strategy Return (%)" value={`${signedPct(perf.profitPct)}`} pos={perf.profitPct >= 0} />
        <Card
          label="Lump Sum Return (%)"
          value={signedPct(returns.lumpSum.profitPct)}
          pos={returns.lumpSum.profitPct >= 0}
          sub={`Strategy ${signedPct(returns.strategyVsLumpPct)} vs lump`}
        />
        <Card
          label="Random Return (%)"
          value={signedPct(returns.randomEnsemble.profitPct)}
          pos={returns.randomEnsemble.profitPct >= 0}
          sub={`Strategy ${signedPct(returns.strategyVsRandomPct)} vs random`}
        />
        <Card
          label={bench ? `${benchmarkLabel} Return (%)` : "S&P 500 Return (%)"}
          value={bench ? signedPct(bench.profitPct) : "n/a"}
          pos={bench ? bench.profitPct >= 0 : undefined}
          sub={bench ? `$${fmt2(bench.profitUsd)} profit` : "Benchmark unavailable for this run"}
        />
        <Card
          label={bench ? `Alpha vs ${benchmarkLabel}` : "Alpha vs S&P 500"}
          value={bench && alphaPct !== null ? signedPct(alphaPct) : "n/a"}
          pos={bench && alphaPct !== null ? alphaPct >= 0 : undefined}
          sub={bench && alphaUsd !== null ? `$${fmt2(alphaUsd)} relative` : "Run benchmark data to compare"}
        />
      </div>

      <div className="px-4 pb-3 text-[11px] text-text-secondary">
        {`Cycle: ${perf.startDate} → ${perf.scaleOutStartDate} (scale-out starts) → ${perf.endDate}`}
      </div>
    </section>
  );
}

function Card({
  label,
  value,
  sub,
  pos,
}: {
  label: string;
  value: string;
  sub?: string;
  pos?: boolean;
}) {
  const color = pos === undefined ? "text-text-primary" : pos ? "text-buy" : "text-sell";

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <p className="text-[11px] text-text-secondary mb-1">{label}</p>
      <p className={`text-base font-semibold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-text-secondary mt-0.5">{sub}</p>}
    </div>
  );
}

function fmt2(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signedPct(n: number): string {
  const prefix = n >= 0 ? "+" : "";
  return `${prefix}${fmt2(n)}%`;
}
