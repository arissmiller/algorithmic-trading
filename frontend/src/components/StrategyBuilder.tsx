import { useEffect, useState } from "react";
import { SIGNAL_META, SignalType, SignalWeight } from "../lib/signals";
import type { AccountType } from "../lib/backtest";

export type StrategyMode = "two_phase" | "continuous_range";

export interface StrategyForm {
  symbol: string;
  timeframe: "1Day" | "1Hour";
  strategyMode: StrategyMode;
  totalAmount: number;
  cadenceDays: number;
  startDate: string;
  endDate: string;
  scaleInWindowDays: number;
  scaleOutStartDate: string;
  scaleOutWindowDays: number;
  randomEnsembleSamples: number;
  aggressiveness: number;
  accountType: AccountType;
  washSaleWindowDays: number;
  signals: SignalWeight[];
}

interface Props {
  onRun: (form: StrategyForm) => void;
  onRunPresetSuite: (form: StrategyForm) => void;
  onFormChange?: (form: StrategyForm) => void;
  running: boolean;
  defaultSymbol?: string;
}

type SignalKey = keyof typeof SIGNAL_META;
export type StrategyPresetKey =
  | "mean_reversion_balanced"
  | "capitulation_hunter"
  | "trend_pullback_hybrid"
  | "defensive_risk_off"
  | "hourly_mean_reversion"
  | "crypto_spot_balanced";

export type StrategyPreset = {
  key: StrategyPresetKey;
  label: string;
  suitableFor: string;
  tuneHint: string;
  strategyMode?: StrategyMode;
  defaultRangeDays?: number;
  timeframe?: "1Day" | "1Hour";
  config: Pick<
    StrategyForm,
    "cadenceDays" | "scaleInWindowDays" | "scaleOutWindowDays" | "aggressiveness" | "signals"
  >;
};

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    key: "mean_reversion_balanced",
    label: "Mean Reversion (Balanced)",
    suitableFor: "Sideways/choppy markets with frequent pullbacks",
    tuneHint: "Raise aggressiveness in range-bound markets. Lower it when trend persistence increases.",
    config: {
      cadenceDays: 3,
      scaleInWindowDays: 30,
      scaleOutWindowDays: 45,
      aggressiveness: 0.6,
      signals: [
        { signal: { type: "price_vs_sma", period: 20 }, weight: 0.4 },
        { signal: { type: "rsi", period: 14 }, weight: 0.4 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.2 },
      ],
    },
  },
  {
    key: "capitulation_hunter",
    label: "Capitulation Hunter",
    suitableFor: "Panic selloffs and volatility spikes",
    tuneHint: "Use shorter cadence and higher volume weight during sharp drawdowns, then taper back.",
    config: {
      cadenceDays: 2,
      scaleInWindowDays: 25,
      scaleOutWindowDays: 35,
      aggressiveness: 0.8,
      signals: [
        { signal: { type: "rsi", period: 10 }, weight: 0.3 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2.5 }, weight: 0.25 },
        { signal: { type: "volume", period: 20 }, weight: 0.3 },
        { signal: { type: "momentum", period: 7 }, weight: 0.15 },
      ],
    },
  },
  {
    key: "trend_pullback_hybrid",
    label: "Trend Pullback Hybrid",
    suitableFor: "Uptrends with shallow pullbacks",
    tuneHint: "Lengthen windows and reduce aggressiveness as trend quality improves.",
    config: {
      cadenceDays: 5,
      scaleInWindowDays: 45,
      scaleOutWindowDays: 60,
      aggressiveness: 0.45,
      signals: [
        { signal: { type: "price_vs_sma", period: 30 }, weight: 0.35 },
        { signal: { type: "momentum", period: 20 }, weight: 0.35 },
        { signal: { type: "rsi", period: 14 }, weight: 0.2 },
        { signal: { type: "volume", period: 20 }, weight: 0.1 },
      ],
    },
  },
  {
    key: "defensive_risk_off",
    label: "Defensive Risk-Off",
    suitableFor: "Uncertain macro and unstable trend transitions",
    tuneHint: "Keep aggressiveness low and cadence wider until volatility and drawdown pressure normalize.",
    config: {
      cadenceDays: 7,
      scaleInWindowDays: 60,
      scaleOutWindowDays: 30,
      aggressiveness: 0.25,
      signals: [
        { signal: { type: "price_vs_sma", period: 40 }, weight: 0.5 },
        { signal: { type: "rsi", period: 14 }, weight: 0.25 },
        { signal: { type: "momentum", period: 15 }, weight: 0.15 },
        { signal: { type: "volume", period: 20 }, weight: 0.1 },
      ],
    },
  },
  {
    key: "hourly_mean_reversion",
    label: "Hourly Mean Reversion",
    suitableFor: "Crypto intraday — picks the best entry/exit hour within each day",
    tuneHint: "Uses hourly candles. Shorten windows further in high-volatility periods; raise aggressiveness when price oscillates tightly.",
    timeframe: "1Hour",
    config: {
      cadenceDays: 1,
      scaleInWindowDays: 14,
      scaleOutWindowDays: 21,
      aggressiveness: 0.75,
      signals: [
        { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.45 },
        { signal: { type: "rsi", period: 14 }, weight: 0.35 },
        { signal: { type: "momentum", period: 10 }, weight: 0.20 },
      ],
    },
  },
  {
    key: "crypto_spot_balanced",
    label: "Crypto Spot Balanced (Perpetual)",
    suitableFor: "Long-run crypto spot allocation with continuous buy/sell opportunities",
    tuneHint: "Uses a continuous date range (start/end only). Keep cadence at 1-2 days for responsive execution.",
    strategyMode: "continuous_range",
    defaultRangeDays: 365,
    timeframe: "1Hour",
    config: {
      cadenceDays: 1,
      scaleInWindowDays: 30,
      scaleOutWindowDays: 30,
      aggressiveness: 0.65,
      signals: [
        { signal: { type: "price_vs_sma", period: 20 }, weight: 0.35 },
        { signal: { type: "rsi", period: 14 }, weight: 0.35 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.2 },
        { signal: { type: "momentum", period: 10 }, weight: 0.1 },
      ],
    },
  },
];

function makeSignal(type: SignalKey): SignalType {
  if (type === "rsi") return { type: "rsi", period: 14 };
  if (type === "bollinger_band") return { type: "bollinger_band", period: 20, std_dev: 2 };
  if (type === "volume") return { type: "volume", period: 20 };
  if (type === "momentum") return { type: "momentum", period: 10 };
  return { type: "price_vs_sma", period: 20 };
}

function defaultForm(defaultSymbol = "AAPL"): StrategyForm {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const startDate = start.toISOString().split("T")[0];
  const scaleInWindowDays = 30;
  const normalizedDefaultSymbol = defaultSymbol.trim().toUpperCase() || "AAPL";
  const isCryptoDefault = isLikelyCryptoSymbol(normalizedDefaultSymbol);

  const baseForm: StrategyForm = {
    symbol: normalizedDefaultSymbol,
    timeframe: "1Day",
    strategyMode: "two_phase",
    totalAmount: 10000,
    cadenceDays: 3,
    startDate,
    endDate: addDaysIso(startDate, scaleInWindowDays + 45),
    scaleInWindowDays,
    scaleOutStartDate: addDaysIso(startDate, scaleInWindowDays),
    scaleOutWindowDays: 45,
    randomEnsembleSamples: 400,
    aggressiveness: 0.6,
    accountType: isCryptoDefault ? "tax_advantaged" : "taxable",
    washSaleWindowDays: 30,
    signals: [
      { signal: { type: "price_vs_sma", period: 20 }, weight: 0.4 },
      { signal: { type: "rsi", period: 14 }, weight: 0.4 },
      { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.2 },
    ],
  };

  if (isCryptoDefault) {
    const cryptoSpotPreset = STRATEGY_PRESETS.find((preset) => preset.key === "crypto_spot_balanced");
    if (cryptoSpotPreset) {
      return buildPresetForm(baseForm, cryptoSpotPreset);
    }
  }

  return baseForm;
}

export default function StrategyBuilder({
  onRun,
  onRunPresetSuite,
  onFormChange,
  running,
  defaultSymbol = "AAPL",
}: Props) {
  const [form, setForm] = useState<StrategyForm>(() => defaultForm(defaultSymbol));
  const [presetKey, setPresetKey] = useState<StrategyPresetKey>(() =>
    isLikelyCryptoSymbol(defaultSymbol) ? "crypto_spot_balanced" : "mean_reversion_balanced"
  );
  const isContinuousRange = form.strategyMode === "continuous_range";
  const continuousWindowDays = deriveContinuousWindowDays(form.startDate, form.endDate);
  const continuousDateError = isContinuousRange
    ? validateContinuousRange(form.startDate, form.endDate)
    : null;
  const inTranches = deriveTranches(form.scaleInWindowDays, form.cadenceDays);
  const outTranches = deriveTranches(form.scaleOutWindowDays, form.cadenceDays);
  const continuousTranches = deriveTranches(continuousWindowDays, form.cadenceDays);
  const suggestedScaleOutStartDate = addDaysIso(form.startDate, form.scaleInWindowDays);
  const selectedPreset = STRATEGY_PRESETS.find((p) => p.key === presetKey) ?? STRATEGY_PRESETS[0];
  const isCryptoSymbol = isLikelyCryptoSymbol(form.symbol);

  useEffect(() => {
    onFormChange?.(form);
  }, [form, onFormChange]);

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

  function applyPreset(key: StrategyPresetKey) {
    const preset = STRATEGY_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setPresetKey(key);
    setForm((prev) => buildPresetForm(prev, preset));
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

      <Field label="Strategy Preset">
        <div className="flex items-center gap-2">
          <select
            className={input}
            value={presetKey}
            onChange={(e) => setPresetKey(e.target.value as StrategyPresetKey)}
          >
            {STRATEGY_PRESETS.map((preset) => (
              <option key={preset.key} value={preset.key}>
                {preset.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="whitespace-nowrap rounded border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary"
            onClick={() => applyPreset(presetKey)}
          >
            Apply
          </button>
        </div>
        <p className="mt-1 text-[10px] text-text-secondary">
          Best for: {selectedPreset.suitableFor}
        </p>
        <p className="text-[10px] text-text-secondary">
          Tuning hint: {selectedPreset.tuneHint}
        </p>
      </Field>

      <Field label="Symbol">
        <input
          className={input}
          value={form.symbol}
          onChange={(e) => patch("symbol", e.target.value.toUpperCase())}
          placeholder={defaultSymbol}
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

      <Field label={isContinuousRange ? "Backtest Start Date" : "Scale-In Start Date"}>
        <input
          type="date"
          className={input}
          value={form.startDate}
          onChange={(e) => patch("startDate", e.target.value)}
        />
      </Field>

      {isContinuousRange && (
        <Field label="Backtest End Date">
          <input
            type="date"
            className={input}
            value={form.endDate}
            onChange={(e) => patch("endDate", e.target.value)}
          />
          {continuousDateError ? (
            <p className="mt-1 text-[10px] text-sell">{continuousDateError}</p>
          ) : null}
          <p className="mt-1 text-[10px] text-text-secondary">
            This strategy uses one continuous window from start to end for both accumulation and distribution logic.
          </p>
        </Field>
      )}

      {!isContinuousRange && form.timeframe !== "1Hour" && (
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
      )}

      {!isContinuousRange && form.timeframe === "1Hour" && (
        <div className="rounded border border-border bg-surface-2 px-2.5 py-2 text-[10px] text-text-secondary">
          Scale-in: {form.scaleInWindowDays} days · Scale-out: {form.scaleOutWindowDays} days (set by preset)
        </div>
      )}

      {!isContinuousRange && form.timeframe !== "1Hour" && (
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
      )}

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

      <Field label="Account Type">
        <select
          className={input}
          value={form.accountType}
          onChange={(e) => patch("accountType", e.target.value as AccountType)}
        >
          <option value="taxable">
            {isCryptoSymbol
              ? "Taxable (capital gains/losses, no wash-sale deferral modeled)"
              : "Taxable (wash-sale checks enabled)"}
          </option>
          <option value="tax_advantaged">
            {isCryptoSymbol
              ? "Tax-Advantaged (no wash-sale checks)"
              : "Tax-Advantaged (wash-sale checks disabled)"}
          </option>
        </select>
      </Field>

      <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
        <p className="text-[11px] text-text-secondary">Derived tranches (from cadence)</p>
        <p className="mt-0.5 text-xs text-text-primary tabular-nums">
          {isContinuousRange
            ? `Continuous: ${continuousTranches} across ${continuousWindowDays} day${continuousWindowDays === 1 ? "" : "s"}`
            : `Scale-in: ${inTranches} | Scale-out: ${outTranches}`}
        </p>
        <p className="text-[10px] text-text-secondary mt-0.5">Runtime may cap counts based on available bars.</p>
      </div>

      <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
        <p className="text-[11px] text-text-secondary">Regime Tuning Cheat Sheet</p>
        <p className="mt-1 text-[10px] text-text-secondary">
          Trending up: cadence 5-8, aggressiveness 0.30-0.50, emphasize Price vs SMA + Momentum.
        </p>
        <p className="mt-0.5 text-[10px] text-text-secondary">
          Sideways/range: cadence 2-4, aggressiveness 0.60-0.85, emphasize RSI + Bollinger.
        </p>
        <p className="mt-0.5 text-[10px] text-text-secondary">
          Panic/high-vol: cadence 1-3, aggressiveness 0.65-0.90, add Volume and shorten momentum lookback.
        </p>
        <p className="mt-0.5 text-[10px] text-text-secondary">
          Risk-off/uncertain: cadence 5-10, aggressiveness 0.20-0.40, widen windows and reduce indicator sensitivity.
        </p>
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
        disabled={running || form.signals.length === 0 || Boolean(continuousDateError)}
        className="mt-auto w-full rounded bg-accent py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
      >
        {running ? "Running…" : "Run Backtest"}
      </button>
      <button
        type="button"
        onClick={() => onRunPresetSuite(form)}
        disabled={running || Boolean(continuousDateError)}
        className="w-full rounded border border-border bg-surface-2 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
      >
        {running ? "Running…" : "Run All Presets"}
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

function isLikelyCryptoSymbol(symbol: string): boolean {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return false;
  if (normalized.includes("/")) return true;
  return /^[A-Z0-9]{2,10}[-_](USD|USDT|USDC|BTC|ETH|EUR|GBP|JPY)$/.test(normalized);
}

function deriveTranches(windowDays: number, cadenceDays: number): number {
  const cadence = Math.max(1, cadenceDays);
  const raw = Math.round(windowDays / cadence);
  return Math.max(1, raw);
}

function deriveContinuousWindowDays(startDate: string, endDate: string): number {
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  const endTs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return 1;
  const dayMs = 86_400_000;
  const diffDays = Math.floor((endTs - startTs) / dayMs) + 1;
  return Math.max(1, diffDays);
}

function validateContinuousRange(startDate: string, endDate: string): string | null {
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  const endTs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
    return "Start and end dates must be valid.";
  }
  if (endTs < startTs) {
    return "End date must be on or after start date.";
  }
  return null;
}

function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map((v) => Number(v));
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().split("T")[0];
}

export function buildPresetForm(baseForm: StrategyForm, preset: StrategyPreset): StrategyForm {
  const strategyMode = preset.strategyMode ?? "two_phase";
  const nextScaleInDays = preset.config.scaleInWindowDays;
  const nextStartDate = baseForm.startDate;
  const nextEndDate =
    strategyMode === "continuous_range"
      ? addDaysIso(nextStartDate, Math.max(1, preset.defaultRangeDays ?? 365))
      : addDaysIso(nextStartDate, nextScaleInDays + preset.config.scaleOutWindowDays);

  return {
    ...baseForm,
    strategyMode,
    timeframe: preset.timeframe ?? "1Day",
    cadenceDays: preset.config.cadenceDays,
    startDate: nextStartDate,
    endDate: nextEndDate,
    scaleInWindowDays: nextScaleInDays,
    scaleOutWindowDays: preset.config.scaleOutWindowDays,
    aggressiveness: preset.config.aggressiveness,
    signals: preset.config.signals.map((sw) => ({
      ...sw,
      signal: { ...sw.signal },
    })),
    scaleOutStartDate:
      strategyMode === "continuous_range"
        ? nextStartDate
        : addDaysIso(nextStartDate, nextScaleInDays),
  };
}
