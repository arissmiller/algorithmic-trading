import { WalkForwardRunResult } from "../lib/backtest";

interface Props {
  runs: WalkForwardRunResult[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

export default function WalkForwardResultsTable({ runs, selectedIndex, onSelect }: Props) {
  const fmtUsd = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const summary = summarizeAverageImprovement(runs);

  return (
    <div className="overflow-auto border-b border-border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface-1 z-10">
          <tr className="border-b border-border text-text-secondary">
            <th className="px-3 py-2 text-left">Run</th>
            <th className="px-3 py-2 text-left">Start</th>
            <th className="px-3 py-2 text-right">In Smart</th>
            <th className="px-3 py-2 text-right">In Lump</th>
            <th className="px-3 py-2 text-right">In Random Ensemble</th>
            <th className="px-3 py-2 text-right">In Interval</th>
            <th className="px-3 py-2 text-right">In vs Lump</th>
            <th className="px-3 py-2 text-right">In vs Random</th>
            <th className="px-3 py-2 text-right">Out Smart</th>
            <th className="px-3 py-2 text-right">Out Lump</th>
            <th className="px-3 py-2 text-right">Out Random Ensemble</th>
            <th className="px-3 py-2 text-right">Out Interval</th>
            <th className="px-3 py-2 text-right">Out vs Lump</th>
            <th className="px-3 py-2 text-right">Out vs Random</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run, idx) => {
            const inComp = run.result.scaleIn?.comparison;
            const outComp = run.result.scaleOut?.comparison;
            const inPos = (inComp?.smartVsLumpPct ?? 0) >= 0;
            const inPosRandom = (inComp?.smartVsRandomPct ?? 0) >= 0;
            const outPos = (outComp?.smartVsLumpPct ?? 0) >= 0;
            const outPosRandom = (outComp?.smartVsRandomPct ?? 0) >= 0;
            const selected = idx === selectedIndex;
            return (
              <tr
                key={`${run.runNumber}-${run.startDate}`}
                onClick={() => onSelect(idx)}
                className={`cursor-pointer border-b border-border/40 ${
                  selected ? "bg-accent/10" : "hover:bg-surface-2"
                }`}
              >
                <td className="px-3 py-2 text-text-secondary">{run.runNumber}</td>
                <td className="px-3 py-2 font-mono text-text-primary">{run.startDate}</td>
                <td className="px-3 py-2 text-right tabular-nums text-buy">${fmtUsd(inComp?.smartScale ?? 0)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-text-primary">${fmtUsd(inComp?.lumpSum ?? 0)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-text-primary">${fmtUsd(inComp?.randomScale ?? 0)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-text-primary">${fmtUsd(inComp?.intervalScale ?? 0)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${inPos ? "text-buy" : "text-sell"}`}>
                  {(inComp?.smartVsLumpPct ?? 0) >= 0 ? "+" : ""}
                  {fmtPct(inComp?.smartVsLumpPct ?? 0)}%
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${inPosRandom ? "text-buy" : "text-sell"}`}>
                  {(inComp?.smartVsRandomPct ?? 0) >= 0 ? "+" : ""}
                  {fmtPct(inComp?.smartVsRandomPct ?? 0)}%
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-sell">${fmtUsd(outComp?.smartScale ?? 0)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-text-primary">${fmtUsd(outComp?.lumpSum ?? 0)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-text-primary">${fmtUsd(outComp?.randomScale ?? 0)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-text-primary">${fmtUsd(outComp?.intervalScale ?? 0)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${outPos ? "text-buy" : "text-sell"}`}>
                  {(outComp?.smartVsLumpPct ?? 0) >= 0 ? "+" : ""}
                  {fmtPct(outComp?.smartVsLumpPct ?? 0)}%
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${outPosRandom ? "text-buy" : "text-sell"}`}>
                  {(outComp?.smartVsRandomPct ?? 0) >= 0 ? "+" : ""}
                  {fmtPct(outComp?.smartVsRandomPct ?? 0)}%
                </td>
              </tr>
            );
          })}
        </tbody>
        {runs.length > 0 && (
          <tfoot>
            <tr className="border-t border-border bg-surface-2 font-semibold">
              <td colSpan={6} className="px-3 py-2 text-text-secondary">
                Average Improvement Across Start Dates
              </td>
              <td
                className={`px-3 py-2 text-right tabular-nums ${
                  summary.inVsLump >= 0 ? "text-buy" : "text-sell"
                }`}
              >
                {summary.inVsLump >= 0 ? "+" : ""}
                {fmtPct(summary.inVsLump)}%
              </td>
              <td
                className={`px-3 py-2 text-right tabular-nums ${
                  summary.inVsRandom >= 0 ? "text-buy" : "text-sell"
                }`}
              >
                {summary.inVsRandom >= 0 ? "+" : ""}
                {fmtPct(summary.inVsRandom)}%
              </td>
              <td colSpan={4} />
              <td
                className={`px-3 py-2 text-right tabular-nums ${
                  summary.outVsLump >= 0 ? "text-buy" : "text-sell"
                }`}
              >
                {summary.outVsLump >= 0 ? "+" : ""}
                {fmtPct(summary.outVsLump)}%
              </td>
              <td
                className={`px-3 py-2 text-right tabular-nums ${
                  summary.outVsRandom >= 0 ? "text-buy" : "text-sell"
                }`}
              >
                {summary.outVsRandom >= 0 ? "+" : ""}
                {fmtPct(summary.outVsRandom)}%
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function summarizeAverageImprovement(runs: WalkForwardRunResult[]) {
  if (runs.length === 0) {
    return { inVsLump: 0, inVsRandom: 0, outVsLump: 0, outVsRandom: 0 };
  }

  let inVsLump = 0;
  let inVsRandom = 0;
  let outVsLump = 0;
  let outVsRandom = 0;

  for (const run of runs) {
    inVsLump += run.result.scaleIn?.comparison.smartVsLumpPct ?? 0;
    inVsRandom += run.result.scaleIn?.comparison.smartVsRandomPct ?? 0;
    outVsLump += run.result.scaleOut?.comparison.smartVsLumpPct ?? 0;
    outVsRandom += run.result.scaleOut?.comparison.smartVsRandomPct ?? 0;
  }

  const n = runs.length;
  return {
    inVsLump: inVsLump / n,
    inVsRandom: inVsRandom / n,
    outVsLump: outVsLump / n,
    outVsRandom: outVsRandom / n,
  };
}
