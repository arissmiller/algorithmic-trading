import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { type Bar } from "../lib/signals";
import BacktestChart, { type BacktestChartEventMarker } from "./BacktestChart";
import { apiFetch } from "../lib/apiFetch";

type LivePortfolioSignalWindow = {
  timeframeDays: 7 | 30 | 90;
  action: "buy" | "sell" | "hold";
  score: number | null;
  latestScore: number | null;
  barTime: string | null;
  rationale: string | null;
  error: string | null;
};

type LivePortfolioHoldingSnapshot = {
  symbol: string;
  targetPct: number;
  normalizedTargetPct: number;
  summary: string | null;
  wikipediaUrl: string | null;
  lastPrice: number | null;
  signals: LivePortfolioSignalWindow[];
};

type LivePortfolioWhitepaper = {
  title: string;
  url: string;
  aiGenerated: boolean;
  disclosure: string | null;
};

type LivePortfolioSnapshot = {
  portfolioKey: string;
  portfolioName: string;
  whitepaper: LivePortfolioWhitepaper | null;
  launchedAt: string | null;
  algorithm: "buy_over_time";
  buyThreshold: number;
  sellThreshold: number;
  totalRequestedPct: number;
  generatedAt: string;
  updatedAt: string;
  holdings: LivePortfolioHoldingSnapshot[];
};

type BarsApiPayload = {
  bars?: Bar[];
  error?: string;
};

type WindowSignalBreakdown = {
  timeframeDays: 7 | 30 | 90;
  barsUsed: number;
};

const SIGNAL_WINDOWS: Array<7 | 30 | 90> = [7, 30, 90];
const PRICE_BAR_RETRY_BACKOFF_MS = 60_000;

export default function LivePortfolioPage({
  apiPrefix,
  portfolioKey,
  defaultPortfolioName,
}: {
  apiPrefix: string;
  portfolioKey?: string;
  defaultPortfolioName: string;
}) {
  const [snapshot, setSnapshot] = useState<LivePortfolioSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priceBarsBySymbol, setPriceBarsBySymbol] = useState<Record<string, Bar[]>>({});
  const [priceBarsLoadingBySymbol, setPriceBarsLoadingBySymbol] = useState<Record<string, boolean>>({});
  const [priceBarsErrorBySymbol, setPriceBarsErrorBySymbol] = useState<Record<string, string | null>>({});
  const priceBarsBySymbolRef = useRef<Record<string, Bar[]>>({});
  const priceBarsLoadingBySymbolRef = useRef<Record<string, boolean>>({});
  const priceBarsNextRetryAtMsRef = useRef<Record<string, number>>({});

  const portfolioUrl = buildPortfolioUrl(apiPrefix, portfolioKey);
  const whitepaperLink = toSafeWhitepaperUrl(snapshot?.whitepaper?.url);
  const liveSinceLabel = formatLiveSinceDay(snapshot?.launchedAt ?? null);
  const aiWhitepaperDisclosure = snapshot?.whitepaper?.disclosure?.trim()
    || "Transparency note: this portfolio whitepaper was originally AI-generated and should be reviewed before relying on it.";

  useEffect(() => {
    priceBarsBySymbolRef.current = priceBarsBySymbol;
  }, [priceBarsBySymbol]);

  useEffect(() => {
    priceBarsLoadingBySymbolRef.current = priceBarsLoadingBySymbol;
  }, [priceBarsLoadingBySymbol]);

  const loadSnapshot = useCallback(async (silent: boolean) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await apiFetch(portfolioUrl);
      const body = (await response.json().catch(() => ({}))) as Partial<LivePortfolioSnapshot> & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      if (
        !Array.isArray(body.holdings) ||
        typeof body.buyThreshold !== "number" ||
        typeof body.sellThreshold !== "number"
      ) {
        throw new Error("Invalid portfolio response.");
      }

      const snapshotPortfolioName =
        typeof body.portfolioName === "string" && body.portfolioName.trim().length > 0
          ? body.portfolioName
          : defaultPortfolioName;
      const snapshotPortfolioKey =
        typeof body.portfolioKey === "string" && body.portfolioKey.trim().length > 0
          ? body.portfolioKey
          : normalizePortfolioKey(portfolioKey ?? snapshotPortfolioName);
      const snapshotWhitepaper = coerceWhitepaper(body.whitepaper);
      const snapshotLaunchedAt = coerceOptionalDateString(body.launchedAt);

      setSnapshot({
        ...(body as LivePortfolioSnapshot),
        portfolioName: snapshotPortfolioName,
        portfolioKey: snapshotPortfolioKey,
        whitepaper: snapshotWhitepaper,
        launchedAt: snapshotLaunchedAt,
      });
      setError(null);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : "Failed to load portfolio.";
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [defaultPortfolioName, portfolioKey, portfolioUrl]);

  const loadPriceHistory = useCallback(async (symbol: string) => {
    const key = normalizeSymbol(symbol);
    if (!key) return;
    if ((priceBarsBySymbolRef.current[key]?.length ?? 0) > 0) return;
    if (priceBarsLoadingBySymbolRef.current[key]) return;
    const nextRetryAtMs = priceBarsNextRetryAtMsRef.current[key] ?? 0;
    if (nextRetryAtMs > Date.now()) return;

    priceBarsLoadingBySymbolRef.current = { ...priceBarsLoadingBySymbolRef.current, [key]: true };
    setPriceBarsLoadingBySymbol((current) => ({ ...current, [key]: true }));
    setPriceBarsErrorBySymbol((current) => ({ ...current, [key]: null }));

    try {
      const params = new URLSearchParams({
        symbol: key,
        timeframe: "1Day",
        range: "2y",
      });
      const response = await apiFetch(`${apiPrefix}/bars?${params.toString()}`);
      const body = (await response.json().catch(() => ({}))) as BarsApiPayload;
      if (!response.ok) {
        throw new Error(body.error ?? `Failed to fetch ${key} bars (HTTP ${response.status}).`);
      }

      const bars = Array.isArray(body.bars)
        ? body.bars.filter(
            (bar) =>
              bar &&
              typeof bar.t === "string" &&
              Number.isFinite(bar.o) &&
              Number.isFinite(bar.h) &&
              Number.isFinite(bar.l) &&
              Number.isFinite(bar.c)
          )
        : [];
      if (bars.length === 0) {
        throw new Error(`No 2-year bars returned for ${key}.`);
      }

      delete priceBarsNextRetryAtMsRef.current[key];
      setPriceBarsBySymbol((current) => ({ ...current, [key]: sortBarsByTime(bars) }));
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : `Failed to load 2-year bars for ${key}.`;
      priceBarsNextRetryAtMsRef.current[key] = Date.now() + PRICE_BAR_RETRY_BACKOFF_MS;
      setPriceBarsErrorBySymbol((current) => ({ ...current, [key]: message }));
    } finally {
      priceBarsLoadingBySymbolRef.current = { ...priceBarsLoadingBySymbolRef.current, [key]: false };
      setPriceBarsLoadingBySymbol((current) => ({ ...current, [key]: false }));
    }
  }, [apiPrefix]);

  useEffect(() => {
    void loadSnapshot(false);
    const timer = setInterval(() => {
      void loadSnapshot(true);
    }, 30_000);
    return () => clearInterval(timer);
  }, [loadSnapshot]);

  useEffect(() => {
    if (!snapshot || snapshot.holdings.length === 0) return;
    snapshot.holdings.forEach((holding) => {
      void loadPriceHistory(holding.symbol);
    });
  }, [snapshot, loadPriceHistory]);

  return (
    <div className="h-full overflow-auto p-4">
      <section className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-sm font-semibold mb-1">{snapshot?.portfolioName ?? defaultPortfolioName}</h2>
          <p className="text-xs text-text-secondary">
            Backend-controlled target allocations with live buy-over-time signals at 7, 30, and 90 days.
          </p>
          {liveSinceLabel ? (
            <p className="text-[11px] text-text-secondary mt-1">
              Live since {liveSinceLabel}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void loadSnapshot(false)}
          disabled={loading || refreshing}
          className="ml-auto rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading || refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </section>

      {snapshot?.whitepaper ? (
        <section className="mb-4 rounded border border-border bg-surface-1 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold text-text-primary">{snapshot.whitepaper.title}</p>
            {whitepaperLink ? (
              <a
                href={whitepaperLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-accent transition-colors hover:border-accent hover:bg-accent/15"
              >
                Open PDF
              </a>
            ) : (
              <span className="text-[10px] text-sell">Whitepaper link is invalid.</span>
            )}
            {snapshot.whitepaper.aiGenerated ? (
              <span className="inline-flex rounded border border-[#f5c16c66] bg-[#f5c16c22] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#f5c16c]">
                AI-generated
              </span>
            ) : null}
          </div>
          {snapshot.whitepaper.aiGenerated ? (
            <p className="mt-1 text-[10px] text-[#f5c16c]">{aiWhitepaperDisclosure}</p>
          ) : null}
        </section>
      ) : null}

      {error ? (
        <div className="mb-4 rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          {error}
        </div>
      ) : null}

      {loading && !snapshot ? (
        <div className="mb-4 rounded border border-border bg-surface-1 px-4 py-5 text-xs text-text-secondary">
          Loading portfolio...
        </div>
      ) : null}

      {snapshot ? (
        <section className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
          <MetricCard
            label="Symbols"
            value={String(snapshot.holdings.length)}
            sub={`Updated ${new Date(snapshot.generatedAt).toLocaleString()}`}
          />
          <MetricCard
            label="Requested Total"
            value={formatPct(snapshot.totalRequestedPct)}
            sub={`Backend config at ${new Date(snapshot.updatedAt).toLocaleString()}`}
          />
          <MetricCard
            label="Buy Threshold"
            value={formatScore(snapshot.buyThreshold)}
            sub="7/30/90 average score trigger"
            valueClassName="text-buy"
          />
          <MetricCard
            label="Sell Threshold"
            value={formatScore(snapshot.sellThreshold)}
            sub="7/30/90 average score trigger"
            valueClassName="text-sell"
          />
        </section>
      ) : null}

      <section className="rounded border border-border bg-surface-1">
        <div className="px-4 py-2 border-b border-border">
          <span className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
            Allocation and Signals
          </span>
        </div>

        {!snapshot ? (
          <div className="p-4 text-xs text-text-secondary">
            Portfolio data is unavailable.
          </div>
        ) : snapshot.holdings.length === 0 ? (
          <div className="p-4 text-xs text-text-secondary">
            No target allocations configured yet.
          </div>
        ) : (
          <div className="space-y-3 p-3">
            {snapshot.holdings.map((holding) => {
              const symbolKey = normalizeSymbol(holding.symbol);
              const wikipediaUrl = toSafeWikipediaUrl(holding.wikipediaUrl);
              const symbolBars = priceBarsBySymbol[symbolKey] ?? [];
              const signalBreakdowns = computeWindowSignalBreakdowns(symbolBars);
              const cadenceMarkers = buildCadenceEventMarkers(symbolBars);

              return (
                <article key={holding.symbol} className="rounded border border-border/70 bg-surface-2 p-2.5">
                  <div className="grid gap-3 xl:grid-cols-2">
                    <section className="rounded border border-border/70 bg-surface-1 p-2.5">
                      <div className="flex gap-2">
                        <aside className="w-44 shrink-0 rounded border border-border bg-surface-2 p-2">
                          <dl className="space-y-1.5 text-[10px]">
                            <div>
                              <dt className="uppercase tracking-wide text-text-secondary">Symbol</dt>
                              <dd className="font-semibold text-text-primary">{holding.symbol}</dd>
                              {holding.summary ? (
                                <p className="mt-1 text-[10px] leading-snug text-text-secondary">
                                  {holding.summary}
                                </p>
                              ) : null}
                              {wikipediaUrl ? (
                                <a
                                  href={wikipediaUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 inline-flex text-[10px] font-medium text-accent hover:underline"
                                >
                                  Wikipedia
                                </a>
                              ) : null}
                            </div>
                            <div>
                              <dt className="uppercase tracking-wide text-text-secondary">Target % (Portfolio)</dt>
                              <dd className="tabular-nums text-text-primary">
                                {formatPct(holding.normalizedTargetPct)}
                              </dd>
                            </div>
                            <div>
                              <dt className="uppercase tracking-wide text-text-secondary">Last Price</dt>
                              <dd className="tabular-nums text-text-primary">
                                {formatUsd(holding.lastPrice)}
                              </dd>
                            </div>
                          </dl>
                        </aside>

                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] uppercase tracking-widest text-text-secondary font-semibold">
                            Price (2Y)
                          </p>
                          <div className="mt-1.5">
                            {priceBarsLoadingBySymbol[symbolKey] ? (
                              <div className="h-40 rounded border border-border/60 bg-surface-2 px-3 py-2 text-xs text-text-secondary">
                                Loading 2-year price bars...
                              </div>
                            ) : priceBarsErrorBySymbol[symbolKey] ? (
                              <div className="h-40 rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
                                {priceBarsErrorBySymbol[symbolKey]}
                              </div>
                            ) : (
                              <div className="h-64 rounded border border-border/60 overflow-hidden">
                                <BacktestChart
                                  bars={symbolBars}
                                  scaleInTrades={[]}
                                  scaleOutTrades={[]}
                                  earningsEvents={[]}
                                  eventMarkers={cadenceMarkers}
                                  movingAverageDays={[7]}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </section>

                    <section className="rounded border border-border/70 bg-surface-1 p-2.5">
                      <p className="text-[10px] uppercase tracking-widest text-text-secondary font-semibold">
                        Signal Breakdown
                      </p>
                      <div className="mt-1.5">
                        {priceBarsLoadingBySymbol[symbolKey] ? (
                          <div className="h-44 rounded border border-border/60 bg-surface-2 px-3 py-2 text-xs text-text-secondary">
                            Loading window signal breakdown...
                          </div>
                        ) : priceBarsErrorBySymbol[symbolKey] ? (
                          <div className="h-44 rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
                            Could not compute window signals from price history.
                          </div>
                        ) : (
                          <SignalBreakdownTable
                            liveSignals={holding.signals}
                            breakdowns={signalBreakdowns}
                            buyThreshold={snapshot.buyThreshold}
                            sellThreshold={snapshot.sellThreshold}
                          />
                        )}
                      </div>
                    </section>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function SignalBreakdownTable({
  liveSignals,
  breakdowns,
  buyThreshold,
  sellThreshold,
}: {
  liveSignals: LivePortfolioSignalWindow[];
  breakdowns: WindowSignalBreakdown[];
  buyThreshold: number;
  sellThreshold: number;
}) {
  if (liveSignals.length === 0 && breakdowns.length === 0) {
    return (
      <div className="h-44 rounded border border-border/60 bg-surface-2 px-3 py-2 text-xs text-text-secondary">
        No signal data available yet.
      </div>
    );
  }

  const signalByWindow = new Map(liveSignals.map((signal) => [signal.timeframeDays, signal] as const));
  const breakdownByWindow = new Map(
    breakdowns.map((breakdown) => [breakdown.timeframeDays, breakdown] as const)
  );

  return (
    <div className="overflow-auto rounded border border-border/60">
      <table className="w-full text-[11px]">
        <thead className="bg-surface-2 text-[9px] uppercase tracking-wide text-text-secondary">
          <tr>
            <th className="px-2 py-1 text-left">Window</th>
            <th className="px-2 py-1 text-left">Action</th>
            <th className="px-2 py-1 text-right">Avg</th>
            <th className="px-2 py-1 text-right">Latest</th>
          </tr>
        </thead>
        <tbody>
          {SIGNAL_WINDOWS.map((window) => {
            const signal = signalByWindow.get(window);
            const breakdown = breakdownByWindow.get(window);
            return (
              <Fragment key={`signal-row-${window}`}>
                <tr className="border-t border-border/40">
                  <td className="px-2 py-1.5 text-text-primary font-medium">{window}D</td>
                  <td className="px-2 py-1.5">
                    <span
                      className={`font-semibold uppercase tracking-wide ${
                        signal ? signalActionClass(signal.action) : "text-text-secondary"
                      }`}
                    >
                      {signal?.action ?? "-"}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <SignalScoreBar score={signal?.score ?? null} color={actionColor(signal?.action)} />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-text-primary">
                    {formatScore(signal?.latestScore ?? null)}
                  </td>
                </tr>
                <tr className="border-t border-border/20 bg-surface-2/20">
                  <td colSpan={3} className="px-2 py-1 text-[10px] text-text-secondary">
                    <p>
                      {signal?.error
                        ? signal.error
                        : signal?.rationale ?? `Buy >= ${formatScore(buyThreshold)} | Sell <= ${formatScore(sellThreshold)}`}
                    </p>
                  </td>
                  <td className="px-2 py-1 text-right text-[10px] text-text-secondary">
                    {breakdown ? `${breakdown.barsUsed} bars` : "-"}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 px-2 py-1.5 text-[10px] text-text-secondary">
        <span className="text-buy">Buy threshold: {formatScore(buyThreshold)}</span>
        <span className="text-sell">Sell threshold: {formatScore(sellThreshold)}</span>
        <span className="inline-flex items-center gap-1 rounded border border-[#f5c16c55] bg-[#f5c16c22] px-1.5 py-0.5 text-[#f5c16c]">
          <WarningTriangleIcon />
          <span className="uppercase tracking-wide">Notice</span>
        </span>
        <span>
          A buy or sell recommendation indicates good price relative to each timeframe, not a direct
          recommendation on any action.
        </span>
      </div>
    </div>
  );
}

function SignalScoreBar({
  score,
  color,
}: {
  score: number | null;
  color: string;
}) {
  if (score == null || !Number.isFinite(score)) {
    return (
      <div className="text-right tabular-nums text-[11px] text-text-secondary">-</div>
    );
  }

  const bounded = clamp01(score);
  const pct = Math.round(bounded * 100);

  return (
    <div className="flex items-center justify-end gap-1">
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="tabular-nums text-[10px]" style={{ color }}>
        {pct}%
      </span>
    </div>
  );
}

function WarningTriangleIcon() {
  return (
    <span className="relative inline-block h-0 w-0 border-l-[6px] border-r-[6px] border-b-[11px] border-l-transparent border-r-transparent border-b-[#f5c16c] align-middle">
      <span className="absolute left-[-2px] top-[2px] text-[8px] font-bold leading-none text-surface">
        !
      </span>
    </span>
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
      <p className="text-[11px] text-text-secondary mb-1">{label}</p>
      <p className={`text-base font-semibold tabular-nums ${valueClassName}`}>{value}</p>
      <p className="text-[10px] text-text-secondary mt-0.5">{sub}</p>
    </div>
  );
}

function signalActionClass(action: LivePortfolioSignalWindow["action"]): string {
  if (action === "buy") return "text-buy";
  if (action === "sell") return "text-sell";
  return "text-text-secondary";
}

function actionColor(action: LivePortfolioSignalWindow["action"] | undefined): string {
  if (action === "buy") return "#35ff9d";
  if (action === "sell") return "#ff5f7f";
  return "#98b8d5";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function toSafeWikipediaUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || !parsed.hostname.toLowerCase().endsWith("wikipedia.org")) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function toSafeWhitepaperUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (!trimmed.includes("://")) {
    if (trimmed.startsWith("//") || /\s/.test(trimmed)) return null;
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function coerceWhitepaper(value: unknown): LivePortfolioWhitepaper | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (!title || !url) return null;

  const disclosureRaw = typeof record.disclosure === "string" ? record.disclosure.trim() : "";
  return {
    title,
    url,
    aiGenerated: typeof record.aiGenerated === "boolean" ? record.aiGenerated : false,
    disclosure: disclosureRaw || null,
  };
}

function coerceOptionalDateString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

function formatLiveSinceDay(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function normalizePortfolioKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildPortfolioUrl(apiPrefix: string, portfolioKey?: string): string {
  if (!portfolioKey || !portfolioKey.trim()) return `${apiPrefix}/bot/portfolio`;
  const params = new URLSearchParams({ portfolio: portfolioKey.trim() });
  return `${apiPrefix}/bot/portfolio?${params.toString()}`;
}

function sortBarsByTime(bars: Bar[]): Bar[] {
  return [...bars].sort((a, b) => a.t.localeCompare(b.t));
}

function buildCadenceEventMarkers(bars: Bar[]): BacktestChartEventMarker[] {
  if (bars.length === 0) return [];
  return SIGNAL_WINDOWS.map((window) => {
    const idx = Math.max(0, bars.length - window);
    const bar = bars[idx] ?? bars[0];
    return {
      date: bar.t,
      position: "aboveBar",
      color: "#38bdf8",
      shape: "circle",
      size: 0.55,
      text: `${window}D`,
    } satisfies BacktestChartEventMarker;
  });
}

function computeWindowSignalBreakdowns(bars: Bar[]): WindowSignalBreakdown[] {
  if (!Array.isArray(bars) || bars.length === 0) return [];

  return SIGNAL_WINDOWS.map((timeframeDays) => {
    return {
      timeframeDays,
      barsUsed: Math.min(bars.length, timeframeDays),
    } satisfies WindowSignalBreakdown;
  });
}

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}%`;
}

function formatScore(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
