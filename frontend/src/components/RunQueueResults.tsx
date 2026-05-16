import type { BacktestResult } from "../lib/backtest";
import { Bar, EarningsEvent, SIGNAL_META } from "../lib/signals";
import type { MarketConditionRecommendation } from "../lib/marketConditions";
import { STRATEGY_PRESETS } from "./StrategyBuilder";
import type { StrategyForm } from "./StrategyBuilder";
import type { BacktestRun } from "./RunQueueBuilder";
import BacktestChart from "./BacktestChart";
import TradeTable from "./TradeTable";

export interface RunQueueResult {
  run: BacktestRun;
  form: StrategyForm;
  result: BacktestResult | null;
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

export default function RunQueueResults({
  results,
  onApplyRecommendation,
}: {
  results: RunQueueResult[];
  onApplyRecommendation?: (rec: MarketConditionRecommendation, run: BacktestRun) => void;
}) {
  if (results.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-secondary">
        Add runs to the queue and click Run to see results here.
      </div>
    );
  }

  const successful = results.filter((r) => r.result);

  const inVsLumpVals = successful
    .map((r) => r.result!.scaleIn?.comparison.smartVsLumpPct)
    .filter((v): v is number => v !== undefined);
  const inVsRandVals = successful
    .map((r) => r.result!.scaleIn?.comparison.smartVsRandomPct)
    .filter((v): v is number => v !== undefined);
  const outVsLumpVals = successful
    .map((r) => r.result!.scaleOut?.comparison.smartVsLumpPct)
    .filter((v): v is number => v !== undefined);
  const outVsRandVals = successful
    .map((r) => r.result!.scaleOut?.comparison.smartVsRandomPct)
    .filter((v): v is number => v !== undefined);

  const avgInVsLump = avg(inVsLumpVals);
  const avgInVsRand = avg(inVsRandVals);
  const avgOutVsLump = avg(outVsLumpVals);
  const avgOutVsRand = avg(outVsRandVals);

  // Combined chart
  const chartBars = successful.find((r) => r.bars.length > 0)?.bars ?? [];
  const chartEarningsEvents = successful.find((r) => r.bars.length > 0)?.earningsEvents ?? [];
  const allBuyTrades = successful.flatMap((r) => r.result!.scaleIn?.trades ?? []);
  const allSellTrades = successful.flatMap((r) => r.result!.scaleOut?.trades ?? []);

  return (
    <div className="h-full overflow-y-auto">
      {/* Cumulative stats */}
      <section className="border-b border-border bg-surface-1 px-4 py-3">
        <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold mb-2">
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
        <p className="mt-2 text-[10px] text-text-secondary">
          {successful.length}/{results.length} runs succeeded
        </p>
      </section>

      {/* Combined chart */}
      {chartBars.length > 0 && (allBuyTrades.length > 0 || allSellTrades.length > 0) && (
        <section className="border-b border-border">
          <div className="px-4 py-2 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
            All Trades
          </div>
          <div className="h-64">
            <BacktestChart
              bars={chartBars}
              scaleInTrades={allBuyTrades}
              scaleOutTrades={allSellTrades}
              earningsEvents={chartEarningsEvents}
            />
          </div>
        </section>
      )}

      {/* Per-run sections */}
      {results.map((r, i) => (
        <RunSection key={r.run.id} r={r} index={i} onApplyRecommendation={onApplyRecommendation} />
      ))}
    </div>
  );
}

function RunSection({
  r,
  index,
  onApplyRecommendation,
}: {
  r: RunQueueResult;
  index: number;
  onApplyRecommendation?: (rec: MarketConditionRecommendation, run: BacktestRun) => void;
}) {
  const res = r.result;
  const phase = res?.phase;
  const preset = STRATEGY_PRESETS.find((p) => p.key === r.run.presetKey);
  const recommendation = r.marketRecommendation;

  const inComp = res?.scaleIn?.comparison;
  const outComp = res?.scaleOut?.comparison;

  return (
    <div className="border-b border-border">
      <div className="px-4 py-2 bg-surface-1 border-b border-border/70 flex items-center gap-3">
        <span className="text-[10px] text-text-secondary uppercase tracking-wide">#{index + 1}</span>
        <span className="text-sm font-semibold text-text-primary">{r.run.symbol}</span>
        <span className="text-[10px] text-text-secondary">{preset?.label ?? r.run.presetKey}</span>
        <span className="text-[10px] text-text-secondary tabular-nums ml-auto">
          {r.run.startDate} · {r.run.durationDays}d · {fmtUsd(r.run.totalAmount)}
        </span>
      </div>

      {r.error && (
        <div className="px-4 py-3 text-xs text-sell">{r.error}</div>
      )}

      {recommendation && (
        <div className="px-4 py-2 border-b border-border/50 bg-surface-1/50">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-text-secondary">Market condition</p>
              <p className="mt-0.5 text-xs text-text-primary">
                {formatConditionLabel(recommendation.condition)} · confidence {fmtPct(recommendation.confidence * 100)}
              </p>
              <p className="mt-0.5 text-[11px] text-text-secondary">
                Recommended strategy: <span className="text-text-primary">{recommendation.recommendation.label}</span>
              </p>
              <p className="mt-0.5 text-[10px] text-text-secondary leading-snug">{recommendation.recommendation.note}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {recommendation.recommendation.strategyConfig.signals.map((sw) => {
                  const meta = SIGNAL_META[sw.signal.type];
                  return (
                    <span
                      key={sw.signal.type}
                      className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary"
                    >
                      {meta?.label ?? sw.signal.type} {Math.round(sw.weight * 100)}%
                    </span>
                  );
                })}
                <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary">
                  every {recommendation.recommendation.strategyConfig.cadenceDays}d
                </span>
                <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary">
                  aggr {Math.round(recommendation.recommendation.strategyConfig.aggressiveness * 100)}%
                </span>
              </div>
            </div>
            {onApplyRecommendation && (
              <button
                type="button"
                onClick={() => onApplyRecommendation(recommendation, r.run)}
                className="flex-shrink-0 rounded border border-accent/50 bg-accent/10 px-2.5 py-1 text-[10px] font-semibold text-accent hover:bg-accent/20 transition-colors"
              >
                + Add to Queue
              </button>
            )}
          </div>
        </div>
      )}

      {res && (
        <>
          {/* Comparison metrics */}
          <div className="px-4 py-2 flex gap-6 text-[11px] border-b border-border/50 flex-wrap">
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
        <p className="text-[10px] text-text-secondary">{label}</p>
        <p className="text-sm font-semibold text-text-secondary mt-0.5">—</p>
      </div>
    );
  }
  const positive = value >= 0;
  return (
    <div className="rounded border border-border bg-surface-2 px-3 py-2">
      <p className="text-[10px] text-text-secondary">{label}</p>
      <p className={`text-sm font-semibold tabular-nums mt-0.5 ${positive ? "text-buy" : "text-sell"}`}>
        {fmtPct(value)}
      </p>
      {wr !== null && (
        <p className="text-[10px] text-text-secondary mt-0.5 tabular-nums">
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
  const color = positive
    ? direction === "buy" ? "text-buy" : "text-buy"
    : "text-sell";
  return (
    <span className="text-text-secondary">
      {label}{" "}
      <span className={`font-semibold tabular-nums ${color}`}>{fmtPct(value)}</span>
      {trades !== null && (
        <span className="ml-1.5 text-text-secondary/70">· {trades} {direction === "buy" ? "buys" : "sells"}</span>
      )}
    </span>
  );
}

function MoneyPill({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <span className="text-text-secondary">
      {label}{" "}
      <span className="font-semibold tabular-nums text-text-primary">{fmtUsd(value)}</span>
    </span>
  );
}
