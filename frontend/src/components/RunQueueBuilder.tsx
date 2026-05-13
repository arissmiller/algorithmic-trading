import { useState } from "react";
import { STRATEGY_PRESETS, StrategyPresetKey } from "./StrategyBuilder";

export interface BacktestRun {
  id: string;
  presetKey: StrategyPresetKey;
  symbol: string;
  startDate: string;
  durationDays: number;
  cadenceDays: number;
  totalAmount: number;
}

const DURATION_OPTIONS = [
  { label: "2 weeks", durationDays: 14, cadenceDays: 1 },
  { label: "1 month", durationDays: 30, cadenceDays: 2 },
  { label: "2 months", durationDays: 60, cadenceDays: 5 },
  { label: "3 months", durationDays: 90, cadenceDays: 7 },
  { label: "6 months", durationDays: 180, cadenceDays: 14 },
  { label: "9 months", durationDays: 270, cadenceDays: 21 },
  { label: "12 months", durationDays: 365, cadenceDays: 30 },
] as const;

interface Props {
  runs: BacktestRun[];
  onRunsChange: (runs: BacktestRun[]) => void;
  onRunAll: () => void;
  running: boolean;
}

const input =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";

function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().split("T")[0];
}

function defaultDraft(): Omit<BacktestRun, "id"> {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const defaultDuration = DURATION_OPTIONS[3];
  return {
    presetKey: "scale_in",
    symbol: "AAPL",
    startDate: start.toISOString().split("T")[0],
    durationDays: defaultDuration.durationDays,
    cadenceDays: defaultDuration.cadenceDays,
    totalAmount: 10000,
  };
}

export default function RunQueueBuilder({ runs, onRunsChange, onRunAll, running }: Props) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Omit<BacktestRun, "id">>(defaultDraft);

  const patchDraft = <K extends keyof Omit<BacktestRun, "id">>(
    k: K,
    v: Omit<BacktestRun, "id">[K]
  ) => setDraft((d) => ({ ...d, [k]: v }));

  function addRun() {
    if (!draft.symbol || !draft.startDate || draft.durationDays < 1) return;
    onRunsChange([...runs, { ...draft, id: crypto.randomUUID() }]);
    setAdding(false);
    setDraft(defaultDraft());
  }

  function removeRun(id: string) {
    onRunsChange(runs.filter((r) => r.id !== id));
  }

  const selectedPreset =
    STRATEGY_PRESETS.find((p) => p.key === draft.presetKey) ?? STRATEGY_PRESETS[0];

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-y-auto">
      <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
        Run Queue
      </p>

      {runs.length === 0 && !adding && (
        <p className="text-[11px] text-text-secondary leading-relaxed">
          No runs added yet. Each run has a preset, symbol, start date, and duration.
        </p>
      )}

      {runs.map((run, index) => {
        const preset = STRATEGY_PRESETS.find((p) => p.key === run.presetKey);
        const endDate = addDaysIso(run.startDate, run.durationDays);
        return (
          <div key={run.id} className="rounded border border-border bg-surface-2 px-3 py-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                Run {index + 1}
              </span>
              <button
                type="button"
                onClick={() => removeRun(run.id)}
                disabled={running}
                className="text-[10px] text-text-secondary hover:text-sell disabled:opacity-40"
              >
                ✕
              </button>
            </div>
            <p className="text-sm font-semibold text-text-primary">{run.symbol}</p>
            <p className="text-[10px] text-text-secondary">{preset?.label ?? run.presetKey}</p>
            <p className="text-[10px] text-text-secondary tabular-nums mt-0.5">
              {run.startDate} → {endDate} · {DURATION_OPTIONS.find((o) => o.durationDays === run.durationDays)?.label ?? `${run.durationDays}d`} · every {run.cadenceDays}d · ${run.totalAmount.toLocaleString()}
            </p>
          </div>
        );
      })}

      {adding ? (
        <div className="rounded border border-accent/40 bg-accent/5 px-3 py-3 flex flex-col gap-2.5">
          <p className="text-[11px] uppercase tracking-widest text-accent font-semibold">New Run</p>

          <div>
            <label className="mb-1 block text-[10px] text-text-secondary">Preset</label>
            <select
              className={input}
              value={draft.presetKey}
              onChange={(e) => patchDraft("presetKey", e.target.value as StrategyPresetKey)}
            >
              {STRATEGY_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="mt-0.5 text-[10px] text-text-secondary">{selectedPreset.suitableFor}</p>
          </div>

          <div>
            <label className="mb-1 block text-[10px] text-text-secondary">Symbol</label>
            <input
              className={input}
              value={draft.symbol}
              onChange={(e) => patchDraft("symbol", e.target.value.toUpperCase())}
              placeholder="AAPL"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[10px] text-text-secondary">Start Date</label>
              <input
                type="date"
                className={input}
                value={draft.startDate}
                onChange={(e) => patchDraft("startDate", e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] text-text-secondary">Duration</label>
              <select
                className={input}
                value={draft.durationDays}
                onChange={(e) => {
                  const opt = DURATION_OPTIONS.find((o) => o.durationDays === +e.target.value);
                  if (!opt) return;
                  setDraft((d) => ({ ...d, durationDays: opt.durationDays, cadenceDays: opt.cadenceDays }));
                }}
              >
                {DURATION_OPTIONS.map((o) => (
                  <option key={o.durationDays} value={o.durationDays}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="mt-0.5 text-[10px] text-text-secondary">
                every {draft.cadenceDays} days
              </p>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[10px] text-text-secondary">Amount ($)</label>
            <input
              type="number"
              min={100}
              className={input}
              value={draft.totalAmount}
              onChange={(e) => patchDraft("totalAmount", +e.target.value)}
            />
          </div>

          <div className="flex gap-2 mt-1">
            <button
              type="button"
              onClick={addRun}
              disabled={!draft.symbol || !draft.startDate || draft.durationDays < 1}
              className="flex-1 rounded bg-accent py-1.5 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
            >
              Add to Queue
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setDraft(defaultDraft());
              }}
              className="rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={running}
          className="rounded border border-dashed border-border/60 py-2 text-xs text-text-secondary hover:border-accent/50 hover:text-accent disabled:opacity-50"
        >
          + Add Run
        </button>
      )}

      <div className="mt-auto pt-2">
        <button
          type="button"
          onClick={onRunAll}
          disabled={running || runs.length === 0}
          className="w-full rounded bg-accent py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {running
            ? "Running…"
            : runs.length === 0
            ? "Add Runs to Begin"
            : `Run ${runs.length} Backtest${runs.length !== 1 ? "s" : ""}`}
        </button>
      </div>
    </div>
  );
}
