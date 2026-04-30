import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { AccountType, BacktestResult, BacktestTrade, runBacktest } from "../lib/backtest";
import { formatAuthDependencyError } from "../lib/authErrors";
import { Bar, SIGNAL_META, SignalWeight } from "../lib/signals";
import BacktestChart from "./BacktestChart";
import { STRATEGY_PRESETS, StrategyPresetKey } from "./StrategyBuilder";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const API_PREFIX = API_BASE_URL ? `${API_BASE_URL}/api` : "/api";
const AUTH_TOKEN_STORAGE_KEY = "smart_scale_auth_token";

interface WatchlistExecutionConfig {
  timeframe: "1Day" | "1Hour";
  signals: SignalWeight[];
  buyThreshold: number;
  sellThreshold: number;
}

interface UserWatchlist {
  userId: string;
  name?: string;
  assetClass?: string;
  symbols: string[];
  enabled: boolean;
  config: WatchlistExecutionConfig;
  createdAt: string;
  updatedAt: string;
}

interface WatchlistSignalEvent {
  id: string;
  userId: string;
  symbol: string;
  timeframe: "1Day" | "1Hour";
  action: "buy" | "sell";
  signalScore: number;
  rationale: string;
  barTime: string;
  generatedAt: string;
  watchlistUpdatedAt: string;
  dispatchStatus: "sent" | "skipped" | "failed";
  dispatchStatusCode: number | null;
  dispatchError: string | null;
}

interface WatchlistMonitorStatus {
  running: boolean;
  watchlistCount: number;
  watchedSymbolCount: number;
  signalCount: number;
  lastRunByTimeframe: Record<"1Day" | "1Hour", string | null>;
  lastError: string | null;
}

type AssetClass = "stocks_etf" | "crypto";

type WatchlistForm = {
  enabled: boolean;
  symbolsText: string;
  timeframe: "1Day" | "1Hour";
  buyThreshold: number;
  sellThreshold: number;
  signals: SignalWeight[];
};

type WatchlistsPayload = {
  watchlists?: UserWatchlist[];
  monitor?: WatchlistMonitorStatus;
  error?: string;
};

type WatchlistSignalsPayload = {
  signals?: WatchlistSignalEvent[];
  error?: string;
};

type UpsertPayload = {
  watchlist?: UserWatchlist;
  error?: string;
};

type MonitorPayload = {
  monitor?: WatchlistMonitorStatus;
};

type WatchlistBacktestForm = {
  startDate: string;
  scaleInWindowDays: number;
  scaleOutStartDate: string;
  scaleOutWindowDays: number;
  totalAmount: number;
  cadenceDays: number;
  randomEnsembleSamples: number;
  aggressiveness: number;
  accountType: AccountType;
  washSaleWindowDays: number;
};

type WatchlistBacktestRun = {
  symbol: string;
  bars: Bar[];
  result: BacktestResult | null;
  error: string | null;
};

const inputClass =
  "w-full rounded border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent/60 focus:outline-none";
const fieldLabelClass =
  "mb-1 block text-[10px] font-semibold uppercase tracking-widest text-text-secondary";

export default function WatchlistPage({
  title,
  description,
  watchlistUserId,
  defaultSymbols,
  defaultTimeframe,
  defaultPresetKey,
  symbolHint,
  assetClass,
  displayName,
  onBack,
}: {
  title: string;
  description: string;
  watchlistUserId: string;
  defaultSymbols: string[];
  defaultTimeframe: "1Day" | "1Hour";
  defaultPresetKey: StrategyPresetKey;
  symbolHint: string;
  assetClass: AssetClass;
  displayName?: string;
  onBack?: () => void;
}) {
  const defaultPreset = STRATEGY_PRESETS.find((preset) => preset.key === defaultPresetKey);
  const fallbackPreset = defaultPreset ?? STRATEGY_PRESETS[0];

  const [form, setForm] = useState<WatchlistForm>(() => ({
    enabled: true,
    symbolsText: defaultSymbols.join(", "),
    timeframe: defaultTimeframe,
    buyThreshold: 0.7,
    sellThreshold: 0.3,
    signals: cloneSignals(fallbackPreset.config.signals),
  }));
  const [selectedPresetKey, setSelectedPresetKey] = useState<StrategyPresetKey>(fallbackPreset.key);
  const [savedWatchlist, setSavedWatchlist] = useState<UserWatchlist | null>(null);
  const [monitor, setMonitor] = useState<WatchlistMonitorStatus | null>(null);
  const [signals, setSignals] = useState<WatchlistSignalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [backtestOpen, setBacktestOpen] = useState(false);
  const [backtestForm, setBacktestForm] = useState<WatchlistBacktestForm>(() =>
    defaultBacktestForm(assetClass)
  );
  const [backtestRuns, setBacktestRuns] = useState<WatchlistBacktestRun[]>([]);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const [runningBacktest, setRunningBacktest] = useState(false);
  const [backtestProgress, setBacktestProgress] = useState<{ completed: number; total: number } | null>(
    null
  );
  const [expandedBacktestTradeRows, setExpandedBacktestTradeRows] = useState<Set<string>>(new Set());

  const filteredSignals = useMemo(
    () => signals.filter((signal) => signal.userId === watchlistUserId),
    [signals, watchlistUserId]
  );

  const watchlistSymbols = useMemo(() => parseSymbols(form.symbolsText), [form.symbolsText]);

  const successfulBacktestRuns = useMemo(
    () => backtestRuns.filter((run) => run.result),
    [backtestRuns]
  );

  const currentSignalsBySymbol = useMemo(() => {
    const map = new Map<string, WatchlistSignalEvent>();
    for (const signal of filteredSignals) {
      const existing = map.get(signal.symbol);
      if (!existing || signal.generatedAt > existing.generatedAt) {
        map.set(signal.symbol, signal);
      }
    }
    return map;
  }, [filteredSignals]);

  const scaleOutDateError = useMemo(() => {
    if (
      backtestForm.scaleOutStartDate &&
      backtestForm.startDate &&
      backtestForm.scaleOutStartDate <= backtestForm.startDate
    ) {
      return "Scale-out start date must be after the backtest start date.";
    }
    return null;
  }, [backtestForm.scaleOutStartDate, backtestForm.startDate]);

  const loadData = useCallback(
    async (options: { silent: boolean }) => {
      if (options.silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const authHeaders = buildWatchlistAuthHeaders();
        const [watchlistsRes, signalsRes] = await Promise.all([
          fetch(`${API_PREFIX}/bot/watchlists`, {
            headers: authHeaders,
          }),
          fetch(`${API_PREFIX}/bot/watchlist-signals?limit=100`, {
            headers: authHeaders,
          }),
        ]);

        const watchlistsBody = (await watchlistsRes.json().catch(() => ({}))) as WatchlistsPayload;
        const signalsBody = (await signalsRes.json().catch(() => ({}))) as WatchlistSignalsPayload;

        if (!watchlistsRes.ok) {
          throw new Error(watchlistsBody.error ?? `Watchlists request failed (${watchlistsRes.status})`);
        }
        if (!signalsRes.ok) {
          throw new Error(signalsBody.error ?? `Signals request failed (${signalsRes.status})`);
        }

        const loadedWatchlists = Array.isArray(watchlistsBody.watchlists)
          ? watchlistsBody.watchlists
          : [];
        const loadedSignals = Array.isArray(signalsBody.signals) ? signalsBody.signals : [];
        const targetWatchlist =
          loadedWatchlists.find((watchlist) => watchlist.userId === watchlistUserId) ?? null;

        setSavedWatchlist(targetWatchlist);
        setMonitor(watchlistsBody.monitor ?? null);
        setSignals(loadedSignals);

        if (targetWatchlist) {
          setForm({
            enabled: targetWatchlist.enabled,
            symbolsText: targetWatchlist.symbols.join(", "),
            timeframe: targetWatchlist.config.timeframe,
            buyThreshold: targetWatchlist.config.buyThreshold,
            sellThreshold: targetWatchlist.config.sellThreshold,
            signals: cloneSignals(targetWatchlist.config.signals),
          });
          setSelectedPresetKey(
            detectPresetKey(targetWatchlist.config) ??
              fallbackPreset.key
          );
        } else {
          setForm({
            enabled: true,
            symbolsText: defaultSymbols.join(", "),
            timeframe: defaultTimeframe,
            buyThreshold: 0.7,
            sellThreshold: 0.3,
            signals: cloneSignals(fallbackPreset.config.signals),
          });
          setSelectedPresetKey(fallbackPreset.key);
        }

        setError(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unable to load watchlist state.";
        setError(formatAuthDependencyError(msg));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [defaultSymbols, defaultTimeframe, fallbackPreset, watchlistUserId]
  );

  useEffect(() => {
    void loadData({ silent: false });
  }, [loadData]);

  const fetchBarsForBacktest = useCallback(
    async (symbol: string, timeframe: "1Day" | "1Hour"): Promise<Bar[]> => {
      const params = new URLSearchParams({
        symbol: normalizeSymbol(symbol),
        range: "2y",
      });
      if (timeframe === "1Hour") {
        params.set("timeframe", "1Hour");
      }

      const response = await fetch(`${API_PREFIX}/bars?${params.toString()}`);
      const payload = (await response.json().catch(() => ({}))) as {
        bars?: Bar[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? `Bars request failed (${response.status})`);
      }

      return Array.isArray(payload.bars) ? payload.bars : [];
    },
    []
  );

  function applyPreset(key: StrategyPresetKey) {
    const preset = STRATEGY_PRESETS.find((candidate) => candidate.key === key);
    if (!preset) return;

    setSelectedPresetKey(key);
    setForm((current) => ({
      ...current,
      timeframe: preset.timeframe ?? current.timeframe,
      signals: cloneSignals(preset.config.signals),
    }));
    setMessage(`Applied preset: ${preset.label}`);
  }

  async function saveWatchlist() {
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const symbols = parseSymbols(form.symbolsText);
      if (symbols.length === 0) {
        throw new Error("Add at least one symbol.");
      }

      const symbolValidationError = validateSymbolsForAssetClass(symbols, assetClass);
      if (symbolValidationError) {
        throw new Error(symbolValidationError);
      }

      if (form.buyThreshold <= form.sellThreshold) {
        throw new Error("Buy threshold must be greater than sell threshold.");
      }

      const payload = {
        name: title,
        displayName,
        assetClass,
        symbols,
        enabled: form.enabled,
        config: {
          timeframe: form.timeframe,
          buyThreshold: form.buyThreshold,
          sellThreshold: form.sellThreshold,
          signals: form.signals,
        },
      };

      const response = await fetch(
        `${API_PREFIX}/bot/watchlists/${encodeURIComponent(watchlistUserId)}`,
        {
          method: "PUT",
          headers: buildWatchlistAuthHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(payload),
        }
      );
      const body = (await response.json().catch(() => ({}))) as UpsertPayload;
      if (!response.ok) {
        throw new Error(body.error ?? `Save failed (${response.status})`);
      }

      setSavedWatchlist(body.watchlist ?? null);
      setMessage("Watchlist saved.");
      await loadData({ silent: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed.";
      setError(formatAuthDependencyError(msg));
    } finally {
      setSaving(false);
    }
  }

  async function runWatchlistBacktest() {
    setBacktestError(null);
    setBacktestRuns([]);
    setBacktestProgress(null);
    setExpandedBacktestTradeRows(new Set());
    setRunningBacktest(true);

    try {
      if (watchlistSymbols.length === 0) {
        throw new Error("Add symbols to the watchlist before running backtests.");
      }

      const symbolValidationError = validateSymbolsForAssetClass(watchlistSymbols, assetClass);
      if (symbolValidationError) {
        throw new Error(symbolValidationError);
      }

      if (backtestForm.totalAmount <= 0) {
        throw new Error("Backtest amount must be greater than 0.");
      }
      if (backtestForm.cadenceDays <= 0) {
        throw new Error("Cadence must be at least 1 day.");
      }
      if (backtestForm.scaleInWindowDays <= 0 || backtestForm.scaleOutWindowDays <= 0) {
        throw new Error("Scale-in and scale-out windows must be at least 1 day.");
      }
      if (
        backtestForm.scaleOutStartDate &&
        backtestForm.scaleOutStartDate <= backtestForm.startDate
      ) {
        throw new Error(
          "Scale-out start date must be after the backtest start date. Use 'Sync Scale-Out Start' to auto-fill."
        );
      }

      const benchmarkSymbol = assetClass === "crypto" ? "BTC/USD" : "^GSPC";
      const normalizedBenchmark = normalizeSymbol(benchmarkSymbol);
      let benchmarkBarsCache: Bar[] | null = null;
      const runs: WatchlistBacktestRun[] = [];

      for (let i = 0; i < watchlistSymbols.length; i++) {
        const symbol = watchlistSymbols[i];
        setBacktestProgress({ completed: i, total: watchlistSymbols.length });

        try {
          const symbolBars = await fetchBarsForBacktest(symbol, form.timeframe);
          if (symbolBars.length === 0) {
            throw new Error("No bars loaded.");
          }

          let benchmarkBars: Bar[] = [];
          if (normalizeSymbol(symbol) === normalizedBenchmark) {
            benchmarkBars = symbolBars;
          } else {
            if (!benchmarkBarsCache) {
              benchmarkBarsCache = await fetchBarsForBacktest(benchmarkSymbol, "1Day");
            }
            benchmarkBars = benchmarkBarsCache;
          }

          const computed = runBacktest({
            symbol: normalizeSymbol(symbol),
            bars: symbolBars,
            benchmarkBars,
            benchmarkSymbol,
            startDate: backtestForm.startDate,
            scaleOutStartDate: backtestForm.scaleOutStartDate,
            scaleInWindowDays: backtestForm.scaleInWindowDays,
            scaleOutWindowDays: backtestForm.scaleOutWindowDays,
            cadenceDays: backtestForm.cadenceDays,
            totalAmount: backtestForm.totalAmount,
            aggressiveness: backtestForm.aggressiveness,
            signals: form.signals,
            randomEnsembleSamples: backtestForm.randomEnsembleSamples,
            accountType: backtestForm.accountType,
            washSaleWindowDays: backtestForm.washSaleWindowDays,
            applyWashSaleRule: !isLikelyCryptoSymbol(symbol),
          });

          if (!computed) {
            throw new Error("No trades generated in the selected windows.");
          }

          runs.push({
            symbol,
            bars: symbolBars,
            result: computed,
            error: null,
          });
        } catch (err) {
          runs.push({
            symbol,
            bars: [],
            result: null,
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }

        setBacktestProgress({ completed: i + 1, total: watchlistSymbols.length });
      }

      runs.sort((a, b) => {
        if (a.result && !b.result) return -1;
        if (!a.result && b.result) return 1;
        if (!a.result && !b.result) return a.symbol.localeCompare(b.symbol);

        const aScore = a.result!.performance.returnComparison.strategyVsRandomPct;
        const bScore = b.result!.performance.returnComparison.strategyVsRandomPct;
        if (bScore !== aScore) return bScore - aScore;

        return b.result!.performance.profitPct - a.result!.performance.profitPct;
      });

      setBacktestRuns(runs);

      if (!runs.some((run) => run.result)) {
        setBacktestError(
          "Backtests finished, but no symbol produced trades for the selected setup."
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Backtest run failed.";
      setBacktestError(msg);
    } finally {
      setRunningBacktest(false);
    }
  }

  function toggleBacktestTrades(runKey: string) {
    setExpandedBacktestTradeRows((previous) => {
      const next = new Set(previous);
      if (next.has(runKey)) {
        next.delete(runKey);
      } else {
        next.add(runKey);
      }
      return next;
    });
  }

  async function runScanNow() {
    setScanning(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(
        `${API_PREFIX}/bot/watchlists/scan?timeframe=${form.timeframe}`,
        {
          method: "POST",
          headers: buildWatchlistAuthHeaders(),
        }
      );
      const body = (await response.json().catch(() => ({}))) as MonitorPayload & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `Scan failed (${response.status})`);
      }

      if (body.monitor) {
        setMonitor(body.monitor);
      }

      setMessage("Watchlist scan started.");
      await loadData({ silent: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Scan failed.";
      setError(formatAuthDependencyError(msg));
    } finally {
      setScanning(false);
    }
  }

  async function deleteWatchlist() {
    if (!savedWatchlist) {
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(
        `${API_PREFIX}/bot/watchlists/${encodeURIComponent(watchlistUserId)}`,
        {
          method: "DELETE",
          headers: buildWatchlistAuthHeaders(),
        }
      );
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `Delete failed (${response.status})`);
      }

      setMessage("Watchlist deleted.");
      await loadData({ silent: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Delete failed.";
      setError(formatAuthDependencyError(msg));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full overflow-auto p-4">
      <section className="mb-4 flex flex-wrap items-start gap-3">
        <div className="flex items-start gap-2">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="mt-0.5 rounded border border-border bg-surface-2 px-2.5 py-1 text-[10px] text-text-secondary hover:text-text-primary"
            >
              ← Back
            </button>
          ) : null}
          <div>
            <h2 className="mb-1 text-sm font-semibold">{title}</h2>
            <p className="max-w-4xl text-xs text-text-secondary">{description}</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadData({ silent: true })}
            disabled={loading || refreshing}
            className="rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading || refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => void runScanNow()}
            disabled={loading || scanning}
            className="rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {scanning ? "Scanning..." : "Scan Now"}
          </button>
          <button
            type="button"
            onClick={() => void saveWatchlist()}
            disabled={loading || saving}
            className="rounded border border-buy/40 bg-buy/10 px-3 py-1.5 text-xs text-buy transition-colors hover:bg-buy/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save Watchlist"}
          </button>
        </div>
      </section>

      {error ? (
        <div className="mb-3 rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="mb-3 rounded border border-buy/30 bg-buy/10 px-3 py-2 text-xs text-buy">
          {message}
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Monitor"
          value={monitor?.running ? "Running" : "Stopped"}
          sub={`Watchlists ${monitor?.watchlistCount ?? 0}`}
          valueClassName={monitor?.running ? "text-buy" : "text-sell"}
        />
        <MetricCard
          label="Symbols Watched"
          value={(monitor?.watchedSymbolCount ?? 0).toString()}
          sub={`Signals retained ${monitor?.signalCount ?? 0}`}
        />
        <MetricCard
          label="Last Hourly Run"
          value={formatTime(monitor?.lastRunByTimeframe?.["1Hour"] ?? null)}
          sub="Timeframe 1Hour"
        />
        <MetricCard
          label="Last Daily Run"
          value={formatTime(monitor?.lastRunByTimeframe?.["1Day"] ?? null)}
          sub="Timeframe 1Day"
        />
      </div>

      <section className="mb-4 rounded border border-border bg-surface-1">
        <div className="border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
          Watchlist Config
        </div>
        <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-2">
          <div>
            <label className={fieldLabelClass}>Symbols</label>
            <textarea
              className={`${inputClass} min-h-32`}
              value={form.symbolsText}
              onChange={(event) =>
                setForm((current) => ({ ...current, symbolsText: event.target.value.toUpperCase() }))
              }
              placeholder={symbolHint}
            />
            <p className="mt-1 text-[10px] text-text-secondary">
              Use commas, spaces, or new lines. Example: {symbolHint}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <div>
              <label className={fieldLabelClass}>Signal Preset</label>
              <div className="flex items-center gap-2">
                <select
                  className={inputClass}
                  value={selectedPresetKey}
                  onChange={(event) =>
                    setSelectedPresetKey(event.target.value as StrategyPresetKey)
                  }
                >
                  {STRATEGY_PRESETS.map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => applyPreset(selectedPresetKey)}
                  className="rounded border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary"
                >
                  Apply
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={fieldLabelClass}>Timeframe</label>
                <select
                  className={inputClass}
                  value={form.timeframe}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      timeframe: event.target.value as "1Day" | "1Hour",
                    }))
                  }
                >
                  <option value="1Day">1Day</option>
                  <option value="1Hour">1Hour</option>
                </select>
              </div>
              <label className="mt-5 flex items-center gap-2 text-xs text-text-primary">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-buy"
                  checked={form.enabled}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                Enabled
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={fieldLabelClass}>Buy Threshold</label>
                <input
                  className={inputClass}
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.buyThreshold}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      buyThreshold: Number(event.target.value),
                    }))
                  }
                />
              </div>
              <div>
                <label className={fieldLabelClass}>Sell Threshold</label>
                <input
                  className={inputClass}
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.sellThreshold}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      sellThreshold: Number(event.target.value),
                    }))
                  }
                />
              </div>
            </div>

            <div className="rounded border border-border bg-surface-2 p-2">
              <p className="mb-1 text-[10px] uppercase tracking-wide text-text-secondary">
                Active Signals
              </p>
              <div className="flex flex-wrap gap-1.5">
                {form.signals.map((signalWeight, idx) => (
                  <span
                    key={`${signalWeight.signal.type}-${idx}`}
                    className="rounded border border-border/80 bg-surface-0/80 px-2 py-0.5 text-[10px] text-text-primary"
                  >
                    {formatSignalWeight(signalWeight)}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="lg:col-span-2 rounded border border-border bg-surface-2">
              <button
                type="button"
                onClick={() => setBacktestOpen((open) => !open)}
                className="flex w-full items-center justify-between px-3 py-2 text-left"
              >
                <span className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
                  Watchlist Backtest
                </span>
                <span className="text-[10px] text-accent">{backtestOpen ? "Collapse" : "Expand"}</span>
              </button>

              {backtestOpen && (
                <div className="border-t border-border p-3">
                  <p className="text-[10px] text-text-secondary">
                    Runs the current watchlist strategy across all watchlist symbols using the
                    configured signals and timeframe.
                  </p>

                  <div className="mt-2 rounded border border-border/70 bg-surface-0/70 px-2.5 py-2 text-[10px] text-text-secondary">
                    <p>
                      Timeframe: <span className="text-text-primary">{form.timeframe}</span>
                    </p>
                    <p className="mt-1">
                      Symbols in run: <span className="text-text-primary">{watchlistSymbols.length}</span>
                    </p>
                    <p className="mt-1">
                      Active signals: <span className="text-text-primary">{form.signals.length}</span>
                    </p>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div>
                      <label className={fieldLabelClass}>Start Date</label>
                      <input
                        type="date"
                        className={inputClass}
                        value={backtestForm.startDate}
                        onChange={(event) =>
                          setBacktestForm((current) => ({
                            ...current,
                            startDate: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className={fieldLabelClass}>Scale-Out Start Date</label>
                      <input
                        type="date"
                        className={`${inputClass} ${scaleOutDateError ? "border-sell/60" : ""}`}
                        value={backtestForm.scaleOutStartDate}
                        onChange={(event) =>
                          setBacktestForm((current) => ({
                            ...current,
                            scaleOutStartDate: event.target.value,
                          }))
                        }
                      />
                      {scaleOutDateError ? (
                        <p className="mt-0.5 text-[10px] text-sell">{scaleOutDateError}</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className={fieldLabelClass}>Scale-In Window (days)</label>
                      <input
                        type="number"
                        min={1}
                        className={inputClass}
                        value={backtestForm.scaleInWindowDays}
                        onChange={(event) =>
                          setBacktestForm((current) => ({
                            ...current,
                            scaleInWindowDays: Math.max(1, Number(event.target.value)),
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className={fieldLabelClass}>Scale-Out Window (days)</label>
                      <input
                        type="number"
                        min={1}
                        className={inputClass}
                        value={backtestForm.scaleOutWindowDays}
                        onChange={(event) =>
                          setBacktestForm((current) => ({
                            ...current,
                            scaleOutWindowDays: Math.max(1, Number(event.target.value)),
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className={fieldLabelClass}>Amount ($)</label>
                      <input
                        type="number"
                        min={100}
                        className={inputClass}
                        value={backtestForm.totalAmount}
                        onChange={(event) =>
                          setBacktestForm((current) => ({
                            ...current,
                            totalAmount: Math.max(1, Number(event.target.value)),
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className={fieldLabelClass}>Cadence (days)</label>
                      <input
                        type="number"
                        min={1}
                        className={inputClass}
                        value={backtestForm.cadenceDays}
                        onChange={(event) =>
                          setBacktestForm((current) => ({
                            ...current,
                            cadenceDays: Math.max(1, Number(event.target.value)),
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className={fieldLabelClass}>Aggressiveness</label>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        className={inputClass}
                        value={backtestForm.aggressiveness}
                        onChange={(event) =>
                          setBacktestForm((current) => ({
                            ...current,
                            aggressiveness: clamp01(Number(event.target.value)),
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className={fieldLabelClass}>Random Ensemble Samples</label>
                      <input
                        type="number"
                        min={50}
                        className={inputClass}
                        value={backtestForm.randomEnsembleSamples}
                        onChange={(event) =>
                          setBacktestForm((current) => ({
                            ...current,
                            randomEnsembleSamples: Math.max(50, Number(event.target.value)),
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className={fieldLabelClass}>Account Type</label>
                      <select
                        className={inputClass}
                        value={backtestForm.accountType}
                        onChange={(event) =>
                          setBacktestForm((current) => ({
                            ...current,
                            accountType: event.target.value as AccountType,
                          }))
                        }
                      >
                        <option value="taxable">Taxable</option>
                        <option value="tax_advantaged">Tax-Advantaged</option>
                      </select>
                    </div>
                    <div>
                      <label className={fieldLabelClass}>Wash-Sale Window (days)</label>
                      <input
                        type="number"
                        min={1}
                        className={inputClass}
                        value={backtestForm.washSaleWindowDays}
                        onChange={(event) =>
                          setBacktestForm((current) => ({
                            ...current,
                            washSaleWindowDays: Math.max(1, Number(event.target.value)),
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setBacktestForm((current) => ({
                          ...current,
                          scaleOutStartDate: addDaysIso(
                            current.startDate,
                            current.scaleInWindowDays
                          ),
                        }))
                      }
                      className="rounded border border-border bg-surface-1 px-2.5 py-1.5 text-[10px] text-text-secondary hover:text-text-primary"
                    >
                      Sync Scale-Out Start
                    </button>
                    <button
                      type="button"
                      onClick={() => void runWatchlistBacktest()}
                      disabled={runningBacktest}
                      className="rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {runningBacktest ? "Running Backtests..." : "Run Backtest Across Watchlist"}
                    </button>
                    {backtestProgress ? (
                      <span className="text-[10px] text-text-secondary">
                        Progress {backtestProgress.completed}/{backtestProgress.total}
                      </span>
                    ) : null}
                  </div>

                  {backtestError ? (
                    <div className="mt-2 rounded border border-sell/30 bg-sell/10 px-2.5 py-2 text-[10px] text-sell">
                      {backtestError}
                    </div>
                  ) : null}

                  {backtestRuns.length > 0 ? (
                    <div className="mt-3 overflow-x-auto rounded border border-border/70">
                      <table className="w-full text-[10px]">
                        <thead className="uppercase tracking-wide text-text-secondary">
                          <tr>
                            <th className="px-2 py-2 text-left font-medium">#</th>
                            <th className="px-2 py-2 text-left font-medium">Symbol</th>
                            <th className="px-2 py-2 text-right font-medium">Return</th>
                            <th className="px-2 py-2 text-right font-medium">Benchmark</th>
                            <th className="px-2 py-2 text-right font-medium">Alpha</th>
                            <th className="px-2 py-2 text-right font-medium">Vs Random</th>
                            <th className="px-2 py-2 text-right font-medium">Vs Lump</th>
                            <th className="px-2 py-2 text-right font-medium">Vs Interval</th>
                            <th className="px-2 py-2 text-right font-medium">Trades</th>
                            <th className="px-2 py-2 text-right font-medium">Show Trades</th>
                            <th className="px-2 py-2 text-left font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {backtestRuns.map((run, index) => {
                            const result = run.result;
                            const returns = result?.performance.returnComparison;
                            const alpha =
                              result && result.benchmark
                                ? result.performance.profitPct - result.benchmark.profitPct
                                : null;
                            const tradeCount = result
                              ? result.scaleIn.trades.length + result.scaleOut.trades.length
                              : 0;
                            const runKey = `${run.symbol}-${index}`;
                            const tradesOpen = expandedBacktestTradeRows.has(runKey);

                            return (
                              <Fragment key={runKey}>
                                <tr className="border-t border-border/60">
                                  <td className="px-2 py-2 text-text-secondary">{index + 1}</td>
                                  <td className="px-2 py-2 text-text-primary">{run.symbol}</td>
                                  <td
                                    className={`px-2 py-2 text-right tabular-nums ${
                                      result && result.performance.profitPct >= 0
                                        ? "text-buy"
                                        : "text-sell"
                                    }`}
                                  >
                                    {result ? signedPct(result.performance.profitPct) : "-"}
                                  </td>
                                  <td
                                    className={`px-2 py-2 text-right tabular-nums ${
                                      result?.benchmark
                                        ? result.benchmark.profitPct >= 0
                                          ? "text-buy"
                                          : "text-sell"
                                        : "text-text-secondary"
                                    }`}
                                    title={result?.benchmark ? result.benchmark.symbol : undefined}
                                  >
                                    {result?.benchmark ? signedPct(result.benchmark.profitPct) : "-"}
                                  </td>
                                  <td
                                    className={`px-2 py-2 text-right tabular-nums ${
                                      alpha != null && alpha >= 0 ? "text-buy" : "text-sell"
                                    }`}
                                  >
                                    {alpha == null ? "-" : signedPct(alpha)}
                                  </td>
                                  <td
                                    className={`px-2 py-2 text-right tabular-nums ${
                                      returns && returns.strategyVsRandomPct >= 0
                                        ? "text-buy"
                                        : "text-sell"
                                    }`}
                                  >
                                    {returns ? signedPct(returns.strategyVsRandomPct) : "-"}
                                  </td>
                                  <td
                                    className={`px-2 py-2 text-right tabular-nums ${
                                      returns && returns.strategyVsLumpPct >= 0
                                        ? "text-buy"
                                        : "text-sell"
                                    }`}
                                  >
                                    {returns ? signedPct(returns.strategyVsLumpPct) : "-"}
                                  </td>
                                  <td
                                    className={`px-2 py-2 text-right tabular-nums ${
                                      returns && returns.strategyVsIntervalPct >= 0
                                        ? "text-buy"
                                        : "text-sell"
                                    }`}
                                  >
                                    {returns ? signedPct(returns.strategyVsIntervalPct) : "-"}
                                  </td>
                                  <td className="px-2 py-2 text-right tabular-nums text-text-primary">
                                    {tradeCount}
                                  </td>
                                  <td className="px-2 py-2 text-right">
                                    {result ? (
                                      <button
                                        type="button"
                                        onClick={() => toggleBacktestTrades(runKey)}
                                        className={`rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                                          tradesOpen
                                            ? "border-accent/50 bg-accent/20 text-accent"
                                            : "border-border bg-surface-2 text-text-secondary hover:text-text-primary"
                                        }`}
                                      >
                                        {tradesOpen ? "Hide" : "Show"}
                                      </button>
                                    ) : (
                                      <span className="text-[10px] text-text-secondary">N/A</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-2 text-text-secondary">
                                    {run.error ? run.error : "OK"}
                                  </td>
                                </tr>
                                {result && tradesOpen ? (
                                  <tr className="border-t border-border/60 bg-surface-0/35">
                                    <td colSpan={11} className="px-3 py-3">
                                      <div className="mb-3 rounded border border-border/70 bg-surface-1">
                                        <div className="border-b border-border/70 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
                                          Execution Chart
                                        </div>
                                        <div className="h-64 min-h-[240px] sm:h-56 sm:min-h-[220px]">
                                          <BacktestChart
                                            bars={run.bars}
                                            scaleInTrades={result.scaleIn.trades}
                                            scaleOutTrades={result.scaleOut.trades}
                                          />
                                        </div>
                                      </div>

                                      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
                                        <BacktestTradesAccordionTable
                                          title="Scale-In Trades"
                                          tone="buy"
                                          trades={result.scaleIn.trades}
                                        />
                                        <BacktestTradesAccordionTable
                                          title="Scale-Out Trades"
                                          tone="sell"
                                          trades={result.scaleOut.trades}
                                        />
                                      </div>
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {successfulBacktestRuns.length > 0 ? (
                    <p className="mt-2 text-[10px] text-text-secondary">
                      Completed {successfulBacktestRuns.length} successful run
                      {successfulBacktestRuns.length === 1 ? "" : "s"} out of {backtestRuns.length}.
                    </p>
                  ) : null}
                </div>
              )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2">
          <p className="text-[10px] text-text-secondary">
            Watchlist ID: <span className="text-text-primary">{watchlistUserId}</span>
            {savedWatchlist
              ? ` · Updated ${new Date(savedWatchlist.updatedAt).toLocaleString()}`
              : " · Not saved yet"}
          </p>
          <button
            type="button"
            onClick={() => void deleteWatchlist()}
            disabled={!savedWatchlist || saving}
            className="rounded border border-sell/40 bg-sell/10 px-2.5 py-1 text-[10px] uppercase tracking-wide text-sell transition-colors hover:bg-sell/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Delete Watchlist
          </button>
        </div>
      </section>

      <section className="rounded border border-border bg-surface-1">
        <div className="border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
          Current Signal Values ({watchlistSymbols.length} symbol{watchlistSymbols.length === 1 ? "" : "s"})
        </div>
        {loading ? (
          <div className="p-4 text-xs text-text-secondary">Loading signal data...</div>
        ) : watchlistSymbols.length === 0 ? (
          <div className="p-4 text-xs text-text-secondary">
            No symbols configured. Add symbols to the watchlist above.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Symbol</th>
                  <th className="px-4 py-2 text-left font-medium">Action</th>
                  <th className="px-4 py-2 text-right font-medium">Score</th>
                  <th className="px-4 py-2 text-left font-medium">Bar Time</th>
                  <th className="px-4 py-2 text-left font-medium">Signal Breakdown</th>
                </tr>
              </thead>
              <tbody>
                {watchlistSymbols.map((symbol) => {
                  const latest = currentSignalsBySymbol.get(symbol);
                  return (
                    <tr key={symbol} className="border-t border-border">
                      <td className="px-4 py-2 text-text-primary">{symbol}</td>
                      {latest ? (
                        <>
                          <td
                            className={`px-4 py-2 font-semibold uppercase tracking-wide ${
                              latest.action === "buy" ? "text-buy" : "text-sell"
                            }`}
                          >
                            {latest.action}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-text-primary">
                            {latest.signalScore.toFixed(4)}
                          </td>
                          <td className="px-4 py-2 text-text-secondary">
                            {new Date(latest.barTime).toLocaleString()}
                          </td>
                          <td className="px-4 py-2 text-text-secondary">{latest.rationale}</td>
                        </>
                      ) : (
                        <td colSpan={4} className="px-4 py-2 text-text-secondary">
                          No signal data yet — run a scan to populate.
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded border border-border bg-surface-1">
        <div className="border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
          Trade Record ({filteredSignals.length})
        </div>
        {loading ? (
          <div className="p-4 text-xs text-text-secondary">Loading watchlist activity...</div>
        ) : filteredSignals.length === 0 ? (
          <div className="p-4 text-xs text-text-secondary">
            No trade records for this watchlist yet. Save the watchlist and run a scan.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Time</th>
                  <th className="px-4 py-2 text-left font-medium">Symbol</th>
                  <th className="px-4 py-2 text-left font-medium">Action</th>
                  <th className="px-4 py-2 text-right font-medium">Score</th>
                  <th className="px-4 py-2 text-left font-medium">Dispatch</th>
                  <th className="px-4 py-2 text-left font-medium">Rationale</th>
                </tr>
              </thead>
              <tbody>
                {filteredSignals.map((signal) => (
                  <tr key={signal.id} className="border-t border-border">
                    <td className="px-4 py-2 text-text-secondary">
                      {new Date(signal.generatedAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-text-primary">
                      {signal.symbol}
                      <span className="ml-1 text-[10px] text-text-secondary">({signal.timeframe})</span>
                    </td>
                    <td
                      className={`px-4 py-2 font-semibold uppercase tracking-wide ${
                        signal.action === "buy" ? "text-buy" : "text-sell"
                      }`}
                    >
                      {signal.action}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-primary">
                      {signal.signalScore.toFixed(4)}
                    </td>
                    <td className="px-4 py-2 text-text-secondary">
                      {formatDispatchStatus(signal)}
                    </td>
                    <td className="px-4 py-2 text-text-secondary">{signal.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
  valueClassName = "text-text-primary",
}: {
  label: string;
  value: string;
  sub: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded border border-border bg-surface-1 p-3">
      <p className="mb-1 text-[11px] text-text-secondary">{label}</p>
      <p className={`text-base font-semibold tabular-nums ${valueClassName}`}>{value}</p>
      <p className="mt-0.5 text-[10px] text-text-secondary">{sub}</p>
    </div>
  );
}

function BacktestTradesAccordionTable({
  title,
  tone,
  trades,
}: {
  title: string;
  tone: "buy" | "sell";
  trades: BacktestTrade[];
}) {
  return (
    <section className="rounded border border-border/70 bg-surface-1">
      <div className="border-b border-border/70 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
        {title} ({trades.length})
      </div>
      {trades.length === 0 ? (
        <div className="px-2 py-3 text-[10px] text-text-secondary">No trades.</div>
      ) : (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-[10px]">
            <thead className="uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Date</th>
                <th className="px-2 py-1.5 text-right font-medium">Price</th>
                <th className="px-2 py-1.5 text-right font-medium">Amount</th>
                <th className="px-2 py-1.5 text-right font-medium">Shares</th>
                <th className="px-2 py-1.5 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade, index) => (
                <tr key={`${trade.date}-${index}`} className="border-t border-border/60">
                  <td className="px-2 py-1.5 text-text-secondary">{formatTradeDate(trade.date)}</td>
                  <td
                    className={`px-2 py-2 text-right tabular-nums ${
                      tone === "buy" ? "text-buy" : "text-sell"
                    }`}
                  >
                    {formatUsdSmall(trade.price)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-text-primary">
                    {formatUsdSmall(trade.amountUsd)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-text-primary">
                    {trade.shares.toFixed(6)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-text-secondary">
                    {trade.signalScore.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatTime(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function formatTradeDate(value: string): string {
  const dt = new Date(value);
  if (!Number.isFinite(dt.getTime())) return value;
  return dt.toLocaleString();
}

function formatUsdSmall(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseSymbols(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,\n]+/)
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean)
    )
  );
}

function validateSymbolsForAssetClass(symbols: string[], assetClass: AssetClass): string | null {
  if (assetClass === "crypto") {
    const invalid = symbols.find((symbol) => !isLikelyCryptoSymbol(symbol));
    if (invalid) {
      return `Crypto page only accepts crypto pairs. Invalid symbol: ${invalid}`;
    }
    return null;
  }

  const invalid = symbols.find((symbol) => isLikelyCryptoSymbol(symbol));
  if (invalid) {
    return `Stocks/ETF page only accepts equity/ETF symbols. Invalid symbol: ${invalid}`;
  }
  return null;
}

function isLikelyCryptoSymbol(symbol: string): boolean {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return false;
  if (normalized.includes("/")) return true;
  return /^[A-Z0-9]{2,10}[-_](USD|USDT|USDC|BTC|ETH|EUR|GBP|JPY)$/.test(normalized);
}

function defaultBacktestForm(assetClass: AssetClass): WatchlistBacktestForm {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const startDate = start.toISOString().slice(0, 10);
  const scaleInWindowDays = assetClass === "crypto" ? 14 : 30;

  return {
    startDate,
    scaleInWindowDays,
    scaleOutStartDate: addDaysIso(startDate, scaleInWindowDays),
    scaleOutWindowDays: assetClass === "crypto" ? 21 : 45,
    totalAmount: 10000,
    cadenceDays: assetClass === "crypto" ? 1 : 3,
    randomEnsembleSamples: 400,
    aggressiveness: 0.6,
    accountType: assetClass === "crypto" ? "tax_advantaged" : "taxable",
    washSaleWindowDays: 30,
  };
}

function addDaysIso(isoDate: string, days: number): string {
  const safeDays = Number.isFinite(days) ? days : 0;
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) {
    return isoDate;
  }
  date.setUTCDate(date.getUTCDate() + safeDays);
  return date.toISOString().slice(0, 10);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function signedPct(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatSignalWeight(signalWeight: SignalWeight): string {
  const meta = SIGNAL_META[signalWeight.signal.type];
  const label = meta?.label ?? signalWeight.signal.type;
  const pct = Math.round(signalWeight.weight * 100);
  const period = "period" in signalWeight.signal ? signalWeight.signal.period : null;

  if (signalWeight.signal.type === "bollinger_band") {
    return `${label} (${pct}%, p${period}, ${signalWeight.signal.std_dev}sd)`;
  }
  if (period != null) {
    return `${label} (${pct}%, p${period})`;
  }
  return `${label} (${pct}%)`;
}

function formatDispatchStatus(signal: WatchlistSignalEvent): string {
  if (signal.dispatchStatus === "sent") return "Sent";
  if (signal.dispatchStatus === "skipped") return "Skipped";
  return signal.dispatchError ? `Failed: ${signal.dispatchError}` : "Failed";
}

function detectPresetKey(config: WatchlistExecutionConfig): StrategyPresetKey | null {
  const signature = makeSignalsSignature(config.signals);

  for (const preset of STRATEGY_PRESETS) {
    const presetSignature = makeSignalsSignature(preset.config.signals);
    if (presetSignature !== signature) continue;

    if (preset.timeframe && preset.timeframe !== config.timeframe) {
      continue;
    }

    return preset.key;
  }

  return null;
}

function makeSignalsSignature(signals: SignalWeight[]): string {
  return signals
    .map((signalWeight) => {
      const signal = signalWeight.signal;
      const period = "period" in signal ? signal.period : "";
      const stdDev = signal.type === "bollinger_band" ? signal.std_dev : "";
      return `${signal.type}:${period}:${stdDev}:${signalWeight.weight.toFixed(5)}`;
    })
    .sort()
    .join("|");
}

function cloneSignals(signals: SignalWeight[]): SignalWeight[] {
  return signals.map((signalWeight) => ({
    weight: signalWeight.weight,
    signal: { ...signalWeight.signal },
  }));
}

function buildWatchlistAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const token = readStoredAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function readStoredAuthToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    if (typeof token !== "string") {
      return null;
    }

    const normalized = token.trim();
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}
