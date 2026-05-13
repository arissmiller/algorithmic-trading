import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "./store";
import StrategyBuilder, {
  buildPresetForm,
  STRATEGY_PRESETS,
  StrategyForm,
  StrategyPresetKey,
} from "./components/StrategyBuilder";
import BacktestMetrics from "./components/BacktestMetrics";
import TradeTable from "./components/TradeTable";
import PerformanceSummary from "./components/PerformanceSummary";
import BacktestChart from "./components/BacktestChart";
import AIControlCenter from "./components/AIControlCenter";
import PaperTradingBot from "./components/PaperTradingBot";
import AuthGate, { type AuthUser } from "./components/AuthGate";
import WatchlistsManagerPage from "./components/WatchlistsManagerPage";
import AccountPage from "./components/AccountPage";
import CommunityPage from "./components/CommunityPage";
import { BacktestResult, DirectionalBacktestResult, runBacktest } from "./lib/backtest";
import { Bar, SIGNAL_META, SignalWeight } from "./lib/signals";
import { formatAuthDependencyError } from "./lib/authErrors";

const STOCK_BENCHMARK_SYMBOL = "^GSPC";
const CRYPTO_BENCHMARK_SYMBOL = "BTC/USD";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const API_PREFIX = API_BASE_URL ? `${API_BASE_URL}/api` : "/api";
const AUTH_TOKEN_STORAGE_KEY = "smart_scale_auth_token";

type AlpacaAccountSnapshot = {
  account: {
    status: string;
    equity: number;
    cash: number;
    buyingPower: number;
    portfolioValue: number;
    longMarketValue: number;
    shortMarketValue: number;
  };
  positions: AlpacaPosition[];
  updatedAt: string;
};

type AlpacaPosition = {
  symbol: string;
  qty: number;
  side: "long" | "short";
  avgEntryPrice: number;
  currentPrice: number | null;
  marketValue: number;
  costBasis: number;
  unrealizedPl: number;
  unrealizedPlpc: number | null;
  changeToday: number | null;
};

type PresetBacktestRun = {
  presetKey: StrategyPresetKey;
  label: string;
  suitableFor: string;
  form: StrategyForm;
  result: BacktestResult | null;
  error: string | null;
};

type PresetRankingMetric =
  | "vs_random"
  | "vs_lump"
  | "vs_interval"
  | "profit_pct"
  | "alpha_pct";

type AssetClass = "stocks_etf" | "crypto";

type WatchlistSummary = {
  userId: string;
  name: string;
  assetClass?: AssetClass;
  symbols: string[];
  enabled: boolean;
  updatedAt: string;
};

type WatchlistBacktestRun = {
  symbol: string;
  bars: Bar[];
  result: BacktestResult | null;
  error: string | null;
};

type AppPage =
  | "stocks_backtest"
  | "crypto_backtest"
  | "watchlists"
  | "community"
  | "account";

const APP_PAGES: { id: AppPage; label: string }[] = [
  { id: "stocks_backtest", label: "Stocks/ETF Backtest" },
  { id: "crypto_backtest", label: "Crypto Backtest" },
  { id: "watchlists", label: "Watchlists" },
  { id: "community", label: "Community" },
  { id: "account", label: "Account" },
];

export default function App() {
  const {
    bars,
    barsLoading,
    result,
    running,
    runError,
    serverOnline,
    setBars,
    setBarsLoading,
    setBarsError,
    setResult,
    setRunning,
    setRunError,
    setServerOnline,
  } = useStore();
  const [lastRunSignals, setLastRunSignals] = useState<SignalWeight[]>([]);
  const [lastRunStrategyId, setLastRunStrategyId] = useState("");
  const [presetRuns, setPresetRuns] = useState<PresetBacktestRun[]>([]);
  const [selectedPresetKey, setSelectedPresetKey] = useState<StrategyPresetKey | null>(null);
  const [activePage, setActivePage] = useState<AppPage>("stocks_backtest");
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    async function check() {
      try {
        const r = await fetch(`${API_PREFIX}/health`);
        setServerOnline(r.ok);
      } catch {
        setServerOnline(false);
      }
    }

    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, [setServerOnline]);

  useEffect(() => {
    if (!result) return;

    const resultIsCrypto = isLikelyCryptoSymbol(result.symbol);
    const pageIsStocks = activePage === "stocks_backtest";
    const pageIsCrypto = activePage === "crypto_backtest";

    if ((pageIsStocks && resultIsCrypto) || (pageIsCrypto && !resultIsCrypto)) {
      setResult(null);
      setRunError(null);
      setPresetRuns([]);
      setSelectedPresetKey(null);
      setLastRunSignals([]);
      setBars([]);
    }
  }, [activePage, result, setBars, setResult, setRunError]);

  const barsCacheRef = useRef<Record<string, Bar[]>>({});

  async function fetchBars(
    symbol: string,
    options: { persist: boolean; timeframe?: "1Day" | "1Hour" }
  ): Promise<Bar[]> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const timeframe = options.timeframe ?? "1Day";
    const cacheKey = `${normalizedSymbol}::${timeframe}`;
    const cached = barsCacheRef.current[cacheKey];
    if (cached && cached.length > 0) {
      if (options.persist) {
        setBars(cached);
      }
      return cached;
    }

    setBarsLoading(true);
    if (options.persist) {
      setBarsError(null);
    }

    try {
      const params = new URLSearchParams({ symbol: normalizedSymbol, range: "2y" });
      if (timeframe === "1Hour") params.set("timeframe", "1Hour");
      const res = await fetch(`${API_PREFIX}/bars?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const json = await res.json();
      const loadedBars = (json.bars as Bar[]) ?? [];
      barsCacheRef.current[cacheKey] = loadedBars;

      if (options.persist) {
        setBars(loadedBars);
      }
      return loadedBars;
    } catch (e) {
      if (options.persist) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        setBarsError(msg);
        setBars([]);
      }
      throw e;
    } finally {
      setBarsLoading(false);
    }
  }

  function computeResultForForm(
    form: StrategyForm,
    assetBars: Bar[],
    benchmarkBars: Bar[],
    benchmarkSymbol: string
  ): BacktestResult {
    const symbol = normalizeSymbol(form.symbol);
    const applyWashSaleRule = !isLikelyCryptoSymbol(symbol);
    const windows = resolveBacktestWindows(form);
    const computed = runBacktest({
      symbol,
      bars: assetBars,
      benchmarkBars,
      benchmarkSymbol,
      totalAmount: form.totalAmount,
      cadenceDays: form.cadenceDays,
      startDate: windows.startDate,
      scaleOutStartDate: windows.scaleOutStartDate,
      scaleInWindowDays: windows.scaleInWindowDays,
      scaleOutWindowDays: windows.scaleOutWindowDays,
      randomEnsembleSamples: form.randomEnsembleSamples,
      aggressiveness: form.aggressiveness,
      accountType: form.accountType,
      washSaleWindowDays: form.washSaleWindowDays,
      applyWashSaleRule,
      signals: form.signals,
    });
    if (!computed) {
      throw new Error("No trades were generated. Try a different date window or cadence.");
    }
    return computed;
  }

  async function handleRun(form: StrategyForm, benchmarkSymbol: string) {
    setRunning(true);
    setRunError(null);

    try {
      const symbol = normalizeSymbol(form.symbol);
      const assetBars = await fetchBars(symbol, { persist: true, timeframe: form.timeframe });
      if (assetBars.length === 0) throw new Error("No bars loaded for symbol.");

      let benchmarkBars: Bar[] = [];
      let benchmarkError: string | null = null;

      if (normalizeSymbol(benchmarkSymbol) === symbol) {
        benchmarkBars = assetBars;
      } else {
        try {
          benchmarkBars = await fetchBars(benchmarkSymbol, { persist: false });
        } catch (e) {
          benchmarkError = e instanceof Error ? e.message : "Unknown benchmark error";
        }
      }

      const computed = computeResultForForm(
        form,
        assetBars,
        benchmarkBars,
        benchmarkSymbol
      );

      setResult(computed);
      setPresetRuns([]);
      setSelectedPresetKey(null);
      setLastRunSignals(form.signals.map((sw) => ({ ...sw, signal: { ...sw.signal } })));
      setLastRunStrategyId(makeStrategyId(form));

      if (benchmarkError) {
        setRunError(
          `Backtest ran, but benchmark (${benchmarkSymbol}) was unavailable: ${benchmarkError}`
        );
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Unknown error");
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  async function handleRunPresetSuite(
    baseForm: StrategyForm,
    benchmarkSymbol: string
  ) {
    setRunning(true);
    setRunError(null);

    try {
      const symbol = normalizeSymbol(baseForm.symbol);
      // Pre-fetch both daily and hourly bars so per-preset fetches hit cache
      const dailyBars = await fetchBars(symbol, { persist: true, timeframe: "1Day" });
      if (dailyBars.length === 0) throw new Error("No bars loaded for symbol.");
      await fetchBars(symbol, { persist: false, timeframe: "1Hour" }).catch(() => null);

      let benchmarkBars: Bar[] = [];
      let benchmarkError: string | null = null;
      if (normalizeSymbol(benchmarkSymbol) === symbol) {
        benchmarkBars = dailyBars;
      } else {
        try {
          benchmarkBars = await fetchBars(benchmarkSymbol, { persist: false });
        } catch (e) {
          benchmarkError = e instanceof Error ? e.message : "Unknown benchmark error";
        }
      }

      const runs: PresetBacktestRun[] = [];
      for (const preset of STRATEGY_PRESETS) {
        const form = buildPresetForm(baseForm, preset);
        const presetBars = await fetchBars(symbol, { persist: false, timeframe: form.timeframe });
        try {
          const computed = computeResultForForm(
            form,
            presetBars,
            benchmarkBars,
            benchmarkSymbol
          );
          runs.push({
            presetKey: preset.key,
            label: preset.label,
            suitableFor: preset.suitableFor,
            form,
            result: computed,
            error: null,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          runs.push({
            presetKey: preset.key,
            label: preset.label,
            suitableFor: preset.suitableFor,
            form,
            result: null,
            error: msg,
          });
        }
      }

      runs.sort((a, b) => {
        if (a.result && !b.result) return -1;
        if (!a.result && b.result) return 1;
        if (!a.result && !b.result) return a.label.localeCompare(b.label);
        const aScore = a.result!.performance.returnComparison.strategyVsRandomPct;
        const bScore = b.result!.performance.returnComparison.strategyVsRandomPct;
        if (bScore !== aScore) return bScore - aScore;
        return b.result!.performance.profitPct - a.result!.performance.profitPct;
      });

      setPresetRuns(runs);
      const best = runs.find((r) => r.result);
      setSelectedPresetKey(best?.presetKey ?? null);
      if (best?.result) {
        setResult(best.result);
        setLastRunSignals(best.form.signals.map((sw) => ({ ...sw, signal: { ...sw.signal } })));
        setLastRunStrategyId(makeStrategyId(best.form));
      } else {
        setResult(null);
      }

      if (benchmarkError) {
        setRunError(
          `Preset suite ran, but benchmark (${benchmarkSymbol}) was unavailable: ${benchmarkError}`
        );
      } else if (!best) {
        setRunError("Preset suite ran, but no preset produced trades for this configuration.");
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Unknown error");
      setPresetRuns([]);
      setSelectedPresetKey(null);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  function handleSelectPresetRun(presetKey: StrategyPresetKey) {
    const selected = presetRuns.find((run) => run.presetKey === presetKey);
    if (!selected || !selected.result) return;
    setSelectedPresetKey(presetKey);
    setResult(selected.result);
    setLastRunSignals(selected.form.signals.map((sw) => ({ ...sw, signal: { ...sw.signal } })));
    setLastRunStrategyId(makeStrategyId(selected.form));
  }

  async function runWatchlistBacktests(
    baseForm: StrategyForm,
    symbols: string[],
    benchmarkSymbol: string
  ): Promise<WatchlistBacktestRun[]> {
    const normalizedSymbols = Array.from(
      new Set(symbols.map((symbol) => normalizeSymbol(symbol)).filter(Boolean))
    );
    if (normalizedSymbols.length === 0) {
      return [];
    }

    const normalizedBenchmark = normalizeSymbol(benchmarkSymbol);
    let benchmarkBarsCache: Bar[] | null = null;
    const runs: WatchlistBacktestRun[] = [];

    for (const symbol of normalizedSymbols) {
      try {
        const form = { ...baseForm, symbol };
        const symbolBars = await fetchBars(symbol, { persist: false, timeframe: form.timeframe });
        if (symbolBars.length === 0) {
          throw new Error("No bars loaded.");
        }

        let benchmarkBars: Bar[] = [];
        if (symbol === normalizedBenchmark) {
          benchmarkBars = symbolBars;
        } else {
          if (!benchmarkBarsCache) {
            benchmarkBarsCache = await fetchBars(benchmarkSymbol, { persist: false });
          }
          benchmarkBars = benchmarkBarsCache;
        }

        const computed = computeResultForForm(form, symbolBars, benchmarkBars, benchmarkSymbol);
        runs.push({
          symbol,
          bars: symbolBars,
          result: computed,
          error: null,
        });
      } catch (e) {
        runs.push({
          symbol,
          bars: [],
          result: null,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
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

    return runs;
  }

  function handleLoadWatchlistRun(baseForm: StrategyForm, run: WatchlistBacktestRun) {
    if (!run.result) return;
    setBars(run.bars);
    setResult(run.result);
    setRunError(null);
    setPresetRuns([]);
    setSelectedPresetKey(null);
    setLastRunSignals(baseForm.signals.map((sw) => ({ ...sw, signal: { ...sw.signal } })));
    setLastRunStrategyId(makeStrategyId({ ...baseForm, symbol: run.symbol }));
  }

  return (
    <div className="flex h-screen flex-col bg-surface text-text-primary overflow-hidden">
      <AuthGate onAuthUserChange={setAuthUser} />
      <div className="pointer-events-none fixed left-1/2 top-2 z-50 -translate-x-1/2 rounded border-2 border-yellow-200 bg-yellow-300 px-4 py-1.5 text-center text-xs font-bold uppercase tracking-wide text-black shadow-[0_0_18px_rgba(253,224,71,0.55)]">
        Nothing here is intended as financial advice. All trades are virtual.
      </div>

      <header className="border-b border-border bg-surface-1 shadow-[0_0_18px_rgba(70,215,255,0.12)]">
        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3 pr-24">
          <span className="text-sm font-semibold tracking-tight">Smart Scale</span>
          <span
            className={`ml-auto h-2 w-2 rounded-full ${serverOnline ? "bg-buy" : "bg-sell"}`}
            title={serverOnline ? "API online" : "API offline"}
          />
          <span className="text-[10px] text-text-secondary">
            {serverOnline ? "API online" : "API offline"}
          </span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 py-2">
          {APP_PAGES.map((page) => {
            const active = page.id === activePage;
            return (
              <button
                key={page.id}
                type="button"
                onClick={() => setActivePage(page.id)}
                className={`rounded border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                  active
                    ? "border-accent/50 bg-accent/15 text-accent"
                    : "border-border bg-surface-2 text-text-secondary hover:text-text-primary"
                }`}
              >
                {page.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="flex-1 min-h-0">
        {activePage === "stocks_backtest" && (
          <BacktestingPage
            key="stocks_backtest"
            title="Stocks/ETF Backtesting"
            assetClass="stocks_etf"
            authUser={authUser}
            defaultSymbol="AAPL"
            running={running}
            runError={runError}
            barsLoading={barsLoading}
            bars={bars}
            strategySignals={lastRunSignals}
            result={result}
            onRun={(form) => handleRun(form, STOCK_BENCHMARK_SYMBOL)}
            onRunPresetSuite={(form) =>
              handleRunPresetSuite(form, STOCK_BENCHMARK_SYMBOL)
            }
            presetRuns={presetRuns}
            selectedPresetKey={selectedPresetKey}
            onSelectPresetRun={handleSelectPresetRun}
            onRunWatchlistBacktests={(form, symbols) =>
              runWatchlistBacktests(form, symbols, STOCK_BENCHMARK_SYMBOL)
            }
            onLoadWatchlistRun={handleLoadWatchlistRun}
            onOpenWatchlists={() => setActivePage("watchlists")}
          />
        )}

        {activePage === "crypto_backtest" && (
          <BacktestingPage
            key="crypto_backtest"
            title="Crypto Backtesting"
            assetClass="crypto"
            authUser={authUser}
            defaultSymbol="BTC/USD"
            running={running}
            runError={runError}
            barsLoading={barsLoading}
            bars={bars}
            strategySignals={lastRunSignals}
            result={result}
            onRun={(form) => handleRun(form, CRYPTO_BENCHMARK_SYMBOL)}
            onRunPresetSuite={(form) =>
              handleRunPresetSuite(form, CRYPTO_BENCHMARK_SYMBOL)
            }
            presetRuns={presetRuns}
            selectedPresetKey={selectedPresetKey}
            onSelectPresetRun={handleSelectPresetRun}
            onRunWatchlistBacktests={(form, symbols) =>
              runWatchlistBacktests(form, symbols, CRYPTO_BENCHMARK_SYMBOL)
            }
            onLoadWatchlistRun={handleLoadWatchlistRun}
            onOpenWatchlists={() => setActivePage("watchlists")}
          />
        )}

        {activePage === "watchlists" && (
          authUser ? (
            <WatchlistsManagerPage authUser={authUser} />
          ) : (
            <AuthRequiredPanel message="Sign in to view or manage your watchlists." />
          )
        )}

        {activePage === "community" && <CommunityPage />}

        {activePage === "account" && <AccountPage authUser={authUser} />}
      </main>
    </div>
  );
}

function AuthRequiredPanel({ message }: { message: string }) {
  return (
    <div className="h-full overflow-auto p-4">
      <section className="rounded border border-border bg-surface-1 p-4">
        <h2 className="mb-2 text-sm font-semibold">Authentication Required</h2>
        <p className="text-xs text-text-secondary">{message}</p>
      </section>
    </div>
  );
}


function BacktestingPage({
  title,
  assetClass,
  authUser,
  defaultSymbol,
  running,
  runError,
  barsLoading,
  bars,
  strategySignals,
  result,
  onRun,
  onRunPresetSuite,
  presetRuns,
  selectedPresetKey,
  onSelectPresetRun,
  onRunWatchlistBacktests,
  onLoadWatchlistRun,
  onOpenWatchlists,
}: {
  title: string;
  assetClass: AssetClass;
  authUser: AuthUser | null;
  defaultSymbol: string;
  running: boolean;
  runError: string | null;
  barsLoading: boolean;
  bars: Bar[];
  strategySignals: SignalWeight[];
  result: BacktestResult | null;
  onRun: (form: StrategyForm) => void;
  onRunPresetSuite: (form: StrategyForm) => void;
  presetRuns: PresetBacktestRun[];
  selectedPresetKey: StrategyPresetKey | null;
  onSelectPresetRun: (presetKey: StrategyPresetKey) => void;
  onRunWatchlistBacktests: (
    form: StrategyForm,
    symbols: string[]
  ) => Promise<WatchlistBacktestRun[]>;
  onLoadWatchlistRun: (form: StrategyForm, run: WatchlistBacktestRun) => void;
  onOpenWatchlists: () => void;
}) {
  const [activeForm, setActiveForm] = useState<StrategyForm | null>(null);
  const [rankBy, setRankBy] = useState<PresetRankingMetric>("vs_random");
  const [watchlists, setWatchlists] = useState<WatchlistSummary[]>([]);
  const [watchlistsLoading, setWatchlistsLoading] = useState(false);
  const [watchlistsError, setWatchlistsError] = useState<string | null>(null);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState("");
  const [watchlistRuns, setWatchlistRuns] = useState<WatchlistBacktestRun[]>([]);
  const [watchlistBacktestError, setWatchlistBacktestError] = useState<string | null>(null);
  const [runningWatchlistBacktest, setRunningWatchlistBacktest] = useState(false);
  const [loadedWatchlistRunSymbol, setLoadedWatchlistRunSymbol] = useState<string | null>(null);

  const loadWatchlists = useCallback(async () => {
    if (!authUser) {
      setWatchlists([]);
      setSelectedWatchlistId("");
      setWatchlistsError(null);
      return;
    }

    setWatchlistsLoading(true);
    try {
      const response = await fetch(`${API_PREFIX}/bot/watchlists`, {
        headers: buildWatchlistAuthHeaders(),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        watchlists?: WatchlistSummary[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? `Watchlists request failed (${response.status})`);
      }

      const allWatchlists = Array.isArray(payload.watchlists) ? payload.watchlists : [];
      const filteredWatchlists = allWatchlists.filter(
        (watchlist) => normalizeWatchlistAssetClass(watchlist.assetClass) === assetClass
      );

      setWatchlists(filteredWatchlists);
      setSelectedWatchlistId((previous) => {
        if (filteredWatchlists.some((watchlist) => watchlist.userId === previous)) {
          return previous;
        }
        const preferred = filteredWatchlists.find((watchlist) => watchlist.enabled);
        return preferred?.userId ?? filteredWatchlists[0]?.userId ?? "";
      });
      setWatchlistsError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unable to load watchlists.";
      setWatchlistsError(formatAuthDependencyError(msg));
      setWatchlists([]);
      setSelectedWatchlistId("");
    } finally {
      setWatchlistsLoading(false);
    }
  }, [assetClass, authUser]);

  useEffect(() => {
    void loadWatchlists();
  }, [loadWatchlists]);

  const selectedWatchlist = useMemo(
    () => watchlists.find((watchlist) => watchlist.userId === selectedWatchlistId) ?? null,
    [watchlists, selectedWatchlistId]
  );

  const handleRunWatchlistBacktest = useCallback(async () => {
    if (!activeForm) {
      setWatchlistBacktestError("Backtest form is still initializing. Please try again.");
      return;
    }

    if (!selectedWatchlist) {
      setWatchlistBacktestError("Select a watchlist first.");
      return;
    }

    if (selectedWatchlist.symbols.length === 0) {
      setWatchlistBacktestError("Selected watchlist has no symbols.");
      return;
    }

    setWatchlistBacktestError(null);
    setWatchlistRuns([]);
    setLoadedWatchlistRunSymbol(null);
    setRunningWatchlistBacktest(true);

    try {
      const runs = await onRunWatchlistBacktests(activeForm, selectedWatchlist.symbols);
      setWatchlistRuns(runs);

      const firstSuccessfulRun = runs.find((run) => run.result);
      if (firstSuccessfulRun) {
        onLoadWatchlistRun(activeForm, firstSuccessfulRun);
        setLoadedWatchlistRunSymbol(firstSuccessfulRun.symbol);
      } else {
        setWatchlistBacktestError(
          "Backtests finished, but no symbol produced trades for the current setup."
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Watchlist backtest failed.";
      setWatchlistBacktestError(msg);
    } finally {
      setRunningWatchlistBacktest(false);
    }
  }, [activeForm, onLoadWatchlistRun, onRunWatchlistBacktests, selectedWatchlist]);

  const handleLoadWatchlistResult = useCallback(
    (run: WatchlistBacktestRun) => {
      if (!activeForm || !run.result) return;
      onLoadWatchlistRun(activeForm, run);
      setLoadedWatchlistRunSymbol(run.symbol);
    },
    [activeForm, onLoadWatchlistRun]
  );

  const rankedPresetRuns = useMemo(() => {
    return [...presetRuns].sort((a, b) => {
      if (a.result && !b.result) return -1;
      if (!a.result && b.result) return 1;
      if (!a.result && !b.result) return a.label.localeCompare(b.label);
      const aScore = getPresetRankingScore(a, rankBy);
      const bScore = getPresetRankingScore(b, rankBy);
      if (bScore !== aScore) return bScore - aScore;
      return b.result!.performance.returnComparison.strategyVsRandomPct - a.result!.performance.returnComparison.strategyVsRandomPct;
    });
  }, [presetRuns, rankBy]);

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-80 flex-shrink-0 border-r border-border overflow-y-auto">
        <StrategyBuilder
          defaultSymbol={defaultSymbol}
          onRun={onRun}
          onRunPresetSuite={onRunPresetSuite}
          onFormChange={setActiveForm}
          running={running}
        />
      </aside>

      <div className="flex flex-col flex-1 min-w-0">
        <div className="px-4 py-2 border-b border-border/70 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
          {title}
        </div>
        {runError && (
          <div className="px-4 py-2 text-xs bg-sell/10 text-sell border-b border-sell/20">{runError}</div>
        )}

        <section className="border-b border-border bg-surface-1">
          <div className="px-4 py-2 flex flex-wrap items-center gap-2">
            <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
              Watchlist Backtesting
            </p>
            <span className="rounded border border-border bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">
              {assetClass === "crypto" ? "Crypto Watchlists" : "Stocks/ETF Watchlists"}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadWatchlists()}
                disabled={watchlistsLoading || !authUser}
                className="rounded border border-border bg-surface-2 px-2.5 py-1 text-[10px] text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {watchlistsLoading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                type="button"
                onClick={onOpenWatchlists}
                className="rounded border border-accent/40 bg-accent/10 px-2.5 py-1 text-[10px] text-accent hover:bg-accent/20"
              >
                Manage Watchlists
              </button>
            </div>
          </div>

          <div className="px-4 pb-3">
            {!authUser ? (
              <p className="text-[10px] text-text-secondary">
                Sign in to run watchlist backtests from this screen.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-56 flex-1">
                    <label className="mb-1 block text-[10px] text-text-secondary">Watchlist</label>
                    <select
                      className="w-full rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
                      value={selectedWatchlistId}
                      onChange={(event) => setSelectedWatchlistId(event.target.value)}
                    >
                      <option value="">Select watchlist</option>
                      {watchlists.map((watchlist) => (
                        <option key={watchlist.userId} value={watchlist.userId}>
                          {watchlist.name} ({watchlist.symbols.length})
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRunWatchlistBacktest()}
                    disabled={
                      running ||
                      runningWatchlistBacktest ||
                      watchlistsLoading ||
                      !activeForm ||
                      !selectedWatchlist
                    }
                    className="rounded border border-buy/40 bg-buy/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-buy hover:bg-buy/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {runningWatchlistBacktest ? "Running..." : "Run Across Watchlist"}
                  </button>
                </div>

                {selectedWatchlist ? (
                  <p className="mt-2 text-[10px] text-text-secondary">
                    {selectedWatchlist.enabled ? "Enabled" : "Disabled"} ·{" "}
                    {selectedWatchlist.symbols.length} symbol
                    {selectedWatchlist.symbols.length === 1 ? "" : "s"} · Updated{" "}
                    {new Date(selectedWatchlist.updatedAt).toLocaleString()}
                  </p>
                ) : null}
              </>
            )}

            {watchlistsError ? (
              <div className="mt-2 rounded border border-sell/30 bg-sell/10 px-2.5 py-2 text-[10px] text-sell">
                {watchlistsError}
              </div>
            ) : null}
            {watchlistBacktestError ? (
              <div className="mt-2 rounded border border-sell/30 bg-sell/10 px-2.5 py-2 text-[10px] text-sell">
                {watchlistBacktestError}
              </div>
            ) : null}

            {watchlistRuns.length > 0 ? (
              <div className="mt-3 overflow-x-auto rounded border border-border/70">
                <table className="w-full text-[10px]">
                  <thead className="uppercase tracking-wide text-text-secondary">
                    <tr>
                      <th className="px-2 py-2 text-left font-medium">#</th>
                      <th className="px-2 py-2 text-left font-medium">Symbol</th>
                      <th className="px-2 py-2 text-right font-medium">Return</th>
                      <th className="px-2 py-2 text-right font-medium">Vs Random</th>
                      <th className="px-2 py-2 text-right font-medium">Vs Lump</th>
                      <th className="px-2 py-2 text-right font-medium">Vs Interval</th>
                      <th className="px-2 py-2 text-right font-medium">Load</th>
                      <th className="px-2 py-2 text-left font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {watchlistRuns.map((run, index) => {
                      const returns = run.result?.performance.returnComparison;
                      const isLoaded = loadedWatchlistRunSymbol === run.symbol && Boolean(run.result);
                      return (
                        <tr
                          key={`${run.symbol}-${index}`}
                          className={`border-t border-border/60 ${
                            isLoaded ? "bg-accent/10" : "hover:bg-surface-2"
                          }`}
                        >
                          <td className="px-2 py-2 text-text-secondary">{index + 1}</td>
                          <td className="px-2 py-2 text-text-primary">{run.symbol}</td>
                          <td
                            className={`px-2 py-2 text-right tabular-nums ${
                              run.result && run.result.performance.profitPct >= 0
                                ? "text-buy"
                                : "text-sell"
                            }`}
                          >
                            {run.result ? signedPct(run.result.performance.profitPct) : "-"}
                          </td>
                          <td
                            className={`px-2 py-2 text-right tabular-nums ${
                              returns && returns.strategyVsRandomPct >= 0 ? "text-buy" : "text-sell"
                            }`}
                          >
                            {returns ? signedPct(returns.strategyVsRandomPct) : "-"}
                          </td>
                          <td
                            className={`px-2 py-2 text-right tabular-nums ${
                              returns && returns.strategyVsLumpPct >= 0 ? "text-buy" : "text-sell"
                            }`}
                          >
                            {returns ? signedPct(returns.strategyVsLumpPct) : "-"}
                          </td>
                          <td
                            className={`px-2 py-2 text-right tabular-nums ${
                              returns && returns.strategyVsIntervalPct >= 0 ? "text-buy" : "text-sell"
                            }`}
                          >
                            {returns ? signedPct(returns.strategyVsIntervalPct) : "-"}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => handleLoadWatchlistResult(run)}
                              disabled={!run.result}
                              className={`rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                                isLoaded
                                  ? "border-accent/50 bg-accent/20 text-accent"
                                  : "border-border bg-surface-2 text-text-secondary hover:text-text-primary"
                              } disabled:cursor-not-allowed disabled:opacity-50`}
                            >
                              {!run.result ? "N/A" : isLoaded ? "Loaded" : "Load"}
                            </button>
                          </td>
                          <td className="px-2 py-2 text-text-secondary">{run.error ?? "OK"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </section>

        {presetRuns.length > 0 && (
          <section className="border-b border-border bg-surface-1">
            <div className="px-4 py-2 flex items-center gap-2">
              <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
                Preset Backtest Results
              </p>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[10px] text-text-secondary">Rank by</span>
                <select
                  className="rounded border border-border bg-surface-2 px-2 py-1 text-[10px] text-text-primary focus:border-accent focus:outline-none"
                  value={rankBy}
                  onChange={(e) => setRankBy(e.target.value as PresetRankingMetric)}
                >
                  <option value="vs_random">Strategy vs Random</option>
                  <option value="vs_lump">Strategy vs Lump Sum</option>
                  <option value="vs_interval">Strategy vs Interval</option>
                  <option value="profit_pct">Strategy Return %</option>
                  <option value="alpha_pct">Alpha vs Benchmark</option>
                </select>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wide text-text-secondary border-t border-border">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Preset</th>
                    <th className="px-3 py-2 text-left font-medium">Best For</th>
                    <th className="px-3 py-2 text-right font-medium">Strategy Return</th>
                    <th className="px-3 py-2 text-right font-medium">Vs Random</th>
                    <th className="px-3 py-2 text-right font-medium">Vs Lump</th>
                    <th className="px-3 py-2 text-right font-medium">Vs Interval</th>
                    <th className="px-3 py-2 text-right font-medium">Load</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedPresetRuns.map((run, index) => {
                    const returns = run.result?.performance.returnComparison;
                    const isSelected = run.presetKey === selectedPresetKey;
                    const canLoad = Boolean(run.result);
                    return (
                      <tr
                        key={run.presetKey}
                        className={`border-t border-border/60 ${
                          isSelected ? "bg-accent/10" : "hover:bg-surface-2"
                        }`}
                      >
                        <td className="px-3 py-2 text-text-secondary">{index + 1}</td>
                        <td className="px-3 py-2 text-text-primary">{run.label}</td>
                        <td className="px-3 py-2 text-text-secondary">
                          {run.suitableFor}
                          {run.error ? ` | ${run.error}` : ""}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            run.result && run.result.performance.profitPct >= 0
                              ? "text-buy"
                              : "text-sell"
                          }`}
                        >
                          {run.result ? signedPct(run.result.performance.profitPct) : "-"}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            returns && returns.strategyVsRandomPct >= 0 ? "text-buy" : "text-sell"
                          }`}
                        >
                          {returns ? signedPct(returns.strategyVsRandomPct) : "-"}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            returns && returns.strategyVsLumpPct >= 0 ? "text-buy" : "text-sell"
                          }`}
                        >
                          {returns ? signedPct(returns.strategyVsLumpPct) : "-"}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            returns && returns.strategyVsIntervalPct >= 0 ? "text-buy" : "text-sell"
                          }`}
                        >
                          {returns ? signedPct(returns.strategyVsIntervalPct) : "-"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => onSelectPresetRun(run.presetKey)}
                            disabled={!canLoad}
                            title={run.error ?? undefined}
                            className={`rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                              isSelected
                                ? "border-accent/50 bg-accent/20 text-accent"
                                : "border-border bg-surface-2 text-text-secondary hover:text-text-primary"
                            } disabled:cursor-not-allowed disabled:opacity-50`}
                          >
                            {!canLoad ? "N/A" : isSelected ? "Loaded" : "View"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <div className="flex-1 min-h-0 relative">
          {barsLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-surface-0/80 z-10 text-xs text-text-secondary">
              Loading bars...
            </div>
          )}

          {!barsLoading && !result && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-text-secondary">
              Set scale-in start/duration and scale-out start/duration, then run backtest
            </div>
          )}

          {result && (
            <div className="h-full min-h-0 border-t border-border flex flex-col">
              <section className="shrink-0 border-b border-border bg-surface-1">
                <div className="px-4 py-2 flex items-center gap-2">
                  <div className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
                    Execution Chart
                  </div>
                  <div className="ml-auto flex items-center gap-3 text-[10px] uppercase tracking-wide">
                    <span className="text-buy">Scale In (below)</span>
                    <span className="text-sell">Scale Out (above)</span>
                  </div>
                </div>
                <div className="h-[44vh] min-h-[280px] max-h-[520px]">
                  <div className="relative h-full">
                    <BacktestChart
                      bars={bars}
                      scaleInTrades={result.scaleIn.trades}
                      scaleOutTrades={result.scaleOut.trades}
                    />
                    {strategySignals.length > 0 && (
                      <div className="pointer-events-none absolute left-2 right-2 top-2 flex flex-wrap gap-1.5">
                        {strategySignals.map((sw, i) => (
                          <span
                            key={`${sw.signal.type}-${i}`}
                            className="rounded border border-border/80 bg-surface-0/80 px-2 py-0.5 text-[10px] text-text-primary backdrop-blur-[1px]"
                          >
                            {formatSignalTag(sw)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <div className="flex-1 min-h-0 overflow-auto">
                <PerformanceSummary result={result} compact />
                <ResultSection title="Smart Scale-In Details" section={result.scaleIn} compact />
                <ResultSection
                  title="Smart Scale-Out Details"
                  section={result.scaleOut}
                  withTopBorder
                  compact
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CapitalManagementPage() {
  const [snapshot, setSnapshot] = useState<AlpacaAccountSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshot = useCallback(async (options: { silent: boolean }) => {
    if (options.silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const res = await fetch(`${API_PREFIX}/alpaca/account`);
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      } & Partial<AlpacaAccountSnapshot>;
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      if (!body.account || !Array.isArray(body.positions) || !body.updatedAt) {
        throw new Error("Invalid account payload");
      }

      setSnapshot({
        account: body.account as AlpacaAccountSnapshot["account"],
        positions: body.positions as AlpacaPosition[],
        updatedAt: body.updatedAt,
      });
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshot({ silent: false });
    const timer = setInterval(() => {
      void loadSnapshot({ silent: true });
    }, 30_000);
    return () => clearInterval(timer);
  }, [loadSnapshot]);

  const account = snapshot?.account ?? null;
  const positions = snapshot?.positions ?? [];
  const unrealizedPlTotal = positions.reduce((sum, row) => sum + row.unrealizedPl, 0);

  return (
    <div className="h-full overflow-auto p-4">
      <section className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-sm font-semibold mb-1">Capital Management</h2>
          <p className="text-xs text-text-secondary">
            Read-only monitoring of balances and positions. This app does not place or manage orders.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadSnapshot({ silent: false })}
          disabled={loading || refreshing}
          className="ml-auto rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading || refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </section>

      {error && (
        <div className="mb-4 rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          {error}
        </div>
      )}

      {loading && !snapshot ? (
        <div className="mb-4 rounded border border-border bg-surface-1 px-4 py-5 text-xs text-text-secondary">
          Loading Alpaca account snapshot...
        </div>
      ) : null}

      {snapshot ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <StatCard
            label="Portfolio Value"
            value={formatUsd(account?.portfolioValue ?? 0)}
            sub={`Equity ${formatUsd(account?.equity ?? 0)}`}
          />
          <StatCard
            label="Available Cash"
            value={formatUsd(account?.cash ?? 0)}
            sub={`Buying Power ${formatUsd(account?.buyingPower ?? 0)}`}
          />
          <StatCard
            label="Allocated Capital"
            value={formatUsd(account?.longMarketValue ?? 0)}
            sub={`${positions.length} open position${positions.length === 1 ? "" : "s"}`}
          />
          <StatCard
            label="Unrealized P/L"
            value={formatUsd(unrealizedPlTotal)}
            sub={`Status ${account?.status ?? "unknown"}`}
            valueClassName={unrealizedPlTotal >= 0 ? "text-buy" : "text-sell"}
          />
        </div>
      ) : null}

      <section className="rounded border border-border bg-surface-1">
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
          <span>Positions</span>
          <span className="normal-case tracking-normal text-[10px] text-text-secondary">
            {snapshot ? `Updated ${new Date(snapshot.updatedAt).toLocaleString()}` : "Waiting for data"}
          </span>
        </div>

        {!snapshot ? (
          <div className="p-4 text-xs text-text-secondary">
            Account snapshot unavailable. Confirm the data-service is running and Alpaca credentials
            are configured.
          </div>
        ) : positions.length === 0 ? (
          <div className="p-4 text-xs text-text-secondary">
            No open Alpaca positions found for this account.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Symbol</th>
                  <th className="px-4 py-2 text-right font-medium">Qty</th>
                  <th className="px-4 py-2 text-right font-medium">Avg Entry</th>
                  <th className="px-4 py-2 text-right font-medium">Current</th>
                  <th className="px-4 py-2 text-right font-medium">Market Value</th>
                  <th className="px-4 py-2 text-right font-medium">Unrealized P/L</th>
                  <th className="px-4 py-2 text-right font-medium">Day Change</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((row) => (
                  <tr key={row.symbol} className="border-t border-border">
                    <td className="px-4 py-2 font-medium text-text-primary">
                      {row.symbol}
                      {row.side === "short" ? (
                        <span className="ml-1 text-[10px] uppercase tracking-wide text-sell">Short</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-primary">
                      {row.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-primary">
                      {formatUsd(row.avgEntryPrice)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-primary">
                      {row.currentPrice == null ? "-" : formatUsd(row.currentPrice)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-primary">
                      {formatUsd(row.marketValue)}
                    </td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums ${
                        row.unrealizedPl >= 0 ? "text-buy" : "text-sell"
                      }`}
                    >
                      {formatUsd(row.unrealizedPl)}
                      <span className="ml-1 text-[10px] text-text-secondary">
                        ({formatPct(row.unrealizedPlpc)})
                      </span>
                    </td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums ${
                        (row.changeToday ?? 0) >= 0 ? "text-buy" : "text-sell"
                      }`}
                    >
                      {formatPct(row.changeToday)}
                    </td>
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

function MarketResearchPage({
  suggestedStrategyId,
  suggestedStrategySummary,
}: {
  suggestedStrategyId: string;
  suggestedStrategySummary: string;
}) {
  return (
    <div className="h-full overflow-auto p-4">
      <section className="mb-4">
        <h2 className="text-sm font-semibold mb-2">Market Research</h2>
        <p className="text-xs text-text-secondary">
          Research workspace for daily news synthesis, catalyst tracking, and symbol notes.
        </p>
      </section>

      <div className="mb-3">
        <AIControlCenter
          suggestedStrategyId={suggestedStrategyId}
          suggestedStrategySummary={suggestedStrategySummary}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <section className="rounded border border-border bg-surface-1">
          <div className="px-4 py-2 border-b border-border text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
            Daily Brief
          </div>
          <div className="p-4 text-xs text-text-secondary">
            No brief generated yet. This page will host your news-driven recommendation pipeline.
          </div>
        </section>

        <section className="rounded border border-border bg-surface-1">
          <div className="px-4 py-2 border-b border-border text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
            Symbol Notes
          </div>
          <div className="p-4 text-xs text-text-secondary">
            Save thesis updates, risk flags, and catalyst notes per ticker here.
          </div>
        </section>
      </div>
    </div>
  );
}

function AboutPage() {
  return (
    <div className="h-full overflow-auto p-4">
      <section className="mb-4">
        <h2 className="text-sm font-semibold mb-2">About Smart Scale</h2>
        <p className="text-xs text-text-secondary max-w-4xl">
          Smart Scale is a signal-weighted DCA engine. Instead of buying or selling only on fixed
          intervals, it scores each day in your configured windows, then allocates more capital to
          the dates that look most favorable based on your selected indicators.
        </p>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
        <section className="rounded border border-border bg-surface-1">
          <div className="px-4 py-2 border-b border-border text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
            How The Algorithm Works
          </div>
          <div className="p-4 text-xs text-text-secondary leading-relaxed">
            <p>
              1. The system builds a scale-in window and a scale-out window using your start dates
              and durations.
            </p>
            <p className="mt-2">
              2. Each active signal produces a normalized score from 0 to 1 on every bar.
            </p>
            <p className="mt-2">
              3. Signal scores are combined using your configured signal weights.
            </p>
            <p className="mt-2">
              4. Each window is split into tranches from your cadence. In each tranche, the highest
              scoring bar is chosen as the execution point.
            </p>
            <p className="mt-2">
              5. Allocation is blended between equal DCA and fully signal-weighted sizing via the
              aggressiveness slider.
            </p>
            <p className="mt-2">
              6. Results are compared against lump sum, random ensemble, interval scaling, and S&P
              500 benchmark return.
            </p>
          </div>
        </section>

        <section className="rounded border border-border bg-surface-1">
          <div className="px-4 py-2 border-b border-border text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
            Build Backtest Scenarios In UI
          </div>
          <div className="p-4 text-xs text-text-secondary leading-relaxed">
            <p>Use the Backtesting panel to create scenario variants by changing inputs and rerunning.</p>
            <p className="mt-2"><span className="text-text-primary">Symbol:</span> switch asset (e.g. AAPL, NVDA, MSFT).</p>
            <p className="mt-2"><span className="text-text-primary">Scale-In Start Date + Duration:</span> defines accumulation regime.</p>
            <p className="mt-2"><span className="text-text-primary">Scale-Out Start Date + Duration:</span> defines distribution regime.</p>
            <p className="mt-2"><span className="text-text-primary">Cadence:</span> controls tranche density (more frequent vs fewer trades).</p>
            <p className="mt-2"><span className="text-text-primary">Aggressiveness:</span> controls equal-DCA vs signal-weighted behavior.</p>
            <p className="mt-2"><span className="text-text-primary">Signals:</span> toggle indicator set and rebalance their weights.</p>
            <p className="mt-2"><span className="text-text-primary">Random Ensemble Samples:</span> stabilizes random baseline quality.</p>
          </div>
        </section>
      </div>

      <section className="rounded border border-border bg-surface-1">
        <div className="px-4 py-2 border-b border-border text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
          Suggested Scenario Workflow
        </div>
        <div className="p-4 text-xs text-text-secondary leading-relaxed">
          <p>1. Pick one symbol and lock dates to define a single market regime.</p>
          <p className="mt-2">2. Start with balanced signal mix and mid aggressiveness.</p>
          <p className="mt-2">3. Change one variable at a time (cadence, aggressiveness, or signal set).</p>
          <p className="mt-2">4. Compare Strategy Return against Lump Sum Return and Random Return.</p>
          <p className="mt-2">5. Validate robustness by repeating the same setup on multiple symbols.</p>
        </div>
      </section>
    </div>
  );
}

function ResultSection({
  title,
  section,
  withTopBorder = false,
  compact = false,
}: {
  title: string;
  section: DirectionalBacktestResult;
  withTopBorder?: boolean;
  compact?: boolean;
}) {
  return (
    <section className={withTopBorder ? "border-t border-border" : ""}>
      <div className="px-4 py-2 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">{title}</div>
      <BacktestMetrics section={section} compact={compact} />
      <div className={`${compact ? "h-44" : "h-60"} border-t border-border`}>
        <TradeTable trades={section.trades} direction={section.direction} compact={compact} />
      </div>
      {section.trades.length === 0 && (
        <div className="px-4 py-3 text-xs text-text-secondary">No trades generated in this window.</div>
      )}
    </section>
  );
}

function StatCard({
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
      <p className="text-[11px] text-text-secondary mb-1">{label}</p>
      <p className={`text-base font-semibold tabular-nums ${valueClassName}`}>{value}</p>
      <p className="text-[10px] text-text-secondary mt-0.5">{sub}</p>
    </div>
  );
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

function normalizeWatchlistAssetClass(assetClass: AssetClass | string | undefined): AssetClass {
  return assetClass === "crypto" ? "crypto" : "stocks_etf";
}

function formatUsd(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "-";
  }
  const pct = value * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function signedPct(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function getPresetRankingScore(
  run: PresetBacktestRun,
  metric: PresetRankingMetric
): number {
  if (!run.result) {
    return Number.NEGATIVE_INFINITY;
  }

  const perf = run.result.performance;
  const compare = perf.returnComparison;
  const benchmark = run.result.benchmark;

  if (metric === "vs_lump") return compare.strategyVsLumpPct;
  if (metric === "vs_interval") return compare.strategyVsIntervalPct;
  if (metric === "profit_pct") return perf.profitPct;
  if (metric === "alpha_pct") {
    return benchmark ? perf.profitPct - benchmark.profitPct : Number.NEGATIVE_INFINITY;
  }
  return compare.strategyVsRandomPct;
}

function formatSignalTag(sw: SignalWeight): string {
  const weightPct = Math.round(sw.weight * 100);
  const base = SIGNAL_META[sw.signal.type]?.label ?? sw.signal.type;
  const period = "period" in sw.signal ? sw.signal.period : null;
  if (sw.signal.type === "bollinger_band") {
    return `${base} (${weightPct}%, p${period}, ${sw.signal.std_dev}sd)`;
  }
  if (period != null) {
    return `${base} (${weightPct}%, p${period})`;
  }
  return `${base} (${weightPct}%)`;
}

function summarizeSignals(signals: SignalWeight[]): string {
  if (signals.length === 0) {
    return "";
  }
  return signals
    .map((sw) => {
      const base = SIGNAL_META[sw.signal.type]?.label ?? sw.signal.type;
      return `${base} ${Math.round(sw.weight * 100)}%`;
    })
    .join(" | ");
}

function makeStrategyId(form: StrategyForm): string {
  const symbol = normalizeSymbol(form.symbol);
  const windowTag =
    form.strategyMode === "continuous_range"
      ? `cont-${form.startDate}-${form.endDate}`
      : `in${form.scaleInWindowDays}-out${form.scaleOutWindowDays}`;
  const washRuleTag =
    form.accountType === "taxable"
      ? isLikelyCryptoSymbol(symbol)
        ? "taxable-nowash"
        : `wash${form.washSaleWindowDays}`
      : "taxadv";
  const signalPart = form.signals
    .map((sw) => `${sw.signal.type}-${Math.round(sw.weight * 100)}`)
    .join("_");
  return [
    symbol,
    form.strategyMode,
    windowTag,
    `cad${form.cadenceDays}`,
    washRuleTag,
    signalPart,
  ].join("-");
}

function resolveBacktestWindows(form: StrategyForm): {
  startDate: string;
  scaleOutStartDate: string;
  scaleInWindowDays: number;
  scaleOutWindowDays: number;
} {
  if (form.strategyMode !== "continuous_range") {
    return {
      startDate: form.startDate,
      scaleOutStartDate: form.scaleOutStartDate,
      scaleInWindowDays: Math.max(1, Math.round(form.scaleInWindowDays)),
      scaleOutWindowDays: Math.max(1, Math.round(form.scaleOutWindowDays)),
    };
  }

  const daySpan = deriveInclusiveDaySpan(form.startDate, form.endDate);
  return {
    startDate: form.startDate,
    scaleOutStartDate: form.startDate,
    scaleInWindowDays: daySpan,
    scaleOutWindowDays: daySpan,
  };
}

function deriveInclusiveDaySpan(startDate: string, endDate: string): number {
  const dayMs = 86_400_000;
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  const endTs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
    throw new Error("Start and end dates must both be valid ISO dates.");
  }
  if (endTs < startTs) {
    throw new Error("End date must be on or after start date.");
  }
  const diffDays = Math.floor((endTs - startTs) / dayMs) + 1;
  return Math.max(1, diffDays);
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function isLikelyCryptoSymbol(symbol: string): boolean {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  if (normalized.includes("/")) return true;
  return /^[A-Z0-9]{2,10}[-_](USD|USDT|USDC|BTC|ETH|EUR|GBP|JPY)$/.test(normalized);
}
