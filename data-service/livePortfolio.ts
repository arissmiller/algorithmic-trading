import { readFile, stat, writeFile } from "node:fs/promises";
import { fetchMarketBars } from "./core.ts";
import { Bar, compositeScore, scoreRationale, SignalWeight } from "./botSignals.ts";

const LIVE_PORTFOLIO_STATE_FILE =
  process.env.LIVE_PORTFOLIO_STATE_FILE ??
  new URL("./live-portfolio-state.json", import.meta.url).pathname;
const LIVE_PORTFOLIO_VALUE_CACHE_FILE =
  process.env.LIVE_PORTFOLIO_VALUE_CACHE_FILE ??
  new URL("./live-portfolio-value-cache.json", import.meta.url).pathname;
const LIVE_PORTFOLIO_SNAPSHOT_TTL_MS = parsePositiveInt(
  process.env.LIVE_PORTFOLIO_SNAPSHOT_TTL_MS,
  60_000
);
const ALPHA_VANTAGE_API_KEY = (process.env.ALPHA_VANTAGE_API_KEY ?? "").trim();
const ALPHA_VANTAGE_BASE_URL =
  process.env.ALPHA_VANTAGE_EARNINGS_URL?.trim() ||
  "https://www.alphavantage.co/query";
const ALPHA_VANTAGE_TIMEOUT_MS = parsePositiveInt(
  process.env.ALPHA_VANTAGE_REQUEST_TIMEOUT_MS,
  10_000
);
const VALUE_RATING_PROVIDER = "alphavantage";
const VALUE_RATING_MODEL_VERSION = "balanced_garp_v1";
const SIGNAL_WINDOWS_DAYS = [7, 30, 90] as const;
const MAX_ALLOCATIONS = 40;
const MAX_PORTFOLIOS = 20;
const DEFAULT_PORTFOLIO_KEY = "live_portfolio";
const DEFAULT_PORTFOLIO_NAME = "Live Portfolio";
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

const BUY_OVER_TIME_SIGNALS: SignalWeight[] = [
  { signal: { type: "price_vs_sma", period: 30 }, weight: 0.35 },
  { signal: { type: "rsi", period: 14 }, weight: 0.4 },
  { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.25 },
];

export interface LivePortfolioAllocation {
  symbol: string;
  targetPct: number;
  summary?: string;
  wikipediaUrl?: string;
}

export interface LivePortfolioWhitepaper {
  title: string;
  url: string;
  aiGenerated: boolean;
  disclosure?: string;
}

export interface LivePortfolioConfig {
  key: string;
  name: string;
  description?: string;
  selectionRationale?: string;
  allocations: LivePortfolioAllocation[];
  whitepaper?: LivePortfolioWhitepaper;
  launchedAt?: string;
  buyThreshold: number;
  sellThreshold: number;
  updatedAt: string;
}

export interface LivePortfolioState {
  defaultPortfolioKey: string;
  portfolios: LivePortfolioConfig[];
  updatedAt: string;
}

export interface LivePortfolioSignalWindow {
  timeframeDays: (typeof SIGNAL_WINDOWS_DAYS)[number];
  action: "buy" | "sell" | "hold";
  score: number | null;
  latestScore: number | null;
  barTime: string | null;
  rationale: string | null;
  error: string | null;
}

export interface LivePortfolioValueRatingDriver {
  label: string;
  effect: "positive" | "negative";
  value: string;
}

export interface LivePortfolioValueRating {
  score: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | "NR";
  confidence: number;
  assetClass: "stock" | "etf" | "unknown";
  asOf: string;
  modelVersion: string;
  drivers: LivePortfolioValueRatingDriver[];
}

export interface LivePortfolioValueRatingQuarterlyPoint {
  date: string;
  score: number | null;
  grade: LivePortfolioValueRating["grade"];
  confidence: number;
}

export interface LivePortfolioHoldingSnapshot {
  symbol: string;
  targetPct: number;
  normalizedTargetPct: number;
  summary: string | null;
  wikipediaUrl: string | null;
  lastPrice: number | null;
  signals: LivePortfolioSignalWindow[];
  valueRating?: LivePortfolioValueRating;
  valueRatingQuarterly?: LivePortfolioValueRatingQuarterlyPoint[];
}

export interface LivePortfolioSnapshot {
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
}

interface PersistedPortfolioConfig {
  key?: unknown;
  name?: unknown;
  description?: unknown;
  selectionRationale?: unknown;
  allocations?: unknown;
  whitepaper?: unknown;
  launchedAt?: unknown;
  buyThreshold?: unknown;
  sellThreshold?: unknown;
  updatedAt?: unknown;
}

interface PersistedPortfolioState {
  defaultPortfolioKey?: unknown;
  portfolios?: unknown;
  updatedAt?: unknown;
  // Legacy single-portfolio shape support.
  key?: unknown;
  name?: unknown;
  description?: unknown;
  selectionRationale?: unknown;
  allocations?: unknown;
  whitepaper?: unknown;
  launchedAt?: unknown;
  buyThreshold?: unknown;
  sellThreshold?: unknown;
}

interface PersistedValueCacheState {
  updatedAt?: unknown;
  entries?: unknown;
}

interface ValueCacheEntry {
  key: string;
  symbol: string;
  provider: string;
  modelVersion: string;
  sourceStatus: string;
  cachedAt: string;
  normalizedFundamentals: Record<string, number | string | null>;
  valueRating: LivePortfolioValueRating;
}

let configState: LivePortfolioState = buildDefaultState();
let persistChain: Promise<void> = Promise.resolve();
let cachedSnapshotsByKey = new Map<string, { snapshot: LivePortfolioSnapshot; cachedAtMs: number }>();
let loadedStateMtimeMs = 0;
let valueCacheByKey = new Map<string, ValueCacheEntry>();
let valueCachePersistChain: Promise<void> = Promise.resolve();

export async function loadLivePortfolioState(): Promise<void> {
  const loaded = await loadConfigFromDisk();
  if (loaded) {
    configState = loaded.state;
    loadedStateMtimeMs = loaded.mtimeMs;
  } else {
    configState = buildDefaultState();
    loadedStateMtimeMs = Date.now();
  }
  await loadValueCacheFromDisk();
  invalidateSnapshotCache();
}

export async function getLivePortfolioConfig(portfolioKey?: string): Promise<LivePortfolioConfig> {
  await syncConfigFromDiskIfChanged();
  const portfolio = resolvePortfolioConfig(portfolioKey);
  return clonePortfolioConfig(portfolio);
}

export async function updateLivePortfolioConfig(
  input: unknown,
  portfolioKey?: string
): Promise<LivePortfolioConfig> {
  await syncConfigFromDiskIfChanged();

  if (!isRecord(input)) {
    throw new Error("Portfolio payload must be a JSON object.");
  }

  const portfolio = resolvePortfolioConfig(portfolioKey);
  const hasName = Object.prototype.hasOwnProperty.call(input, "name");
  const hasDescription = Object.prototype.hasOwnProperty.call(input, "description");
  const hasSelectionRationale = Object.prototype.hasOwnProperty.call(input, "selectionRationale");
  const hasAllocations = Object.prototype.hasOwnProperty.call(input, "allocations");
  const hasWhitepaper = Object.prototype.hasOwnProperty.call(input, "whitepaper");
  const hasLaunchedAt = Object.prototype.hasOwnProperty.call(input, "launchedAt");
  const hasBuyThreshold = Object.prototype.hasOwnProperty.call(input, "buyThreshold");
  const hasSellThreshold = Object.prototype.hasOwnProperty.call(input, "sellThreshold");

  if (
    !hasName &&
    !hasDescription &&
    !hasSelectionRationale &&
    !hasAllocations &&
    !hasWhitepaper &&
    !hasLaunchedAt &&
    !hasBuyThreshold &&
    !hasSellThreshold
  ) {
    throw new Error(
      "Provide at least one of name, description, selectionRationale, allocations, whitepaper, launchedAt, buyThreshold, or sellThreshold."
    );
  }

  const name = hasName ? parsePortfolioName(input.name) : portfolio.name;
  const description = hasDescription
    ? parseOptionalPortfolioDescription(input.description)
    : portfolio.description;
  const selectionRationale = hasSelectionRationale
    ? parseOptionalPortfolioSelectionRationale(input.selectionRationale)
    : portfolio.selectionRationale;
  const allocations = hasAllocations
    ? parseAllocationsInput(input.allocations)
    : portfolio.allocations;
  const whitepaper = hasWhitepaper ? parseOptionalWhitepaper(input.whitepaper) : portfolio.whitepaper;
  const launchedAt = hasLaunchedAt
    ? parseOptionalPortfolioLaunchDate(input.launchedAt)
    : portfolio.launchedAt;
  const buyThreshold = hasBuyThreshold
    ? parseThreshold(input.buyThreshold, "buyThreshold")
    : portfolio.buyThreshold;
  const sellThreshold = hasSellThreshold
    ? parseThreshold(input.sellThreshold, "sellThreshold")
    : portfolio.sellThreshold;

  if (sellThreshold >= buyThreshold) {
    throw new Error("sellThreshold must be less than buyThreshold.");
  }

  const updatedAt = new Date().toISOString();
  const nextPortfolio: LivePortfolioConfig = {
    key: portfolio.key,
    name,
    ...(description ? { description } : {}),
    ...(selectionRationale ? { selectionRationale } : {}),
    allocations,
    ...(whitepaper ? { whitepaper } : {}),
    ...(launchedAt ? { launchedAt } : {}),
    buyThreshold,
    sellThreshold,
    updatedAt,
  };

  const nextPortfolios = configState.portfolios.map((item) =>
    item.key === portfolio.key ? nextPortfolio : item
  );
  configState = {
    ...configState,
    portfolios: nextPortfolios,
    updatedAt,
  };

  await persistConfig();
  await clearValueCache();
  invalidateSnapshotCache();
  return clonePortfolioConfig(nextPortfolio);
}

export async function getLivePortfolioSnapshot(
  portfolioKey?: string,
  options?: { forceValueRefresh?: boolean }
): Promise<LivePortfolioSnapshot> {
  await syncConfigFromDiskIfChanged();
  const portfolio = resolvePortfolioConfig(portfolioKey);
  const forceValueRefresh = options?.forceValueRefresh === true;

  const cached = cachedSnapshotsByKey.get(portfolio.key);
  if (
    cached &&
    !forceValueRefresh &&
    Date.now() - cached.cachedAtMs < LIVE_PORTFOLIO_SNAPSHOT_TTL_MS
  ) {
    return cloneSnapshot(cached.snapshot);
  }

  const generatedAt = new Date().toISOString();
  const totalRequestedPct = portfolio.allocations.reduce(
    (sum, allocation) => sum + allocation.targetPct,
    0
  );

  const holdings = await Promise.all(
    portfolio.allocations.map(async (allocation) => {
      const normalizedTargetPct =
        totalRequestedPct > 0 ? (allocation.targetPct / totalRequestedPct) * 100 : 0;
      try {
        const payload = await fetchMarketBars({
          symbol: allocation.symbol,
          range: "2y",
          timeframe: "1Day",
        });
        const bars: Bar[] = payload.bars.map((bar) => ({
          t: bar.t,
          o: bar.o,
          h: bar.h,
          l: bar.l,
          c: bar.c,
          v: bar.v ?? 0,
        }));

        const lastPrice = bars[bars.length - 1]?.c ?? null;
        const signals = SIGNAL_WINDOWS_DAYS.map((timeframeDays) =>
          buildWindowSignal(bars, timeframeDays, portfolio.buyThreshold, portfolio.sellThreshold)
        );
        const valueEntry = await getOrCreateValueRatingEntry({
          symbol: allocation.symbol,
          bars,
          forceValueRefresh,
        });
        const valueRating = cloneValueRating(valueEntry.valueRating);
        const valueRatingQuarterly = buildQuarterlyValueRatingBacktest({
          bars,
        });

        return {
          symbol: allocation.symbol,
          targetPct: allocation.targetPct,
          normalizedTargetPct,
          summary: allocation.summary ?? null,
          wikipediaUrl: allocation.wikipediaUrl ?? null,
          lastPrice,
          signals,
          ...(valueRating ? { valueRating } : {}),
          ...(valueRatingQuarterly.length > 0 ? { valueRatingQuarterly } : {}),
        } satisfies LivePortfolioHoldingSnapshot;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const signals = SIGNAL_WINDOWS_DAYS.map((timeframeDays) => ({
          timeframeDays,
          action: "hold" as const,
          score: null,
          latestScore: null,
          barTime: null,
          rationale: null,
          error: message,
        }));
        const cachedEntry = readCachedValueEntry(allocation.symbol);
        return {
          symbol: allocation.symbol,
          targetPct: allocation.targetPct,
          normalizedTargetPct,
          summary: allocation.summary ?? null,
          wikipediaUrl: allocation.wikipediaUrl ?? null,
          lastPrice: null,
          signals,
          ...(cachedEntry ? { valueRating: cloneValueRating(cachedEntry.valueRating) } : {}),
        } satisfies LivePortfolioHoldingSnapshot;
      }
    })
  );

  const snapshot: LivePortfolioSnapshot = {
    portfolioKey: portfolio.key,
    portfolioName: portfolio.name,
    description: portfolio.description ?? null,
    selectionRationale: portfolio.selectionRationale ?? null,
    whitepaper: portfolio.whitepaper ? cloneWhitepaper(portfolio.whitepaper) : null,
    launchedAt: portfolio.launchedAt ?? null,
    algorithm: "buy_over_time",
    buyThreshold: portfolio.buyThreshold,
    sellThreshold: portfolio.sellThreshold,
    totalRequestedPct,
    generatedAt,
    updatedAt: portfolio.updatedAt,
    holdings,
  };

  cachedSnapshotsByKey.set(portfolio.key, {
    snapshot,
    cachedAtMs: Date.now(),
  });
  return cloneSnapshot(snapshot);
}

async function getOrCreateValueRatingEntry(input: {
  symbol: string;
  bars: Bar[];
  forceValueRefresh: boolean;
}): Promise<ValueCacheEntry> {
  const symbol = normalizeSymbol(input.symbol);
  const key = buildValueCacheKey(symbol);
  const cached = valueCacheByKey.get(key);
  if (cached && !input.forceValueRefresh) {
    const shouldRefreshLegacyUnknown =
      cached.valueRating.assetClass === "unknown" &&
      (cached.sourceStatus === "missing_api_key" ||
        cached.sourceStatus === "upstream_unavailable");
    if (!shouldRefreshLegacyUnknown) {
      return cloneValueCacheEntry(cached);
    }
  }

  const fundamentals = await fetchNormalizedFundamentals(symbol);
  const rating = computeValueRating({
    assetClass: fundamentals.assetClass,
    fundamentals: fundamentals.normalizedFundamentals,
    bars: input.bars,
    asOf: new Date().toISOString(),
  });

  const entry: ValueCacheEntry = {
    key,
    symbol,
    provider: VALUE_RATING_PROVIDER,
    modelVersion: VALUE_RATING_MODEL_VERSION,
    sourceStatus: fundamentals.sourceStatus,
    cachedAt: new Date().toISOString(),
    normalizedFundamentals: { ...fundamentals.normalizedFundamentals },
    valueRating: rating,
  };
  valueCacheByKey.set(key, entry);
  await persistValueCache();
  return cloneValueCacheEntry(entry);
}

function readCachedValueEntry(symbol: string): ValueCacheEntry | null {
  const key = buildValueCacheKey(normalizeSymbol(symbol));
  const cached = valueCacheByKey.get(key);
  if (!cached) return null;
  return cloneValueCacheEntry(cached);
}

function buildValueCacheKey(symbol: string): string {
  return `${symbol}|${VALUE_RATING_PROVIDER}|${VALUE_RATING_MODEL_VERSION}`;
}

async function fetchNormalizedFundamentals(symbol: string): Promise<{
  assetClass: LivePortfolioValueRating["assetClass"];
  normalizedFundamentals: Record<string, number | string | null>;
  sourceStatus: string;
}> {
  const fallbackAssetClass = inferFallbackAssetClass(symbol);

  if (!ALPHA_VANTAGE_API_KEY) {
    return {
      assetClass: fallbackAssetClass,
      normalizedFundamentals: {},
      sourceStatus: "missing_api_key_fallback",
    };
  }

  const overview = await fetchAlphaVantageObject("OVERVIEW", symbol);
  const overviewAssetType = trimToNull(overview?.AssetType);
  const looksLikeEtf =
    overviewAssetType === "ETF" || overviewAssetType === "Mutual Fund";

  if (looksLikeEtf) {
    const etfProfile = await fetchAlphaVantageObject("ETF_PROFILE", symbol);
    if (etfProfile) {
      return {
        assetClass: "etf",
        normalizedFundamentals: normalizeEtfFundamentals(etfProfile),
        sourceStatus: "ok",
      };
    }
  }

  if (overview) {
    return {
      assetClass: "stock",
      normalizedFundamentals: normalizeStockFundamentals(overview),
      sourceStatus: "ok",
    };
  }

  if (!overview) {
    const etfProfile = await fetchAlphaVantageObject("ETF_PROFILE", symbol);
    if (etfProfile) {
      return {
        assetClass: "etf",
        normalizedFundamentals: normalizeEtfFundamentals(etfProfile),
        sourceStatus: "ok",
      };
    }
  }

  return {
    assetClass: fallbackAssetClass,
    normalizedFundamentals: {},
    sourceStatus: "upstream_unavailable_fallback",
  };
}

function inferFallbackAssetClass(symbol: string): LivePortfolioValueRating["assetClass"] {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!normalizedSymbol) return "unknown";
  if (KNOWN_ETF_SYMBOLS.has(normalizedSymbol)) return "etf";

  // Common US mutual fund tickers end in X, while most listed stocks/ADRs do not.
  if (/^[A-Z]{5}X$/.test(normalizedSymbol)) return "etf";

  // Crypto/cross pairs should remain unknown in this stock/ETF rating model.
  if (normalizedSymbol.includes("/")) return "unknown";

  return "stock";
}

async function fetchAlphaVantageObject(
  fn: "OVERVIEW" | "ETF_PROFILE",
  symbol: string
): Promise<Record<string, string> | null> {
  const params = new URLSearchParams({
    function: fn,
    symbol,
    datatype: "json",
    apikey: ALPHA_VANTAGE_API_KEY,
  });
  const url = `${ALPHA_VANTAGE_BASE_URL}?${params.toString()}`;
  try {
    const response = await fetchWithTimeout(url, ALPHA_VANTAGE_TIMEOUT_MS);
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    const warning =
      trimToNull(record.Note) ??
      trimToNull(record.Information) ??
      trimToNull(record["Error Message"]);
    if (warning) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string" || typeof value === "number") {
        out[key] = String(value);
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

function normalizeStockFundamentals(
  record: Record<string, string>
): Record<string, number | string | null> {
  return {
    sector: trimToNull(record.Sector),
    industry: trimToNull(record.Industry),
    peRatio: numberOrNull(record.PERatio),
    priceToBook: numberOrNull(record.PriceToBookRatio),
    evToEbitda: numberOrNull(record.EVToEBITDA),
    priceToSales: numberOrNull(record.PriceToSalesRatioTTM),
    profitMargin: numberOrNull(record.ProfitMargin),
    roe: numberOrNull(record.ReturnOnEquityTTM),
    revGrowthYoy: numberOrNull(record.QuarterlyRevenueGrowthYOY),
    epsGrowthYoy: numberOrNull(record.QuarterlyEarningsGrowthYOY),
  };
}

function normalizeEtfFundamentals(
  record: Record<string, string>
): Record<string, number | string | null> {
  return {
    expenseRatio:
      numberOrNull(record.net_expense_ratio) ??
      numberOrNull(record.expense_ratio) ??
      numberOrNull(record.expenseRatio),
    turnover:
      numberOrNull(record.portfolio_turnover) ??
      numberOrNull(record.turnover) ??
      numberOrNull(record.portfolioTurnover),
    dividendYield:
      numberOrNull(record.dividend_yield) ??
      numberOrNull(record.dividendYield) ??
      numberOrNull(record.yield),
    netAssets:
      numberOrNull(record.net_assets) ??
      numberOrNull(record.netAssets),
  };
}

function computeValueRating(input: {
  assetClass: LivePortfolioValueRating["assetClass"];
  fundamentals: Record<string, number | string | null>;
  bars: Bar[];
  asOf: string;
}): LivePortfolioValueRating {
  const technical = computeTechnicalScore(input.bars);

  if (input.assetClass === "etf") {
    const expenseRatio = normalizePercentLikeNumber(getNumberMetric(input.fundamentals.expenseRatio));
    const turnover = normalizePercentLikeNumber(getNumberMetric(input.fundamentals.turnover));
    const costParts: number[] = [];
    const expenseScore = scoreLowerBetter(expenseRatio, 0.03, 1.5);
    const turnoverScore = scoreLowerBetter(turnover, 3, 100);
    if (expenseScore != null) costParts.push(expenseScore);
    if (turnoverScore != null) costParts.push(turnoverScore);
    const costScore = avg(costParts);
    return finalizeValueRating({
      assetClass: "etf",
      asOf: input.asOf,
      modelVersion: VALUE_RATING_MODEL_VERSION,
      weightedScores: [
        { score: costScore, weight: 0.4 },
        { score: technical, weight: 0.6 },
      ],
      drivers: [
        buildDriver("Expense ratio", expenseRatio, "lower_is_better", "%"),
        buildDriver("Turnover", turnover, "lower_is_better", "%"),
      ],
    });
  }

  const peRatio = getNumberMetric(input.fundamentals.peRatio);
  const priceToBook = getNumberMetric(input.fundamentals.priceToBook);
  const evToEbitda = getNumberMetric(input.fundamentals.evToEbitda);
  const priceToSales = getNumberMetric(input.fundamentals.priceToSales);
  const profitMargin = normalizePercentLikeNumber(getNumberMetric(input.fundamentals.profitMargin));
  const roe = normalizePercentLikeNumber(getNumberMetric(input.fundamentals.roe));
  const revGrowthYoy = normalizePercentLikeNumber(getNumberMetric(input.fundamentals.revGrowthYoy));
  const epsGrowthYoy = normalizePercentLikeNumber(getNumberMetric(input.fundamentals.epsGrowthYoy));

  const valuation = avg([
    scoreLowerBetter(peRatio, 5, 45),
    scoreLowerBetter(priceToBook, 0.5, 12),
    scoreLowerBetter(evToEbitda, 4, 40),
    scoreLowerBetter(priceToSales, 0.5, 20),
  ]);
  const qualityGrowth = avg([
    scoreHigherBetter(profitMargin, 0, 40),
    scoreHigherBetter(roe, 0, 40),
    scoreHigherBetter(revGrowthYoy, -20, 50),
    scoreHigherBetter(epsGrowthYoy, -20, 60),
  ]);

  return finalizeValueRating({
    assetClass: input.assetClass === "unknown" ? "unknown" : "stock",
    asOf: input.asOf,
    modelVersion: VALUE_RATING_MODEL_VERSION,
    weightedScores: [
      { score: valuation, weight: 0.45 },
      { score: qualityGrowth, weight: 0.35 },
      { score: technical, weight: 0.2 },
    ],
    drivers: [
      buildDriver("P/E", peRatio, "lower_is_better"),
      buildDriver("Price/Book", priceToBook, "lower_is_better"),
      buildDriver("ROE", roe, "higher_is_better", "%"),
      buildDriver("Revenue YoY", revGrowthYoy, "higher_is_better", "%"),
    ],
  });
}

function finalizeValueRating(input: {
  assetClass: LivePortfolioValueRating["assetClass"];
  asOf: string;
  modelVersion: string;
  weightedScores: Array<{ score: number | null; weight: number }>;
  drivers: Array<LivePortfolioValueRatingDriver | null>;
}): LivePortfolioValueRating {
  let weighted = 0;
  let totalWeight = 0;
  for (const row of input.weightedScores) {
    if (row.score == null || !Number.isFinite(row.score)) continue;
    if (!Number.isFinite(row.weight) || row.weight <= 0) continue;
    weighted += row.score * row.weight;
    totalWeight += row.weight;
  }

  const confidence = clamp01(totalWeight);
  const score = totalWeight > 0 ? clamp01(weighted / totalWeight) * 100 : null;
  const grade = toGrade(score);
  const drivers = input.drivers.filter((driver): driver is LivePortfolioValueRatingDriver => driver !== null);

  return {
    score: score == null ? null : Math.round(score * 10) / 10,
    grade,
    confidence: Math.round(confidence * 1000) / 1000,
    assetClass: input.assetClass,
    asOf: input.asOf,
    modelVersion: input.modelVersion,
    drivers: drivers.slice(0, 4),
  };
}

function computeTechnicalScore(bars: Bar[]): number | null {
  if (!Array.isArray(bars) || bars.length < 30) return null;
  const closes = bars.map((bar) => bar.c).filter((close) => Number.isFinite(close));
  if (closes.length < 30) return null;
  const last = closes[closes.length - 1]!;
  const yearSlice = closes.slice(-252);
  const yearLow = Math.min(...yearSlice);
  const yearHigh = Math.max(...yearSlice);
  const location = yearHigh > yearLow ? (last - yearLow) / (yearHigh - yearLow) : 0.5;

  const lookback = Math.min(63, closes.length - 1);
  const anchor = closes[closes.length - 1 - lookback]!;
  const momentumPct = anchor > 0 ? ((last - anchor) / anchor) * 100 : 0;

  const valueLocationScore = scoreLowerBetter(location * 100, 5, 95);
  const momentumScore = scoreLowerBetter(momentumPct, -30, 40);
  return avg([valueLocationScore, momentumScore]);
}

function buildDriver(
  label: string,
  value: number | null,
  direction: "higher_is_better" | "lower_is_better",
  suffix = ""
): LivePortfolioValueRatingDriver | null {
  if (value == null || !Number.isFinite(value)) return null;
  const effect =
    direction === "higher_is_better"
      ? value >= 0 ? "positive" : "negative"
      : value <= 0 ? "positive" : "negative";
  const valueText = suffix === "%" ? `${value.toFixed(2)}%` : value.toFixed(2);
  return { label, effect, value: valueText };
}

function scoreLowerBetter(value: number | null, min: number, max: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (max <= min) return null;
  const pct = (value - min) / (max - min);
  return clamp01(1 - pct);
}

function scoreHigherBetter(value: number | null, min: number, max: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (max <= min) return null;
  const pct = (value - min) / (max - min);
  return clamp01(pct);
}

function toGrade(score: number | null): LivePortfolioValueRating["grade"] {
  if (score == null || !Number.isFinite(score)) return "NR";
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}

function avg(values: Array<number | null>): number | null {
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    total += value;
    count += 1;
  }
  return count > 0 ? total / count : null;
}

function getNumberMetric(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  return numberOrNull(value);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none" || trimmed === "-") return null;
  const normalized = trimmed.replace(/[$,%\s]/g, "").replace(/,/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePercentLikeNumber(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (Math.abs(value) <= 1) return value * 100;
  return value;
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadValueCacheFromDisk(): Promise<void> {
  try {
    const raw = await readFile(LIVE_PORTFOLIO_VALUE_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as PersistedValueCacheState;
    valueCacheByKey = parsePersistedValueCache(parsed);
  } catch {
    valueCacheByKey = new Map<string, ValueCacheEntry>();
  }
}

function parsePersistedValueCache(raw: PersistedValueCacheState): Map<string, ValueCacheEntry> {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) {
    return new Map<string, ValueCacheEntry>();
  }
  const next = new Map<string, ValueCacheEntry>();
  for (const row of raw.entries) {
    if (!isRecord(row)) continue;
    if (
      typeof row.key !== "string" ||
      typeof row.symbol !== "string" ||
      typeof row.provider !== "string" ||
      typeof row.modelVersion !== "string" ||
      typeof row.sourceStatus !== "string" ||
      typeof row.cachedAt !== "string" ||
      !isRecord(row.normalizedFundamentals) ||
      !isRecord(row.valueRating)
    ) {
      continue;
    }
    const rating = parseCachedValueRating(row.valueRating);
    if (!rating) continue;
    next.set(row.key, {
      key: row.key,
      symbol: row.symbol,
      provider: row.provider,
      modelVersion: row.modelVersion,
      sourceStatus: row.sourceStatus,
      cachedAt: row.cachedAt,
      normalizedFundamentals: { ...row.normalizedFundamentals } as Record<string, number | string | null>,
      valueRating: rating,
    });
  }
  return next;
}

function parseCachedValueRating(value: Record<string, unknown>): LivePortfolioValueRating | null {
  const grade = value.grade;
  const assetClass = value.assetClass;
  if (
    grade !== "A" &&
    grade !== "B" &&
    grade !== "C" &&
    grade !== "D" &&
    grade !== "F" &&
    grade !== "NR"
  ) {
    return null;
  }
  if (assetClass !== "stock" && assetClass !== "etf" && assetClass !== "unknown") {
    return null;
  }
  const score = typeof value.score === "number" && Number.isFinite(value.score) ? value.score : null;
  const confidence =
    typeof value.confidence === "number" && Number.isFinite(value.confidence)
      ? clamp01(value.confidence)
      : 0;
  const asOf = typeof value.asOf === "string" ? value.asOf : new Date(0).toISOString();
  const modelVersion =
    typeof value.modelVersion === "string" && value.modelVersion
      ? value.modelVersion
      : VALUE_RATING_MODEL_VERSION;
  const drivers = Array.isArray(value.drivers)
    ? value.drivers
        .filter((row): row is Record<string, unknown> => isRecord(row))
        .map((row) => {
          const effect = row.effect === "negative" ? "negative" : "positive";
          const label = typeof row.label === "string" ? row.label : "Metric";
          const metricValue = typeof row.value === "string" ? row.value : "-";
          return { label, effect, value: metricValue } satisfies LivePortfolioValueRatingDriver;
        })
    : [];
  return {
    score,
    grade,
    confidence,
    assetClass,
    asOf,
    modelVersion,
    drivers,
  };
}

function cloneValueCacheEntry(entry: ValueCacheEntry): ValueCacheEntry {
  return {
    key: entry.key,
    symbol: entry.symbol,
    provider: entry.provider,
    modelVersion: entry.modelVersion,
    sourceStatus: entry.sourceStatus,
    cachedAt: entry.cachedAt,
    normalizedFundamentals: { ...entry.normalizedFundamentals },
    valueRating: cloneValueRating(entry.valueRating),
  };
}

function cloneValueRating(value: LivePortfolioValueRating): LivePortfolioValueRating {
  return {
    score: value.score,
    grade: value.grade,
    confidence: value.confidence,
    assetClass: value.assetClass,
    asOf: value.asOf,
    modelVersion: value.modelVersion,
    drivers: value.drivers.map((driver) => ({ ...driver })),
  };
}

function buildQuarterlyValueRatingBacktest(input: {
  bars: Bar[];
}): LivePortfolioValueRatingQuarterlyPoint[] {
  const checkpoints = extractQuarterlyCheckpoints(input.bars);
  if (checkpoints.length === 0) return [];

  return checkpoints.map((checkpoint) => {
    const checkpointBars = input.bars.slice(0, checkpoint.index + 1);
    const technicalOnlyScore = computeTechnicalScore(checkpointBars);
    const score = technicalOnlyScore == null ? null : Math.round(clamp01(technicalOnlyScore) * 1000) / 10;
    return {
      date: checkpoint.bar.t,
      score,
      grade: toGrade(score),
      // Quarterly series is intentionally price-only to prevent look-forward on fundamentals.
      confidence: technicalOnlyScore == null ? 0 : 1,
    } satisfies LivePortfolioValueRatingQuarterlyPoint;
  });
}

function extractQuarterlyCheckpoints(bars: Bar[]): Array<{ index: number; bar: Bar }> {
  if (!Array.isArray(bars) || bars.length === 0) return [];

  const byQuarter = new Map<string, { index: number; bar: Bar }>();
  bars.forEach((bar, index) => {
    const parsed = new Date(bar.t);
    if (!Number.isFinite(parsed.getTime())) return;
    const year = parsed.getUTCFullYear();
    const quarter = Math.floor(parsed.getUTCMonth() / 3) + 1;
    const key = `${year}-Q${quarter}`;
    byQuarter.set(key, { index, bar });
  });

  return Array.from(byQuarter.values()).sort((a, b) => a.index - b.index);
}

async function persistValueCache(): Promise<void> {
  const payload = JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      entries: Array.from(valueCacheByKey.values()).map((entry) => ({
        key: entry.key,
        symbol: entry.symbol,
        provider: entry.provider,
        modelVersion: entry.modelVersion,
        sourceStatus: entry.sourceStatus,
        cachedAt: entry.cachedAt,
        normalizedFundamentals: entry.normalizedFundamentals,
        valueRating: entry.valueRating,
      })),
    },
    null,
    2
  );
  valueCachePersistChain = valueCachePersistChain.then(async () => {
    await writeFile(LIVE_PORTFOLIO_VALUE_CACHE_FILE, payload, "utf8");
  });
  return valueCachePersistChain;
}

async function clearValueCache(): Promise<void> {
  valueCacheByKey = new Map<string, ValueCacheEntry>();
  await persistValueCache();
}

function buildWindowSignal(
  bars: Bar[],
  timeframeDays: (typeof SIGNAL_WINDOWS_DAYS)[number],
  buyThreshold: number,
  sellThreshold: number
): LivePortfolioSignalWindow {
  if (bars.length === 0) {
    return {
      timeframeDays,
      action: "hold",
      score: null,
      latestScore: null,
      barTime: null,
      rationale: null,
      error: "No bars available for signal computation.",
    };
  }

  if (bars.length < timeframeDays) {
    return {
      timeframeDays,
      action: "hold",
      score: null,
      latestScore: null,
      barTime: bars[bars.length - 1]?.t ?? null,
      rationale: null,
      error: `Need at least ${timeframeDays} daily bars.`,
    };
  }

  const lastIndex = bars.length - 1;
  const startIndex = Math.max(0, bars.length - timeframeDays);
  let scoreSum = 0;
  let scoreCount = 0;
  for (let index = startIndex; index <= lastIndex; index += 1) {
    scoreSum += compositeScore(BUY_OVER_TIME_SIGNALS, bars, index);
    scoreCount += 1;
  }

  const averageScore = scoreCount > 0 ? scoreSum / scoreCount : null;
  const latestScore = compositeScore(BUY_OVER_TIME_SIGNALS, bars, lastIndex);
  const action = resolveAction(averageScore, buyThreshold, sellThreshold);
  const barTime = bars[lastIndex]?.t ?? null;
  const latestRationale = scoreRationale(BUY_OVER_TIME_SIGNALS, bars, lastIndex, false);
  const rationale =
    averageScore == null
      ? null
      : `${timeframeDays}d avg ${(averageScore * 100).toFixed(1)}% | latest ${(latestScore * 100).toFixed(1)}% | ${latestRationale}`;

  return {
    timeframeDays,
    action,
    score: averageScore,
    latestScore,
    barTime,
    rationale,
    error: null,
  };
}

function resolveAction(
  score: number | null,
  buyThreshold: number,
  sellThreshold: number
): "buy" | "sell" | "hold" {
  if (score == null || !Number.isFinite(score)) return "hold";
  if (score >= buyThreshold) return "buy";
  if (score <= sellThreshold) return "sell";
  return "hold";
}

function buildDefaultState(): LivePortfolioState {
  const seededAllocations = parseEnvAllocations(process.env.LIVE_PORTFOLIO_ALLOCATIONS ?? "");
  const defaultAllocations =
    seededAllocations.length > 0 ? seededAllocations : [{ symbol: "SPY", targetPct: 100 }];
  const updatedAt = new Date().toISOString();
  const portfolio: LivePortfolioConfig = {
    key: DEFAULT_PORTFOLIO_KEY,
    name: DEFAULT_PORTFOLIO_NAME,
    allocations: defaultAllocations,
    buyThreshold: 0.6,
    sellThreshold: 0.4,
    updatedAt,
  };

  return {
    defaultPortfolioKey: portfolio.key,
    portfolios: [portfolio],
    updatedAt,
  };
}

function normalizePersistedState(raw: PersistedPortfolioState): LivePortfolioState {
  const fallback = buildDefaultState();
  const fallbackPortfolio = fallback.portfolios[0];

  if (Array.isArray(raw.portfolios)) {
    const portfolios = parsePersistedPortfolios(raw.portfolios, fallbackPortfolio);
    if (portfolios.length > 0) {
      const fallbackKey = portfolios[0].key;
      const defaultPortfolioKey = parseOptionalPortfolioKey(raw.defaultPortfolioKey, fallbackKey);
      const existingDefault = portfolios.some((portfolio) => portfolio.key === defaultPortfolioKey)
        ? defaultPortfolioKey
        : fallbackKey;
      const updatedAt = parseOptionalIsoTimestamp(raw.updatedAt, fallback.updatedAt);
      return {
        defaultPortfolioKey: existingDefault,
        portfolios,
        updatedAt,
      };
    }
  }

  const allocations = Object.prototype.hasOwnProperty.call(raw, "allocations")
    ? parseAllocationsInput(raw.allocations)
    : fallbackPortfolio.allocations;
  const buyThreshold = parseOptionalThreshold(raw.buyThreshold, fallbackPortfolio.buyThreshold);
  const sellThreshold = parseOptionalThreshold(raw.sellThreshold, fallbackPortfolio.sellThreshold);
  if (sellThreshold >= buyThreshold) {
    throw new Error("Persisted portfolio config is invalid: sellThreshold must be less than buyThreshold.");
  }

  const updatedAt = parseOptionalIsoTimestamp(raw.updatedAt, fallbackPortfolio.updatedAt);
  const name = parseOptionalPortfolioName(raw.name, fallbackPortfolio.name);
  const derivedDefaultKey = parseOptionalPortfolioKey(raw.key, slugifyPortfolioKey(name));
  const description = parseOptionalPortfolioDescription(raw.description);
  const selectionRationale = parseOptionalPortfolioSelectionRationale(raw.selectionRationale);
  const whitepaper = parseOptionalWhitepaper(raw.whitepaper);
  const launchedAt = parseOptionalPortfolioLaunchDate(raw.launchedAt);
  const portfolio: LivePortfolioConfig = {
    key: derivedDefaultKey,
    name,
    ...(description ? { description } : {}),
    ...(selectionRationale ? { selectionRationale } : {}),
    allocations,
    ...(whitepaper ? { whitepaper } : {}),
    ...(launchedAt ? { launchedAt } : {}),
    buyThreshold,
    sellThreshold,
    updatedAt,
  };

  return {
    defaultPortfolioKey: portfolio.key,
    portfolios: [portfolio],
    updatedAt,
  };
}

function parsePersistedPortfolios(
  value: unknown[],
  fallbackPortfolio: LivePortfolioConfig
): LivePortfolioConfig[] {
  if (value.length > MAX_PORTFOLIOS) {
    throw new Error(`Persisted state supports at most ${MAX_PORTFOLIOS} portfolios.`);
  }

  const usedKeys = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Persisted portfolio at index ${index} must be an object.`);
    }

    const nameFallback = `Portfolio ${index + 1}`;
    const name = parseOptionalPortfolioName(entry.name, nameFallback);
    const key = parseOptionalPortfolioKey(entry.key, slugifyPortfolioKey(name));
    if (usedKeys.has(key)) {
      throw new Error(`Duplicate portfolio key "${key}" in persisted state.`);
    }
    usedKeys.add(key);

    const allocations = Object.prototype.hasOwnProperty.call(entry, "allocations")
      ? parseAllocationsInput(entry.allocations)
      : fallbackPortfolio.allocations;
    const description = parseOptionalPortfolioDescription(entry.description);
    const selectionRationale = parseOptionalPortfolioSelectionRationale(entry.selectionRationale);
    const whitepaper = parseOptionalWhitepaper(entry.whitepaper);
    const launchedAt = parseOptionalPortfolioLaunchDate(entry.launchedAt);
    const buyThreshold = parseOptionalThreshold(entry.buyThreshold, fallbackPortfolio.buyThreshold);
    const sellThreshold = parseOptionalThreshold(entry.sellThreshold, fallbackPortfolio.sellThreshold);
    if (sellThreshold >= buyThreshold) {
      throw new Error(
        `Persisted portfolio "${key}" is invalid: sellThreshold must be less than buyThreshold.`
      );
    }

    const updatedAt = parseOptionalIsoTimestamp(entry.updatedAt, fallbackPortfolio.updatedAt);
    return {
      key,
      name,
      ...(description ? { description } : {}),
      ...(selectionRationale ? { selectionRationale } : {}),
      allocations,
      ...(whitepaper ? { whitepaper } : {}),
      ...(launchedAt ? { launchedAt } : {}),
      buyThreshold,
      sellThreshold,
      updatedAt,
    };
  });
}

function parseAllocationsInput(value: unknown): LivePortfolioAllocation[] {
  if (!Array.isArray(value)) {
    throw new Error("allocations must be an array of { symbol, targetPct, summary?, wikipediaUrl? }.");
  }
  if (value.length > MAX_ALLOCATIONS) {
    throw new Error(`allocations supports at most ${MAX_ALLOCATIONS} symbols.`);
  }

  const mergedBySymbol = new Map<
    string,
    { targetPct: number; summary?: string; wikipediaUrl?: string }
  >();
  for (const row of value) {
    if (!isRecord(row)) {
      throw new Error("Each allocation must be an object.");
    }
    const symbol = normalizeSymbol(row.symbol);
    const targetPct = parseTargetPct(row.targetPct);
    const summary = parseOptionalAllocationSummary(row.summary);
    const wikipediaUrl = parseOptionalWikipediaUrl(row.wikipediaUrl);
    const existing = mergedBySymbol.get(symbol);
    if (existing) {
      mergedBySymbol.set(symbol, {
        targetPct: existing.targetPct + targetPct,
        summary: existing.summary ?? summary,
        wikipediaUrl: existing.wikipediaUrl ?? wikipediaUrl,
      });
      continue;
    }
    mergedBySymbol.set(symbol, {
      targetPct,
      summary,
      wikipediaUrl,
    });
  }

  return Array.from(mergedBySymbol.entries()).map(([symbol, allocation]) => {
    return {
      symbol,
      targetPct: allocation.targetPct,
      ...(allocation.summary ? { summary: allocation.summary } : {}),
      ...(allocation.wikipediaUrl ? { wikipediaUrl: allocation.wikipediaUrl } : {}),
    };
  });
}

function parseEnvAllocations(value: string): LivePortfolioAllocation[] {
  const chunks = value
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  if (chunks.length === 0) return [];

  const merged = new Map<string, number>();
  for (const chunk of chunks) {
    const parts = chunk.split(/[:=]/);
    if (parts.length !== 2) continue;
    try {
      const symbol = normalizeSymbol(parts[0]);
      const targetPct = Number(parts[1].trim());
      if (!Number.isFinite(targetPct) || targetPct <= 0) continue;
      merged.set(symbol, (merged.get(symbol) ?? 0) + targetPct);
    } catch {
      continue;
    }
  }

  return Array.from(merged.entries()).map(([symbol, targetPct]) => ({
    symbol,
    targetPct,
  }));
}

function parseThreshold(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number.`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${fieldName} must be between 0 and 1.`);
  }
  return value;
}

function parseOptionalThreshold(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  return parseThreshold(value, "threshold");
}

function parseTargetPct(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("targetPct must be a finite number.");
  }
  if (value <= 0) {
    throw new Error("targetPct must be greater than 0.");
  }
  return value;
}

function parseOptionalAllocationSummary(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error("summary must be a string when provided.");
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 220) {
    throw new Error("summary must be 220 characters or fewer.");
  }
  return trimmed;
}

function parseOptionalWikipediaUrl(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error("wikipediaUrl must be a string when provided.");
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid wikipediaUrl "${value}".`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !hostname.endsWith("wikipedia.org")) {
    throw new Error("wikipediaUrl must be an https link to wikipedia.org.");
  }
  return trimmed;
}

function parseOptionalWhitepaper(value: unknown): LivePortfolioWhitepaper | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) {
    throw new Error("whitepaper must be an object when provided.");
  }

  const title = parseWhitepaperTitle(value.title);
  const url = parseWhitepaperUrl(value.url);
  const aiGenerated = parseWhitepaperAiGenerated(value.aiGenerated);
  const disclosure = parseOptionalWhitepaperDisclosure(value.disclosure);
  return {
    title,
    url,
    aiGenerated,
    ...(disclosure ? { disclosure } : {}),
  };
}

function parseWhitepaperTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("whitepaper.title must be a string.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("whitepaper.title is required.");
  }
  if (trimmed.length > 180) {
    throw new Error("whitepaper.title must be 180 characters or fewer.");
  }
  return trimmed;
}

function parseWhitepaperUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("whitepaper.url must be a string.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("whitepaper.url is required.");
  }
  if (trimmed.length > 500) {
    throw new Error("whitepaper.url must be 500 characters or fewer.");
  }

  // Support relative paths so local static PDFs can be referenced.
  if (!trimmed.includes("://")) {
    if (trimmed.startsWith("//")) {
      throw new Error("whitepaper.url must not start with //.");
    }
    if (/\s/.test(trimmed)) {
      throw new Error("whitepaper.url must not include spaces.");
    }
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid whitepaper.url "${value}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("whitepaper.url must use http or https when absolute.");
  }
  return trimmed;
}

function parseWhitepaperAiGenerated(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value !== "boolean") {
    throw new Error("whitepaper.aiGenerated must be a boolean when provided.");
  }
  return value;
}

function parseOptionalWhitepaperDisclosure(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error("whitepaper.disclosure must be a string when provided.");
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 500) {
    throw new Error("whitepaper.disclosure must be 500 characters or fewer.");
  }
  return trimmed;
}

function parseOptionalPortfolioDescription(value: unknown): string | undefined {
  return parseOptionalPortfolioNarrative(value, "description", 600);
}

function parseOptionalPortfolioSelectionRationale(value: unknown): string | undefined {
  return parseOptionalPortfolioNarrative(value, "selectionRationale", 900);
}

function parseOptionalPortfolioNarrative(
  value: unknown,
  fieldName: string,
  maxLength: number
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string when provided.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

function parsePortfolioName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("name must be a string.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("name is required.");
  }
  if (trimmed.length > 120) {
    throw new Error("name must be 120 characters or fewer.");
  }
  return trimmed;
}

function parseOptionalPortfolioName(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  return parsePortfolioName(value);
}

function parseOptionalPortfolioKey(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  return normalizePortfolioKey(value);
}

function normalizePortfolioKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("portfolio key must be a string.");
  }
  const normalized = slugifyPortfolioKey(value);
  if (!normalized) {
    throw new Error("portfolio key is required.");
  }
  if (normalized.length > 64) {
    throw new Error("portfolio key must be 64 characters or fewer.");
  }
  return normalized;
}

function slugifyPortfolioKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeSymbol(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("symbol must be a string.");
  }
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    throw new Error("symbol is required.");
  }
  if (!/^[A-Z0-9./_-]+$/.test(normalized)) {
    throw new Error(`Invalid symbol "${value}".`);
  }
  return normalized;
}

function resolvePortfolioConfig(portfolioKey?: string): LivePortfolioConfig {
  if (configState.portfolios.length === 0) {
    throw new Error("No live portfolios are configured.");
  }

  if (!portfolioKey) {
    const defaultPortfolio = configState.portfolios.find(
      (portfolio) => portfolio.key === configState.defaultPortfolioKey
    );
    return defaultPortfolio ?? configState.portfolios[0];
  }

  const normalizedRequestedKey = slugifyPortfolioKey(portfolioKey);
  const byKey = configState.portfolios.find((portfolio) => portfolio.key === normalizedRequestedKey);
  if (byKey) return byKey;

  const byName = configState.portfolios.find(
    (portfolio) => slugifyPortfolioKey(portfolio.name) === normalizedRequestedKey
  );
  if (byName) return byName;

  const available = configState.portfolios.map((portfolio) => portfolio.key).join(", ");
  throw new Error(
    `Unknown portfolio "${portfolioKey}". Available portfolio keys: ${available || "none"}.`
  );
}

function parseOptionalIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return Number.isFinite(Date.parse(value)) ? value : fallback;
}

function parseOptionalPortfolioLaunchDate(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error("launchedAt must be a string when provided.");
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!Number.isFinite(Date.parse(trimmed))) {
    throw new Error("launchedAt must be a valid date string.");
  }
  return trimmed;
}

function persistConfig(): Promise<void> {
  const payload = JSON.stringify(configState, null, 2);
  persistChain = persistChain.then(async () => {
    await writeFile(LIVE_PORTFOLIO_STATE_FILE, payload, "utf8");
    const info = await stat(LIVE_PORTFOLIO_STATE_FILE);
    loadedStateMtimeMs = info.mtimeMs;
  });
  return persistChain;
}

function clonePortfolioConfig(config: LivePortfolioConfig): LivePortfolioConfig {
  return {
    key: config.key,
    name: config.name,
    ...(config.description ? { description: config.description } : {}),
    ...(config.selectionRationale ? { selectionRationale: config.selectionRationale } : {}),
    allocations: config.allocations.map((allocation) => ({ ...allocation })),
    ...(config.whitepaper ? { whitepaper: cloneWhitepaper(config.whitepaper) } : {}),
    ...(config.launchedAt ? { launchedAt: config.launchedAt } : {}),
    buyThreshold: config.buyThreshold,
    sellThreshold: config.sellThreshold,
    updatedAt: config.updatedAt,
  };
}

function cloneWhitepaper(whitepaper: LivePortfolioWhitepaper): LivePortfolioWhitepaper {
  return {
    title: whitepaper.title,
    url: whitepaper.url,
    aiGenerated: whitepaper.aiGenerated,
    ...(whitepaper.disclosure ? { disclosure: whitepaper.disclosure } : {}),
  };
}

function cloneSnapshot(snapshot: LivePortfolioSnapshot): LivePortfolioSnapshot {
  return {
    portfolioKey: snapshot.portfolioKey,
    portfolioName: snapshot.portfolioName,
    description: snapshot.description,
    selectionRationale: snapshot.selectionRationale,
    whitepaper: snapshot.whitepaper ? cloneWhitepaper(snapshot.whitepaper) : null,
    launchedAt: snapshot.launchedAt,
    algorithm: snapshot.algorithm,
    buyThreshold: snapshot.buyThreshold,
    sellThreshold: snapshot.sellThreshold,
    totalRequestedPct: snapshot.totalRequestedPct,
    generatedAt: snapshot.generatedAt,
    updatedAt: snapshot.updatedAt,
    holdings: snapshot.holdings.map((holding) => ({
      symbol: holding.symbol,
      targetPct: holding.targetPct,
      normalizedTargetPct: holding.normalizedTargetPct,
      summary: holding.summary,
      wikipediaUrl: holding.wikipediaUrl,
      lastPrice: holding.lastPrice,
      signals: holding.signals.map((signal) => ({ ...signal })),
      ...(holding.valueRating ? { valueRating: cloneValueRating(holding.valueRating) } : {}),
      ...(holding.valueRatingQuarterly
        ? { valueRatingQuarterly: holding.valueRatingQuarterly.map((point) => ({ ...point })) }
        : {}),
    })),
  };
}

function invalidateSnapshotCache(): void {
  cachedSnapshotsByKey = new Map<string, { snapshot: LivePortfolioSnapshot; cachedAtMs: number }>();
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function syncConfigFromDiskIfChanged(): Promise<void> {
  try {
    const info = await stat(LIVE_PORTFOLIO_STATE_FILE);
    if (info.mtimeMs <= loadedStateMtimeMs + 0.5) {
      return;
    }
    const loaded = await loadConfigFromDisk();
    if (!loaded) return;
    configState = loaded.state;
    loadedStateMtimeMs = loaded.mtimeMs;
    await clearValueCache();
    invalidateSnapshotCache();
  } catch {
    // Keep in-memory config if disk state is unavailable.
  }
}

async function loadConfigFromDisk(): Promise<{ state: LivePortfolioState; mtimeMs: number } | null> {
  try {
    const info = await stat(LIVE_PORTFOLIO_STATE_FILE);
    const raw = await readFile(LIVE_PORTFOLIO_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as PersistedPortfolioState;
    return {
      state: normalizePersistedState(parsed),
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return null;
  }
}
