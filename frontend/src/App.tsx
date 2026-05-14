import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "./store";
import { STRATEGY_PRESETS, StrategyForm } from "./components/StrategyBuilder";
import RunQueueBuilder, { BacktestRun } from "./components/RunQueueBuilder";
import RunQueueResults, { RunQueueResult } from "./components/RunQueueResults";
import AIControlCenter from "./components/AIControlCenter";
import { BacktestResult, runBacktest } from "./lib/backtest";
import { Bar, EarningsEvent } from "./lib/signals";

const STOCK_BENCHMARK_SYMBOL = "^GSPC";
const CRYPTO_BENCHMARK_SYMBOL = "BTC/USD";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const API_PREFIX = API_BASE_URL ? `${API_BASE_URL}/api` : "/api";

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

type AssetClass = "stocks_etf" | "crypto";

type AppPage = "stocks_backtest" | "crypto_backtest";
type MarketBarsPayload = { bars: Bar[]; earningsEvents: EarningsEvent[] };

const APP_PAGES: { id: AppPage; label: string }[] = [
  { id: "stocks_backtest", label: "Stocks/ETF Backtest" },
  { id: "crypto_backtest", label: "Crypto Backtest" },
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
  const [activePage, setActivePage] = useState<AppPage>("stocks_backtest");

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

  const barsCacheRef = useRef<Record<string, MarketBarsPayload>>({});

  async function fetchBars(
    symbol: string,
    options: {
      persist: boolean;
      timeframe?: "1Day" | "1Hour" | "15Min";
      startDate?: string;
      endDate?: string;
      range?: string;
    }
  ): Promise<MarketBarsPayload> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const timeframe = options.timeframe ?? "1Day";
    const range = options.range ?? "2y";
    const intradayWindowKey =
      timeframe === "15Min"
        ? `${options.startDate ?? "none"}::${options.endDate ?? "none"}`
        : "all";
    const cacheKey = `${normalizedSymbol}::${timeframe}::${range}::${intradayWindowKey}`;
    const cached = barsCacheRef.current[cacheKey];
    if (cached && cached.bars.length > 0) {
      if (options.persist) {
        setBars(cached.bars);
      }
      return cached;
    }

    setBarsLoading(true);
    if (options.persist) {
      setBarsError(null);
    }

    try {
      const params = new URLSearchParams({ symbol: normalizedSymbol, range });
      if (timeframe !== "1Day") params.set("timeframe", timeframe);
      if (timeframe === "15Min") {
        if (!options.startDate || !options.endDate) {
          throw new Error("15Min backtests require start and end dates.");
        }
        params.set("startDate", options.startDate);
        params.set("endDate", options.endDate);
      }
      const res = await fetch(`${API_PREFIX}/bars?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const json = await res.json();
      const loadedBars = (json.bars as Bar[]) ?? [];
      const loadedEarningsEvents = (json.earningsEvents as EarningsEvent[] | undefined) ?? [];
      const payload: MarketBarsPayload = {
        bars: loadedBars,
        earningsEvents: loadedEarningsEvents,
      };
      barsCacheRef.current[cacheKey] = payload;

      if (options.persist) {
        setBars(loadedBars);
      }
      return payload;
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
      phase: form.phase,
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

  function buildFormFromRun(run: BacktestRun): StrategyForm {
    const preset = STRATEGY_PRESETS.find((p) => p.key === run.presetKey) ?? STRATEGY_PRESETS[0];
    const strategyMode = preset.strategyMode ?? "two_phase";
    const presetPhase = preset.phase;

    let scaleInDays: number;
    let scaleOutDays: number;

    if (strategyMode === "continuous_range") {
      scaleInDays = run.durationDays;
      scaleOutDays = run.durationDays;
    } else if (presetPhase === "scale_in") {
      scaleInDays = run.durationDays;
      scaleOutDays = 1;
    } else if (presetPhase === "scale_out") {
      scaleInDays = 1;
      scaleOutDays = run.durationDays;
    } else {
      const presetScaleIn = preset.config.scaleInWindowDays;
      const presetScaleOut = preset.config.scaleOutWindowDays;
      const presetTotal = presetScaleIn + presetScaleOut;
      scaleInDays = Math.max(1, Math.round((run.durationDays * presetScaleIn) / presetTotal));
      scaleOutDays = Math.max(1, run.durationDays - scaleInDays);
    }

    const scaleOutStartDate = presetPhase === "scale_out"
      ? run.startDate
      : addDaysIso(run.startDate, scaleInDays);
    const endDate = addDaysIso(scaleOutStartDate, scaleOutDays);
    const symbol = normalizeSymbol(run.symbol);

    return {
      symbol,
      timeframe: preset.timeframe ?? "1Day",
      strategyMode,
      phase: presetPhase,
      totalAmount: run.totalAmount,
      cadenceDays: run.cadenceDays,
      startDate: run.startDate,
      endDate,
      scaleInWindowDays: scaleInDays,
      scaleOutStartDate,
      scaleOutWindowDays: scaleOutDays,
      randomEnsembleSamples: 400,
      aggressiveness: preset.config.aggressiveness,
      accountType: isLikelyCryptoSymbol(symbol) ? "tax_advantaged" : "taxable",
      washSaleWindowDays: 30,
      signals: preset.config.signals.map((sw) => ({ ...sw, signal: { ...sw.signal } })),
    };
  }

  async function handleRunQueue(
    runs: BacktestRun[],
    benchmarkSymbol: string
  ): Promise<RunQueueResult[]> {
    setRunning(true);
    setRunError(null);

    const results: RunQueueResult[] = [];

    for (const run of runs) {
      const form = buildFormFromRun(run);
      try {
        const symbol = normalizeSymbol(form.symbol);
        const intradayFetchWindow = resolveIntradayFetchWindow(form);
        const neededRange = rangeForStartDate(form.startDate);
        const assetData = await fetchBars(symbol, {
          persist: false,
          timeframe: form.timeframe,
          range: neededRange,
          startDate: intradayFetchWindow?.startDate,
          endDate: intradayFetchWindow?.endDate,
        });
        const assetBars = assetData.bars;
        const assetEarningsEvents = assetData.earningsEvents;

        if (assetBars.length === 0) throw new Error("No bars loaded for symbol.");

        let benchmarkBars: Bar[] = [];
        if (normalizeSymbol(benchmarkSymbol) === symbol) {
          benchmarkBars = assetBars;
        } else {
          try {
            benchmarkBars = (await fetchBars(benchmarkSymbol, { persist: false })).bars;
          } catch {
            // non-fatal — benchmark unavailable
          }
        }

        const computed = computeResultForForm(form, assetBars, benchmarkBars, benchmarkSymbol);
        results.push({
          run,
          form,
          result: computed,
          bars: assetBars,
          earningsEvents: assetEarningsEvents,
          error: null,
        });
      } catch (e) {
        results.push({
          run,
          form,
          result: null,
          bars: [],
          earningsEvents: [],
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    setRunning(false);
    return results;
  }

  return (
    <div className="flex h-screen flex-col bg-surface text-text-primary overflow-hidden">
      <div className="pointer-events-none fixed left-1/2 top-2 z-50 -translate-x-1/2 rounded border-2 border-yellow-200 bg-yellow-300 px-4 py-1.5 text-center text-xs font-bold uppercase tracking-wide text-black shadow-[0_0_18px_rgba(253,224,71,0.55)]">
        Nothing here is intended as financial advice. All trades are virtual.
      </div>

      <header className="border-b border-border bg-surface-1 shadow-[0_0_18px_rgba(70,215,255,0.12)]">
        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3 pr-24">
          <span className="text-sm font-semibold tracking-tight">Smart Scale</span>
          <a
            href="https://arissmiller.net"
            className="ml-auto rounded border border-border bg-surface-2 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary transition-colors hover:text-text-primary"
          >
            Back to Projects
          </a>
          <span
            className={`h-2 w-2 rounded-full ${serverOnline ? "bg-buy" : "bg-sell"}`}
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
            running={running}
            runError={runError}
            benchmarkSymbol={STOCK_BENCHMARK_SYMBOL}
            defaultSymbol="AAPL"
            symbolMode="stocks"
            onRunQueue={handleRunQueue}
          />
        )}

        {activePage === "crypto_backtest" && (
          <BacktestingPage
            key="crypto_backtest"
            title="Crypto Backtesting"
            running={running}
            runError={runError}
            benchmarkSymbol={CRYPTO_BENCHMARK_SYMBOL}
            defaultSymbol="BTC"
            symbolMode="crypto"
            onRunQueue={handleRunQueue}
          />
        )}
      </main>
    </div>
  );
}


function BacktestingPage({
  title,
  running,
  runError,
  benchmarkSymbol,
  defaultSymbol,
  symbolMode,
  onRunQueue,
}: {
  title: string;
  running: boolean;
  runError: string | null;
  benchmarkSymbol: string;
  defaultSymbol: string;
  symbolMode: "stocks" | "crypto";
  onRunQueue: (runs: BacktestRun[], benchmarkSymbol: string) => Promise<RunQueueResult[]>;
}) {
  const [runs, setRuns] = useState<BacktestRun[]>([]);
  const [runQueueResults, setRunQueueResults] = useState<RunQueueResult[]>([]);

  async function handleRunAll() {
    if (runs.length === 0) return;
    const results = await onRunQueue(runs, benchmarkSymbol);
    setRunQueueResults(results);
  }

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-72 flex-shrink-0 border-r border-border overflow-y-auto">
        <RunQueueBuilder
          runs={runs}
          onRunsChange={setRuns}
          onRunAll={() => void handleRunAll()}
          running={running}
          defaultSymbol={defaultSymbol}
          symbolMode={symbolMode}
        />
      </aside>

      <div className="flex flex-col flex-1 min-w-0">
        <div className="shrink-0 px-4 py-2 border-b border-border/70 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
          {title}
        </div>
        {runError && (
          <div className="shrink-0 px-4 py-2 text-xs bg-sell/10 text-sell border-b border-sell/20">
            {runError}
          </div>
        )}
        {running && (
          <div className="shrink-0 px-4 py-2 text-xs text-text-secondary border-b border-border/40">
            Running backtests…
          </div>
        )}
        <div className="flex-1 min-h-0">
          <RunQueueResults results={runQueueResults} />
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


function resolveIntradayFetchWindow(
  form: StrategyForm
): { startDate: string; endDate: string } | null {
  if (form.timeframe !== "15Min") {
    return null;
  }
  const windows = resolveBacktestWindows(form);
  return {
    startDate: windows.startDate,
    endDate: addDaysIso(windows.scaleOutStartDate, windows.scaleOutWindowDays - 1),
  };
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

function addDaysIso(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map((v) => Number(v));
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return dt.toISOString().split("T")[0];
}

function rangeForStartDate(startDate: string): string {
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(startTs)) return "2y";

  const warmupDays = 90;
  const daysBack = (Date.now() - startTs) / 86_400_000;

  // Keep ~90 days of pre-start bars so indicators can warm up.
  // If a selected range is too short to include that warmup, step up to the next range.
  if (daysBack > 5 * 365 - warmupDays) return "max";
  if (daysBack > 2 * 365 - warmupDays) return "5y";
  if (daysBack > 365 - warmupDays) return "2y";
  return "1y";
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function isLikelyCryptoSymbol(symbol: string): boolean {
  const normalized = normalizeSymbol(symbol);
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
