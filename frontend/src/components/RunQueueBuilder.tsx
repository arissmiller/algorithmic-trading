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
  defaultSymbol?: string;
  symbolMode?: "stocks" | "crypto";
}

const input =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";

function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().split("T")[0];
}

function durationLabel(days: number): string {
  const match = DURATION_OPTIONS.find((o) => o.durationDays === days);
  if (match) return match.label;
  if (days < 14) return `${days} days`;
  if (days < 60) return `${days} days (~${Math.round(days / 7)}w)`;
  return `${days} days (~${(days / 30.44).toFixed(1)}mo)`;
}

function defaultDraft(defaultSymbol = "AAPL"): Omit<BacktestRun, "id"> {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const defaultDuration = DURATION_OPTIONS[3];
  const normalizedSymbol = defaultSymbol.trim().toUpperCase() || "AAPL";
  return {
    presetKey: "scale_in",
    symbol: normalizedSymbol,
    startDate: start.toISOString().split("T")[0],
    durationDays: defaultDuration.durationDays,
    cadenceDays: defaultDuration.cadenceDays,
    totalAmount: 10000,
  };
}

const CRYPTO_ONLY_PRESETS = new Set<StrategyPresetKey>([
  "crypto_perpetual_selloff_protection",
  "crypto_autotrader",
  "crypto_short_selloff",
  "crypto_trend_confidence",
]);
const EVENT_DRIVEN_PRESETS = new Set<StrategyPresetKey>([
  "crypto_autotrader",
  "crypto_short_selloff",
]);

export default function RunQueueBuilder({
  runs,
  onRunsChange,
  onRunAll,
  running,
  defaultSymbol = "AAPL",
  symbolMode = "stocks",
}: Props) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Omit<BacktestRun, "id">>(() =>
    defaultDraft(defaultSymbol)
  );
  const visiblePresets = STRATEGY_PRESETS.filter(
    (preset) => symbolMode === "crypto" || !CRYPTO_ONLY_PRESETS.has(preset.key)
  );

  const patchDraft = <K extends keyof Omit<BacktestRun, "id">>(
    k: K,
    v: Omit<BacktestRun, "id">[K]
  ) => setDraft((d) => ({ ...d, [k]: v }));

  function addRun() {
    if (!canAddRun) return;

    const normalizedSymbol =
      symbolMode === "crypto"
        ? normalizeCryptoInput(draft.symbol)
        : draft.symbol;

    onRunsChange([
      ...runs,
      {
        ...draft,
        cadenceDays: EVENT_DRIVEN_PRESETS.has(draft.presetKey) ? 1 : draft.cadenceDays,
        symbol: normalizedSymbol,
        id: crypto.randomUUID(),
      },
    ]);
    setAdding(false);
    setDraft(defaultDraft(defaultSymbol));
  }

  function removeRun(id: string) {
    onRunsChange(runs.filter((r) => r.id !== id));
  }

  const selectedPreset =
    visiblePresets.find((p) => p.key === draft.presetKey) ?? visiblePresets[0];
  const draftUsesCadence = !EVENT_DRIVEN_PRESETS.has(draft.presetKey);
  const cryptoSymbolError =
    symbolMode === "crypto" ? validateCryptoSymbol(draft.symbol) : null;
  const canAddRun =
    Boolean(draft.symbol) && Boolean(draft.startDate) && draft.durationDays >= 1 && !cryptoSymbolError;

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-y-auto">
      <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
        Run Queue
      </p>

      {runs.length === 0 && !adding && (
        <p className="text-[12px] text-text-secondary leading-relaxed">
          No runs added yet. Each run has a preset, symbol, start date, and duration.
        </p>
      )}

      {runs.map((run, index) => {
        const preset = STRATEGY_PRESETS.find((p) => p.key === run.presetKey);
        const endDate = addDaysIso(run.startDate, run.durationDays);
        const cadenceLabel = EVENT_DRIVEN_PRESETS.has(run.presetKey)
          ? "event-driven"
          : `every ${run.cadenceDays}d`;
        return (
          <div key={run.id} className="rounded border border-border bg-surface-2 px-3 py-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                Run {index + 1}
              </span>
              <button
                type="button"
                onClick={() => removeRun(run.id)}
                disabled={running}
                className="text-[11px] text-text-secondary hover:text-sell disabled:opacity-40"
              >
                ✕
              </button>
            </div>
            <p className="text-sm font-semibold text-text-primary">{run.symbol}</p>
            <p className="text-[11px] text-text-secondary">{preset?.label ?? run.presetKey}</p>
            <p className="text-[11px] text-text-secondary tabular-nums mt-0.5">
              {run.startDate} → {endDate} · {durationLabel(run.durationDays)} · {cadenceLabel} · ${run.totalAmount.toLocaleString()}
            </p>
          </div>
        );
      })}

      {adding ? (
        <div className="rounded border border-accent/40 bg-accent/5 px-3 py-3 flex flex-col gap-2.5">
          <p className="text-[12px] uppercase tracking-widest text-accent font-semibold">New Run</p>

          <div>
            <label className="mb-1 block text-[11px] text-text-secondary">Preset</label>
            <select
              className={input}
              value={draft.presetKey}
              onChange={(e) => {
                const nextPreset = e.target.value as StrategyPresetKey;
                setDraft((d) => ({
                  ...d,
                  presetKey: nextPreset,
                  cadenceDays: EVENT_DRIVEN_PRESETS.has(nextPreset) ? 1 : d.cadenceDays,
                }));
              }}
            >
              {visiblePresets.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="mt-0.5 text-[11px] text-text-secondary">{selectedPreset.suitableFor}</p>
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-text-secondary">Symbol</label>
            <input
              className={input}
              value={draft.symbol}
              onChange={(e) =>
                patchDraft(
                  "symbol",
                  symbolMode === "crypto"
                    ? normalizeCryptoInput(e.target.value)
                    : e.target.value.toUpperCase()
                )
              }
              placeholder={defaultSymbol}
            />
            {cryptoSymbolError ? (
              <p className="mt-0.5 text-[11px] text-sell">{cryptoSymbolError}</p>
            ) : null}
            {symbolMode === "crypto" && !cryptoSymbolError ? (
              <p className="mt-0.5 text-[11px] text-text-secondary">
                Crypto-only symbols. Examples: BTC, ETH, SOL, BTC/USD, ETH/USDT
              </p>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-text-secondary">Start Date</label>
            <input
              type="date"
              className={input}
              value={draft.startDate}
              onChange={(e) => patchDraft("startDate", e.target.value)}
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-text-secondary">Duration</label>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {DURATION_OPTIONS.map((o) => (
                <button
                  key={o.durationDays}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, durationDays: o.durationDays, cadenceDays: o.cadenceDays }))}
                  className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                    draft.durationDays === o.durationDays
                      ? "border-accent/60 bg-accent/10 text-accent"
                      : "border-border bg-surface-3 text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={1}
              className={input}
              value={draft.durationDays}
              onChange={(e) => patchDraft("durationDays", Math.max(1, +e.target.value))}
              placeholder="Custom days"
            />
            <p className="mt-0.5 text-[11px] text-text-secondary">
              {durationLabel(draft.durationDays)}
            </p>
          </div>

          {draftUsesCadence ? (
            <div>
              <label className="mb-1 block text-[11px] text-text-secondary">Cadence (days / tranche)</label>
              <input
                type="number"
                min={1}
                max={365}
                className={input}
                value={draft.cadenceDays}
                onChange={(e) => patchDraft("cadenceDays", Math.max(1, +e.target.value))}
              />
              <p className="mt-0.5 text-[11px] text-text-secondary">
                ~{Math.ceil(draft.durationDays / Math.max(1, draft.cadenceDays))} tranches
              </p>
            </div>
          ) : (
            <div className="rounded border border-border bg-surface-2 px-2.5 py-2 text-[11px] text-text-secondary">
              This preset is event-driven. Cadence is not used.
            </div>
          )}

          <div>
            <label className="mb-1 block text-[11px] text-text-secondary">Amount ($)</label>
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
              disabled={!canAddRun}
              className="flex-1 rounded bg-accent py-1.5 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
            >
              Add to Queue
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setDraft(defaultDraft(defaultSymbol));
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

function normalizeCryptoInput(value: string): string {
  return value.trim().toUpperCase().replace(/[-_]/g, "/");
}

function validateCryptoSymbol(value: string): string | null {
  const normalized = normalizeCryptoInput(value);
  if (!normalized) {
    return "Enter a crypto ticker.";
  }

  if (!normalized.includes("/")) {
    return SUPPORTED_CRYPTO_BASES.has(normalized)
      ? null
      : "Unsupported crypto ticker. Use symbols like BTC, ETH, SOL, or BTC/USD.";
  }

  const [base, quote, ...rest] = normalized.split("/");
  if (!base || !quote || rest.length > 0) {
    return "Use format BASE/QUOTE, for example BTC/USD.";
  }

  if (!SUPPORTED_CRYPTO_BASES.has(base)) {
    return "Unsupported base asset for crypto mode.";
  }

  if (!SUPPORTED_CRYPTO_QUOTES.has(quote)) {
    return "Unsupported quote asset. Use USD, USDT, USDC, or BTC.";
  }

  return null;
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

const SUPPORTED_CRYPTO_QUOTES = new Set(["USD", "USDT", "USDC", "BTC"]);
