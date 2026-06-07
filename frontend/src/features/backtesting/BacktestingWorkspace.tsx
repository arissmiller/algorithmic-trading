import { useEffect } from "react";
import RunQueueBuilder from "../../components/RunQueueBuilder";
import RunQueueResults from "../../components/RunQueueResults";
import { useBacktestingWorkspace } from "./useBacktestingWorkspace";

export default function BacktestingWorkspace({
  title,
  benchmarkSymbol,
  defaultSymbol,
  symbolMode,
}: {
  title: string;
  benchmarkSymbol: string;
  defaultSymbol: string;
  symbolMode: "stocks" | "crypto";
}) {
  const { runs, setRuns, runQueueResults, running, handleRunAll, resetWorkspace } =
    useBacktestingWorkspace(benchmarkSymbol);

  useEffect(() => {
    resetWorkspace();
  }, [benchmarkSymbol, defaultSymbol, symbolMode, resetWorkspace]);

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-72 flex-shrink-0 overflow-y-auto border-r border-border">
        <RunQueueBuilder
          runs={runs}
          onRunsChange={setRuns}
          onRunAll={() => void handleRunAll()}
          running={running}
          defaultSymbol={defaultSymbol}
          symbolMode={symbolMode}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border/70 px-4 py-2 text-[12px] font-semibold uppercase tracking-widest text-text-secondary">
          {title}
        </div>
        {running ? (
          <div className="shrink-0 border-b border-border/40 px-4 py-2 text-xs text-text-secondary">
            Running backtests…
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          <RunQueueResults results={runQueueResults} />
        </div>
      </div>
    </div>
  );
}
