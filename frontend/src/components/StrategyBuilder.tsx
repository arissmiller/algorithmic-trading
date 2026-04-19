import { useState } from "react";
import { SIGNAL_META, SignalType, SignalWeight } from "../lib/signals";

export interface StrategyForm {
  symbol: string;
  totalAmount: number;
  cadenceDays: number;
  startDate: string;
  scaleInWindowDays: number;
  scaleOutStartDate: string;
  scaleOutWindowDays: number;
  randomEnsembleSamples: number;
  aggressiveness: number;
  signals: SignalWeight[];
}

interface Props {
  onRun: (form: StrategyForm) => void;
  running: boolean;
}

type SignalKey = keyof typeof SIGNAL_META;

function makeSignal(type: SignalKey): SignalType {
  if (type === "rsi") return { type: "rsi", period: 14 };
  if (type === "bollinger_band") return { type: "bollinger_band", period: 20, std_dev: 2 };
  if (type === "volume") return { type: "volume", period: 20 };
  if (type === "momentum") return { type: "momentum", period: 10 };
  return { type: "price_vs_sma", period: 20 };
}

function defaultForm(): StrategyForm {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const startDate = start.toISOString().split("T")[0];
  const scaleInWindowDays = 30;

  return {
    symbol: "AAPL",
    totalAmount: 10000,
    cadenceDays: 3,
    startDate,
    scaleInWindowDays,
    scaleOutStartDate: addDaysIso(startDate, scaleInWindowDays),
    scaleOutWindowDays: 45,
    randomEnsembleSamples: 400,
    aggressiveness: 0.6,
    signals: [
      { signal: { type: "price_vs_sma", period: 20 }, weight: 0.4 },
      { signal: { type: "rsi", period: 14 }, weight: 0.4 },
      { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.2 },
    ],
  };
}

export default function StrategyBuilder({ onRun, running }: Props) {
  const [form, setForm] = useState<StrategyForm>(defaultForm);
  const inTranches = deriveTranches(form.scaleInWindowDays, form.cadenceDays);
  const outTranches = deriveTranches(form.scaleOutWindowDays, form.cadenceDays);
  const suggestedScaleOutStartDate = addDaysIso(form.startDate, form.scaleInWindowDays);

  const patch = <K extends keyof StrategyForm>(k: K, v: StrategyForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const activeTypes = new Set<string>(form.signals.map((sw) => sw.signal.type));

  function toggleSignal(type: SignalKey) {
    if (activeTypes.has(type)) {
      const next = form.signals.filter((sw) => sw.signal.type !== type);
      if (next.length === 0) return;
      const w = 1 / next.length;
      patch("signals", next.map((sw) => ({ ...sw, weight: w })));
    } else {
      const n = form.signals.length + 1;
      const w = 1 / n;
      patch("signals", [
        ...form.signals.map((sw) => ({ ...sw, weight: w })),
        { signal: makeSignal(type), weight: w },
      ]);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onRun(form);
      }}
      className="flex flex-col gap-4 p-4 h-full overflow-y-auto"
    >
      <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
        Strategy
      </p>

      <Field label="Symbol">
        <input
          className={input}
          value={form.symbol}
          onChange={(e) => patch("symbol", e.target.value.toUpperCase())}
          placeholder="AAPL"
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Amount ($)">
          <input
            type="number"
            min={100}
            className={input}
            value={form.totalAmount}
            onChange={(e) => patch("totalAmount", +e.target.value)}
          />
        </Field>
        <Field label="Cadence (days/tranche)">
          <input
            type="number"
            min={1}
            max={30}
            className={input}
            value={form.cadenceDays}
            onChange={(e) => patch("cadenceDays", +e.target.value)}
          />
        </Field>
      </div>

      <Field label="Scale-In Start Date">
        <input
          type="date"
          className={input}
          value={form.startDate}
          onChange={(e) => patch("startDate", e.target.value)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Scale-In Duration (days)">
          <input
            type="number"
            min={1}
            className={input}
            value={form.scaleInWindowDays}
            onChange={(e) => patch("scaleInWindowDays", +e.target.value)}
          />
        </Field>
        <Field label="Scale-Out Duration (days)">
          <input
            type="number"
            min={1}
            className={input}
            value={form.scaleOutWindowDays}
            onChange={(e) => patch("scaleOutWindowDays", +e.target.value)}
          />
        </Field>
      </div>

      <Field label="Scale-Out Start Date">
        <div className="flex items-center gap-2">
          <input
            type="date"
            className={input}
            value={form.scaleOutStartDate}
            onChange={(e) => patch("scaleOutStartDate", e.target.value)}
          />
          <button
            type="button"
            className="rounded border border-border bg-surface-2 px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary"
            onClick={() => patch("scaleOutStartDate", suggestedScaleOutStartDate)}
          >
            Use Suggested
          </button>
        </div>
        <p className="mt-1 text-[10px] text-text-secondary">
          Suggested from start + scale-in period: {suggestedScaleOutStartDate}
        </p>
      </Field>

      <Field label="Random Ensemble Samples">
        <input
          type="number"
          min={50}
          max={5000}
          step={50}
          className={input}
          value={form.randomEnsembleSamples}
          onChange={(e) => patch("randomEnsembleSamples", +e.target.value)}
        />
      </Field>

      <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
        <p className="text-[11px] text-text-secondary">Derived tranches (from cadence)</p>
        <p className="mt-0.5 text-xs text-text-primary tabular-nums">
          Scale-in: {inTranches} | Scale-out: {outTranches}
        </p>
        <p className="text-[10px] text-text-secondary mt-0.5">Runtime may cap counts based on available bars.</p>
      </div>

      <Field label={`Signal weight: ${Math.round(form.aggressiveness * 100)}%`}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          className="w-full accent-accent"
          value={form.aggressiveness}
          onChange={(e) => patch("aggressiveness", +e.target.value)}
        />
        <div className="flex justify-between text-[10px] text-text-secondary -mt-1">
          <span>Equal DCA</span>
          <span>Signal-weighted</span>
        </div>
      </Field>

      <div>
        <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold mb-2">Signals</p>
        <div className="flex flex-col gap-1.5">
          {(Object.entries(SIGNAL_META) as [SignalKey, { label: string; description: string }][]).map(
            ([type, meta]) => {
              const on = activeTypes.has(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleSignal(type)}
                  className={`flex items-start gap-3 rounded border px-2.5 py-2 text-left transition-colors ${
                    on ? "border-accent/50 bg-accent/10" : "border-border bg-surface-2 hover:border-border/70"
                  }`}
                >
                  <span className={`mt-px flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-sm text-[9px] ${on ? "bg-accent text-white" : "bg-surface-3"}`}>
                    {on ? "✓" : ""}
                  </span>
                  <div>
                    <p className={`text-xs font-medium ${on ? "text-accent" : "text-text-primary"}`}>{meta.label}</p>
                    <p className="text-[10px] text-text-secondary leading-snug">{meta.description}</p>
                  </div>
                </button>
              );
            }
          )}
        </div>
      </div>

      <button
        type="submit"
        disabled={running || form.signals.length === 0}
        className="mt-auto w-full rounded bg-accent py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
      >
        {running ? "Running…" : "Run Backtest"}
      </button>
    </form>
  );
}

const input =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] text-text-secondary">{label}</label>
      {children}
    </div>
  );
}

function deriveTranches(windowDays: number, cadenceDays: number): number {
  const cadence = Math.max(1, cadenceDays);
  const raw = Math.round(windowDays / cadence);
  return Math.max(1, raw);
}

function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map((v) => Number(v));
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().split("T")[0];
}
