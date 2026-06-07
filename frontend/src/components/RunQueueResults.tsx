import BacktestChart from "./BacktestChart";
import { ComparisonChip, BACKTEST_EMA_DAYS } from "../features/backtesting/results/shared";
import { avg, winRate } from "../features/backtesting/results/formatters";
import { groupResultsBySymbol } from "../features/backtesting/results/transforms";
import { PerpetualRunSection } from "../features/backtesting/results/PerpetualRunSection";
import { CryptoAutotraderRunSection } from "../features/backtesting/results/CryptoAutotraderRunSection";
import { CryptoTrendConfidenceRunSection } from "../features/backtesting/results/CryptoTrendConfidenceRunSection";
import { StandardRunSection } from "../features/backtesting/results/StandardRunSection";
import type { RunQueueResult } from "../features/backtesting/types";

export type { RunQueueResult } from "../features/backtesting/types";

function renderRunSection(runResult: RunQueueResult, index: number) {
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

  return <StandardRunSection key={runResult.run.id} r={runResult} index={index} />;
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
  const runIndexById = new Map(results.map((runResult, index) => [runResult.run.id, index]));

  return (
    <div className="h-full overflow-y-auto">
      {symbolGroups.map((group, groupIndex) => {
        const successful = group.runs.filter((runResult) => runResult.result);
        const scaleInVsLump = successful
          .map((runResult) => runResult.result!.scaleIn?.comparison.smartVsLumpPct)
          .filter((value): value is number => value !== undefined);
        const scaleInVsRandom = successful
          .map((runResult) => runResult.result!.scaleIn?.comparison.smartVsRandomPct)
          .filter((value): value is number => value !== undefined);
        const scaleOutVsLump = successful
          .map((runResult) => runResult.result!.scaleOut?.comparison.smartVsLumpPct)
          .filter((value): value is number => value !== undefined);
        const scaleOutVsRandom = successful
          .map((runResult) => runResult.result!.scaleOut?.comparison.smartVsRandomPct)
          .filter((value): value is number => value !== undefined);
        const chartBars = successful.find((runResult) => runResult.bars.length > 0)?.bars ?? [];
        const chartEarningsEvents =
          successful.find((runResult) => runResult.bars.length > 0)?.earningsEvents ?? [];
        const allBuyTrades = successful.flatMap((runResult) => runResult.result!.scaleIn?.trades ?? []);
        const allSellTrades = successful.flatMap((runResult) => runResult.result!.scaleOut?.trades ?? []);

        return (
          <section key={group.symbol} className={groupIndex > 0 ? "border-t-2 border-border" : undefined}>
            {hasMultipleSymbols ? (
              <div className="border-b border-border bg-surface-1 px-4 py-2">
                <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
                  Symbol: {group.symbol}
                </p>
                <p className="mt-0.5 text-[11px] text-text-secondary">
                  {group.runs.length} run{group.runs.length !== 1 ? "s" : ""} queued
                </p>
              </div>
            ) : null}

            {successful.length > 0 ? (
              <section className="border-b border-border bg-surface-1 px-4 py-3">
                <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold mb-2">
                  Avg Strategy Edge
                </p>
                <div className="grid grid-cols-4 gap-3">
                  <ComparisonChip
                    label="Buy vs Lump Sum"
                    value={avg(scaleInVsLump)}
                    winRate={winRate(scaleInVsLump)}
                    n={scaleInVsLump.length}
                  />
                  <ComparisonChip
                    label="Buy vs Random"
                    value={avg(scaleInVsRandom)}
                    winRate={winRate(scaleInVsRandom)}
                    n={scaleInVsRandom.length}
                  />
                  <ComparisonChip
                    label="Sell vs Lump Sum"
                    value={avg(scaleOutVsLump)}
                    winRate={winRate(scaleOutVsLump)}
                    n={scaleOutVsLump.length}
                  />
                  <ComparisonChip
                    label="Sell vs Random"
                    value={avg(scaleOutVsRandom)}
                    winRate={winRate(scaleOutVsRandom)}
                    n={scaleOutVsRandom.length}
                  />
                </div>
                <p className="mt-2 text-[11px] text-text-secondary">
                  {successful.length}/{group.runs.length} runs succeeded
                </p>
              </section>
            ) : null}

            {chartBars.length > 0 && (allBuyTrades.length > 0 || allSellTrades.length > 0) ? (
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
            ) : null}

            {group.runs.map((runResult, fallbackIndex) =>
              renderRunSection(runResult, runIndexById.get(runResult.run.id) ?? fallbackIndex)
            )}
          </section>
        );
      })}
    </div>
  );
}
