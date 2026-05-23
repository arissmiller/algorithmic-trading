import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import BacktestChart, { BacktestChartHorizontalSegment } from "./BacktestChart";
import type { Bar, EarningsEvent } from "../lib/signals";
import type { BacktestTrade } from "../lib/backtest";
import { apiFetch } from "../lib/apiFetch";
import {
  OrbBacktestResult,
  OrbBacktestTrade,
  runStockDaytradeOrbBacktest,
} from "../lib/stockDaytradeOrbBacktest";

type FormState = {
  symbol: string;
  initialCapital: number;
  riskPerTradePct: number;
  rewardRisk: number;
  allowLong: boolean;
  allowShort: boolean;
  windowDaysBefore: number;
  windowDaysAfter: number;
};

type BarsPayload = {
  bars: Bar[];
  earningsEvents: EarningsEvent[];
};

type BatchWindowRun = {
  id: string;
  symbol: string;
  earningsDate: string;
  startDate: string;
  endDate: string;
  result: OrbBacktestResult | null;
  error: string | null;
};

type TradeChartCard = {
  id: string;
  symbol: string;
  runLabel: string;
  trade: OrbBacktestTrade;
  bars: Bar[];
  scaleInTrades: BacktestTrade[];
  scaleOutTrades: BacktestTrade[];
  segments: BacktestChartHorizontalSegment[];
};

type ChecklistDateSource = "earnings" | "fallback_earnings" | "available";

type ChecklistDatesPayload = {
  dates: string[];
  source: ChecklistDateSource;
};

type SymbolChecklistItem = {
  key: string;
  symbol: string;
  date: string;
  source: ChecklistDateSource;
};

const inputClass =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";

const MAX_AUTO_SELECTED_DATES = 120;

const FALLBACK_EARNINGS_DATES_BY_SYMBOL: Record<string, string[]> = {
  AAPL: ["2024-02-02", "2024-05-03", "2024-08-02", "2024-11-01", "2025-01-31", "2025-05-02", "2025-08-01", "2025-10-31", "2026-01-30", "2026-05-01"],
  MSFT: ["2024-01-30", "2024-04-25", "2024-07-30", "2024-10-30", "2025-01-29", "2025-04-30", "2025-07-30", "2025-10-29", "2026-01-28", "2026-04-29"],
  NVDA: ["2024-02-21", "2024-05-29", "2024-08-28", "2024-11-20", "2025-02-26", "2025-05-28", "2025-08-27", "2025-11-19", "2026-02-25"],
  AMZN: ["2024-02-02", "2024-05-01", "2024-08-02", "2024-11-01", "2025-02-07", "2025-05-02", "2025-08-01", "2025-10-31", "2026-02-06", "2026-04-30"],
  META: ["2024-02-02", "2024-04-25", "2024-08-01", "2024-10-31", "2025-01-30", "2025-05-01", "2025-07-31", "2025-10-30", "2026-01-29", "2026-04-30"],
  GOOGL: ["2024-01-31", "2024-04-26", "2024-07-24", "2024-10-30", "2025-02-05", "2025-04-25", "2025-07-24", "2025-10-30", "2026-02-05", "2026-04-30"],
  NFLX: ["2024-01-26", "2024-04-22", "2024-07-19", "2024-10-18", "2025-01-27", "2025-04-18", "2025-07-18", "2025-10-22", "2026-01-23", "2026-04-17"],
  AMD: ["2024-01-31", "2024-05-01", "2024-07-31", "2024-10-30", "2025-02-05", "2025-05-07", "2025-08-06", "2025-11-05", "2026-02-04", "2026-05-06"],
  AVGO: ["2024-03-14", "2024-06-13", "2024-09-11", "2024-12-20", "2025-03-12", "2025-06-11", "2025-09-10", "2025-12-18", "2026-03-11"],
  TSLA: ["2024-01-29", "2024-04-24", "2024-07-24", "2024-10-24", "2025-01-30", "2025-04-23", "2025-07-24", "2025-10-23", "2026-01-29", "2026-04-23"],
};

export default function StockDaytradeBacktestPage({ apiPrefix }: { apiPrefix: string }) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [batchRuns, setBatchRuns] = useState<BatchWindowRun[]>([]);
  const [form, setForm] = useState<FormState>(() => defaultForm());

  const [checklistItems, setChecklistItems] = useState<SymbolChecklistItem[]>([]);
  const [selectedChecklistKeys, setSelectedChecklistKeys] = useState<string[]>([]);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [checklistError, setChecklistError] = useState<string | null>(null);
  const [hasAnyAvailableFallback, setHasAnyAvailableFallback] = useState(false);
  const [hasAnyFallbackEarnings, setHasAnyFallbackEarnings] = useState(false);

  const barsCacheRef = useRef<Record<string, BarsPayload>>({});
  const earningsDatesCacheRef = useRef<Record<string, ChecklistDatesPayload>>({});

  const batchSummary = useMemo(() => {
    if (batchRuns.length === 0) return null;

    let windowsSucceeded = 0;
    let windowsFailed = 0;
    let totalTrades = 0;
    let totalPnl = 0;
    let wins = 0;

    for (const run of batchRuns) {
      if (!run.result || run.error) {
        windowsFailed += 1;
        continue;
      }
      windowsSucceeded += 1;
      totalTrades += run.result.trades.length;
      totalPnl += run.result.summary.totalPnlUsd;
      for (const trade of run.result.trades) {
        if (trade.pnlUsd > 0) wins += 1;
      }
    }

    return {
      windows: batchRuns.length,
      windowsSucceeded,
      windowsFailed,
      totalTrades,
      totalPnl,
      winRatePct: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    };
  }, [batchRuns]);

  const batchFlattenedTrades = useMemo(() => {
    const out: Array<{ run: BatchWindowRun; trade: OrbBacktestTrade }> = [];
    for (const run of batchRuns) {
      if (!run.result) continue;
      for (const trade of run.result.trades) {
        out.push({ run, trade });
      }
    }
    return out;
  }, [batchRuns]);

  const tradeChartCards = useMemo<TradeChartCard[]>(() => {
    const cards: TradeChartCard[] = [];

    for (const run of batchRuns) {
      if (!run.result) continue;
      for (const trade of run.result.trades) {
        const bars = sliceBarsForTrade(run.result.barsUsed, trade.entryDate, trade.exitDate, 8);
        const session = run.result.sessionRanges.find((row) => row.sessionDate === trade.sessionDate);
        cards.push({
          id: `batch-${run.id}-${trade.id}`,
          symbol: run.symbol,
          runLabel: `Date ${run.earningsDate} (${run.startDate} to ${run.endDate})`,
          trade,
          bars,
          ...toChartTrades(trade),
          segments: session
            ? [
                {
                  startDate: session.openingRangeStart,
                  endDate: session.sessionEnd,
                  price: session.high,
                  color: "#a78bfa",
                  lineWidth: 2,
                },
                {
                  startDate: session.openingRangeStart,
                  endDate: session.sessionEnd,
                  price: session.low,
                  color: "#a78bfa",
                  lineWidth: 2,
                },
                {
                  startDate: session.openingRangeStart,
                  endDate: session.sessionEnd,
                  price: session.mid,
                  color: "#60a5fa",
                  lineWidth: 1,
                },
              ]
            : [],
        });
      }
    }

    return cards;
  }, [batchRuns]);

  useEffect(() => {
    const symbols = parseSymbolsInput(form.symbol);
    if (symbols.length === 0) {
      setChecklistItems([]);
      setSelectedChecklistKeys([]);
      setChecklistError(null);
      setHasAnyAvailableFallback(false);
      setHasAnyFallbackEarnings(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setChecklistLoading(true);
      setChecklistError(null);

      try {
        const nextItems: SymbolChecklistItem[] = [];
        const errors: string[] = [];
        let sawAvailableFallback = false;
        let sawFallbackEarnings = false;

        for (const symbol of symbols) {
          try {
            const dates = await fetchSymbolEarningsDates(symbol);
            if (dates.source === "available") sawAvailableFallback = true;
            if (dates.source === "fallback_earnings") sawFallbackEarnings = true;
            for (const date of dates.dates) {
              nextItems.push({
                key: checklistKeyFor(symbol, date),
                symbol,
                date,
                source: dates.source,
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to load dates";
            errors.push(`${symbol}: ${message}`);
          }
        }

        nextItems.sort((a, b) => {
          const symbolOrder = a.symbol.localeCompare(b.symbol);
          if (symbolOrder !== 0) return symbolOrder;
          return a.date.localeCompare(b.date);
        });

        const dedupedItems: SymbolChecklistItem[] = [];
        const seenKeys = new Set<string>();
        for (const item of nextItems) {
          if (seenKeys.has(item.key)) continue;
          seenKeys.add(item.key);
          dedupedItems.push(item);
        }

        if (!cancelled) {
          setChecklistItems(dedupedItems);
          setHasAnyAvailableFallback(sawAvailableFallback);
          setHasAnyFallbackEarnings(sawFallbackEarnings);
          const defaultSelection =
            dedupedItems.length > MAX_AUTO_SELECTED_DATES
              ? dedupedItems.slice(-MAX_AUTO_SELECTED_DATES).map((item) => item.key)
              : dedupedItems.map((item) => item.key);
          setSelectedChecklistKeys(defaultSelection);

          if (errors.length > 0) {
            const preview = errors.slice(0, 3).join(" | ");
            const suffix = errors.length > 3 ? ` (+${errors.length - 3} more)` : "";
            setChecklistError(`Some symbols failed to load: ${preview}${suffix}`);
          } else {
            setChecklistError(null);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setChecklistItems([]);
          setSelectedChecklistKeys([]);
          setHasAnyAvailableFallback(false);
          setHasAnyFallbackEarnings(false);
          setChecklistError(error instanceof Error ? error.message : "Failed to load checklist dates");
        }
      } finally {
        if (!cancelled) {
          setChecklistLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [form.symbol]);

  async function fetchSymbolEarningsDates(symbol: string): Promise<ChecklistDatesPayload> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const cached = earningsDatesCacheRef.current[normalizedSymbol];
    if (cached) return cached;

    const params = new URLSearchParams({
      symbol: normalizedSymbol,
      range: "2y",
    });
    const response = await apiFetch(`${apiPrefix}/bars?${params.toString()}`);
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      earningsEvents?: EarningsEvent[];
      bars?: Bar[];
    };

    if (!response.ok) {
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }

    const apiDates = Array.isArray(body.earningsEvents)
      ? body.earningsEvents
          .map((event) => normalizeIsoDateInput(event.date ?? ""))
          .filter((value): value is string => Boolean(value))
      : [];

    const fallbackDates = FALLBACK_EARNINGS_DATES_BY_SYMBOL[normalizedSymbol] ?? [];
    const mergedEarnings = Array.from(new Set([...apiDates, ...fallbackDates])).sort((a, b) =>
      a.localeCompare(b)
    );
    if (mergedEarnings.length > 0) {
      const payload: ChecklistDatesPayload = {
        dates: mergedEarnings,
        source: apiDates.length > 0 ? "earnings" : "fallback_earnings",
      };
      earningsDatesCacheRef.current[normalizedSymbol] = payload;
      return payload;
    }

    const barDates = Array.isArray(body.bars)
      ? body.bars
          .map((bar) => isoDayFromTimestamp(bar.t))
          .filter((value): value is string => Boolean(value))
      : [];
    const dedupedBarDates = Array.from(new Set(barDates)).sort((a, b) => a.localeCompare(b));
    const payload: ChecklistDatesPayload = {
      dates: dedupedBarDates,
      source: "available",
    };
    earningsDatesCacheRef.current[normalizedSymbol] = payload;
    return payload;
  }

  async function loadBars(symbol: string, startDate: string, endDate: string): Promise<BarsPayload> {
    const cacheKey = `${apiPrefix}::${symbol}::15Min::${startDate}::${endDate}`;
    const cached = barsCacheRef.current[cacheKey];
    if (cached) return cached;

    const params = new URLSearchParams({
      symbol,
      timeframe: "15Min",
      startDate,
      endDate,
      range: rangeForStartDate(startDate),
    });
    const response = await apiFetch(`${apiPrefix}/bars?${params.toString()}`);
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      bars?: Bar[];
      earningsEvents?: EarningsEvent[];
    };

    if (!response.ok) {
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }

    const payload: BarsPayload = {
      bars: Array.isArray(body.bars) ? body.bars : [],
      earningsEvents: Array.isArray(body.earningsEvents) ? body.earningsEvents : [],
    };
    barsCacheRef.current[cacheKey] = payload;
    return payload;
  }

  async function runBacktest() {
    setRunning(true);
    setRunError(null);

    try {
      if (parseSymbolsInput(form.symbol).length === 0) {
        throw new Error("Enter at least one stock symbol.");
      }
      if (!form.allowLong && !form.allowShort) {
        throw new Error("Enable at least one direction (long or short).");
      }

      const selected = checklistItems
        .filter((item) => selectedChecklistKeys.includes(item.key))
        .sort((a, b) => {
          const symbolOrder = a.symbol.localeCompare(b.symbol);
          if (symbolOrder !== 0) return symbolOrder;
          return a.date.localeCompare(b.date);
        });

      if (selected.length === 0) {
        throw new Error("Select at least one checklist date.");
      }

      if (form.windowDaysBefore + form.windowDaysAfter + 1 > 120) {
        throw new Error("Window size is too large for 15Min bars (max 120 days).");
      }

      const nextRuns: BatchWindowRun[] = [];

      for (const item of selected) {
        const symbol = item.symbol;
        const earningsDate = item.date;
        const startDate = addDaysIso(earningsDate, -form.windowDaysBefore);
        const endDate = addDaysIso(earningsDate, form.windowDaysAfter);
        const runId = `${symbol}-${earningsDate}`;

        try {
          const payload = await loadBars(symbol, startDate, endDate);
          if (payload.bars.length === 0) {
            nextRuns.push({
              id: runId,
              symbol,
              earningsDate,
              startDate,
              endDate,
              result: null,
              error: "No bars returned for this earnings window.",
            });
            continue;
          }

          const computed = runStockDaytradeOrbBacktest({
            symbol,
            bars: payload.bars,
            startDate,
            endDate,
            initialCapital: form.initialCapital,
            riskPerTradePct: form.riskPerTradePct / 100,
            rewardRisk: form.rewardRisk,
            allowLong: form.allowLong,
            allowShort: form.allowShort,
            maxTradesPerDay: 1,
            earningsDates: [earningsDate],
          });

          nextRuns.push({
            id: runId,
            symbol,
            earningsDate,
            startDate,
            endDate,
            result: computed,
            error: computed ? null : "Backtest returned no result.",
          });
        } catch (error) {
          nextRuns.push({
            id: runId,
            symbol,
            earningsDate,
            startDate,
            endDate,
            result: null,
            error: error instanceof Error ? error.message : "Failed to run earnings window",
          });
        }
      }

      setBatchRuns(nextRuns);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Backtest failed");
      setBatchRuns([]);
    } finally {
      setRunning(false);
    }
  }

  function toggleChecklistKey(key: string): void {
    setSelectedChecklistKeys((current) => {
      if (current.includes(key)) {
        return current.filter((value) => value !== key);
      }
      return [...current, key].sort((a, b) => a.localeCompare(b));
    });
  }

  const hasChecklistDates = checklistItems.length > 0;

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-80 flex-shrink-0 border-r border-border overflow-y-auto p-4 space-y-3">
        <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
          Tech Earnings ORB
        </p>
        <p className="text-[12px] text-text-secondary leading-relaxed">
          Enter one or more symbols, select checklist dates, then run ORB windows and inspect a chart for each generated trade.
        </p>

        <Field label="Symbols (comma separated)">
          <input
            className={inputClass}
            value={form.symbol}
            onChange={(event) =>
              setForm((current) => ({ ...current, symbol: event.target.value.toUpperCase() }))
            }
            placeholder="AAPL, MSFT, NVDA"
          />
        </Field>

        <div className="rounded border border-border bg-surface-2 p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Days Before">
              <input
                type="number"
                min={0}
                max={30}
                className={inputClass}
                value={form.windowDaysBefore}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    windowDaysBefore: Math.max(0, Number(event.target.value) || 0),
                  }))
                }
              />
            </Field>
            <Field label="Days After">
              <input
                type="number"
                min={0}
                max={30}
                className={inputClass}
                value={form.windowDaysAfter}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    windowDaysAfter: Math.max(0, Number(event.target.value) || 0),
                  }))
                }
              />
            </Field>
          </div>

          <div className="rounded border border-border bg-surface-3 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] uppercase tracking-wide text-text-secondary">Date Checklist</p>
              <p className="text-[11px] text-text-secondary">
                {selectedChecklistKeys.length}/{checklistItems.length} selected
              </p>
            </div>

            {checklistLoading ? (
              <p className="mt-2 text-[12px] text-text-secondary">Loading checklist dates...</p>
            ) : !hasChecklistDates ? (
              <p className="mt-2 text-[12px] text-text-secondary">
                {checklistError ?? "No dates available for these symbols."}
              </p>
            ) : (
              <>
                {checklistError ? (
                  <p className="mt-2 text-[11px] text-sell">{checklistError}</p>
                ) : null}
                {hasAnyAvailableFallback ? (
                  <p className="mt-2 text-[11px] text-text-secondary">
                    Some symbols had no detected earnings dates. Those symbols use all available bar dates.
                  </p>
                ) : hasAnyFallbackEarnings ? (
                  <p className="mt-2 text-[11px] text-text-secondary">
                    Some symbols are using built-in earnings date lists.
                  </p>
                ) : null}
                {checklistItems.length > MAX_AUTO_SELECTED_DATES ? (
                  <p className="mt-1 text-[11px] text-text-secondary">
                    Auto-selected the most recent {MAX_AUTO_SELECTED_DATES} windows. Use Select All for the full list.
                  </p>
                ) : null}
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedChecklistKeys(checklistItems.map((item) => item.key))}
                    className="rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedChecklistKeys([])}
                    className="rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
                  >
                    Clear All
                  </button>
                </div>

                <div className="mt-2 max-h-56 overflow-y-auto rounded border border-border/60 bg-surface-2 p-2">
                  {checklistItems.map((item) => (
                    <label key={item.key} className="mb-1 flex items-center gap-2 text-[12px] text-text-primary last:mb-0">
                      <input
                        type="checkbox"
                        checked={selectedChecklistKeys.includes(item.key)}
                        onChange={() => toggleChecklistKey(item.key)}
                      />
                      <span className="font-mono">{item.symbol}</span>
                      <span className="font-mono text-text-secondary">{item.date}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Initial Capital ($)">
            <input
              type="number"
              min={100}
              className={inputClass}
              value={form.initialCapital}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  initialCapital: Math.max(100, Number(event.target.value) || 0),
                }))
              }
            />
          </Field>
          <Field label="Risk / Trade (%)">
            <input
              type="number"
              min={0.1}
              max={5}
              step={0.1}
              className={inputClass}
              value={form.riskPerTradePct}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  riskPerTradePct: Math.max(0.1, Number(event.target.value) || 0),
                }))
              }
            />
          </Field>
        </div>

        <Field label="Reward / Risk Target">
          <input
            type="number"
            min={0.5}
            max={10}
            step={0.1}
            className={inputClass}
            value={form.rewardRisk}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                rewardRisk: Math.max(0.5, Number(event.target.value) || 0),
              }))
            }
          />
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setForm((current) => ({ ...current, allowLong: !current.allowLong }))}
            className={`rounded border px-2.5 py-1.5 text-xs ${
              form.allowLong
                ? "border-buy/60 bg-buy/10 text-buy"
                : "border-border bg-surface-2 text-text-secondary"
            }`}
          >
            Long {form.allowLong ? "On" : "Off"}
          </button>
          <button
            type="button"
            onClick={() => setForm((current) => ({ ...current, allowShort: !current.allowShort }))}
            className={`rounded border px-2.5 py-1.5 text-xs ${
              form.allowShort
                ? "border-sell/60 bg-sell/10 text-sell"
                : "border-border bg-surface-2 text-text-secondary"
            }`}
          >
            Short {form.allowShort ? "On" : "Off"}
          </button>
        </div>

        <button
          type="button"
          onClick={() => void runBacktest()}
          disabled={running || checklistLoading || selectedChecklistKeys.length === 0}
          className="w-full rounded bg-accent py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-60"
        >
          {running ? "Running…" : "Run Tech Earnings ORB Batch"}
        </button>

        {runError ? (
          <div className="rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
            {runError}
          </div>
        ) : null}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="shrink-0 px-4 py-2 border-b border-border/70 text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
          Results
        </div>

        {batchRuns.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-xs text-text-secondary">
            Run to test the selected checklist dates across the chosen symbols.
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {batchSummary ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 p-4 border-b border-border">
                  <StatCard label="Windows" value={String(batchSummary.windows)} sub="selected dates" />
                  <StatCard label="Succeeded" value={String(batchSummary.windowsSucceeded)} sub="with result" />
                  <StatCard
                    label="Failed"
                    value={String(batchSummary.windowsFailed)}
                    sub="errors or empty"
                    valueClassName={batchSummary.windowsFailed > 0 ? "text-sell" : "text-text-primary"}
                  />
                  <StatCard label="Total Trades" value={String(batchSummary.totalTrades)} sub="across windows" />
                  <StatCard
                    label="Batch P/L"
                    value={formatUsd(batchSummary.totalPnl)}
                    sub={`Win Rate ${batchSummary.winRatePct.toFixed(1)}%`}
                    valueClassName={batchSummary.totalPnl >= 0 ? "text-buy" : "text-sell"}
                  />
                </div>

                <div className="overflow-x-auto border-b border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-surface-1 border-b border-border text-text-secondary">
                      <tr>
                        <th className="px-3 py-2 text-left">Symbol</th>
                        <th className="px-3 py-2 text-left">Checklist Date</th>
                        <th className="px-3 py-2 text-left">Window</th>
                        <th className="px-3 py-2 text-right">Trades</th>
                        <th className="px-3 py-2 text-right">P/L</th>
                        <th className="px-3 py-2 text-left">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchRuns.map((run) => (
                        <tr key={run.id} className="border-b border-border/50">
                          <td className="px-3 py-2 font-mono text-text-primary">{run.symbol}</td>
                          <td className="px-3 py-2 font-mono text-text-primary">{run.earningsDate}</td>
                          <td className="px-3 py-2 text-text-secondary">
                            {run.startDate} to {run.endDate}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                            {run.result?.trades.length ?? 0}
                          </td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums ${(run.result?.summary.totalPnlUsd ?? 0) >= 0 ? "text-buy" : "text-sell"}`}
                          >
                            {run.result ? formatUsd(run.result.summary.totalPnlUsd) : "—"}
                          </td>
                          <td className={`px-3 py-2 ${run.error ? "text-sell" : "text-text-secondary"}`}>
                            {run.error ?? "ok"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="overflow-x-auto border-b border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-surface-1 border-b border-border text-text-secondary">
                      <tr>
                        <th className="px-3 py-2 text-left">Symbol</th>
                        <th className="px-3 py-2 text-left">Date</th>
                        <th className="px-3 py-2 text-left">Session</th>
                        <th className="px-3 py-2 text-left">Side</th>
                        <th className="px-3 py-2 text-right">Entry</th>
                        <th className="px-3 py-2 text-right">Exit</th>
                        <th className="px-3 py-2 text-right">P/L</th>
                        <th className="px-3 py-2 text-right">R</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchFlattenedTrades.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-3 py-3 text-text-secondary">
                            No trades generated across the selected dates.
                          </td>
                        </tr>
                      ) : (
                        batchFlattenedTrades.map(({ run, trade }) => (
                          <tr key={`${run.id}-${trade.id}`} className="border-b border-border/50">
                            <td className="px-3 py-2 font-mono text-text-primary">{run.symbol}</td>
                            <td className="px-3 py-2 font-mono text-text-primary">{run.earningsDate}</td>
                            <td className="px-3 py-2 text-text-secondary">{trade.sessionDate}</td>
                            <td className={`px-3 py-2 font-semibold ${trade.side === "long" ? "text-buy" : "text-sell"}`}>
                              {trade.side.toUpperCase()}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                              {formatUsd(trade.entryPrice)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-text-primary">
                              {formatUsd(trade.exitPrice)}
                            </td>
                            <td
                              className={`px-3 py-2 text-right tabular-nums ${trade.pnlUsd >= 0 ? "text-buy" : "text-sell"}`}
                            >
                              {formatUsd(trade.pnlUsd)}
                            </td>
                            <td
                              className={`px-3 py-2 text-right tabular-nums ${trade.pnlR >= 0 ? "text-buy" : "text-sell"}`}
                            >
                              {formatSigned(trade.pnlR)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}

            <div className="px-4 py-3 border-b border-border text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
              Trade Charts ({tradeChartCards.length})
            </div>
            {tradeChartCards.length === 0 ? (
              <div className="px-4 py-3 text-xs text-text-secondary">No trade charts to display yet.</div>
            ) : (
              <div className="p-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                {tradeChartCards.map((card) => (
                  <div key={card.id} className="rounded border border-border bg-surface-1 overflow-hidden">
                    <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2 text-[12px]">
                      <span className="font-semibold text-text-primary">{card.symbol}</span>
                      <span className="text-text-secondary">{card.runLabel}</span>
                      <span className={`ml-auto font-semibold ${card.trade.side === "long" ? "text-buy" : "text-sell"}`}>
                        {card.trade.side.toUpperCase()}
                      </span>
                      <span className={`font-semibold ${card.trade.pnlUsd >= 0 ? "text-buy" : "text-sell"}`}>
                        {formatUsd(card.trade.pnlUsd)}
                      </span>
                    </div>
                    <div className="h-64">
                      <BacktestChart
                        bars={card.bars}
                        scaleInTrades={card.scaleInTrades}
                        scaleOutTrades={card.scaleOutTrades}
                        earningsEvents={[]}
                        horizontalSegments={card.segments}
                        movingAverageDays={[7]}
                      />
                    </div>
                    <div className="px-3 py-2 text-[11px] text-text-secondary border-t border-border/60">
                      Entry {formatUsd(card.trade.entryPrice)} · Stop {formatUsd(card.trade.stopPrice)} · Target {formatUsd(card.trade.targetPrice)} · Exit {formatUsd(card.trade.exitPrice)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function toChartTrades(trade: OrbBacktestTrade): {
  scaleInTrades: BacktestTrade[];
  scaleOutTrades: BacktestTrade[];
} {
  const entry: BacktestTrade = {
    date: trade.entryDate,
    price: trade.entryPrice,
    amountUsd: trade.entryPrice * trade.qty,
    shares: trade.qty,
    sharesHeld: trade.side === "long" ? trade.qty : -trade.qty,
    signalScore: 1,
    rationale: `${trade.side} entry`,
    side: trade.side === "long" ? "buy" : "sell",
  };

  const exit: BacktestTrade = {
    date: trade.exitDate,
    price: trade.exitPrice,
    amountUsd: trade.exitPrice * trade.qty,
    shares: trade.qty,
    sharesHeld: 0,
    signalScore: 1,
    rationale: `${trade.side} exit`,
    side: trade.side === "long" ? "sell" : "buy",
  };

  if (trade.side === "long") {
    return {
      scaleInTrades: [entry],
      scaleOutTrades: [exit],
    };
  }

  return {
    scaleInTrades: [exit],
    scaleOutTrades: [entry],
  };
}

function sliceBarsForTrade(bars: Bar[], entryDate: string, exitDate: string, paddingBars: number): Bar[] {
  if (bars.length === 0) return [];

  const entryTs = Date.parse(entryDate);
  const exitTs = Date.parse(exitDate);
  if (!Number.isFinite(entryTs) || !Number.isFinite(exitTs)) return bars;

  let entryIdx = bars.findIndex((bar) => {
    const ts = Date.parse(bar.t);
    return Number.isFinite(ts) && ts >= entryTs;
  });
  let exitIdx = bars.findIndex((bar) => {
    const ts = Date.parse(bar.t);
    return Number.isFinite(ts) && ts >= exitTs;
  });

  if (entryIdx < 0) entryIdx = 0;
  if (exitIdx < 0) exitIdx = bars.length - 1;

  const start = Math.max(0, entryIdx - paddingBars);
  const end = Math.min(bars.length - 1, exitIdx + paddingBars);
  return bars.slice(start, end + 1);
}

function defaultForm(): FormState {
  return {
    symbol: "AAPL,MSFT,NVDA",
    initialCapital: 25_000,
    riskPerTradePct: 1,
    rewardRisk: 2,
    allowLong: true,
    allowShort: true,
    windowDaysBefore: 2,
    windowDaysAfter: 2,
  };
}

function checklistKeyFor(symbol: string, date: string): string {
  return `${symbol}::${date}`;
}

function parseSymbolsInput(value: string): string[] {
  if (!value.trim()) return [];
  const symbols = value
    .split(/[\s,]+/)
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item.length > 0);
  return Array.from(new Set(symbols));
}

function normalizeIsoDateInput(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ts = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  return trimmed;
}

function isoDayFromTimestamp(value: string): string | null {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString().slice(0, 10);
}

function addDaysIso(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map((value) => Number(value));
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return dt.toISOString().slice(0, 10);
}

function rangeForStartDate(startDate: string): string {
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(startTs)) return "2y";
  const warmupDays = 90;
  const daysBack = (Date.now() - startTs) / 86_400_000;
  if (daysBack > 5 * 365 - warmupDays) return "max";
  if (daysBack > 2 * 365 - warmupDays) return "5y";
  if (daysBack > 365 - warmupDays) return "2y";
  return "1y";
}

function formatUsd(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-text-secondary">{label}</span>
      {children}
    </label>
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
    <div className="rounded border border-border bg-surface-1 px-3 py-2">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${valueClassName}`}>{value}</p>
      <p className="text-[11px] text-text-secondary">{sub}</p>
    </div>
  );
}
