import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { ApiHttpError, fetchAlpacaAccountSnapshot, fetchMarketBars } from "./core";
import { compositeScore, scoreRationale, SignalWeight, SignalType, Bar } from "./botSignals";
import { BOT_TUNING, BOT_TUNING_PROFILES, BotTuningProfileKey } from "./botTuning";

const STATE_FILE = new URL("./bot-state.json", import.meta.url).pathname;

const POLL_INTERVALS: Record<BotConfig["timeframe"], number> = {
  "1Hour": 5 * 60 * 1000,   // check every 5 min — catches new bar within 5 min of close
  "1Day":  30 * 60 * 1000,  // check every 30 min — daily bar only closes once per day
};

const ALPACA_TRADING_BASE_URL = normalizeUrl(
  process.env.ALPACA_TRADING_BASE_URL ??
    process.env.APCA_API_BASE_URL ??
    "https://paper-api.alpaca.markets/v2"
);
const ALPACA_API_KEY_ID = (
  process.env.APCA_API_KEY_ID ?? process.env.ALPACA_API_KEY_ID ?? ""
).trim();
const ALPACA_API_SECRET_KEY = (
  process.env.APCA_API_SECRET_KEY ?? process.env.ALPACA_API_SECRET_KEY ?? ""
).trim();
const DAY_MS = 86_400_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BotStartRequest {
  label?: string;
  symbol: string;
  profile?: BotTuningProfileKey;
  startDate?: string;
  durationDays?: number;
  allocationMode?: "fixed_usd" | "pct_of_cash";
  allocationFixed?: number;
  allocationPct?: number;
}

export interface BotConfig {
  label: string;
  symbol: string;
  profile: BotTuningProfileKey;
  timeframe: "1Day" | "1Hour";
  signals: SignalWeight[];
  objective: "scale_in" | "selloff";
  startDate: string;
  durationDays: number;
  allocationMode: "fixed_usd" | "pct_of_cash";
  allocationFixed: number;
  allocationPct: number;
  buyThreshold: number;
  sellThreshold: number;
  crashDetection?: CrashDetectionConfig;
}

export interface CrashDetectionConfig {
  enabled: boolean;
  threshold: number;
  signals: SignalWeight[];
}

export interface BotPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  costBasis: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlpc: number | null;
}

export interface BotTrade {
  id: string;
  date: string;
  side: "buy" | "sell";
  price: number;
  qty: number | null;
  notional: number | null;
  signalScore: number;
  rationale: string;
  orderId: string;
  status: "submitted" | "error";
  errorMsg?: string;
}

export interface BotStatus {
  id: string;
  running: boolean;
  config: BotConfig;
  position: BotPosition | null;
  trades: BotTrade[];
  lastSignalScore: number | null;
  lastSignalRationale: string | null;
  lastCrashScore: number | null;
  lastCrashRationale: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  availableCash: number | null;
}

interface BotInstance extends BotStatus {
  lastActionBarTsBySide: {
    buy: string | null;
    sell: string | null;
  };
  timer: ReturnType<typeof setInterval> | null;
}

interface PersistedBot {
  id: string;
  config: BotConfig;
  trades: BotTrade[];
}

// ── State ─────────────────────────────────────────────────────────────────────

const bots = new Map<string, BotInstance>();

// ── Public API ────────────────────────────────────────────────────────────────

export function startBot(cfg: BotStartRequest, existingId?: string): string {
  const normalizedCfg = normalizeBotConfig(cfg);
  const id = existingId ?? randomUUID();

  // Stop existing instance with this id if any
  const existing = bots.get(id);
  if (existing?.timer) clearInterval(existing.timer);

  const instance: BotInstance = {
    id,
    running: true,
    config: normalizedCfg,
    position: existing?.position ?? null,
    trades: existing?.trades ?? [],
    lastSignalScore: existing?.lastSignalScore ?? null,
    lastSignalRationale: existing?.lastSignalRationale ?? null,
    lastCrashScore: existing?.lastCrashScore ?? null,
    lastCrashRationale: existing?.lastCrashRationale ?? null,
    lastTickAt: existing?.lastTickAt ?? null,
    lastError: null,
    availableCash: existing?.availableCash ?? null,
    lastActionBarTsBySide:
      existing?.lastActionBarTsBySide ?? deriveLastActionBarTsBySide(existing?.trades ?? []),
    timer: null,
  };

  bots.set(id, instance);
  instance.timer = setInterval(() => void tick(id), POLL_INTERVALS[normalizedCfg.timeframe]);
  void tick(id);
  void persistAllBots();
  console.log(
    `[bot:${id.slice(0, 8)}] started — ${normalizedCfg.symbol} ${normalizedCfg.timeframe} "${normalizedCfg.label}"`
  );
  return id;
}

export function stopBot(id: string): void {
  const instance = bots.get(id);
  if (!instance) return;
  if (instance.timer) clearInterval(instance.timer);
  instance.timer = null;
  instance.running = false;
  // Stopped deliberately — remove from persistence so it won't auto-restart
  void removePersistedBot(id);
  console.log(`[bot:${id.slice(0, 8)}] stopped`);
}

export function removeBot(id: string): void {
  stopBot(id);
  bots.delete(id);
  console.log(`[bot:${id.slice(0, 8)}] removed`);
}

export function getBotList(): BotStatus[] {
  return Array.from(bots.values()).map(toStatus);
}

export function getBotStatus(id: string): BotStatus | null {
  const instance = bots.get(id);
  return instance ? toStatus(instance) : null;
}

export async function loadPersistedState(): Promise<void> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const saved = JSON.parse(raw) as PersistedBot[];
    if (!Array.isArray(saved)) return;
    for (const entry of saved) {
      if (!entry.id || !entry.config?.symbol || !Array.isArray(entry.config?.signals)) continue;
      // Restore trades before starting so startBot picks them up
      const placeholder: BotInstance = {
        id: entry.id,
        running: false,
        config: normalizeBotConfig(entry.config),
        position: null,
        trades: Array.isArray(entry.trades) ? entry.trades : [],
        lastSignalScore: null,
        lastSignalRationale: null,
        lastCrashScore: null,
        lastCrashRationale: null,
        lastTickAt: null,
        lastError: null,
        availableCash: null,
        lastActionBarTsBySide: deriveLastActionBarTsBySide(entry.trades ?? []),
        timer: null,
      };
      bots.set(entry.id, placeholder);
      startBot(normalizeBotConfig(entry.config), entry.id);
      console.log(`[bot:${entry.id.slice(0, 8)}] restored "${entry.config.label}" (${entry.trades.length} trades)`);
    }
  } catch {
    // No saved state — start fresh
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persistAllBots(): Promise<void> {
  const running = Array.from(bots.values()).filter((b) => b.running);
  if (running.length === 0) {
    await clearAllPersistedBots();
    return;
  }
  const payload: PersistedBot[] = running.map((b) => ({
    id: b.id,
    config: b.config,
    trades: b.trades,
  }));
  try {
    await writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    console.error("[bot] failed to persist state:", err);
  }
}

async function removePersistedBot(id: string): Promise<void> {
  // Persist the remaining running bots (excluding the stopped one)
  const stillRunning = Array.from(bots.values()).filter((b) => b.running && b.id !== id);
  if (stillRunning.length === 0) {
    await clearAllPersistedBots();
    return;
  }
  const payload: PersistedBot[] = stillRunning.map((b) => ({
    id: b.id,
    config: b.config,
    trades: b.trades,
  }));
  try {
    await writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    console.error("[bot] failed to update persisted state:", err);
  }
}

async function clearAllPersistedBots(): Promise<void> {
  try {
    await unlink(STATE_FILE);
  } catch {
    // file may not exist
  }
}

// ── Tick ──────────────────────────────────────────────────────────────────────

async function tick(id: string): Promise<void> {
  const instance = bots.get(id);
  if (!instance || !instance.running) return;
  const cfg = instance.config;

  try {
    const nowIso = new Date().toISOString();
    const phase = resolveCampaignPhase(cfg.startDate, cfg.durationDays, Date.now());
    instance.lastTickAt = nowIso;
    instance.lastError = null;

    if (phase !== "active") {
      const endDate = addDaysIso(cfg.startDate, cfg.durationDays - 1);
      instance.lastSignalScore = null;
      instance.lastSignalRationale =
        phase === "pending"
          ? `Campaign pending. Starts ${cfg.startDate} (duration ${cfg.durationDays}d, ends ${endDate}).`
          : `Campaign completed on ${endDate}.`;
      instance.lastCrashScore = null;
      instance.lastCrashRationale = null;
      return;
    }

    const range = cfg.timeframe === "1Hour" ? null : "2y";
    const { bars: rawBars } = await fetchMarketBars({
      symbol: cfg.symbol,
      range,
      timeframe: cfg.timeframe,
    });

    if (rawBars.length < 30) {
      instance.lastError = "Insufficient bar history for signal computation";
      return;
    }

    const bars: Bar[] = rawBars.map((b) => ({
      t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0,
    }));

    const lastIdx = bars.length - 1;
    const tunedSignals = tuneSignalWeightsByHistory(cfg.signals, bars);
    const score = compositeScore(tunedSignals, bars, lastIdx);
    const rationale = scoreRationale(tunedSignals, bars, lastIdx, false);
    const cadenceDays = deriveCadenceDays(cfg.durationDays);
    const currentBarTs = bars[lastIdx].t;
    instance.lastSignalScore = score;
    instance.lastSignalRationale = rationale;

    let crashDetected = false;
    if (cfg.crashDetection?.enabled) {
      const tunedCrashSignals = tuneSignalWeightsByHistory(cfg.crashDetection.signals, bars);
      const crashScore = compositeScore(tunedCrashSignals, bars, lastIdx);
      const crashRationale = scoreRationale(tunedCrashSignals, bars, lastIdx, false);
      instance.lastCrashScore = crashScore;
      instance.lastCrashRationale = crashRationale;
      crashDetected = crashScore >= cfg.crashDetection.threshold;
    } else {
      instance.lastCrashScore = null;
      instance.lastCrashRationale = null;
    }

    console.log(`[bot:${id.slice(0, 8)}] ${cfg.symbol} ${cfg.timeframe} score=${score.toFixed(3)}`);

    await syncPosition(instance);

    const snapshot = await fetchAlpacaAccountSnapshot();
    instance.availableCash = snapshot.account.cash;

    if (
      cfg.objective === "scale_in" &&
      score >= cfg.buyThreshold &&
      shouldPlaceTrade(instance, "buy", currentBarTs, cadenceDays)
    ) {
      const amount = resolveAllocationAmount(cfg, instance.availableCash);
      if (amount < 1) {
        instance.lastError = `Allocation too small: $${amount.toFixed(2)}`;
        return;
      }
      await placeBuyOrder(instance, amount, score, rationale, bars[lastIdx].c, currentBarTs);
      return;
    }

    if (
      cfg.objective === "selloff" &&
      instance.position &&
      instance.position.qty > 0 &&
      shouldPlaceTrade(instance, "sell", currentBarTs, cadenceDays)
    ) {
      if (crashDetected) {
        await placeSellOrder(
          instance,
          instance.position.qty,
          score,
          `Crash selloff trigger (${Math.round((instance.lastCrashScore ?? 0) * 100)}%): ${instance.lastCrashRationale ?? rationale}`,
          bars[lastIdx].c,
          currentBarTs
        );
        return;
      }
      if (score <= cfg.sellThreshold) {
        await placeSellOrder(instance, instance.position.qty, score, rationale, bars[lastIdx].c, currentBarTs);
      }
    }
  } catch (err) {
    instance.lastError = err instanceof Error ? err.message : String(err);
    console.error(`[bot:${id.slice(0, 8)}] tick error: ${instance.lastError}`);
  }
}

// ── Order placement ───────────────────────────────────────────────────────────

async function placeBuyOrder(
  instance: BotInstance,
  notional: number,
  signalScore: number,
  rationale: string,
  currentPrice: number,
  barTs: string
): Promise<void> {
  const body = {
    symbol: normalizeAlpacaCryptoSymbol(instance.config.symbol),
    notional: notional.toFixed(2),
    side: "buy",
    type: "market",
    time_in_force: "gtc",
  };
  const result = await submitAlpacaOrder(body);
  instance.trades.unshift({
    id: randomUUID(),
    date: new Date().toISOString(),
    side: "buy",
    price: currentPrice,
    qty: null,
    notional,
    signalScore,
    rationale,
    orderId: result.id ?? "unknown",
    status: result.error ? "error" : "submitted",
    errorMsg: result.error,
  });
  instance.lastActionBarTsBySide.buy = barTs;
  void persistAllBots();
  console.log(`[bot:${instance.id.slice(0, 8)}] buy $${notional.toFixed(2)} ${instance.config.symbol}`);
}

async function placeSellOrder(
  instance: BotInstance,
  qty: number,
  signalScore: number,
  rationale: string,
  currentPrice: number,
  barTs: string
): Promise<void> {
  const body = {
    symbol: normalizeAlpacaCryptoSymbol(instance.config.symbol),
    qty: qty.toFixed(8),
    side: "sell",
    type: "market",
    time_in_force: "gtc",
  };
  const result = await submitAlpacaOrder(body);
  instance.trades.unshift({
    id: randomUUID(),
    date: new Date().toISOString(),
    side: "sell",
    price: currentPrice,
    qty,
    notional: null,
    signalScore,
    rationale,
    orderId: result.id ?? "unknown",
    status: result.error ? "error" : "submitted",
    errorMsg: result.error,
  });
  instance.lastActionBarTsBySide.sell = barTs;
  void persistAllBots();
  console.log(`[bot:${instance.id.slice(0, 8)}] sell ${qty} ${instance.config.symbol}`);
}

interface AlpacaOrderResult { id?: string; error?: string; }

async function submitAlpacaOrder(body: Record<string, string>): Promise<AlpacaOrderResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${ALPACA_TRADING_BASE_URL}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "APCA-API-KEY-ID": ALPACA_API_KEY_ID,
        "APCA-API-SECRET-KEY": ALPACA_API_SECRET_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const msg = typeof payload.message === "string"
        ? payload.message
        : `Alpaca order rejected (${res.status})`;
      return { error: msg };
    }
    return { id: typeof payload.id === "string" ? payload.id : undefined };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function syncPosition(instance: BotInstance): Promise<void> {
  try {
    const snapshot = await fetchAlpacaAccountSnapshot();
    const alpacaSymbol = normalizeAlpacaCryptoSymbol(instance.config.symbol);
    const pos = snapshot.positions.find(
      (p) => normalizeAlpacaCryptoSymbol(p.symbol) === alpacaSymbol
    );
    instance.position = pos && pos.qty > 0
      ? {
          symbol: instance.config.symbol,
          qty: pos.qty,
          avgEntryPrice: pos.avgEntryPrice,
          costBasis: pos.costBasis,
          marketValue: pos.marketValue,
          unrealizedPl: pos.unrealizedPl,
          unrealizedPlpc: pos.unrealizedPlpc,
        }
      : null;
  } catch {
    // Non-fatal: keep last known position
  }
}

function resolveAllocationAmount(cfg: BotConfig, cash: number): number {
  if (cfg.allocationMode === "pct_of_cash") {
    return Math.max(0, (cfg.allocationPct / 100) * cash);
  }
  return Math.max(0, cfg.allocationFixed);
}

function normalizeBotConfig(input: BotStartRequest | BotConfig): BotConfig {
  const symbol = normalizeAlpacaCryptoSymbol(input.symbol);
  const profileKey =
    input.profile && input.profile in BOT_TUNING_PROFILES
      ? input.profile
      : BOT_TUNING.defaults.profile;
  const profile = BOT_TUNING_PROFILES[profileKey];
  const timeframe = profile.timeframe;
  const objective = profile.objective;
  const durationDays = Math.max(1, Math.round(input.durationDays || profile.durationDays));
  const startDate = normalizeIsoDate(input.startDate) ?? new Date().toISOString().slice(0, 10);
  const allocationMode = input.allocationMode === "fixed_usd" ? "fixed_usd" : "pct_of_cash";
  const allocationFixed =
    typeof input.allocationFixed === "number" && Number.isFinite(input.allocationFixed)
      ? Math.max(0, input.allocationFixed)
      : 0;
  const allocationPct =
    typeof input.allocationPct === "number" && Number.isFinite(input.allocationPct)
      ? clamp(input.allocationPct, 0, 100)
      : 0;
  const buyThreshold = normalizeThreshold(profile.buyThreshold, BOT_TUNING.defaults.buyThreshold);
  const sellThreshold = normalizeThreshold(profile.sellThreshold, BOT_TUNING.defaults.sellThreshold);
  const signals = normalizeSignalWeights(profile.signals);

  const crashDetection = profile.crashDetection?.enabled
      ? {
          enabled: true,
          threshold: normalizeThreshold(
            profile.crashDetection?.threshold,
            BOT_TUNING.crashDetection.defaultThreshold
          ),
          signals: normalizeSignalWeights(
            profile.crashDetection?.signals?.length ? profile.crashDetection.signals : profile.signals
          ),
        }
      : undefined;

  return {
    ...input,
    label: (input.label ?? "").trim() || profile.label,
    symbol,
    profile: profile.key,
    timeframe,
    signals,
    objective,
    startDate,
    durationDays,
    allocationMode,
    allocationFixed,
    allocationPct,
    buyThreshold,
    sellThreshold,
    crashDetection,
  };
}

function normalizeSignalWeights(signals: SignalWeight[]): SignalWeight[] {
  if (!Array.isArray(signals) || signals.length === 0) {
    return [];
  }
  const positive = signals
    .filter((sw) => sw && sw.signal && Number.isFinite(sw.weight) && sw.weight > 0)
    .map((sw) => ({
      signal: cloneSignal(sw.signal),
      weight: sw.weight,
    }));
  if (positive.length === 0) {
    return [];
  }
  const total = positive.reduce((sum, sw) => sum + sw.weight, 0);
  return positive.map((sw) => ({ signal: sw.signal, weight: sw.weight / total }));
}

function cloneSignal(signal: SignalType): SignalType {
  if (signal.type === "bollinger_band") {
    return {
      type: "bollinger_band",
      period: Math.max(2, Math.round(signal.period)),
      std_dev: Math.max(0.1, signal.std_dev),
    };
  }
  return {
    ...signal,
    period: Math.max(2, Math.round(signal.period)),
  };
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(value!, 0, 1);
}

function resolveCampaignPhase(
  startDate: string,
  durationDays: number,
  nowMs: number
): "pending" | "active" | "expired" {
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(startTs)) return "pending";
  const endExclusiveTs = startTs + Math.max(1, durationDays) * DAY_MS;
  if (nowMs < startTs) return "pending";
  if (nowMs >= endExclusiveTs) return "expired";
  return "active";
}

function deriveCadenceDays(durationDays: number): number {
  const raw = Math.round(Math.max(1, durationDays) / BOT_TUNING.cadence.durationDivisor);
  return clampInt(raw, BOT_TUNING.cadence.minDays, BOT_TUNING.cadence.maxDays);
}

function deriveLastActionBarTsBySide(trades: BotTrade[]): { buy: string | null; sell: string | null } {
  let buy: string | null = null;
  let sell: string | null = null;
  for (const trade of trades) {
    if (!trade?.date) continue;
    if (trade.side === "buy" && !buy) buy = trade.date;
    if (trade.side === "sell" && !sell) sell = trade.date;
    if (buy && sell) break;
  }
  return { buy, sell };
}

function shouldPlaceTrade(
  instance: BotInstance,
  side: "buy" | "sell",
  currentBarTs: string,
  cadenceDays: number
): boolean {
  const last = instance.lastActionBarTsBySide[side];
  if (!last) return true;
  const lastTs = Date.parse(last);
  const nextTs = Date.parse(currentBarTs);
  if (!Number.isFinite(lastTs) || !Number.isFinite(nextTs)) return true;
  return nextTs - lastTs >= cadenceDays * DAY_MS;
}

function tuneSignalWeightsByHistory(signals: SignalWeight[], bars: Bar[]): SignalWeight[] {
  const normalized = normalizeSignalWeights(signals);
  if (normalized.length === 0) {
    return normalized;
  }

  const lookbackBars = BOT_TUNING.historyWeighting.lookbackBars;
  const startIdx = Math.max(0, bars.length - lookbackBars);
  const sampleCount = Math.max(0, bars.length - startIdx - 1);
  if (sampleCount < BOT_TUNING.historyWeighting.minSamples) {
    return normalized;
  }

  const adjusted = normalized.map((sw) => {
    const edge = computeSignalEdge(sw.signal, bars, startIdx, bars.length - 2);
    const multiplier = clamp(
      1 + edge * BOT_TUNING.historyWeighting.correlationScale,
      BOT_TUNING.historyWeighting.minMultiplier,
      BOT_TUNING.historyWeighting.maxMultiplier
    );
    return {
      signal: cloneSignal(sw.signal),
      baseWeight: sw.weight,
      tunedWeight: sw.weight * multiplier,
    };
  });

  const tunedSum = adjusted.reduce((sum, row) => sum + row.tunedWeight, 0);
  if (tunedSum <= 0) {
    return normalized;
  }

  const blend = BOT_TUNING.historyWeighting.blend;
  const blended = adjusted.map((row) => {
    const tunedNormalized = row.tunedWeight / tunedSum;
    return {
      signal: row.signal,
      weight: (1 - blend) * row.baseWeight + blend * tunedNormalized,
    };
  });

  const finalSum = blended.reduce((sum, row) => sum + row.weight, 0);
  if (finalSum <= 0) return normalized;
  return blended.map((row) => ({
    signal: row.signal,
    weight: row.weight / finalSum,
  }));
}

function computeSignalEdge(
  signal: SignalType,
  bars: Bar[],
  startIdx: number,
  endIdx: number
): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const now = bars[i];
    const next = bars[i + 1];
    if (!now || !next || now.c <= 0) continue;
    const x = compositeScore([{ signal, weight: 1 }], bars, i);
    const y = (next.c - now.c) / now.c;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < BOT_TUNING.historyWeighting.minSamples) {
    return 0;
  }
  return Math.max(0, pearson(xs, ys));
}

function pearson(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
  }
  const numerator = n * sumXY - sumX * sumY;
  const denomX = n * sumXX - sumX * sumX;
  const denomY = n * sumYY - sumY * sumY;
  const denominator = Math.sqrt(Math.max(denomX, 0) * Math.max(denomY, 0));
  if (denominator < 1e-12) return 0;
  return numerator / denominator;
}

function normalizeIsoDate(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ts = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString().slice(0, 10);
}

function addDaysIso(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map((v) => Number(v));
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return dt.toISOString().slice(0, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeAlpacaCryptoSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (upper.includes("/")) return upper;
  const quotes = ["USDT", "USDC", "USD", "BTC", "ETH"];
  for (const q of quotes) {
    if (upper.endsWith(q) && upper.length > q.length) {
      return `${upper.slice(0, -q.length)}/${q}`;
    }
  }
  return upper;
}

function normalizeUrl(raw: string): string {
  const cleaned = raw.trim().replace(/\/+$/, "");
  if (!cleaned) return "https://paper-api.alpaca.markets/v2";
  if (cleaned.endsWith("/v2")) return cleaned;
  return `${cleaned}/v2`;
}

function toStatus(instance: BotInstance): BotStatus {
  const { timer: _timer, ...status } = instance;
  return { ...status, trades: [...status.trades] };
}

// Suppress unused import warning
void (ApiHttpError as unknown);
