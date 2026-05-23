import { readFile, stat, writeFile } from "node:fs/promises";
import { fetchMarketBars } from "./core.ts";
import { Bar, compositeScore, scoreRationale, SignalWeight } from "./botSignals.ts";

const LIVE_PORTFOLIO_STATE_FILE =
  process.env.LIVE_PORTFOLIO_STATE_FILE ??
  new URL("./live-portfolio-state.json", import.meta.url).pathname;
const LIVE_PORTFOLIO_SNAPSHOT_TTL_MS = parsePositiveInt(
  process.env.LIVE_PORTFOLIO_SNAPSHOT_TTL_MS,
  60_000
);
const SIGNAL_WINDOWS_DAYS = [7, 30, 90] as const;
const MAX_ALLOCATIONS = 40;
const MAX_PORTFOLIOS = 20;
const DEFAULT_PORTFOLIO_KEY = "live_portfolio";
const DEFAULT_PORTFOLIO_NAME = "Live Portfolio";

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

export interface LivePortfolioHoldingSnapshot {
  symbol: string;
  targetPct: number;
  normalizedTargetPct: number;
  summary: string | null;
  wikipediaUrl: string | null;
  lastPrice: number | null;
  signals: LivePortfolioSignalWindow[];
}

export interface LivePortfolioSnapshot {
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
}

interface PersistedPortfolioConfig {
  key?: unknown;
  name?: unknown;
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
  allocations?: unknown;
  whitepaper?: unknown;
  launchedAt?: unknown;
  buyThreshold?: unknown;
  sellThreshold?: unknown;
}

let configState: LivePortfolioState = buildDefaultState();
let persistChain: Promise<void> = Promise.resolve();
let cachedSnapshotsByKey = new Map<string, { snapshot: LivePortfolioSnapshot; cachedAtMs: number }>();
let loadedStateMtimeMs = 0;

export async function loadLivePortfolioState(): Promise<void> {
  const loaded = await loadConfigFromDisk();
  if (loaded) {
    configState = loaded.state;
    loadedStateMtimeMs = loaded.mtimeMs;
  } else {
    configState = buildDefaultState();
    loadedStateMtimeMs = Date.now();
  }
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
  const hasAllocations = Object.prototype.hasOwnProperty.call(input, "allocations");
  const hasWhitepaper = Object.prototype.hasOwnProperty.call(input, "whitepaper");
  const hasLaunchedAt = Object.prototype.hasOwnProperty.call(input, "launchedAt");
  const hasBuyThreshold = Object.prototype.hasOwnProperty.call(input, "buyThreshold");
  const hasSellThreshold = Object.prototype.hasOwnProperty.call(input, "sellThreshold");

  if (
    !hasName &&
    !hasAllocations &&
    !hasWhitepaper &&
    !hasLaunchedAt &&
    !hasBuyThreshold &&
    !hasSellThreshold
  ) {
    throw new Error(
      "Provide at least one of name, allocations, whitepaper, launchedAt, buyThreshold, or sellThreshold."
    );
  }

  const name = hasName ? parsePortfolioName(input.name) : portfolio.name;
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
  invalidateSnapshotCache();
  return clonePortfolioConfig(nextPortfolio);
}

export async function getLivePortfolioSnapshot(portfolioKey?: string): Promise<LivePortfolioSnapshot> {
  await syncConfigFromDiskIfChanged();
  const portfolio = resolvePortfolioConfig(portfolioKey);

  const cached = cachedSnapshotsByKey.get(portfolio.key);
  if (cached && Date.now() - cached.cachedAtMs < LIVE_PORTFOLIO_SNAPSHOT_TTL_MS) {
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
          range: "1y",
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

        return {
          symbol: allocation.symbol,
          targetPct: allocation.targetPct,
          normalizedTargetPct,
          summary: allocation.summary ?? null,
          wikipediaUrl: allocation.wikipediaUrl ?? null,
          lastPrice,
          signals,
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
        return {
          symbol: allocation.symbol,
          targetPct: allocation.targetPct,
          normalizedTargetPct,
          summary: allocation.summary ?? null,
          wikipediaUrl: allocation.wikipediaUrl ?? null,
          lastPrice: null,
          signals,
        } satisfies LivePortfolioHoldingSnapshot;
      }
    })
  );

  const snapshot: LivePortfolioSnapshot = {
    portfolioKey: portfolio.key,
    portfolioName: portfolio.name,
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
  const whitepaper = parseOptionalWhitepaper(raw.whitepaper);
  const launchedAt = parseOptionalPortfolioLaunchDate(raw.launchedAt);
  const portfolio: LivePortfolioConfig = {
    key: derivedDefaultKey,
    name,
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
