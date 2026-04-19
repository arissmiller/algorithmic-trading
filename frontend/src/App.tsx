import { useEffect, useRef, useState } from "react";
import { useStore } from "./store";
import StrategyBuilder, { StrategyForm } from "./components/StrategyBuilder";
import BacktestMetrics from "./components/BacktestMetrics";
import TradeTable from "./components/TradeTable";
import PerformanceSummary from "./components/PerformanceSummary";
import { BacktestResult, DirectionalBacktestResult, runBacktest } from "./lib/backtest";
import { Bar } from "./lib/signals";

type AppPage = "backtesting" | "capital_management" | "market_research" | "about";

const BENCHMARK_SYMBOL = "^GSPC";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const API_PREFIX = API_BASE_URL ? `${API_BASE_URL}/api` : "/api";

export default function App() {
  const {
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
  const [activePage, setActivePage] = useState<AppPage>("backtesting");

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

  const barsCacheRef = useRef<Record<string, Bar[]>>({});

  async function fetchBars(
    symbol: string,
    options: { persist: boolean }
  ): Promise<Bar[]> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const cached = barsCacheRef.current[normalizedSymbol];
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
      const res = await fetch(
        `${API_PREFIX}/bars?symbol=${encodeURIComponent(normalizedSymbol)}&range=2y`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const json = await res.json();
      const loadedBars = (json.bars as Bar[]) ?? [];
      barsCacheRef.current[normalizedSymbol] = loadedBars;

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

  async function handleRun(form: StrategyForm) {
    setRunning(true);
    setRunError(null);

    try {
      const symbol = normalizeSymbol(form.symbol);
      const assetBars = await fetchBars(symbol, { persist: true });
      if (assetBars.length === 0) throw new Error("No bars loaded for symbol.");

      let benchmarkBars: Bar[] = [];
      let benchmarkError: string | null = null;

      try {
        benchmarkBars = await fetchBars(BENCHMARK_SYMBOL, { persist: false });
      } catch (e) {
        benchmarkError = e instanceof Error ? e.message : "Unknown benchmark error";
      }

      const computed = runBacktest({
        symbol,
        bars: assetBars,
        benchmarkBars,
        benchmarkSymbol: BENCHMARK_SYMBOL,
        totalAmount: form.totalAmount,
        cadenceDays: form.cadenceDays,
        startDate: form.startDate,
        scaleOutStartDate: form.scaleOutStartDate,
        scaleInWindowDays: form.scaleInWindowDays,
        scaleOutWindowDays: form.scaleOutWindowDays,
        randomEnsembleSamples: form.randomEnsembleSamples,
        aggressiveness: form.aggressiveness,
        signals: form.signals,
      });

      if (!computed) {
        throw new Error("No trades were generated. Try a different date window or cadence.");
      }

      setResult(computed);

      if (benchmarkError) {
        setRunError(`Backtest ran, but S&P 500 benchmark was unavailable: ${benchmarkError}`);
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Unknown error");
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-surface text-text-primary overflow-hidden">
      <div className="pointer-events-none fixed left-1/2 top-2 z-50 -translate-x-1/2 rounded border-2 border-yellow-200 bg-yellow-300 px-4 py-1.5 text-center text-xs font-bold uppercase tracking-wide text-black shadow-[0_0_18px_rgba(253,224,71,0.55)]">
        Nothing here is intended as financial advice. All trades are virtual.
      </div>

      <header className="border-b border-border bg-surface-1 shadow-[0_0_18px_rgba(70,215,255,0.12)]">
        <div className="px-4 py-3 flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">Smart Scale</span>
          <span
            className={`ml-auto h-2 w-2 rounded-full ${serverOnline ? "bg-buy" : "bg-sell"}`}
            title={serverOnline ? "API online" : "API offline"}
          />
        </div>
        <nav className="px-2 pb-2 flex gap-1">
          <PageTab
            label="Backtesting"
            active={activePage === "backtesting"}
            onClick={() => setActivePage("backtesting")}
          />
          <PageTab
            label="Capital Management"
            active={activePage === "capital_management"}
            onClick={() => setActivePage("capital_management")}
          />
          <PageTab
            label="Market Research"
            active={activePage === "market_research"}
            onClick={() => setActivePage("market_research")}
          />
          <PageTab
            label="About"
            active={activePage === "about"}
            onClick={() => setActivePage("about")}
          />
        </nav>
      </header>

      <main className="flex-1 min-h-0">
        {activePage === "backtesting" && (
          <BacktestingPage
            running={running}
            runError={runError}
            barsLoading={barsLoading}
            result={result}
            onRun={handleRun}
          />
        )}
        {activePage === "capital_management" && <CapitalManagementPage />}
        {activePage === "market_research" && <MarketResearchPage />}
        {activePage === "about" && <AboutPage />}
      </main>
    </div>
  );
}

function PageTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-3 py-1.5 text-xs transition-colors ${
        active
          ? "bg-accent/25 text-accent border border-accent/60 shadow-[0_0_12px_rgba(70,215,255,0.28)]"
          : "bg-surface-2 text-text-secondary border border-border hover:text-text-primary hover:border-accent/30"
      }`}
    >
      {label}
    </button>
  );
}

function BacktestingPage({
  running,
  runError,
  barsLoading,
  result,
  onRun,
}: {
  running: boolean;
  runError: string | null;
  barsLoading: boolean;
  result: BacktestResult | null;
  onRun: (form: StrategyForm) => void;
}) {
  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-80 flex-shrink-0 border-r border-border overflow-y-auto">
        <StrategyBuilder onRun={onRun} running={running} />
      </aside>

      <div className="flex flex-col flex-1 min-w-0">
        {runError && (
          <div className="px-4 py-2 text-xs bg-sell/10 text-sell border-b border-sell/20">{runError}</div>
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
            <div className="h-full overflow-auto border-t border-border">
              <PerformanceSummary result={result} />
              <ResultSection title="Smart Scale-In Details" section={result.scaleIn} />
              <ResultSection title="Smart Scale-Out Details" section={result.scaleOut} withTopBorder />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CapitalManagementPage() {
  return (
    <div className="h-full overflow-auto p-4">
      <section className="mb-4">
        <h2 className="text-sm font-semibold mb-2">Capital Management</h2>
        <p className="text-xs text-text-secondary">
          Portfolio and guardrail workspace. This page is ready for the next phase of implementation.
        </p>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <StatCard label="Starting Capital" value="$100,000.00" sub="Framework placeholder" />
        <StatCard label="Available Cash" value="$100,000.00" sub="No live positions yet" />
        <StatCard label="Allocated Capital" value="$0.00" sub="0 active plans" />
      </div>

      <section className="rounded border border-border bg-surface-1">
        <div className="px-4 py-2 border-b border-border text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
          Position Ledger
        </div>
        <div className="p-4 text-xs text-text-secondary">
          No positions yet. Next step is wiring starting lump sum, positions, and allocation constraints.
        </div>
      </section>
    </div>
  );
}

function MarketResearchPage() {
  return (
    <div className="h-full overflow-auto p-4">
      <section className="mb-4">
        <h2 className="text-sm font-semibold mb-2">Market Research</h2>
        <p className="text-xs text-text-secondary">
          Research workspace for daily news synthesis, catalyst tracking, and symbol notes.
        </p>
      </section>

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
}: {
  title: string;
  section: DirectionalBacktestResult;
  withTopBorder?: boolean;
}) {
  return (
    <section className={withTopBorder ? "border-t border-border" : ""}>
      <div className="px-4 py-2 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">{title}</div>
      <BacktestMetrics section={section} />
      <div className="h-60 border-t border-border">
        <TradeTable trades={section.trades} direction={section.direction} />
      </div>
      {section.trades.length === 0 && (
        <div className="px-4 py-3 text-xs text-text-secondary">No trades generated in this window.</div>
      )}
    </section>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded border border-border bg-surface-1 p-3">
      <p className="text-[11px] text-text-secondary mb-1">{label}</p>
      <p className="text-base font-semibold tabular-nums text-text-primary">{value}</p>
      <p className="text-[10px] text-text-secondary mt-0.5">{sub}</p>
    </div>
  );
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}
