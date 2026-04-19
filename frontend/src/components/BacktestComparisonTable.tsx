import { BacktestComparisonRow, makeRegimeKey } from "../lib/comparison";

interface Props {
  rows: BacktestComparisonRow[];
  onClear: () => void;
}

export default function BacktestComparisonTable({ rows, onClear }: Props) {
  if (rows.length === 0) return null;

  const fmtPct = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const firstRegime = makeRegimeKey(rows[0]);

  return (
    <section className="border-b border-border bg-surface-1">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-border">
        <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
          Parameter Comparison
        </p>
        <span className="text-[10px] text-text-secondary">
          {rows.length} rows
        </span>
        <button
          type="button"
          onClick={onClear}
          className="ml-auto rounded border border-border bg-surface-2 px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary"
        >
          Clear
        </button>
      </div>

      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface-1 z-10">
            <tr className="border-b border-border text-text-secondary">
              <th className="px-3 py-2 text-left">Run</th>
              <th className="px-3 py-2 text-left">Symbol</th>
              <th className="px-3 py-2 text-left">Regime</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-right">Cadence</th>
              <th className="px-3 py-2 text-right">Agg%</th>
              <th className="px-3 py-2 text-right">Rnd N</th>
              <th className="px-3 py-2 text-right">In vs Lump</th>
              <th className="px-3 py-2 text-right">In vs Random</th>
              <th className="px-3 py-2 text-right">Out vs Lump</th>
              <th className="px-3 py-2 text-right">Out vs Random</th>
              <th className="px-3 py-2 text-right">Obs</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const regime = makeRegimeKey(row);
              const sameRegime = regime === firstRegime;
              return (
                <tr key={row.id} className="border-b border-border/40 hover:bg-surface-2">
                  <td className="px-3 py-2 text-text-primary">{row.label}</td>
                  <td className="px-3 py-2 font-mono text-text-primary">{row.symbol}</td>
                  <td className={`px-3 py-2 font-mono ${sameRegime ? "text-text-secondary" : "text-sell"}`}>
                    {regime}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                    ${Math.round(row.totalAmount).toLocaleString("en-US")}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-primary">{row.cadenceDays}d</td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                    {Math.round(row.aggressiveness * 100)}%
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                    {row.randomEnsembleSamples}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${row.inVsLumpMean >= 0 ? "text-buy" : "text-sell"}`}>
                    {row.inVsLumpMean >= 0 ? "+" : ""}
                    {fmtPct(row.inVsLumpMean)}%
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${row.inVsRandomMean >= 0 ? "text-buy" : "text-sell"}`}>
                    {row.inVsRandomMean >= 0 ? "+" : ""}
                    {fmtPct(row.inVsRandomMean)}%
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${row.outVsLumpMean >= 0 ? "text-buy" : "text-sell"}`}>
                    {row.outVsLumpMean >= 0 ? "+" : ""}
                    {fmtPct(row.outVsLumpMean)}%
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${row.outVsRandomMean >= 0 ? "text-buy" : "text-sell"}`}>
                    {row.outVsRandomMean >= 0 ? "+" : ""}
                    {fmtPct(row.outVsRandomMean)}%
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-secondary">{row.observations}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
