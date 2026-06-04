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

type LivePortfolioValueRatingDriver = {
  label: string;
  effect: "positive" | "negative";
  value: string;
};

type LivePortfolioValueRating = {
  score: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | "NR";
  confidence: number;
  assetClass: "stock" | "etf" | "unknown";
  asOf: string;
  modelVersion: string;
  drivers: LivePortfolioValueRatingDriver[];
};

type LivePortfolioValueRatingQuarterlyPoint = {
  date: string;
  score: number | null;
  grade: LivePortfolioValueRating["grade"];
  confidence: number;
};

type LivePortfolioHoldingSnapshot = {
  symbol: string;
  targetPct: number;
  normalizedTargetPct: number;
  summary: string | null;
  wikipediaUrl: string | null;
  lastPrice: number | null;
  signals: LivePortfolioSignalWindow[];
  valueRating?: LivePortfolioValueRating;
  valueRatingQuarterly?: LivePortfolioValueRatingQuarterlyPoint[];
};

type WhitepaperRevisionNote = {
  date: string;
  note: string;
};

type LivePortfolioWhitepaper = {
  title: string;
  url: string;
  aiGenerated: boolean;
  disclosure: string | null;
  revisionNotes: WhitepaperRevisionNote[];
};

type LivePortfolioSnapshot = {
  portfolioKey: string;
  portfolioName: string;
  description: string | null;
  selectionRationale: string | null;
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

type LiveSinceInfo = {
  displayDate: string;
  isoDate: string;
  daysLive: number;
};

const SIGNAL_WINDOWS: Array<7 | 30 | 90> = [7, 30, 90];
const PRICE_BAR_RETRY_BACKOFF_MS = 60_000;
const KNOWN_ETF_SYMBOLS = new Set<string>([
  "ARKG",
  "CIBR",
  "CLOU",
  "CNXT",
  "HACK",
  "IGV",
  "IHI",
  "QQQ",
  "SKYY",
  "SMH",
  "SOXQ",
  "SOXX",
  "VHT",
  "VOO",
  "VXUS",
  "XHE",
  "XLV",
  "XSD",
]);

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
  const [valueRatingModal, setValueRatingModal] = useState<LivePortfolioHoldingSnapshot | null>(null);
  const priceBarsBySymbolRef = useRef<Record<string, Bar[]>>({});
  const priceBarsLoadingBySymbolRef = useRef<Record<string, boolean>>({});
  const priceBarsNextRetryAtMsRef = useRef<Record<string, number>>({});

  const portfolioUrl = buildPortfolioUrl(apiPrefix, portfolioKey);
  const whitepaperLink = toSafeWhitepaperUrl(snapshot?.whitepaper?.url);
  const liveSinceInfo = buildLiveSinceInfo(snapshot?.launchedAt ?? null);
  const aiWhitepaperDisclosure = snapshot?.whitepaper?.disclosure?.trim()
    || "Transparency note: this portfolio whitepaper was originally AI-generated and should be reviewed before relying on it.";
  const portfolioDescription = snapshot?.description?.trim()
    || "This live portfolio is a rules-based allocation built to represent a focused theme while remaining diversified across complementary assets.";
  const portfolioSelectionRationale = snapshot?.selectionRationale?.trim()
    || "Selections emphasize category leaders, strategic suppliers, and supporting infrastructure so the portfolio captures core growth drivers instead of relying on a single company outcome.";

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
      const snapshotDescription = coerceOptionalNarrative(body.description);
      const snapshotSelectionRationale = coerceOptionalNarrative(body.selectionRationale);

      setSnapshot({
        ...(body as LivePortfolioSnapshot),
        portfolioName: snapshotPortfolioName,
        portfolioKey: snapshotPortfolioKey,
        description: snapshotDescription,
        selectionRationale: snapshotSelectionRationale,
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
            {portfolioDescription}
          </p>
          <p className="text-xs text-text-secondary mt-1">
            {portfolioSelectionRationale}
          </p>
          {liveSinceInfo ? (
            <div className="mt-2 inline-flex max-w-full flex-col rounded border border-accent/35 bg-accent/10 px-2.5 py-2">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-accent">
                  Live Since
                </span>
                <span className="text-sm font-semibold text-text-primary">{liveSinceInfo.displayDate}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-text-secondary">
                Transparency: launch date {liveSinceInfo.isoDate} ({liveSinceInfo.daysLive} day
                {liveSinceInfo.daysLive === 1 ? "" : "s"} live).
              </p>
            </div>
          ) : (
            <div className="mt-2 inline-flex max-w-full rounded border border-sell/30 bg-sell/10 px-2.5 py-1.5 text-[11px] text-sell">
              Transparency note: launch date is unavailable in backend data.
            </div>
          )}
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
                className="inline-flex rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-accent transition-colors hover:border-accent hover:bg-accent/15"
              >
                Open PDF
              </a>
            ) : (
              <span className="text-[11px] text-sell">Whitepaper link is invalid.</span>
            )}
            {snapshot.whitepaper.aiGenerated ? (
              <span className="inline-flex rounded border border-[#f5c16c66] bg-[#f5c16c22] px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#f5c16c]">
                AI-generated
              </span>
            ) : null}
          </div>
          {snapshot.whitepaper.aiGenerated ? (
            <p className="mt-1 text-[11px] text-[#f5c16c]">{aiWhitepaperDisclosure}</p>
          ) : null}
          {snapshot.whitepaper.revisionNotes.length > 0 ? (
            <div className="mt-2 border-t border-border/50 pt-2">
              <p className="text-[11px] font-semibold text-text-secondary">Revision notes</p>
              <ul className="mt-1 space-y-0.5">
                {snapshot.whitepaper.revisionNotes.map((n, i) => (
                  <li key={i} className="text-[11px] text-text-secondary">
                    <span className="font-medium text-text-primary">{n.date}</span>
                    {" — "}
                    {n.note}
                  </li>
                ))}
              </ul>
            </div>
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
          <span className="text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
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
              const quarterlyValueMarkers = buildQuarterlyValueRatingMarkers(
                holding.valueRatingQuarterly ?? []
              );

              return (
                <article key={holding.symbol} className="rounded border border-border/70 bg-surface-2 p-2.5">
                  <div className="grid gap-3 xl:grid-cols-2">
                    <section className="rounded border border-border/70 bg-surface-1 p-2.5">
                      <div className="flex gap-2">
                        <aside className="w-44 shrink-0 rounded border border-border bg-surface-2 p-2">
                          <dl className="space-y-1.5 text-[11px]">
                            <div>
                              <dt className="uppercase tracking-wide text-text-secondary">Symbol</dt>
                              <dd className="font-semibold text-text-primary">{holding.symbol}</dd>
                              {holding.summary ? (
                                <p className="mt-1 text-[11px] leading-snug text-text-secondary">
                                  {holding.summary}
                                </p>
                              ) : null}
                              {wikipediaUrl ? (
                                <a
                                  href={wikipediaUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 inline-flex text-[11px] font-medium text-accent hover:underline"
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
                              <dt className="uppercase tracking-wide text-text-secondary">Value Rating</dt>
                              <dd className="tabular-nums text-text-primary">
                                {holding.valueRating ? (
                                  <button
                                    type="button"
                                    onClick={() => setValueRatingModal(holding)}
                                    className="inline-flex items-center gap-1 cursor-pointer hover:opacity-75 transition-opacity"
                                    title="Click to see how this rating was calculated"
                                  >
                                    <span
                                      className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${valueRatingGradeClass(holding.valueRating.grade)}`}
                                    >
                                      {holding.valueRating.grade}
                                    </span>
                                    <span>
                                      {holding.valueRating.score == null
                                        ? "NR"
                                        : `${holding.valueRating.score.toFixed(1)}/100`}
                                    </span>
                                  </button>
                                ) : (
                                  "-"
                                )}
                              </dd>
                              {holding.valueRating ? (
                                <p className="mt-1 text-[10px] text-text-secondary">
                                  Confidence {formatConfidencePct(holding.valueRating.confidence)} ·{" "}
                                  {resolveValueRatingAssetClass(
                                    holding.symbol,
                                    holding.valueRating.assetClass
                                  ).toUpperCase()}
                                </p>
                              ) : null}
                              {holding.valueRating ? (
                                <p className="mt-0.5 text-[10px] text-text-secondary">
                                  As of {formatValueRatingAsOf(holding.valueRating.asOf)} · {holding.valueRating.modelVersion}
                                </p>
                              ) : null}
                              {holding.valueRating?.drivers?.length ? (
                                <div className="mt-1.5 space-y-0.5">
                                  {holding.valueRating.drivers.slice(0, 2).map((driver) => (
                                    <p
                                      key={`${holding.symbol}-${driver.label}-${driver.value}`}
                                      className={`text-[10px] ${
                                        driver.effect === "positive" ? "text-buy" : "text-sell"
                                      }`}
                                    >
                                      {driver.effect === "positive" ? "+" : "-"} {driver.label}: {driver.value}
                                    </p>
                                  ))}
                                </div>
                              ) : null}
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
                          <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
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
                                  eventMarkers={quarterlyValueMarkers}
                                  movingAverageDays={[7]}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </section>

                    <section className="rounded border border-border/70 bg-surface-1 p-2.5">
                      <p className="text-[11px] uppercase tracking-widest text-text-secondary font-semibold">
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

      {valueRatingModal?.valueRating ? (
        <ValueRatingDetailModal holding={valueRatingModal} onClose={() => setValueRatingModal(null)} />
      ) : null}
    </div>
  );
}

function ValueRatingDetailModal({
  holding,
  onClose,
}: {
  holding: LivePortfolioHoldingSnapshot;
  onClose: () => void;
}) {
  const vr = holding.valueRating!;
  const resolvedAssetClass = resolveValueRatingAssetClass(holding.symbol, vr.assetClass);
  const usingInferredAssetClass = vr.assetClass === "unknown" && resolvedAssetClass !== "unknown";

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const gradeDescriptions: Record<LivePortfolioValueRating["grade"], { label: string; range: string }> = {
    A: { label: "Excellent value", range: "80–100" },
    B: { label: "Good value", range: "65–79" },
    C: { label: "Fair value", range: "50–64" },
    D: { label: "Below average", range: "35–49" },
    F: { label: "Poor value", range: "0–34" },
    NR: { label: "Not rated", range: "—" },
  };

  const isStock = resolvedAssetClass === "stock";
  const isEtf = resolvedAssetClass === "etf";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-lg border border-border bg-surface-1 shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-surface-1 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text-primary">{holding.symbol}</span>
            <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${valueRatingGradeClass(vr.grade)}`}>
              {vr.grade}
            </span>
            <span className="text-sm text-text-primary">
              {vr.score == null ? "NR" : `${vr.score.toFixed(1)}/100`}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 p-4 text-[13px]">
          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-text-secondary">What is Value Rating?</h3>
            <p className="text-text-primary leading-relaxed">
              Value Rating is a composite score (0–100) that evaluates whether a security is attractively priced relative to its fundamentals and recent price momentum. It combines multiple financial metrics into a single grade, updated whenever fresh fundamental data is available.
            </p>
          </div>

          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-text-secondary">How It&apos;s Calculated</h3>
            {isStock && (
              <div className="space-y-2">
                <p className="text-[12px] text-text-secondary">For stocks, the score is a weighted blend of three factor groups:</p>
                <div className="rounded border border-border bg-surface-2 p-3 space-y-2">
                  <FactorRow pct="45%" label="Valuation" desc="P/E Ratio, Price/Book, EV/EBITDA, Price/Sales — lower is better" />
                  <FactorRow pct="35%" label="Quality & Growth" desc="Profit Margin, Return on Equity, Revenue Growth YoY, EPS Growth YoY — higher is better" />
                  <FactorRow pct="20%" label="Technical Momentum" desc="Price location within 252-day range + 63-day momentum" />
                </div>
              </div>
            )}
            {isEtf && (
              <div className="space-y-2">
                <p className="text-[12px] text-text-secondary">For ETFs, the score focuses on cost efficiency and price momentum:</p>
                <div className="rounded border border-border bg-surface-2 p-3 space-y-2">
                  <FactorRow pct="40%" label="Cost Efficiency" desc="Expense Ratio + Portfolio Turnover — lower costs score higher" />
                  <FactorRow pct="60%" label="Technical Momentum" desc="Price location within 252-day range + 63-day momentum" />
                </div>
              </div>
            )}
            {!isStock && !isEtf && (
              <p className="text-[12px] text-text-secondary">Asset class is unknown — scoring methodology could not be determined.</p>
            )}
            {usingInferredAssetClass && (
              <p className="mt-1 text-[11px] text-text-secondary">
                Asset class metadata was unavailable from upstream fundamentals; this view inferred class from the symbol.
              </p>
            )}
          </div>

          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-text-secondary">Grade Scale</h3>
            <div className="overflow-hidden rounded border border-border bg-surface-2">
              {(["A", "B", "C", "D", "F", "NR"] as const).map((grade) => {
                const { label, range } = gradeDescriptions[grade];
                const isActive = grade === vr.grade;
                return (
                  <div
                    key={grade}
                    className={`flex items-center gap-3 border-b border-border/50 px-3 py-2 last:border-0 ${isActive ? "bg-surface-3" : ""}`}
                  >
                    <span className={`inline-flex w-8 justify-center rounded border px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${valueRatingGradeClass(grade)}`}>
                      {grade}
                    </span>
                    <span className="text-text-primary">{label}</span>
                    <span className="ml-auto tabular-nums text-[12px] text-text-secondary">{range}</span>
                    {isActive && <span className="text-[10px] text-text-secondary">← current</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {vr.drivers && vr.drivers.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-text-secondary">Contributing Factors</h3>
              <div className="overflow-hidden rounded border border-border bg-surface-2">
                {vr.drivers.map((driver) => (
                  <div
                    key={`${driver.label}-${driver.value}`}
                    className="flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-0"
                  >
                    <span className={`text-[12px] font-bold ${driver.effect === "positive" ? "text-buy" : "text-sell"}`}>
                      {driver.effect === "positive" ? "+" : "−"}
                    </span>
                    <span className="text-text-primary">{driver.label}</span>
                    <span className="ml-auto tabular-nums text-[12px] text-text-secondary">{driver.value}</span>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-text-secondary">
                Factors with the largest impact on the score are listed first. Positive factors raised the score; negative factors lowered it.
              </p>
            </div>
          )}

          <div className="rounded border border-border bg-surface-2 px-3 py-2.5 space-y-1.5">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-text-secondary">Confidence</span>
              <span className="tabular-nums text-text-primary">{formatConfidencePct(vr.confidence)}</span>
            </div>
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-text-secondary">Asset class</span>
              <span className="uppercase text-text-primary">{resolvedAssetClass}</span>
            </div>
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-text-secondary">Model</span>
              <span className="font-mono text-text-primary">{vr.modelVersion}</span>
            </div>
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-text-secondary">Data as of</span>
              <span className="tabular-nums text-text-primary">{formatValueRatingAsOf(vr.asOf)}</span>
            </div>
          </div>
          <p className="text-[11px] text-text-secondary">
            Confidence reflects how many expected data points were available. 100% means all metrics were present; lower values indicate some fundamental data was missing.
          </p>
        </div>
      </div>
    </div>
  );
}

function FactorRow({ pct, label, desc }: { pct: string; label: string; desc: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 inline-flex w-10 shrink-0 justify-end tabular-nums text-[11px] font-semibold text-accent">{pct}</span>
      <div className="text-[12px]">
        <span className="font-medium text-text-primary">{label}</span>
        <span className="text-text-secondary"> — {desc}</span>
      </div>
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
      <table className="w-full text-[12px]">
        <thead className="bg-surface-2 text-[11px] uppercase tracking-wide text-text-secondary">
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
                  <td colSpan={3} className="px-2 py-1 text-[11px] text-text-secondary">
                    <p>
                      {signal?.error
                        ? signal.error
                        : signal?.rationale ?? `Buy >= ${formatScore(buyThreshold)} | Sell <= ${formatScore(sellThreshold)}`}
                    </p>
                  </td>
                  <td className="px-2 py-1 text-right text-[11px] text-text-secondary">
                    {breakdown ? `${breakdown.barsUsed} bars` : "-"}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 px-2 py-1.5 text-[11px] text-text-secondary">
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
      <div className="text-right tabular-nums text-[12px] text-text-secondary">-</div>
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
      <span className="tabular-nums text-[11px]" style={{ color }}>
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
      <p className="text-[12px] text-text-secondary mb-1">{label}</p>
      <p className={`text-base font-semibold tabular-nums ${valueClassName}`}>{value}</p>
      <p className="text-[11px] text-text-secondary mt-0.5">{sub}</p>
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

function valueRatingGradeClass(grade: LivePortfolioValueRating["grade"]): string {
  if (grade === "A" || grade === "B") return "border-buy/40 bg-buy/10 text-buy";
  if (grade === "C") return "border-accent/40 bg-accent/10 text-accent";
  if (grade === "D" || grade === "F") return "border-sell/40 bg-sell/10 text-sell";
  return "border-border bg-surface-3 text-text-secondary";
}

function formatConfidencePct(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${(clamp01(value) * 100).toFixed(1)}%`;
}

function formatValueRatingAsOf(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return parsed.toLocaleString();
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

function resolveValueRatingAssetClass(
  symbol: string,
  assetClass: LivePortfolioValueRating["assetClass"]
): LivePortfolioValueRating["assetClass"] {
  if (assetClass === "stock" || assetClass === "etf") return assetClass;
  return inferAssetClassFromSymbol(symbol);
}

function inferAssetClassFromSymbol(symbol: string): LivePortfolioValueRating["assetClass"] {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return "unknown";
  if (KNOWN_ETF_SYMBOLS.has(normalizedSymbol)) return "etf";

  if (normalizedSymbol.includes("/")) return "unknown";
  if (/^[A-Z]{5}X$/.test(normalizedSymbol)) return "etf";

  return "stock";
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
  const revisionNotes = Array.isArray(record.revisionNotes)
    ? record.revisionNotes
        .filter((n): n is Record<string, unknown> => !!n && typeof n === "object" && !Array.isArray(n))
        .map((n) => ({ date: String(n.date ?? "").trim(), note: String(n.note ?? "").trim() }))
        .filter((n) => n.date && n.note)
    : [];
  return {
    title,
    url,
    aiGenerated: typeof record.aiGenerated === "boolean" ? record.aiGenerated : false,
    disclosure: disclosureRaw || null,
    revisionNotes,
  };
}

function coerceOptionalDateString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

function coerceOptionalNarrative(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function buildLiveSinceInfo(value: string | null): LiveSinceInfo | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;

  const displayDate = parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const launchDateUtc = Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate()
  );
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysLive = Math.max(0, Math.floor((todayUtc - launchDateUtc) / 86_400_000));

  return {
    displayDate,
    isoDate: parsed.toISOString().split("T")[0],
    daysLive,
  };
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

function buildQuarterlyValueRatingMarkers(
  points: LivePortfolioValueRatingQuarterlyPoint[]
): BacktestChartEventMarker[] {
  if (!Array.isArray(points) || points.length === 0) return [];
  return points
    .map((point) => {
      const scoreText =
        point.score == null || !Number.isFinite(point.score) ? "NR" : Math.round(point.score).toString();
      return {
        date: point.date,
        position: "belowBar",
        color: valueRatingMarkerColor(point.grade),
        shape: "square",
        size: 0.5,
        text: `Q ${point.grade} ${scoreText}`,
      } satisfies BacktestChartEventMarker;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function valueRatingMarkerColor(grade: LivePortfolioValueRating["grade"]): string {
  if (grade === "A" || grade === "B") return "#35ff9d";
  if (grade === "C") return "#38bdf8";
  if (grade === "D" || grade === "F") return "#ff5f7f";
  return "#98b8d5";
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
