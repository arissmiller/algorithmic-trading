import BacktestChart from "../../../components/BacktestChart";
import type { RunQueueResult } from "../types";
import { fmtPct } from "./formatters";
import { BACKTEST_EMA_DAYS, RunSectionHeader } from "./shared";
import { formatTrendDirection, trendDirectionClass } from "./trendUtils";
import { toTrendRegionMarkers } from "./transforms";

export function CryptoTrendConfidenceRunSection({ r, index }: { r: RunQueueResult; index: number }) {
  const result = r.trendConfidenceResult ?? null;
  const markers = result ? toTrendRegionMarkers(result.regions) : [];
  const currentTrend = result?.currentTrend ?? null;

  return (
    <div className="border-b border-border">
      <RunSectionHeader r={r} index={index} />
      {r.error ? <div className="px-4 py-3 text-xs text-sell">{r.error}</div> : null}
      {result ? (
        <>
          <div className="px-4 py-2 flex gap-6 text-[12px] border-b border-border/50 flex-wrap">
            <span className="text-text-secondary">
              EMA pair <span className="font-semibold text-text-primary">{result.fastEmaPeriod}/{result.slowEmaPeriod}</span>
            </span>
            <span className="text-text-secondary">
              Realized regions <span className="font-semibold text-text-primary">{result.realizedRegionCount}</span>
            </span>
            <span className="text-text-secondary">
              Avg realized confidence{" "}
              <span className="font-semibold text-text-primary">{(result.averageRealizedConfidence * 100).toFixed(0)}%</span>
            </span>
            {currentTrend ? (
              <span className="text-text-secondary">
                Current trend guess{" "}
                <span className={`font-semibold ${trendDirectionClass(currentTrend.direction)}`}>
                  {formatTrendDirection(currentTrend.direction)}
                </span>{" "}
                <span className="font-semibold text-text-primary">{(currentTrend.confidence * 100).toFixed(0)}%</span>
              </span>
            ) : null}
          </div>

          {r.bars.length > 0 && markers.length > 0 ? (
            <div className="h-64 border-b border-border/50">
              <BacktestChart
                bars={r.bars}
                scaleInTrades={[]}
                scaleOutTrades={[]}
                earningsEvents={r.earningsEvents}
                eventMarkers={markers}
                movingAverageDays={BACKTEST_EMA_DAYS}
              />
            </div>
          ) : null}

          <div className="max-h-72 overflow-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-surface-1 text-[11px] uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Region</th>
                  <th className="px-3 py-1.5 text-left font-medium">Status</th>
                  <th className="px-3 py-1.5 text-left font-medium">Trend</th>
                  <th className="px-3 py-1.5 text-right font-medium">Confidence</th>
                  <th className="px-3 py-1.5 text-right font-medium">Bars</th>
                  <th className="px-3 py-1.5 text-right font-medium">Return</th>
                  <th className="px-3 py-1.5 text-left font-medium">Start</th>
                  <th className="px-3 py-1.5 text-left font-medium">End</th>
                </tr>
              </thead>
              <tbody>
                {result.regions.map((region) => (
                  <tr key={region.id} className="border-t border-border/40 hover:bg-surface-2/40">
                    <td className="px-3 py-1 font-semibold text-text-primary">{region.id}</td>
                    <td className="px-3 py-1 text-text-secondary">{region.status === "forming" ? "forming (guess)" : "realized"}</td>
                    <td className={`px-3 py-1 font-semibold ${trendDirectionClass(region.direction)}`}>
                      {formatTrendDirection(region.direction)}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums text-text-primary">{(region.confidence * 100).toFixed(0)}%</td>
                    <td className="px-3 py-1 text-right tabular-nums text-text-secondary">{region.barCount.toLocaleString()}</td>
                    <td className="px-3 py-1 text-right tabular-nums text-text-secondary">{fmtPct(region.returnPct)}</td>
                    <td className="px-3 py-1 tabular-nums text-text-secondary">{region.startDate.slice(0, 10)}</td>
                    <td className="px-3 py-1 tabular-nums text-text-secondary">{region.endDate.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
