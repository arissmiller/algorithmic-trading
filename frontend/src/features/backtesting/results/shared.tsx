import { STRATEGY_PRESETS } from "../../../components/StrategyBuilder";
import type { RunQueueResult } from "../types";
import { fmtPct, fmtUsd } from "./formatters";

export const BACKTEST_EMA_DAYS = [7];

export function RunSectionHeader({ r, index }: { r: RunQueueResult; index: number }) {
  const preset = STRATEGY_PRESETS.find((candidate) => candidate.key === r.run.presetKey);

  return (
    <div className="px-4 py-2 bg-surface-1 border-b border-border/70 flex items-center gap-3">
      <span className="text-[11px] text-text-secondary uppercase tracking-wide">#{index + 1}</span>
      <span className="text-sm font-semibold text-text-primary">{r.run.symbol}</span>
      <span className="text-[11px] text-text-secondary">{preset?.label ?? r.run.presetKey}</span>
      <span className="text-[11px] text-text-secondary tabular-nums ml-auto">
        {r.run.startDate} · {r.run.durationDays}d · {fmtUsd(r.run.totalAmount)}
      </span>
    </div>
  );
}

export function StatCell({
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
      {sub ? <p className="text-[11px] text-text-secondary tabular-nums mt-0.5">{sub}</p> : null}
    </div>
  );
}

export function ComparisonChip({
  label,
  value,
  winRate,
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

  return (
    <div className="rounded border border-border bg-surface-2 px-3 py-2">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-sm font-semibold tabular-nums mt-0.5 ${value >= 0 ? "text-buy" : "text-sell"}`}>
        {fmtPct(value)}
      </p>
      {winRate !== null ? (
        <p className="text-[11px] text-text-secondary mt-0.5 tabular-nums">
          {winRate.toFixed(0)}% win · {n} run{n !== 1 ? "s" : ""}
        </p>
      ) : null}
    </div>
  );
}

export function ComparisonPill({
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
  return (
    <span className="text-text-secondary">
      {label}{" "}
      <span className={`font-semibold tabular-nums ${value >= 0 ? "text-buy" : "text-sell"}`}>
        {fmtPct(value)}
      </span>
      {trades !== null ? (
        <span className="ml-1.5 text-text-secondary/70">
          · {trades} {direction === "buy" ? "buys" : "sells"}
        </span>
      ) : null}
    </span>
  );
}

export function MoneyPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-text-secondary">
      {label} <span className="font-semibold tabular-nums text-text-primary">{fmtUsd(value)}</span>
    </span>
  );
}
