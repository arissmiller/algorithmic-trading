import { useEffect, useState } from "react";
import { SIGNAL_META, SignalType, SignalWeight } from "../lib/signals";
import type { AccountType } from "../lib/backtest";

export type StrategyMode = "two_phase" | "continuous_range";

export interface StrategyForm {
  symbol: string;
  timeframe: "1Day" | "1Hour" | "15Min" | "5Min";
  strategyMode: StrategyMode;
  phase?: "scale_in" | "scale_out";
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
  | "scale_in"
  | "selloff"
  | "perpetual"
  | "stock_mean_reversion_swing"
  | "crypto_perpetual_selloff_protection"
  | "crypto_autotrader"
  | "crypto_short_selloff"
  | "crypto_trend_confidence";

export type StrategyPreset = {
  key: StrategyPresetKey;
  label: string;
  suitableFor: string;
  tuneHint: string;
  phase: "scale_in" | "scale_out";
  strategyMode?: StrategyMode;
  defaultRangeDays?: number;
  timeframe?: "1Day" | "1Hour" | "15Min" | "5Min";
  /** Buy threshold for the perpetual engine (0–1). Defaults to aggressiveness. */
  buyThreshold?: number;
  /** Sell threshold for the perpetual engine (0–1). Defaults to 1 - buyThreshold. */
  sellThreshold?: number;
  selloffProtection?: {
    selloffStartThreshold: number;
    selloffEndThreshold: number;
    selloffSignals: SignalWeight[];
  };
  autotrader?: {
    selloffStartThreshold: number;
    selloffEndThreshold: number;
    selloffSignals: SignalWeight[];
    longEntrySlopeThreshold?: number;
    longExitSlopeThreshold?: number;
    longTrailingStopPct: number;
    trailingActivationPct: number;
    atrPeriod?: number;
    shortStopAtrMult?: number;
    shortTakeProfitRR?: number;
    shortMaxHoldBars?: number;
    shortBreakEvenActivationRR?: number;
    shortBreakEvenLockRR?: number;
    shortTrailActivationRR?: number;
    shortTrailAtrMult?: number;
    longExitStyle?: "trend" | "momentum";
    longStopAtrMult?: number;
    longTakeProfitRR?: number;
    longTrailAtrMult?: number;
    longBreakEvenActivationRR?: number;
    longBreakEvenLockRR?: number;
    longTrailActivationRR?: number;
  };
  config: Pick<
    StrategyForm,
    "cadenceDays" | "scaleInWindowDays" | "scaleOutWindowDays" | "aggressiveness" | "signals"
  >;
};

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    key: "scale_in",
    label: "buy over time",
    suitableFor: "Accumulating a position over time",
    tuneHint: "Raise aggressiveness in high-conviction setups. Duration and cadence are set by the run queue option.",
    phase: "scale_in",
    config: {
      cadenceDays: 7,
      scaleInWindowDays: 90,
      scaleOutWindowDays: 1,
      aggressiveness: 0.55,
      signals: [
        { signal: { type: "price_vs_sma", period: 30 }, weight: 0.35 },
        { signal: { type: "rsi", period: 14 }, weight: 0.4 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.25 },
      ],
    },
  },
  {
    key: "selloff",
    label: "sell off",
    suitableFor: "Exiting a position gradually over time",
    tuneHint: "Raise aggressiveness to exit faster. Use volume signals to time sales around peak sell pressure.",
    phase: "scale_out",
    config: {
      cadenceDays: 7,
      scaleInWindowDays: 1,
      scaleOutWindowDays: 90,
      aggressiveness: 0.55,
      signals: [
        { signal: { type: "rsi", period: 14 }, weight: 0.35 },
        { signal: { type: "volume", period: 20 }, weight: 0.35 },
        { signal: { type: "selloff_pressure", period: 8 }, weight: 0.3 },
      ],
    },
  },
  {
    key: "perpetual",
    label: "perpetual",
    suitableFor: "Simultaneously buying dips and selling rallies over one continuous window, tracking position throughout",
    tuneHint: "Signal weight controls buy sensitivity. Buys when score ≥ threshold; sells when score ≤ (1−threshold). Cadence throttles trade frequency.",
    phase: "scale_in",
    strategyMode: "continuous_range",
    defaultRangeDays: 365,
    buyThreshold: 0.60,
    sellThreshold: 0.40,
    config: {
      cadenceDays: 7,
      scaleInWindowDays: 365,
      scaleOutWindowDays: 365,
      aggressiveness: 0.60,
      signals: [
        { signal: { type: "price_vs_sma", period: 30 }, weight: 0.35 },
        { signal: { type: "rsi", period: 14 }, weight: 0.4 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.25 },
      ],
    },
  },
  {
    key: "stock_mean_reversion_swing",
    label: "stock swing mean reversion",
    suitableFor: "Stocks/ETFs with pullback-and-rebound behavior where you want multi-day swing entries and exits",
    tuneHint: "Cadence controls swing pace. Try 2-4 days for active swing cadence or 5-10 for slower setups.",
    phase: "scale_in",
    strategyMode: "continuous_range",
    defaultRangeDays: 240,
    buyThreshold: 0.64,
    sellThreshold: 0.42,
    config: {
      cadenceDays: 4,
      scaleInWindowDays: 240,
      scaleOutWindowDays: 240,
      aggressiveness: 0.7,
      signals: [
        { signal: { type: "rsi", period: 10 }, weight: 0.35 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2.2 }, weight: 0.3 },
        { signal: { type: "price_vs_sma", period: 20 }, weight: 0.25 },
        { signal: { type: "momentum", period: 7 }, weight: 0.1 },
      ],
    },
  },
  {
    key: "crypto_perpetual_selloff_protection",
    label: "crypto perpetual + selloff protection",
    suitableFor: "Crypto perpetual dip-buy/rally-sell with forced full risk-off during detected selloffs, then full re-entry when stress ends",
    tuneHint: "Normal perpetual cadence runs outside selloffs. On selloff start it liquidates fully; on selloff end it buys back with available cash.",
    phase: "scale_in",
    strategyMode: "continuous_range",
    defaultRangeDays: 365,
    timeframe: "1Hour",
    buyThreshold: 0.6,
    sellThreshold: 0.4,
    selloffProtection: {
      selloffStartThreshold: 0.7,
      selloffEndThreshold: 0.52,
      selloffSignals: [
        { signal: { type: "selloff_pressure", period: 8 }, weight: 0.55 },
        { signal: { type: "volume", period: 20 }, weight: 0.22 },
        { signal: { type: "rsi", period: 7 }, weight: 0.1 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2.5 }, weight: 0.13 },
      ],
    },
    config: {
      cadenceDays: 3,
      scaleInWindowDays: 365,
      scaleOutWindowDays: 365,
      aggressiveness: 0.6,
      signals: [
        { signal: { type: "price_vs_sma", period: 20 }, weight: 0.35 },
        { signal: { type: "rsi", period: 14 }, weight: 0.3 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.2 },
        { signal: { type: "momentum", period: 10 }, weight: 0.15 },
      ],
    },
  },
  {
    key: "crypto_autotrader",
    label: "crypto autotrader",
    suitableFor: "Crypto-only event trading: buy selloff-end confirmations in positive EMA slope, short selloff-start confirmations in negative EMA slope",
    tuneHint: "Uses 1h bars with 7-day EMA slope regime + selloff started/ended events. Longs use a trailing take-profit stop.",
    phase: "scale_in",
    strategyMode: "continuous_range",
    defaultRangeDays: 180,
    timeframe: "1Hour",
    autotrader: {
      selloffStartThreshold: 0.7,
      selloffEndThreshold: 0.52,
      selloffSignals: [
        { signal: { type: "selloff_pressure", period: 8 }, weight: 0.55 },
        { signal: { type: "volume", period: 20 }, weight: 0.22 },
        { signal: { type: "rsi", period: 7 }, weight: 0.1 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2.5 }, weight: 0.13 },
      ],
      atrPeriod: 14,
      shortStopAtrMult: 1.05,
      shortTakeProfitRR: 1.35,
      shortMaxHoldBars: 8,
      shortBreakEvenActivationRR: 0.7,
      shortBreakEvenLockRR: 0.05,
      shortTrailActivationRR: 1.0,
      shortTrailAtrMult: 1.2,
      longEntrySlopeThreshold: 0.56,
      longExitSlopeThreshold: 0.46,
      longExitStyle: "trend",
      longStopAtrMult: 1.6,
      longTakeProfitRR: 1.8,
      longTrailAtrMult: 2.4,
      longBreakEvenActivationRR: 0.8,
      longBreakEvenLockRR: 0.05,
      longTrailActivationRR: 1.1,
      longTrailingStopPct: 0.04,
      trailingActivationPct: 0.01,
    },
    config: {
      cadenceDays: 1,
      scaleInWindowDays: 180,
      scaleOutWindowDays: 180,
      aggressiveness: 0.6,
      signals: [
        { signal: { type: "price_vs_sma", period: 20 }, weight: 0.35 },
        { signal: { type: "rsi", period: 14 }, weight: 0.3 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.2 },
        { signal: { type: "momentum", period: 10 }, weight: 0.15 },
      ],
    },
  },
  {
    key: "crypto_short_selloff",
    label: "crypto short selloff",
    suitableFor: "Event-driven shorting during detected selloff starts, then staged mean-reversion cover execution over the next 10 hours",
    tuneHint: "Triggers a large short on selloff-start detection, waits for the trigger bar to close, then covers on 5m cadence (about every 20–30 minutes).",
    phase: "scale_in",
    strategyMode: "continuous_range",
    defaultRangeDays: 60,
    timeframe: "1Hour",
    autotrader: {
      selloffStartThreshold: 0.7,
      selloffEndThreshold: 0.52,
      selloffSignals: [
        { signal: { type: "selloff_pressure", period: 8 }, weight: 0.55 },
        { signal: { type: "volume", period: 20 }, weight: 0.22 },
        { signal: { type: "rsi", period: 7 }, weight: 0.1 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2.5 }, weight: 0.13 },
      ],
      longTrailingStopPct: 0.04,
      trailingActivationPct: 0.01,
    },
    config: {
      cadenceDays: 1,
      scaleInWindowDays: 60,
      scaleOutWindowDays: 60,
      aggressiveness: 0.62,
      signals: [
        { signal: { type: "rsi", period: 10 }, weight: 0.35 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2.2 }, weight: 0.3 },
        { signal: { type: "price_vs_sma", period: 20 }, weight: 0.2 },
        { signal: { type: "momentum", period: 7 }, weight: 0.15 },
      ],
    },
  },
  {
    key: "crypto_trend_confidence",
    label: "crypto trend confidence",
    suitableFor: "Classifying completed EMA trend regimes and estimating the current forming trend",
    tuneHint: "Uses 1h bars and EMA trend regions. Past regions are finalized after regime shifts; current region is shown as a confidence-weighted guess.",
    phase: "scale_in",
    strategyMode: "continuous_range",
    defaultRangeDays: 180,
    timeframe: "1Hour",
    config: {
      cadenceDays: 1,
      scaleInWindowDays: 180,
      scaleOutWindowDays: 180,
      aggressiveness: 0.6,
      signals: [
        { signal: { type: "price_vs_sma", period: 20 }, weight: 0.35 },
        { signal: { type: "momentum", period: 10 }, weight: 0.25 },
        { signal: { type: "rsi", period: 14 }, weight: 0.25 },
        { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.15 },
      ],
    },
  },
];

function makeSignal(type: SignalKey): SignalType {
  if (type === "rsi") return { type: "rsi", period: 14 };
  if (type === "bollinger_band") return { type: "bollinger_band", period: 20, std_dev: 2 };
  if (type === "volume") return { type: "volume", period: 20 };
  if (type === "momentum") return { type: "momentum", period: 10 };
  if (type === "ema_slope_7d") return { type: "ema_slope_7d" };
  if (type === "selloff_pressure") return { type: "selloff_pressure", period: 8 };
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

  return buildPresetForm(baseForm, STRATEGY_PRESETS[0]);
}

export default function StrategyBuilder({
  onRun,
  onRunPresetSuite,
  onFormChange,
  running,
  defaultSymbol = "AAPL",
}: Props) {
  const [form, setForm] = useState<StrategyForm>(() => defaultForm(defaultSymbol));
  const [presetKey, setPresetKey] = useState<StrategyPresetKey>("scale_in");
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
  const isEventDrivenPreset =
    selectedPreset.key === "crypto_autotrader" || selectedPreset.key === "crypto_short_selloff";
  const isCryptoSymbol = isLikelyCryptoSymbol(form.symbol);
  const isIntraday = form.timeframe !== "1Day";

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
      <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
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
        <p className="mt-1 text-[11px] text-text-secondary">
          Best for: {selectedPreset.suitableFor}
        </p>
        <p className="text-[11px] text-text-secondary">
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

      {isEventDrivenPreset ? (
        <>
          <Field label="Amount ($)">
            <input
              type="number"
              min={100}
              className={input}
              value={form.totalAmount}
              onChange={(e) => patch("totalAmount", +e.target.value)}
            />
          </Field>
          <div className="rounded border border-border bg-surface-2 px-2.5 py-2 text-[11px] text-text-secondary">
            This preset is event-driven. Cadence is not used.
          </div>
        </>
      ) : (
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
      )}

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
            <p className="mt-1 text-[11px] text-sell">{continuousDateError}</p>
          ) : null}
          <p className="mt-1 text-[11px] text-text-secondary">
            This strategy uses one continuous window from start to end for both accumulation and distribution logic.
          </p>
        </Field>
      )}

      {!isContinuousRange && !isIntraday && (
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

      {!isContinuousRange && isIntraday && (
        <div className="rounded border border-border bg-surface-2 px-2.5 py-2 text-[11px] text-text-secondary">
          Scale-in: {form.scaleInWindowDays} days · Scale-out: {form.scaleOutWindowDays} days
          {" "}(set by preset for intraday)
        </div>
      )}

      {!isContinuousRange && !isIntraday && (
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
              className="rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
              onClick={() => patch("scaleOutStartDate", suggestedScaleOutStartDate)}
            >
              Use Suggested
            </button>
          </div>
          <p className="mt-1 text-[11px] text-text-secondary">
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

      {isEventDrivenPreset ? (
        <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
          <p className="text-[12px] text-text-secondary">Execution model</p>
          <p className="mt-0.5 text-xs text-text-primary">
            {selectedPreset.key === "crypto_short_selloff"
              ? "Event-driven short entry on selloff trigger, then 5m mean-reversion cover cadence."
              : "Event-driven on selloff confirmations + EMA slope regime."}
          </p>
          <p className="text-[11px] text-text-secondary mt-0.5">No tranche cadence is applied for this preset.</p>
        </div>
      ) : (
        <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
          <p className="text-[12px] text-text-secondary">Derived tranches (from cadence)</p>
          <p className="mt-0.5 text-xs text-text-primary tabular-nums">
            {isContinuousRange
              ? `Continuous: ${continuousTranches} across ${continuousWindowDays} day${continuousWindowDays === 1 ? "" : "s"}`
              : `Scale-in: ${inTranches} | Scale-out: ${outTranches}`}
          </p>
          <p className="text-[11px] text-text-secondary mt-0.5">Runtime may cap counts based on available bars.</p>
        </div>
      )}

      {!isEventDrivenPreset && (
        <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
          <p className="text-[12px] text-text-secondary">Regime Tuning Cheat Sheet</p>
          <p className="mt-1 text-[11px] text-text-secondary">
            Trending up: cadence 5-8, aggressiveness 0.30-0.50, emphasize Price vs SMA + Momentum.
          </p>
          <p className="mt-0.5 text-[11px] text-text-secondary">
            Sideways/range: cadence 2-4, aggressiveness 0.60-0.85, emphasize RSI + Bollinger.
          </p>
          <p className="mt-0.5 text-[11px] text-text-secondary">
            Panic/high-vol: cadence 1-3, aggressiveness 0.65-0.90, add Volume and shorten momentum lookback.
          </p>
          <p className="mt-0.5 text-[11px] text-text-secondary">
            Risk-off/uncertain: cadence 5-10, aggressiveness 0.20-0.40, widen windows and reduce indicator sensitivity.
          </p>
        </div>
      )}

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
        <div className="flex justify-between text-[11px] text-text-secondary -mt-1">
          <span>Equal DCA</span>
          <span>Signal-weighted</span>
        </div>
      </Field>

      <div>
        <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold mb-2">Signals</p>
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
                  <span className={`mt-px flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-sm text-[11px] ${on ? "bg-accent text-white" : "bg-surface-3"}`}>
                    {on ? "✓" : ""}
                  </span>
                  <div>
                    <p className={`text-xs font-medium ${on ? "text-accent" : "text-text-primary"}`}>{meta.label}</p>
                    <p className="text-[11px] text-text-secondary leading-snug">{meta.description}</p>
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
      <label className="mb-1 block text-[12px] text-text-secondary">{label}</label>
      {children}
    </div>
  );
}

function isLikelyCryptoSymbol(symbol: string): boolean {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return false;
  if (SUPPORTED_CRYPTO_BASES.has(normalized)) return true;
  if (normalized.includes("/")) return true;
  return /^[A-Z0-9]{2,10}[-_](USD|USDT|USDC|BTC|ETH|EUR|GBP|JPY)$/.test(normalized);
}

const SUPPORTED_CRYPTO_BASES = new Set([
  "AAVE",
  "ALGO",
  "AVAX",
  "BAT",
  "BCH",
  "BTC",
  "CRV",
  "DOGE",
  "DOT",
  "ETH",
  "GRT",
  "LINK",
  "LTC",
  "MKR",
  "NEAR",
  "PAXG",
  "SHIB",
  "SOL",
  "SUSHI",
  "TRX",
  "UNI",
  "USDC",
  "USDT",
  "WBTC",
  "XTZ",
  "YFI",
]);

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
  const phase = preset.phase;
  const nextScaleInDays = preset.config.scaleInWindowDays;
  const nextScaleOutDays = preset.config.scaleOutWindowDays;
  const nextStartDate = baseForm.startDate;

  let nextEndDate: string;
  let nextScaleOutStartDate: string;

  if (strategyMode === "continuous_range") {
    nextEndDate = addDaysIso(nextStartDate, Math.max(1, preset.defaultRangeDays ?? 365));
    nextScaleOutStartDate = nextStartDate;
  } else if (phase === "scale_in") {
    nextEndDate = addDaysIso(nextStartDate, nextScaleInDays);
    nextScaleOutStartDate = addDaysIso(nextStartDate, nextScaleInDays);
  } else if (phase === "scale_out") {
    nextEndDate = addDaysIso(nextStartDate, nextScaleOutDays);
    nextScaleOutStartDate = nextStartDate;
  } else {
    nextEndDate = addDaysIso(nextStartDate, nextScaleInDays + nextScaleOutDays);
    nextScaleOutStartDate = addDaysIso(nextStartDate, nextScaleInDays);
  }

  return {
    ...baseForm,
    strategyMode,
    phase,
    timeframe: preset.timeframe ?? "1Day",
    cadenceDays: preset.config.cadenceDays,
    startDate: nextStartDate,
    endDate: nextEndDate,
    scaleInWindowDays: nextScaleInDays,
    scaleOutWindowDays: nextScaleOutDays,
    aggressiveness: preset.config.aggressiveness,
    signals: preset.config.signals.map((sw) => ({
      ...sw,
      signal: { ...sw.signal },
    })),
    scaleOutStartDate: nextScaleOutStartDate,
  };
}
