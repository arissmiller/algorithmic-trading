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

const BUY_OVER_TIME_SIGNALS: SignalWeight[] = [
  { signal: { type: "price_vs_sma", period: 30 }, weight: 0.35 },
  { signal: { type: "rsi", period: 14 }, weight: 0.4 },
  { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.25 },
];

export interface LivePortfolioAllocation {
  symbol: string;
  targetPct: number;
}

export interface LivePortfolioConfig {
  allocations: LivePortfolioAllocation[];
  buyThreshold: number;
  sellThreshold: number;
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
  lastPrice: number | null;
  signals: LivePortfolioSignalWindow[];
}

export interface LivePortfolioSnapshot {
  algorithm: "buy_over_time";
  buyThreshold: number;
  sellThreshold: number;
  totalRequestedPct: number;
  generatedAt: string;
  updatedAt: string;
  holdings: LivePortfolioHoldingSnapshot[];
}

interface PersistedPortfolioState {
  allocations?: unknown;
  buyThreshold?: unknown;
  sellThreshold?: unknown;
  updatedAt?: unknown;
}

let configState: LivePortfolioConfig = buildDefaultConfig();
let persistChain: Promise<void> = Promise.resolve();
let cachedSnapshot: LivePortfolioSnapshot | null = null;
let cachedSnapshotAtMs = 0;
let loadedStateMtimeMs = 0;

export async function loadLivePortfolioState(): Promise<void> {
  const loaded = await loadConfigFromDisk();
  if (loaded) {
    configState = loaded.config;
    loadedStateMtimeMs = loaded.mtimeMs;
  } else {
    configState = buildDefaultConfig();
    loadedStateMtimeMs = Date.now();
  }
  invalidateSnapshotCache();
}

export async function getLivePortfolioConfig(): Promise<LivePortfolioConfig> {
  await syncConfigFromDiskIfChanged();
  return cloneConfig(configState);
}

export async function updateLivePortfolioConfig(input: unknown): Promise<LivePortfolioConfig> {
  if (!isRecord(input)) {
    throw new Error("Portfolio payload must be a JSON object.");
  }

  const hasAllocations = Object.prototype.hasOwnProperty.call(input, "allocations");
  const hasBuyThreshold = Object.prototype.hasOwnProperty.call(input, "buyThreshold");
  const hasSellThreshold = Object.prototype.hasOwnProperty.call(input, "sellThreshold");

  if (!hasAllocations && !hasBuyThreshold && !hasSellThreshold) {
    throw new Error("Provide at least one of allocations, buyThreshold, or sellThreshold.");
  }

  const allocations = hasAllocations
    ? parseAllocationsInput(input.allocations)
    : configState.allocations;
  const buyThreshold = hasBuyThreshold
    ? parseThreshold(input.buyThreshold, "buyThreshold")
    : configState.buyThreshold;
  const sellThreshold = hasSellThreshold
    ? parseThreshold(input.sellThreshold, "sellThreshold")
    : configState.sellThreshold;

  if (sellThreshold >= buyThreshold) {
    throw new Error("sellThreshold must be less than buyThreshold.");
  }

  const next: LivePortfolioConfig = {
    allocations,
    buyThreshold,
    sellThreshold,
    updatedAt: new Date().toISOString(),
  };

  configState = next;
  await persistConfig();
  invalidateSnapshotCache();
  return cloneConfig(configState);
}

export async function getLivePortfolioSnapshot(): Promise<LivePortfolioSnapshot> {
  await syncConfigFromDiskIfChanged();
  const cacheIsFresh =
    cachedSnapshot && Date.now() - cachedSnapshotAtMs < LIVE_PORTFOLIO_SNAPSHOT_TTL_MS;
  if (cacheIsFresh && cachedSnapshot) {
    return cloneSnapshot(cachedSnapshot);
  }

  const generatedAt = new Date().toISOString();
  const totalRequestedPct = configState.allocations.reduce(
    (sum, allocation) => sum + allocation.targetPct,
    0
  );

  const holdings = await Promise.all(
    configState.allocations.map(async (allocation) => {
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
          buildWindowSignal(bars, timeframeDays)
        );

        return {
          symbol: allocation.symbol,
          targetPct: allocation.targetPct,
          normalizedTargetPct,
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
          lastPrice: null,
          signals,
        } satisfies LivePortfolioHoldingSnapshot;
      }
    })
  );

  const snapshot: LivePortfolioSnapshot = {
    algorithm: "buy_over_time",
    buyThreshold: configState.buyThreshold,
    sellThreshold: configState.sellThreshold,
    totalRequestedPct,
    generatedAt,
    updatedAt: configState.updatedAt,
    holdings,
  };

  cachedSnapshot = snapshot;
  cachedSnapshotAtMs = Date.now();
  return cloneSnapshot(snapshot);
}

function buildWindowSignal(
  bars: Bar[],
  timeframeDays: (typeof SIGNAL_WINDOWS_DAYS)[number]
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
  const action = resolveAction(averageScore, configState.buyThreshold, configState.sellThreshold);
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

function buildDefaultConfig(): LivePortfolioConfig {
  const seededAllocations = parseEnvAllocations(process.env.LIVE_PORTFOLIO_ALLOCATIONS ?? "");
  const defaultAllocations =
    seededAllocations.length > 0 ? seededAllocations : [{ symbol: "SPY", targetPct: 100 }];

  return {
    allocations: defaultAllocations,
    buyThreshold: 0.6,
    sellThreshold: 0.4,
    updatedAt: new Date().toISOString(),
  };
}

function normalizePersistedConfig(raw: PersistedPortfolioState): LivePortfolioConfig {
  const fallback = buildDefaultConfig();
  const allocations =
    raw && Object.prototype.hasOwnProperty.call(raw, "allocations")
      ? parseAllocationsInput(raw.allocations)
      : fallback.allocations;
  const buyThreshold = parseOptionalThreshold(raw.buyThreshold, fallback.buyThreshold);
  const sellThreshold = parseOptionalThreshold(raw.sellThreshold, fallback.sellThreshold);
  const updatedAt =
    typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : fallback.updatedAt;

  if (sellThreshold >= buyThreshold) {
    throw new Error("Persisted portfolio config is invalid: sellThreshold must be less than buyThreshold.");
  }

  return {
    allocations,
    buyThreshold,
    sellThreshold,
    updatedAt,
  };
}

function parseAllocationsInput(value: unknown): LivePortfolioAllocation[] {
  if (!Array.isArray(value)) {
    throw new Error("allocations must be an array of { symbol, targetPct }.");
  }
  if (value.length > MAX_ALLOCATIONS) {
    throw new Error(`allocations supports at most ${MAX_ALLOCATIONS} symbols.`);
  }

  const mergedBySymbol = new Map<string, number>();
  for (const row of value) {
    if (!isRecord(row)) {
      throw new Error("Each allocation must be an object.");
    }
    const symbol = normalizeSymbol(row.symbol);
    const targetPct = parseTargetPct(row.targetPct);
    mergedBySymbol.set(symbol, (mergedBySymbol.get(symbol) ?? 0) + targetPct);
  }

  return Array.from(mergedBySymbol.entries()).map(([symbol, targetPct]) => ({
    symbol,
    targetPct,
  }));
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

function persistConfig(): Promise<void> {
  const payload = JSON.stringify(configState, null, 2);
  persistChain = persistChain.then(async () => {
    await writeFile(LIVE_PORTFOLIO_STATE_FILE, payload, "utf8");
    const info = await stat(LIVE_PORTFOLIO_STATE_FILE);
    loadedStateMtimeMs = info.mtimeMs;
  });
  return persistChain;
}

function cloneConfig(config: LivePortfolioConfig): LivePortfolioConfig {
  return {
    allocations: config.allocations.map((allocation) => ({ ...allocation })),
    buyThreshold: config.buyThreshold,
    sellThreshold: config.sellThreshold,
    updatedAt: config.updatedAt,
  };
}

function cloneSnapshot(snapshot: LivePortfolioSnapshot): LivePortfolioSnapshot {
  return {
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
      lastPrice: holding.lastPrice,
      signals: holding.signals.map((signal) => ({ ...signal })),
    })),
  };
}

function invalidateSnapshotCache(): void {
  cachedSnapshot = null;
  cachedSnapshotAtMs = 0;
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
    configState = loaded.config;
    loadedStateMtimeMs = loaded.mtimeMs;
    invalidateSnapshotCache();
  } catch {
    // Keep in-memory config if disk state is unavailable.
  }
}

async function loadConfigFromDisk(): Promise<{ config: LivePortfolioConfig; mtimeMs: number } | null> {
  try {
    const info = await stat(LIVE_PORTFOLIO_STATE_FILE);
    const raw = await readFile(LIVE_PORTFOLIO_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as PersistedPortfolioState;
    return {
      config: normalizePersistedConfig(parsed),
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return null;
  }
}
