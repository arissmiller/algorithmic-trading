import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fetchMarketBars } from "./core";
import { Bar, compositeScore, scoreRationale, SignalType, SignalWeight } from "./botSignals";
import {
  dispatchTradingSignal,
  DispatchableTradingSignal,
} from "./signalDispatch";

const WATCHLIST_STATE_FILE = new URL("./watchlist-state.json", import.meta.url).pathname;
const MIN_SIGNAL_BARS = 30;
const WATCHLIST_POLL_INTERVALS: Record<WatchlistExecutionConfig["timeframe"], number> = {
  "1Hour": 5 * 60 * 1000,
  "1Day": 30 * 60 * 1000,
};
const MAX_RECENT_SIGNALS = parsePositiveInt(
  process.env.WATCHLIST_SIGNAL_HISTORY_LIMIT,
  500
);

const DEFAULT_SIGNALS: SignalWeight[] = [
  { signal: { type: "price_vs_sma", period: 20 }, weight: 0.4 },
  { signal: { type: "rsi", period: 14 }, weight: 0.4 },
  { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.2 },
];

const DEFAULT_CONFIG: WatchlistExecutionConfig = {
  timeframe: "1Day",
  signals: DEFAULT_SIGNALS,
  buyThreshold: 0.7,
  sellThreshold: 0.3,
};

export interface WatchlistExecutionConfig {
  timeframe: "1Day" | "1Hour";
  signals: SignalWeight[];
  buyThreshold: number;
  sellThreshold: number;
}

export type WatchlistAssetClass = "stocks_etf" | "crypto";

export interface UserWatchlistInput {
  userId: string;
  name?: string;
  displayName?: string;
  assetClass?: WatchlistAssetClass;
  symbols?: string[];
  enabled?: boolean;
  config?: Partial<WatchlistExecutionConfig>;
}

export interface UserWatchlist {
  userId: string;
  name: string;
  displayName: string;
  assetClass: WatchlistAssetClass;
  symbols: string[];
  enabled: boolean;
  config: WatchlistExecutionConfig;
  createdAt: string;
  updatedAt: string;
}

export interface WatchlistSignalEvent extends DispatchableTradingSignal {
  dispatchStatus: "sent" | "skipped" | "failed";
  dispatchStatusCode: number | null;
  dispatchError: string | null;
}

export interface WatchlistMonitorStatus {
  running: boolean;
  watchlistCount: number;
  watchedSymbolCount: number;
  signalCount: number;
  lastRunByTimeframe: Record<WatchlistExecutionConfig["timeframe"], string | null>;
  lastError: string | null;
}

interface PersistedWatchlistState {
  watchlists: UserWatchlist[];
}

const watchlists = new Map<string, UserWatchlist>();
const recentSignals: WatchlistSignalEvent[] = [];
const lastSignalFingerprintByKey = new Map<string, string>();
const watchlistTimers: Partial<
  Record<WatchlistExecutionConfig["timeframe"], ReturnType<typeof setInterval>>
> = {};
const lastRunByTimeframe: Record<WatchlistExecutionConfig["timeframe"], string | null> = {
  "1Hour": null,
  "1Day": null,
};

let monitorRunning = false;
let lastError: string | null = null;
let persistChain: Promise<void> = Promise.resolve();

export async function loadPersistedWatchlists(): Promise<void> {
  try {
    const raw = await readFile(WATCHLIST_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as PersistedWatchlistState | UserWatchlist[];

    const savedList = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.watchlists)
      ? parsed.watchlists
      : [];

    watchlists.clear();
    for (const candidate of savedList) {
      try {
        const normalized = normalizePersistedWatchlist(candidate);
        watchlists.set(normalized.userId, normalized);
      } catch {
        // Skip invalid rows
      }
    }
  } catch {
    // Fresh start
  }
}

export function startWatchlistExecution(): void {
  if (monitorRunning) return;

  monitorRunning = true;
  (Object.keys(WATCHLIST_POLL_INTERVALS) as WatchlistExecutionConfig["timeframe"][]).forEach(
    (timeframe) => {
      watchlistTimers[timeframe] = setInterval(
        () => void runWatchlistTick(timeframe),
        WATCHLIST_POLL_INTERVALS[timeframe]
      );
      void runWatchlistTick(timeframe);
    }
  );

  console.log("[watchlist-monitor] started");
}

export function stopWatchlistExecution(): void {
  if (!monitorRunning) return;

  (Object.keys(watchlistTimers) as WatchlistExecutionConfig["timeframe"][]).forEach(
    (timeframe) => {
      const timer = watchlistTimers[timeframe];
      if (timer) {
        clearInterval(timer);
      }
      delete watchlistTimers[timeframe];
    }
  );

  monitorRunning = false;
  console.log("[watchlist-monitor] stopped");
}

export function getWatchlistMonitorStatus(): WatchlistMonitorStatus {
  return {
    running: monitorRunning,
    watchlistCount: watchlists.size,
    watchedSymbolCount: countWatchedSymbols(),
    signalCount: recentSignals.length,
    lastRunByTimeframe: { ...lastRunByTimeframe },
    lastError,
  };
}

export interface PublicUserWatchlistEntry {
  displayName: string;
  watchlists: Array<{
    name: string;
    assetClass: WatchlistAssetClass;
    symbols: string[];
    symbolCount: number;
    updatedAt: string;
  }>;
}

export function getPublicWatchlistUsers(): PublicUserWatchlistEntry[] {
  const byUser = new Map<string, { displayName: string; watchlists: UserWatchlist[] }>();
  for (const wl of watchlists.values()) {
    const ownerId = wl.userId.split(":wl-")[0] ?? wl.userId;
    let entry = byUser.get(ownerId);
    if (!entry) {
      entry = { displayName: wl.displayName || "Anonymous", watchlists: [] };
      byUser.set(ownerId, entry);
    }
    if (wl.displayName) entry.displayName = wl.displayName;
    entry.watchlists.push(wl);
  }
  return Array.from(byUser.values()).map(({ displayName, watchlists: wls }) => ({
    displayName,
    watchlists: wls.map((wl) => ({
      name: wl.name,
      assetClass: wl.assetClass,
      symbols: wl.symbols,
      symbolCount: wl.symbols.length,
      updatedAt: wl.updatedAt,
    })),
  }));
}

export function getUserWatchlists(): UserWatchlist[] {
  return Array.from(watchlists.values())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(cloneWatchlist);
}

export function upsertUserWatchlist(input: UserWatchlistInput): UserWatchlist {
  const existing = watchlists.get(normalizeUserId(input.userId));
  const normalized = normalizeInputWatchlist(input, existing);

  watchlists.set(normalized.userId, normalized);
  const prefix = `${normalized.userId}|`;
  for (const key of Array.from(lastSignalFingerprintByKey.keys())) {
    if (key.startsWith(prefix)) {
      lastSignalFingerprintByKey.delete(key);
    }
  }
  void persistWatchlists();

  return cloneWatchlist(normalized);
}

export function replaceAllUserWatchlists(inputs: UserWatchlistInput[]): UserWatchlist[] {
  if (!Array.isArray(inputs)) {
    throw new Error("Watchlists payload must be an array");
  }

  watchlists.clear();
  lastSignalFingerprintByKey.clear();

  for (const input of inputs) {
    const normalized = normalizeInputWatchlist(input);
    watchlists.set(normalized.userId, normalized);
  }

  void persistWatchlists();
  return getUserWatchlists();
}

export function removeUserWatchlist(userId: string): boolean {
  const normalizedId = normalizeUserId(userId);
  const existed = watchlists.delete(normalizedId);

  if (existed) {
    const prefix = `${normalizedId}|`;
    for (const key of Array.from(lastSignalFingerprintByKey.keys())) {
      if (key.startsWith(prefix)) {
        lastSignalFingerprintByKey.delete(key);
      }
    }

    void persistWatchlists();
  }

  return existed;
}

export function getRecentWatchlistSignals(limit = 100): WatchlistSignalEvent[] {
  const safeLimit = Math.max(1, Math.min(1_000, Math.round(limit) || 100));
  return recentSignals.slice(0, safeLimit).map((signal) => ({ ...signal }));
}

export async function runWatchlistScanNow(
  timeframe?: WatchlistExecutionConfig["timeframe"]
): Promise<void> {
  if (timeframe) {
    await runWatchlistTick(timeframe);
    return;
  }

  await runWatchlistTick("1Hour");
  await runWatchlistTick("1Day");
}

async function runWatchlistTick(
  timeframe: WatchlistExecutionConfig["timeframe"]
): Promise<void> {
  const startedAt = new Date().toISOString();
  lastRunByTimeframe[timeframe] = startedAt;

  const scopedWatchlists = Array.from(watchlists.values()).filter(
    (watchlist) =>
      watchlist.enabled &&
      watchlist.config.timeframe === timeframe
  );

  if (scopedWatchlists.length === 0) {
    return;
  }

  try {
    const uniqueSymbols = Array.from(
      new Set(scopedWatchlists.flatMap((watchlist) => watchlist.symbols))
    );
    const barsBySymbol = await fetchBarsForSymbols(uniqueSymbols, timeframe);

    for (const watchlist of scopedWatchlists) {
      for (const symbol of watchlist.symbols) {
        const bars = barsBySymbol.get(symbol);
        if (!bars || bars.length < MIN_SIGNAL_BARS) {
          continue;
        }

        const lastIdx = bars.length - 1;
        const score = compositeScore(watchlist.config.signals, bars, lastIdx);
        const action = resolveSignalAction(score, watchlist.config);

        if (!action) {
          continue;
        }

        const barTime = bars[lastIdx].t;
        const key = `${watchlist.userId}|${symbol}|${timeframe}`;
        const fingerprint = `${barTime}|${action}`;

        if (lastSignalFingerprintByKey.get(key) === fingerprint) {
          continue;
        }

        const rationale = scoreRationale(
          watchlist.config.signals,
          bars,
          lastIdx,
          action === "sell"
        );

        const signal: DispatchableTradingSignal = {
          id: randomUUID(),
          userId: watchlist.userId,
          symbol,
          timeframe,
          action,
          signalScore: score,
          rationale,
          barTime,
          generatedAt: new Date().toISOString(),
          watchlistUpdatedAt: watchlist.updatedAt,
        };

        const dispatchResult = await dispatchTradingSignal(signal);
        const signalEvent: WatchlistSignalEvent = {
          ...signal,
          dispatchStatus: dispatchResult.status,
          dispatchStatusCode: dispatchResult.statusCode,
          dispatchError: dispatchResult.error,
        };

        recentSignals.unshift(signalEvent);
        if (recentSignals.length > MAX_RECENT_SIGNALS) {
          recentSignals.length = MAX_RECENT_SIGNALS;
        }

        lastSignalFingerprintByKey.set(key, fingerprint);

        if (dispatchResult.status === "failed") {
          console.error(
            `[watchlist-monitor] dispatch failed for ${watchlist.userId}/${symbol}: ${dispatchResult.error}`
          );
        }
      }
    }

    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error(`[watchlist-monitor] tick error (${timeframe}): ${lastError}`);
  }
}

async function fetchBarsForSymbols(
  symbols: string[],
  timeframe: WatchlistExecutionConfig["timeframe"]
): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();

  for (const symbol of symbols) {
    try {
      const { bars: rawBars } = await fetchMarketBars({
        symbol,
        range: timeframe === "1Hour" ? null : "2y",
        timeframe,
      });

      if (rawBars.length < MIN_SIGNAL_BARS) {
        continue;
      }

      out.set(
        symbol,
        rawBars.map((bar) => ({
          t: bar.t,
          o: bar.o,
          h: bar.h,
          l: bar.l,
          c: bar.c,
          v: bar.v ?? 0,
        }))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[watchlist-monitor] ${symbol} fetch failed: ${message}`);
    }
  }

  return out;
}

function resolveSignalAction(
  score: number,
  cfg: WatchlistExecutionConfig
): "buy" | "sell" | null {
  if (score >= cfg.buyThreshold) {
    return "buy";
  }
  if (score <= cfg.sellThreshold) {
    return "sell";
  }
  return null;
}

function normalizeInputWatchlist(
  input: UserWatchlistInput,
  existing?: UserWatchlist
): UserWatchlist {
  const userId = normalizeUserId(input.userId);
  const symbols = normalizeSymbols(input.symbols ?? existing?.symbols ?? []);
  const config = normalizeWatchlistConfig(input.config, existing?.config);
  const name = normalizeWatchlistName(input.name, existing?.name, userId);
  const assetClass = normalizeAssetClass(input.assetClass, existing?.assetClass);

  const now = new Date().toISOString();
  return {
    userId,
    name,
    displayName: input.displayName?.trim() || existing?.displayName || "",
    assetClass,
    symbols,
    enabled: input.enabled ?? existing?.enabled ?? true,
    config,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function normalizePersistedWatchlist(input: UserWatchlist): UserWatchlist {
  const userId = normalizeUserId(input.userId);
  const createdAt = asIsoTimestamp(input.createdAt) ?? new Date().toISOString();
  const updatedAt = asIsoTimestamp(input.updatedAt) ?? createdAt;

  return {
    userId,
    name: normalizeWatchlistName(input.name, undefined, userId),
    displayName: input.displayName ?? "",
    assetClass: normalizeAssetClass(input.assetClass, undefined),
    symbols: normalizeSymbols(input.symbols ?? []),
    enabled: input.enabled !== false,
    config: normalizeWatchlistConfig(input.config),
    createdAt,
    updatedAt,
  };
}

function normalizeWatchlistConfig(
  partial?: Partial<WatchlistExecutionConfig>,
  existing?: WatchlistExecutionConfig
): WatchlistExecutionConfig {
  const base = existing ?? DEFAULT_CONFIG;
  const timeframe =
    partial?.timeframe === "1Hour" || partial?.timeframe === "1Day"
      ? partial.timeframe
      : base.timeframe;

  const buyThreshold = normalizeThreshold(
    partial?.buyThreshold,
    base.buyThreshold ?? DEFAULT_CONFIG.buyThreshold
  );
  const sellThreshold = normalizeThreshold(
    partial?.sellThreshold,
    base.sellThreshold ?? DEFAULT_CONFIG.sellThreshold
  );

  if (buyThreshold <= sellThreshold) {
    throw new Error("buyThreshold must be greater than sellThreshold");
  }

  const fallbackSignals = base.signals?.length
    ? base.signals
    : DEFAULT_CONFIG.signals;

  return {
    timeframe,
    signals: normalizeSignals(partial?.signals, fallbackSignals),
    buyThreshold,
    sellThreshold,
  };
}

function normalizeSignals(
  raw: unknown,
  fallback: SignalWeight[]
): SignalWeight[] {
  if (!Array.isArray(raw)) {
    return cloneSignals(fallback);
  }

  const out: SignalWeight[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") continue;

    const weightRaw = (candidate as { weight?: unknown }).weight;
    const signalRaw = (candidate as { signal?: unknown }).signal;
    const weight = Number(weightRaw);

    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }

    const signal = normalizeSignalType(signalRaw);
    if (!signal) {
      continue;
    }

    out.push({ signal, weight });
  }

  return out.length > 0 ? out : cloneSignals(fallback);
}

function normalizeSignalType(raw: unknown): SignalType | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string") {
    return null;
  }

  switch (type) {
    case "price_vs_sma": {
      const period = parsePositiveInt((raw as { period?: unknown }).period, 20);
      return { type, period };
    }
    case "rsi": {
      const period = parsePositiveInt((raw as { period?: unknown }).period, 14);
      return { type, period };
    }
    case "volume": {
      const period = parsePositiveInt((raw as { period?: unknown }).period, 20);
      return { type, period };
    }
    case "momentum": {
      const period = parsePositiveInt((raw as { period?: unknown }).period, 10);
      return { type, period };
    }
    case "selloff_pressure": {
      const period = parsePositiveInt((raw as { period?: unknown }).period, 8);
      return { type, period };
    }
    case "bollinger_band": {
      const period = parsePositiveInt((raw as { period?: unknown }).period, 20);
      const stdDev = parsePositiveNumber((raw as { std_dev?: unknown }).std_dev, 2);
      return { type, period, std_dev: stdDev };
    }
    default:
      return null;
  }
}

function normalizeThreshold(raw: unknown, fallback: number): number {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  if (numeric < 0 || numeric > 1) {
    throw new Error("Thresholds must be between 0 and 1");
  }

  return numeric;
}

function normalizeWatchlistName(raw: unknown, existing: string | undefined, userId: string): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof existing === "string" && existing.trim()) return existing.trim();
  const parts = userId.split(":");
  const last = parts[parts.length - 1];
  if (last === "stocks-etf") return "Stocks/ETF";
  if (last === "crypto") return "Crypto";
  return last || "Watchlist";
}

function normalizeAssetClass(raw: unknown, existing: WatchlistAssetClass | undefined): WatchlistAssetClass {
  if (raw === "stocks_etf" || raw === "crypto") return raw;
  if (existing === "stocks_etf" || existing === "crypto") return existing;
  return "stocks_etf";
}

function normalizeUserId(raw: string): string {
  const userId = raw.trim();
  if (!userId) {
    throw new Error("userId is required");
  }
  return userId;
}

function normalizeSymbols(raw: string[]): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const deduped = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const symbol = value.trim().toUpperCase();
    if (!symbol) continue;
    deduped.add(symbol);
  }

  return Array.from(deduped);
}

function cloneWatchlist(watchlist: UserWatchlist): UserWatchlist {
  return {
    ...watchlist,
    symbols: [...watchlist.symbols],
    config: {
      ...watchlist.config,
      signals: cloneSignals(watchlist.config.signals),
    },
  };
}

function cloneSignals(signals: SignalWeight[]): SignalWeight[] {
  return signals.map((signalWeight) => ({
    weight: signalWeight.weight,
    signal: { ...signalWeight.signal },
  }));
}

function countWatchedSymbols(): number {
  const symbols = new Set<string>();
  for (const watchlist of watchlists.values()) {
    if (!watchlist.enabled) continue;
    for (const symbol of watchlist.symbols) {
      symbols.add(symbol);
    }
  }
  return symbols.size;
}

function asIsoTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

async function persistWatchlists(): Promise<void> {
  const all = Array.from(watchlists.values()).map(cloneWatchlist);

  if (all.length === 0) {
    persistChain = persistChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await unlink(WATCHLIST_STATE_FILE);
        } catch {
          // File may not exist.
        }
      });
    return;
  }

  const payload: PersistedWatchlistState = {
    watchlists: all,
  };

  persistChain = persistChain
    .catch(() => undefined)
    .then(async () => {
      await writeFile(WATCHLIST_STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
    });

  await persistChain;
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.round(numeric);
}

function parsePositiveNumber(raw: unknown, fallback: number): number {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}
