import TradeTable from "../../../components/TradeTable";
import type { RunQueueResult } from "../types";
import { fmtPct, formatConditionLabel } from "./formatters";
import { ComparisonPill, MoneyPill, RunSectionHeader } from "./shared";

export function StandardRunSection({ r, index }: { r: RunQueueResult; index: number }) {
  const result = r.result;
  const phase = result?.phase;
  const recommendation = r.marketRecommendation;
  const scaleInComparison = result?.scaleIn?.comparison;
  const scaleOutComparison = result?.scaleOut?.comparison;

  return (
    <div className="border-b border-border">
      <RunSectionHeader r={r} index={index} />
      {r.error ? <div className="px-4 py-3 text-xs text-sell">{r.error}</div> : null}

      {recommendation ? (
        <div className="px-4 py-2 border-b border-border/50 bg-surface-1/50">
          <p className="text-[11px] uppercase tracking-widest text-text-secondary">Market condition</p>
          <p className="mt-0.5 text-xs text-text-primary">
            {formatConditionLabel(recommendation.condition)} · confidence {fmtPct(recommendation.confidence * 100)}
          </p>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            Recommended strategy: <span className="text-text-primary">{recommendation.recommendation.label}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-text-secondary">{recommendation.recommendation.note}</p>
        </div>
      ) : null}

      {result ? (
        <>
          <div className="px-4 py-2 flex gap-6 text-[12px] border-b border-border/50 flex-wrap">
            {scaleInComparison && phase !== "scale_out" ? (
              <>
                <ComparisonPill
                  label="Buy vs Lump"
                  value={scaleInComparison.smartVsLumpPct}
                  trades={result.scaleIn!.trades.length}
                  direction="buy"
                />
                <ComparisonPill
                  label="Buy vs Random"
                  value={scaleInComparison.smartVsRandomPct}
                  trades={null}
                  direction="buy"
                />
              </>
            ) : null}
            {scaleOutComparison && phase !== "scale_in" ? (
              <>
                <ComparisonPill
                  label="Sell vs Lump"
                  value={scaleOutComparison.smartVsLumpPct}
                  trades={result.scaleOut!.trades.length}
                  direction="sell"
                />
                <ComparisonPill
                  label="Sell vs Random"
                  value={scaleOutComparison.smartVsRandomPct}
                  trades={null}
                  direction="sell"
                />
              </>
            ) : null}
            <MoneyPill label="Total Cost" value={result.performance.investedAmount} />
            <MoneyPill label="Proceeds" value={result.performance.proceeds} />
          </div>

          {result.scaleIn && phase !== "scale_out" ? (
            <div className="max-h-56 overflow-auto">
              <TradeTable trades={result.scaleIn.trades} direction="scale_in" compact />
            </div>
          ) : null}

          {result.scaleOut && phase !== "scale_in" ? (
            <div className="max-h-56 overflow-auto">
              <TradeTable trades={result.scaleOut.trades} direction="scale_out" compact />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
