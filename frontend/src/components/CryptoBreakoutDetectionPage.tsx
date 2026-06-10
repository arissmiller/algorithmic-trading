import { ReactNode, useMemo, useRef, useState } from "react";
import BacktestChart, {
  BacktestChartEventMarker,
  BacktestChartHorizontalSegment,
} from "./BacktestChart";
import {
  CryptoJumpDetectionBacktestResult,
  JumpDetectionEvent,
  runCryptoJumpDetectionBacktest,
} from "../lib/cryptoJumpDetectionBacktest";
import type { Bar, SignalWeight } from "../lib/signals";
import type { MarketBarsPayload } from "../features/backtesting/types";
import { fetchMarketBarsCached } from "../features/backtesting/marketData";
import { normalizeCryptoSymbol } from "../features/backtesting/symbolUtils";
import {
  addDaysIso,
  addMonthsIso,
  monthsAgoIso,
  normalizeIsoDateInput,
  todayIsoDate,
} from "../features/backtesting/dateUtils";
import { rangeForStartDate } from "../features/backtesting/rangeUtils";

type FormState = {
  symbol: string;
  startDate: string;
  timeframe: "1Hour" | "1Day";
  startThreshold: number;
  endThreshold: number;
  simulateIntrabar: boolean;
  intrabarSlices: number;
};

type DetectionRunResult = {
  startDate: string;
  endDate: string;
  result: CryptoJumpDetectionBacktestResult;
};

const inputClass =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";

const BREAKOUT_SIGNALS: SignalWeight[] = [
  { signal: { type: "bullish_impulse", period: 6 }, weight: 0.4 },
  { signal: { type: "volume", period: 20 }, weight: 0.2 },
  { signal: { type: "breakout_momentum", period: 20 }, weight: 0.25 },
  { signal: { type: "momentum_rsi", period: 14 }, weight: 0.15 },
];

export default function CryptoBreakoutDetectionPage({ apiPrefix }: { apiPrefix: string }) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<DetectionRunResult | null>(null);
  const [form, setForm] = useState<FormState>(() => defaultForm());
  const barsCacheRef = useRef<Record<string, MarketBarsPayload>>({});

  const result = runResult?.result ?? null;
  const returnLabels = useMemo(
    () =>
      form.timeframe === "1Day"
        ? { oneBar: "1d Return", threeBar: "3d Return" }
        : { oneBar: "1h Return", threeBar: "3h Return" },
    [form.timeframe]
  );

  const eventMarkers = useMemo<BacktestChartEventMarker[]>(() => {
    if (!result) return [];
    return result.events.map((event) =>
      event.type === "jump_started"
        ? {
            date: event.date,
            position: "aboveBar" as const,
            shape: "circle" as const,
            color: "#f59e0b",
            size: 1.2,
            text: "B",
          }
        : {
            date: event.date,
            position: "belowBar" as const,
            shape: "arrowUp" as const,
            color: "#38bdf8",
            size: 1.1,
            text: "R",
          }
    );
  }, [result]);

  const breakoutLevelSegments = useMemo<BacktestChartHorizontalSegment[]>(() => {
    if (!result) return [];
    return result.events.flatMap((event) => {
      if (!Number.isFinite(event.price)) return [];
      const startIndex = findBarIndexAtOrAfter(result.barsUsed, event.date);
      if (startIndex < 0) return [];
      const endIndex = Math.min(result.barsUsed.length - 1, startIndex + 10);
      const startBar = result.barsUsed[startIndex];
      const endBar = result.barsUsed[endIndex];
      if (!startBar || !endBar) return [];
      return [
        {
          startDate: startBar.t,
          endDate: endBar.t,
          price: event.price,
          color: event.type === "jump_started" ? "#f59e0b" : "#38bdf8",
          lineWidth: 2,
        },
      ];
    });
  }, [result]);

  async function runDetectionBacktest() {
    setRunning(true);
    setRunError(null);

    try {
      const symbol = normalizeCryptoSymbol(form.symbol);
      const customStart = normalizeIsoDateInput(form.startDate);
      if (!customStart) {
        throw new Error("Start date must be YYYY-MM-DD.");
      }
      if (form.endThreshold >= form.startThreshold) {
        throw new Error("Breakout end threshold must be below the start threshold.");
      }
      if (form.intrabarSlices < 2) {
        throw new Error("Intrabar slices must be at least 2.");
      }
      const today = todayIsoDate();
      if (customStart > today) {
        throw new Error("Start date cannot be after today.");
      }
      const endDate = addDaysIso(addMonthsIso(customStart, 3), -1);
      if (endDate > today) {
        throw new Error("Start date must be at least 3 months before today.");
      }
      const range = rangeForStartDate(customStart);
      const { bars } = await fetchMarketBarsCached({
        apiPrefix,
        cacheRef: barsCacheRef,
        symbol,
        timeframe: form.timeframe,
        range,
      });

      const minBars = form.timeframe === "1Day" ? 50 : 80;
      if (bars.length < minBars) {
        throw new Error("Not enough market bars returned for this symbol/timeframe.");
      }

      const computed = runCryptoJumpDetectionBacktest({
        symbol,
        bars,
        startDate: customStart,
        endDate,
        signals: BREAKOUT_SIGNALS,
        jumpStartThreshold: form.startThreshold,
        jumpEndThreshold: form.endThreshold,
        minJumpBars: 1,
        minGapBars: form.timeframe === "1Day" ? 3 : 2,
        volumeLookbackPeriod: form.timeframe === "1Day" ? 30 : 20,
        simulateBarFormation: form.simulateIntrabar,
        barFormationSlices: form.intrabarSlices,
      });
      setRunResult({
        startDate: customStart,
        endDate,
        result: computed,
      });
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Failed to run breakout detection backtest");
      setRunResult(null);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-80 flex-shrink-0 border-r border-border overflow-y-auto p-4 space-y-3">
        <p className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
          Crypto Breakout Detection
        </p>
        <p className="text-[12px] text-text-secondary leading-relaxed">
          Detects upside breakout start and reset events using bullish impulse, breakout momentum,
          RSI, and relative volume. Runs a single 3-month window from your selected start date.
        </p>

        <Field label="Symbol">
          <input
            className={inputClass}
            value={form.symbol}
            onChange={(event) =>
              setForm((current) => ({ ...current, symbol: normalizeCryptoSymbol(event.target.value) }))
            }
            placeholder="BTC/USD"
          />
        </Field>

        <Field label="Start Date">
          <input
            type="date"
            className={inputClass}
            value={form.startDate}
            onChange={(event) => setForm((current) => ({ ...current, startDate: event.target.value }))}
          />
        </Field>

        <Field label="Timeframe">
          <select
            className={inputClass}
            value={form.timeframe}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                timeframe: event.target.value === "1Day" ? "1Day" : "1Hour",
              }))
            }
          >
            <option value="1Hour">1Hour</option>
            <option value="1Day">1Day</option>
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Start Threshold">
            <input
              type="number"
              className={inputClass}
              value={form.startThreshold}
              min={0.1}
              max={1}
              step={0.01}
              onChange={(event) =>
                setForm((current) => ({ ...current, startThreshold: Number(event.target.value) }))
              }
            />
          </Field>
          <Field label="End Threshold">
            <input
              type="number"
              className={inputClass}
              value={form.endThreshold}
              min={0.05}
              max={1}
              step={0.01}
              onChange={(event) =>
                setForm((current) => ({ ...current, endThreshold: Number(event.target.value) }))
              }
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.simulateIntrabar}
            onChange={(event) =>
              setForm((current) => ({ ...current, simulateIntrabar: event.target.checked }))
            }
            className="accent-accent"
          />
          <span className="text-[11px] text-text-secondary">Detect breakouts within the forming bar</span>
        </label>

        <Field label="Intrabar Slices">
          <input
            type="number"
            className={inputClass}
            value={form.intrabarSlices}
            min={2}
            max={24}
            step={1}
            onChange={(event) =>
              setForm((current) => ({ ...current, intrabarSlices: Number(event.target.value) }))
            }
          />
        </Field>

        <div className="rounded border border-border bg-surface-2 px-3 py-2 text-[11px] text-text-secondary space-y-1">
          <p>
            Detection Profile: <span className="text-text-primary">Breakout Momentum (Fallback)</span>
          </p>
          <p>
            Start Threshold: <span className="text-text-primary">{form.startThreshold.toFixed(2)}</span>
            {" · "}
            End Threshold: <span className="text-text-primary">{form.endThreshold.toFixed(2)}</span>
          </p>
          <p>
            Timeframe: <span className="text-text-primary">{form.timeframe}</span>
          </p>
          <p>
            Window: <span className="text-text-primary">3 months from selected start date</span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => void runDetectionBacktest()}
          disabled={running}
          className="w-full rounded bg-accent py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-60"
        >
          {running ? "Running…" : "Run Breakout Detection Backtest"}
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
        {!result ? (
          <div className="flex-1 flex items-center justify-center text-xs text-text-secondary">
            Choose a symbol and run to detect breakout started/reset events.
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="border-b border-border p-4 space-y-3">
              <p className="text-[12px] text-text-secondary">
                3-month window: {runResult?.startDate} to {runResult?.endDate}
              </p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 border-b border-border">
              <StatCard label="Breakouts Started" value={String(result.totalJumpStarted)} sub="event count" />
              <StatCard label="Breakouts Reset" value={String(result.totalJumpEnded)} sub="event count" />
              <StatCard
                label="Active Breakout"
                value={result.activeJumpAtEnd ? "Yes" : "No"}
                sub="at end of window"
              />
              <StatCard
                label="Avg Duration"
                value={`${result.averageJumpDurationBars.toFixed(1)} bars`}
                sub={`Max ${result.maxJumpDurationBars} bars`}
              />
              <StatCard
                label="Bars Used"
                value={String(result.barsUsed.length)}
                sub={`${form.timeframe} bars`}
              />
              <StatCard
                label="Signal Events"
                value={String(result.events.length)}
                sub="start + reset"
              />
            </div>

            <div className="h-72 border-b border-border">
              <BacktestChart
                bars={result.barsUsed}
                scaleInTrades={[]}
                scaleOutTrades={[]}
                earningsEvents={[]}
                eventMarkers={eventMarkers}
                horizontalSegments={breakoutLevelSegments}
              />
            </div>
            <div className="px-4 py-2 border-b border-border text-[12px] text-text-secondary">
              Markers: amber circle = breakout started, blue up arrow = breakout reset. Lines: 10-bar
              horizontal projection at each event price ({eventMarkers.length} events).
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface-1 border-b border-border text-text-secondary">
                  <tr>
                    <th className="px-3 py-2 text-left">Time</th>
                    <th className="px-3 py-2 text-left">Event</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Score</th>
                    <th className="px-3 py-2 text-right">Threshold</th>
                    <th className="px-3 py-2 text-right">{returnLabels.oneBar}</th>
                    <th className="px-3 py-2 text-right">{returnLabels.threeBar}</th>
                    <th className="px-3 py-2 text-right">Rel Vol</th>
                    <th className="px-3 py-2 text-left">Reason</th>
                    <th className="px-3 py-2 text-left">Top Influences</th>
                  </tr>
                </thead>
                <tbody>
                  {result.events.length === 0 ? (
                    <tr>
                      <td className="px-3 py-3 text-text-secondary" colSpan={10}>
                        No breakout start/reset events were detected in this window.
                      </td>
                    </tr>
                  ) : (
                    result.events.map((event) => (
                      <EventRow key={event.id} event={event} />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function EventRow({ event }: { event: JumpDetectionEvent }) {
  const topInfluences = event.influences
    .slice(0, 3)
    .map((influence) => {
      const scorePct = `${(influence.score * 100).toFixed(0)}%`;
      const sharePct = `${(influence.shareOfComposite * 100).toFixed(0)}%`;
      return `${influence.label} ${scorePct} (share ${sharePct})`;
    })
    .join(" | ");

  return (
    <tr key={event.id} className="border-b border-border/50">
      <td className="px-3 py-2 font-mono text-text-primary">{event.date}</td>
      <td
        className={`px-3 py-2 font-semibold ${
          event.type === "jump_started" ? "text-accent" : "text-sky-400"
        }`}
      >
        {event.type === "jump_started" ? "Breakout Started" : "Breakout Reset"}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">{formatUsd(event.price)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">{(event.score * 100).toFixed(1)}%</td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">{(event.threshold * 100).toFixed(1)}%</td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">{formatPct(event.oneBarReturn)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">{formatPct(event.threeBarReturn)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">{event.relVolume.toFixed(2)}x</td>
      <td className="px-3 py-2 text-text-secondary">{event.reason}</td>
      <td className="px-3 py-2 text-text-secondary">{topInfluences || "—"}</td>
    </tr>
  );
}

function defaultForm(): FormState {
  return {
    symbol: "BTC/USD",
    startDate: monthsAgoIso(3),
    timeframe: "1Hour",
    startThreshold: 0.72,
    endThreshold: 0.52,
    simulateIntrabar: true,
    intrabarSlices: 8,
  };
}

function formatUsd(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function findBarIndexAtOrAfter(bars: Bar[], date: string): number {
  const targetTs = Date.parse(date);
  if (!Number.isFinite(targetTs)) return -1;
  for (let i = 0; i < bars.length; i++) {
    const barTs = Date.parse(bars[i].t);
    if (Number.isFinite(barTs) && barTs >= targetTs) return i;
  }
  return bars.length > 0 ? bars.length - 1 : -1;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded border border-border bg-surface-2 px-3 py-2">
      <p className="text-[11px] uppercase tracking-widest text-text-secondary">{label}</p>
      <p className="mt-1 text-lg font-semibold text-text-primary">{value}</p>
      <p className="text-[11px] text-text-secondary">{sub}</p>
    </div>
  );
}
