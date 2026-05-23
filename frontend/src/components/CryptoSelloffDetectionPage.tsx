import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import BacktestChart, {
  BacktestChartEventMarker,
  BacktestChartHorizontalSegment,
} from "./BacktestChart";
import {
  CryptoSelloffDetectionBacktestResult,
  SelloffDetectionEvent,
  runCryptoSelloffDetectionBacktest,
} from "../lib/cryptoSelloffDetectionBacktest";
import type { Bar, SignalWeight } from "../lib/signals";
import { apiFetch } from "../lib/apiFetch";

type StrategyProfile = {
  key: string;
  label: string;
  summary: string;
  timeframe: "1Day" | "1Hour";
  objective: "scale_in" | "selloff";
  durationDays: number;
  buyThreshold: number;
  sellThreshold: number;
  signals: SignalWeight[];
  crashDetection?: {
    enabled: boolean;
    threshold: number;
    signals: SignalWeight[];
  };
};

type ProfilesPayload = {
  profiles?: Record<string, StrategyProfile>;
};

type FormState = {
  symbol: string;
  startDate: string;
  timeframe: "1Hour" | "1Day";
};

type DetectionRunResult = {
  startDate: string;
  endDate: string;
  result: CryptoSelloffDetectionBacktestResult;
};

type DetectionConfig = {
  label: string;
  signals: SignalWeight[];
  startThreshold: number;
  endThreshold: number;
};

const inputClass =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";
const SELLOFF_DETECTION_MA_DAYS = [7];

export default function CryptoSelloffDetectionPage({ apiPrefix }: { apiPrefix: string }) {
  const [profilesByKey, setProfilesByKey] = useState<Record<string, StrategyProfile>>({});
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<DetectionRunResult | null>(null);
  const [form, setForm] = useState<FormState>(() => defaultForm());
  const barsCacheRef = useRef<Record<string, Bar[]>>({});

  useEffect(() => {
    let cancelled = false;

    async function loadProfiles() {
      setProfilesLoading(true);
      setProfilesError(null);
      try {
        const response = await apiFetch(`${apiPrefix}/bot/strategy-profiles`);
        const body = (await response.json().catch(() => ({}))) as ProfilesPayload & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        const map = body.profiles ?? {};
        if (Object.keys(map).length === 0) {
          throw new Error("No strategy profiles returned by backend.");
        }
        if (!cancelled) {
          setProfilesByKey(map);
        }
      } catch (err) {
        if (cancelled) return;
        setProfilesError(err instanceof Error ? err.message : "Failed to load profiles");
      } finally {
        if (!cancelled) {
          setProfilesLoading(false);
        }
      }
    }

    void loadProfiles();
    return () => {
      cancelled = true;
    };
  }, [apiPrefix]);

  const detectionConfig = useMemo(() => resolveDetectionConfig(profilesByKey), [profilesByKey]);
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
    return result.events.map((event) => {
      if (event.type === "selloff_started") {
        return {
          date: event.date,
          position: "aboveBar",
          shape: "arrowDown",
          color: "#ef4444",
          size: 1.4,
          text: "S",
        };
      }
      return {
        date: event.date,
        position: "belowBar",
        shape: "arrowUp",
        color: "#22c55e",
        size: 1.4,
        text: "E",
      };
    });
  }, [result]);

  const selloffLevelSegments = useMemo<BacktestChartHorizontalSegment[]>(() => {
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
          color: event.type === "selloff_started" ? "#ef4444" : "#22c55e",
          lineWidth: 2,
        },
      ];
    });
  }, [result]);

  async function runDetectionBacktest() {
    if (!detectionConfig) {
      setRunError("Selloff detection profile not available.");
      return;
    }

    setRunning(true);
    setRunError(null);

    try {
      const symbol = normalizeCryptoSymbol(form.symbol);
      const customStart = normalizeIsoDateInput(form.startDate);
      if (!customStart) {
        throw new Error("Start date must be YYYY-MM-DD.");
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
      const params = new URLSearchParams({
        symbol,
        timeframe: form.timeframe,
        range,
      });
      const cacheKey = `${apiPrefix}::${symbol}::${form.timeframe}::${range}`;
      let bars = barsCacheRef.current[cacheKey];
      if (!bars) {
        const barsResponse = await apiFetch(`${apiPrefix}/bars?${params.toString()}`);
        const barsBody = (await barsResponse.json().catch(() => ({}))) as {
          error?: string;
          bars?: Bar[];
        };
        if (!barsResponse.ok) {
          throw new Error(barsBody.error ?? `HTTP ${barsResponse.status}`);
        }
        bars = Array.isArray(barsBody.bars) ? barsBody.bars : [];
        barsCacheRef.current[cacheKey] = bars;
      }

      const minBars = form.timeframe === "1Day" ? 50 : 80;
      if (bars.length < minBars) {
        throw new Error("Not enough market bars returned for this symbol/timeframe.");
      }

      const computed = runCryptoSelloffDetectionBacktest({
        symbol,
        bars,
        startDate: customStart,
        endDate,
        signals: detectionConfig.signals,
        selloffStartThreshold: detectionConfig.startThreshold,
        selloffEndThreshold: detectionConfig.endThreshold,
        minGapBars: form.timeframe === "1Day" ? 3 : 2,
        minSelloffBars: 2,
        volumeLookbackPeriod: form.timeframe === "1Day" ? 30 : 20,
        simulateBarFormation: true,
        barFormationSlices: form.timeframe === "1Day" ? 6 : 8,
      });
      setRunResult({
        startDate: customStart,
        endDate,
        result: computed,
      });
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Failed to run selloff detection backtest");
      setRunResult(null);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-80 flex-shrink-0 border-r border-border overflow-y-auto p-4 space-y-3">
        <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
          Crypto Selloff Detection
        </p>
        <p className="text-[11px] text-text-secondary leading-relaxed">
          Detects selloff start and end events using candlestick selloff structure and
          bullish reversal confirmation, with composite score shown as context.
          Runs a single 3-month window from your selected start date.
        </p>

        {profilesError ? (
          <div className="rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
            {profilesError}
          </div>
        ) : null}

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

        {detectionConfig ? (
          <div className="rounded border border-border bg-surface-2 px-3 py-2 text-[10px] text-text-secondary space-y-1">
            <p>
              Detection Profile: <span className="text-text-primary">{detectionConfig.label}</span>
            </p>
            <p>
              Start Threshold: <span className="text-text-primary">{detectionConfig.startThreshold.toFixed(2)}</span>
              {" · "}
              End Threshold: <span className="text-text-primary">{detectionConfig.endThreshold.toFixed(2)}</span>
            </p>
            <p>
              Timeframe: <span className="text-text-primary">{form.timeframe}</span>
            </p>
            <p>
              Window: <span className="text-text-primary">3 months from selected start date</span>
            </p>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => void runDetectionBacktest()}
          disabled={running || profilesLoading || !detectionConfig}
          className="w-full rounded bg-accent py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-60"
        >
          {running ? "Running…" : "Run Selloff Detection Backtest"}
        </button>

        {runError ? (
          <div className="rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
            {runError}
          </div>
        ) : null}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="shrink-0 px-4 py-2 border-b border-border/70 text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
          Results
        </div>
        {!result ? (
          <div className="flex-1 flex items-center justify-center text-xs text-text-secondary">
            Choose a symbol and run to detect selloff started/ended events.
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="border-b border-border p-4 space-y-3">
              <p className="text-[11px] text-text-secondary">
                3-month window: {runResult?.startDate} to {runResult?.endDate}
              </p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 border-b border-border">
              <StatCard label="Selloff Started" value={String(result.totalSelloffStarted)} sub="event count" />
              <StatCard label="Selloff Ended" value={String(result.totalSelloffEnded)} sub="event count" />
              <StatCard
                label="Active Selloff"
                value={result.activeSelloffAtEnd ? "Yes" : "No"}
                sub="at end of window"
              />
              <StatCard
                label="Avg Duration"
                value={`${result.averageSelloffDurationBars.toFixed(1)} bars`}
                sub={`Max ${result.maxSelloffDurationBars} bars`}
              />
              <StatCard
                label="Bars Used"
                value={String(result.barsUsed.length)}
                sub={`${form.timeframe} bars`}
              />
              <StatCard
                label="Signal Events"
                value={String(result.events.length)}
                sub="start + end"
              />
            </div>

            <div className="h-72 border-b border-border">
              <BacktestChart
                bars={result.barsUsed}
                scaleInTrades={[]}
                scaleOutTrades={[]}
                earningsEvents={[]}
                eventMarkers={eventMarkers}
                horizontalSegments={selloffLevelSegments}
                movingAverageDays={SELLOFF_DETECTION_MA_DAYS}
              />
            </div>
            <div className="px-4 py-2 border-b border-border text-[11px] text-text-secondary">
              Markers: red down arrow = selloff started, green up arrow = selloff ended. Lines: 10-bar
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
                        No selloff start/end events were detected in this window.
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

function EventRow({ event }: { event: SelloffDetectionEvent }) {
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
      <td className={`px-3 py-2 font-semibold ${event.type === "selloff_started" ? "text-sell" : "text-buy"}`}>
        {event.type === "selloff_started" ? "Selloff Started" : "Selloff Ended"}
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
  };
}

function resolveDetectionConfig(
  profilesByKey: Record<string, StrategyProfile>
): DetectionConfig | null {
  const crashProfile = profilesByKey["crash_selloff_detected"];
  const fallbackSignals: SignalWeight[] = [
    { signal: { type: "selloff_pressure", period: 8 }, weight: 0.4 },
    { signal: { type: "volume", period: 20 }, weight: 0.25 },
    { signal: { type: "rsi", period: 7 }, weight: 0.15 },
    { signal: { type: "bollinger_band", period: 20, std_dev: 2.5 }, weight: 0.2 },
  ];

  if (crashProfile?.crashDetection?.enabled) {
    const startThreshold = clamp(crashProfile.crashDetection.threshold, 0.05, 0.99);
    const endThreshold = clamp(startThreshold - 0.18, 0.05, startThreshold - 0.01);
    return {
      label: crashProfile.label,
      signals:
        crashProfile.crashDetection.signals.length > 0
          ? crashProfile.crashDetection.signals
          : fallbackSignals,
      startThreshold,
      endThreshold,
    };
  }

  return {
    label: "Selloff Detection (Fallback)",
    signals: fallbackSignals,
    startThreshold: 0.74,
    endThreshold: 0.56,
  };
}

function normalizeCryptoSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/[-_]/g, "/");
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

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeIsoDateInput(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ts = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  return trimmed;
}

function monthsAgoIso(months: number): string {
  const now = new Date();
  const dt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate())
  );
  return dt.toISOString().slice(0, 10);
}

function addMonthsIso(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split("-").map((v) => Number(v));
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, targetMonthIndex + 1, 0)
  ).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);
  const dt = new Date(Date.UTC(targetYear, targetMonthIndex, clampedDay));
  return dt.toISOString().slice(0, 10);
}

function addDaysIso(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map((v) => Number(v));
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return dt.toISOString().slice(0, 10);
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
      <span className="mb-1 block text-[10px] text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded border border-border bg-surface-1 px-3 py-2">
      <p className="text-[10px] text-text-secondary">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-text-primary">{value}</p>
      <p className="text-[10px] text-text-secondary">{sub}</p>
    </div>
  );
}
