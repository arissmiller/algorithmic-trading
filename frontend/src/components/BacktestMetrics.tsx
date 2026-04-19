import { DirectionalBacktestResult } from "../lib/backtest";

export default function BacktestMetrics({ section }: { section: DirectionalBacktestResult }) {
  const c = section.comparison;
  const isScaleOut = section.direction === "scale_out";
  const avgLabel = isScaleOut ? "Avg Price" : "Avg Cost";
  const tradeNoun = isScaleOut ? "sells" : "buys";
  const amountVerb = isScaleOut ? "sold" : "invested";
  const fmt = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
      <Card
        label={`Smart Scale ${avgLabel}`}
        value={`$${fmt(c.smartScale)}`}
        sub={`$${fmt(section.totalAmount)} ${amountVerb} across ${section.trades.length} ${tradeNoun}`}
      />
      <Card
        label={`Lump Sum ${avgLabel}`}
        value={`$${fmt(c.lumpSum)}`}
        pos={c.smartVsLumpPct >= 0}
        sub={deltaText(c.smartVsLumpPct, fmt, isScaleOut)}
      />
      <Card
        label={`Random Ensemble ${avgLabel}`}
        value={`$${fmt(c.randomScale)}`}
        pos={c.smartVsRandomPct >= 0}
        sub={deltaText(c.smartVsRandomPct, fmt, isScaleOut)}
      />
      <Card
        label={`Interval Scale ${avgLabel}`}
        value={`$${fmt(c.intervalScale)}`}
        pos={c.smartVsIntervalPct >= 0}
        sub={deltaText(c.smartVsIntervalPct, fmt, isScaleOut)}
      />
    </div>
  );
}

function deltaText(
  deltaPct: number,
  fmt: (n: number) => string,
  isScaleOut: boolean
): string {
  const abs = Math.abs(deltaPct);
  if (abs < 0.01) return "Smart scale and this baseline are nearly identical";
  if (deltaPct > 0) {
    return isScaleOut
      ? `Smart scale higher by ${fmt(abs)}%`
      : `Smart scale lower by ${fmt(abs)}%`;
  }
  return isScaleOut
    ? `Smart scale lower by ${fmt(abs)}%`
    : `Smart scale higher by ${fmt(abs)}%`;
}

function Card({
  label, value, sub, pos,
}: {
  label: string; value: string; sub?: string; pos?: boolean;
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
