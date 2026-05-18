import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { ALLOW_LIVE_CRYPTO_TRADING } from "./config.ts";
import { fetchAlpacaAccountSnapshot, fetchMarketBars } from "./core.ts";
import { Bar, SignalWeight, SignalType, compositeScore, scoreRationale } from "./botSignals.ts";
import { BOT_TUNING_PROFILES } from "./botTuning.ts";

const STATE_FILE = new URL("./live-crypto-bot-state.json", import.meta.url).pathname;
const MIN_SIGNAL_BARS = 40;
const PAPER_TRADING_BASE_URL = "https://paper-api.alpaca.markets/v2";
const LIVE_TRADING_BASE_URL = "https://api.alpaca.markets/v2";
const ALPACA_API_KEY_ID = (
  process.env.APCA_API_KEY_ID ?? process.env.ALPACA_API_KEY_ID ?? ""
).trim();
const ALPACA_API_SECRET_KEY = (
  process.env.APCA_API_SECRET_KEY ?? process.env.ALPACA_API_SECRET_KEY ?? ""
).trim();
const MAX_RECENT_TRADES = parsePositiveInt(process.env.LIVE_CRYPTO_TRADE_HISTORY_LIMIT, 300);
const MAX_CONSECUTIVE_ERRORS = parsePositiveInt(
  process.env.LIVE_CRYPTO_MAX_CONSECUTIVE_ERRORS,
  5
);
const POLL_INTERVALS: Record<LiveCryptoBotConfig["timeframe"], number> = {
  "1Hour": 5 * 60 * 1000,
  "1Day": 30 * 60 * 1000,
};
const MINUTE_MS = 60_000;

const DEFAULT_SIGNALS: SignalWeight[] = [
  { signal: { type: "price_vs_sma", period: 20 }, weight: 0.35 },
  { signal: { type: "rsi", period: 14 }, weight: 0.3 },
  { signal: { type: "bollinger_band", period: 20, std_dev: 2 }, weight: 0.2 },
  { signal: { type: "momentum", period: 10 }, weight: 0.15 },
];
const FALLBACK_SELLOFF_SIGNALS: SignalWeight[] = [
  { signal: { type: "selloff_pressure", period: 8 }, weight: 0.55 },
  { signal: { type: "volume", period: 20 }, weight: 0.22 },
  { signal: { type: "rsi", period: 7 }, weight: 0.1 },
  { signal: { type: "bollinger_band", period: 20, std_dev: 2.5 }, weight: 0.13 },
];
const DEFAULT_SELLOFF_SIGNALS: SignalWeight[] = (
  BOT_TUNING_PROFILES.crash_selloff_detected.crashDetection?.signals?.length
    ? BOT_TUNING_PROFILES.crash_selloff_detected.crashDetection.signals
    : FALLBACK_SELLOFF_SIGNALS
).map((row) => ({ signal: row.signal, weight: row.weight }));
const DEFAULT_SELLOFF_START_THRESHOLD = clamp(
  BOT_TUNING_PROFILES.crash_selloff_detected.crashDetection?.threshold ?? 0.7,
  0.05,
  0.99
);
const DEFAULT_SELLOFF_END_THRESHOLD = clamp(DEFAULT_SELLOFF_START_THRESHOLD - 0.18, 0.05, 0.95);
const DEFAULT_DIRECTION_MODE: LiveCryptoDirectionMode = "long_only";
const DEFAULT_TREND_LOOKBACK_DAYS = 10;
const DEFAULT_TREND_BAND_PCT = 0.015;

export type LiveCryptoDirectionMode = "long_only" | "trend_short_selloff";
type TrendDirection = "up" | "down" | "neutral";
type TradeIntent = "open_long" | "close_long" | "open_short" | "close_short";

export interface LiveCryptoBotStartRequest {
  label?: string;
  symbol: string;
  timeframe?: "1Hour" | "1Day";
  mode?: "dry_run" | "paper" | "live";
  allocationUsd?: number;
  buyThreshold?: number;
  sellThreshold?: number;
  maxPositionUsd?: number;
  maxDailyOrders?: number;
  cooldownMinutes?: number;
  signals?: SignalWeight[];
  directionMode?: LiveCryptoDirectionMode;
  trendLookbackDays?: number;
  trendBandPct?: number;
  selloffStartThreshold?: number;
  selloffEndThreshold?: number;
  selloffSignals?: SignalWeight[];
}

export interface BackendManagedPaperBotInput {
  label?: string;
  symbol: string;
  timeframe?: "1Hour" | "1Day";
  allocationUsd?: number;
  buyThreshold?: number;
  sellThreshold?: number;
  maxPositionUsd?: number;
  maxDailyOrders?: number;
  cooldownMinutes?: number;
  signals?: SignalWeight[];
  directionMode?: LiveCryptoDirectionMode;
  trendLookbackDays?: number;
  trendBandPct?: number;
  selloffStartThreshold?: number;
  selloffEndThreshold?: number;
  selloffSignals?: SignalWeight[];
}

export interface LiveCryptoBotConfig {
  label: string;
  symbol: string;
  timeframe: "1Hour" | "1Day";
  mode: "dry_run" | "paper" | "live";
  allocationUsd: number;
  buyThreshold: number;
  sellThreshold: number;
  maxPositionUsd: number;
  maxDailyOrders: number;
  cooldownMinutes: number;
  signals: SignalWeight[];
  directionMode: LiveCryptoDirectionMode;
  trendLookbackDays: number;
  trendBandPct: number;
  selloffStartThreshold: number;
  selloffEndThreshold: number;
  selloffSignals: SignalWeight[];
}

export interface LiveCryptoPosition {
  symbol: string;
  side: "long" | "short";
  qty: number;
  avgEntryPrice: number;
  costBasis: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlpc: number | null;
}

export interface LiveCryptoTrade {
  id: string;
  date: string;
  mode: "dry_run" | "paper" | "live";
  side: "buy" | "sell";
  intent?: TradeIntent;
  trendDirection?: TrendDirection;
  selloffScore?: number | null;
  status: "submitted" | "simulated" | "error";
  price: number;
  qty: number | null;
  notional: number | null;
  signalScore: number;
  rationale: string;
  orderId: string | null;
  errorMsg?: string;
}

export interface LiveCryptoBotStatus {
  id: string;
  running: boolean;
  config: LiveCryptoBotConfig;
  position: LiveCryptoPosition | null;
  trades: LiveCryptoTrade[];
  availableCash: number | null;
  availableBuyingPower: number | null;
  lastSignalScore: number | null;
  lastSignalRationale: string | null;
  lastTrendDirection: TrendDirection | null;
  lastTrendReturn: number | null;
  lastSelloffScore: number | null;
  selloffActive: boolean;
  lastDecision: string | null;
  lastRiskBlock: string | null;
  lastTickAt: string | null;
  lastOrderAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
}

interface LiveCryptoBotInstance extends LiveCryptoBotStatus {
  timer: ReturnType<typeof setInterval> | null;
  simulatedQty: number;
  simulatedCostBasis: number;
  simulatedShortQty: number;
  simulatedShortEntryNotional: number;
  lastActionBarTsBySide: {
    buy: string | null;
    sell: string | null;
  };
}

interface PersistedLiveCryptoBot {
  id: string;
  config: LiveCryptoBotConfig;
  trades: LiveCryptoTrade[];
  simulatedQty: number;
  simulatedCostBasis: number;
  simulatedShortQty?: number;
  simulatedShortEntryNotional?: number;
}

interface RiskCheckInput {
  intent: TradeIntent;
  side: "buy" | "sell";
  notional: number;
  qty: number;
  currentPrice: number;
  currentBarTs: string;
}

const bots = new Map<string, LiveCryptoBotInstance>();
const backendManagedBotIds = new Set<string>();
let persistChain: Promise<void> = Promise.resolve();

export function startLiveCryptoBot(cfg: LiveCryptoBotStartRequest, existingId?: string): string {
  const normalizedCfg = normalizeLiveCryptoConfig(cfg);
  const id = existingId ?? randomUUID();
  const existing = bots.get(id);

  if (existing?.timer) {
    clearInterval(existing.timer);
  }

  if (normalizedCfg.mode !== "dry_run" && !hasAlpacaCredentials()) {
    throw new Error(
      "Missing Alpaca API credentials. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY before starting paper/live mode."
    );
  }

  if (normalizedCfg.mode === "live" && !ALLOW_LIVE_CRYPTO_TRADING) {
    throw new Error(
      "Live mode is disabled. Set ALLOW_LIVE_CRYPTO_TRADING=true to allow live order submission."
    );
  }

  const instance: LiveCryptoBotInstance = {
    id,
    running: true,
    config: normalizedCfg,
    position: existing?.position ?? null,
    trades: existing?.trades ?? [],
    availableCash: existing?.availableCash ?? null,
    availableBuyingPower: existing?.availableBuyingPower ?? null,
    lastSignalScore: existing?.lastSignalScore ?? null,
    lastSignalRationale: existing?.lastSignalRationale ?? null,
    lastTrendDirection: existing?.lastTrendDirection ?? null,
    lastTrendReturn: existing?.lastTrendReturn ?? null,
    lastSelloffScore: existing?.lastSelloffScore ?? null,
    selloffActive: existing?.selloffActive ?? false,
    lastDecision: existing?.lastDecision ?? null,
    lastRiskBlock: existing?.lastRiskBlock ?? null,
    lastTickAt: existing?.lastTickAt ?? null,
    lastOrderAt: existing?.lastOrderAt ?? null,
    lastError: null,
    consecutiveErrors: existing?.consecutiveErrors ?? 0,
    simulatedQty: existing?.simulatedQty ?? 0,
    simulatedCostBasis: existing?.simulatedCostBasis ?? 0,
    simulatedShortQty: existing?.simulatedShortQty ?? 0,
    simulatedShortEntryNotional: existing?.simulatedShortEntryNotional ?? 0,
    lastActionBarTsBySide:
      existing?.lastActionBarTsBySide ??
      deriveLastActionBarTsBySide(existing?.trades ?? []),
    timer: null,
  };

  bots.set(id, instance);
  instance.timer = setInterval(() => void tickLiveCryptoBot(id), POLL_INTERVALS[normalizedCfg.timeframe]);
  void tickLiveCryptoBot(id);
  void persistAllLiveCryptoBots();
  console.log(
    `[live-crypto:${id.slice(0, 8)}] started — ${normalizedCfg.symbol} ${normalizedCfg.timeframe} ` +
      `(${normalizedCfg.mode}, ${normalizedCfg.directionMode})`
  );
  return id;
}

export function stopLiveCryptoBot(id: string): void {
  const instance = bots.get(id);
  if (!instance) return;
  if (instance.timer) clearInterval(instance.timer);
  instance.timer = null;
  instance.running = false;
  void removePersistedLiveCryptoBot(id);
  console.log(`[live-crypto:${id.slice(0, 8)}] stopped`);
}

export function removeLiveCryptoBot(id: string): void {
  stopLiveCryptoBot(id);
  bots.delete(id);
  console.log(`[live-crypto:${id.slice(0, 8)}] removed`);
}

export function getLiveCryptoBotList(): LiveCryptoBotStatus[] {
  return Array.from(bots.values()).map(toStatus);
}

export function getLiveCryptoBotStatus(id: string): LiveCryptoBotStatus | null {
  const instance = bots.get(id);
  return instance ? toStatus(instance) : null;
}

export function startBackendManagedPaperBots(
  inputs: BackendManagedPaperBotInput[]
): string[] {
  if (!Array.isArray(inputs)) {
    throw new Error("Backend managed paper bot config must be an array.");
  }

  const desiredIds = new Set<string>();
  for (const input of inputs) {
    const normalizedSymbol = normalizeAlpacaCryptoSymbol(input.symbol);
    const timeframe = input.timeframe === "1Day" ? "1Day" : "1Hour";
    const botId = backendManagedBotId(normalizedSymbol, timeframe);
    desiredIds.add(botId);
    startLiveCryptoBot(
      {
        ...input,
        symbol: normalizedSymbol,
        timeframe,
        mode: "paper",
        label: (input.label ?? "").trim() || `Backend Paper ${normalizedSymbol}`,
      },
      botId
    );
    backendManagedBotIds.add(botId);
  }

  for (const existingId of Array.from(backendManagedBotIds)) {
    if (desiredIds.has(existingId)) continue;
    removeLiveCryptoBot(existingId);
    backendManagedBotIds.delete(existingId);
  }

  return Array.from(desiredIds);
}

export function getBackendManagedPaperBotList(): LiveCryptoBotStatus[] {
  const statuses: LiveCryptoBotStatus[] = [];
  for (const id of backendManagedBotIds) {
    const status = getLiveCryptoBotStatus(id);
    if (status) statuses.push(status);
  }
  return statuses;
}

export function getBackendManagedPaperBotStatus(id: string): LiveCryptoBotStatus | null {
  if (!backendManagedBotIds.has(id)) return null;
  return getLiveCryptoBotStatus(id);
}

export async function runLiveCryptoTickNow(id: string): Promise<LiveCryptoBotStatus | null> {
  if (!bots.has(id)) return null;
  await tickLiveCryptoBot(id);
  return getLiveCryptoBotStatus(id);
}

export async function loadPersistedLiveCryptoState(): Promise<void> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const saved = JSON.parse(raw) as PersistedLiveCryptoBot[];
    if (!Array.isArray(saved)) return;

    for (const row of saved) {
      try {
        if (!row?.id || !row?.config?.symbol) continue;
        const restoredConfig = normalizeLiveCryptoConfig(row.config);
        const placeholder: LiveCryptoBotInstance = {
          id: row.id,
          running: false,
          config: restoredConfig,
          position: null,
          trades: normalizeTrades(row.trades),
          availableCash: null,
          availableBuyingPower: null,
          lastSignalScore: null,
          lastSignalRationale: null,
          lastTrendDirection: null,
          lastTrendReturn: null,
          lastSelloffScore: null,
          selloffActive: false,
          lastDecision: null,
          lastRiskBlock: null,
          lastTickAt: null,
          lastOrderAt: null,
          lastError: null,
          consecutiveErrors: 0,
          simulatedQty: safeNumber(row.simulatedQty),
          simulatedCostBasis: safeNumber(row.simulatedCostBasis),
          simulatedShortQty: safeNumber(row.simulatedShortQty),
          simulatedShortEntryNotional: safeNumber(row.simulatedShortEntryNotional),
          lastActionBarTsBySide: deriveLastActionBarTsBySide(row.trades ?? []),
          timer: null,
        };
        bots.set(row.id, placeholder);
        startLiveCryptoBot(restoredConfig, row.id);
      } catch (err) {
        console.error("[live-crypto] failed to restore bot:", err);
      }
    }
  } catch {
    // No saved state.
  }
}

async function tickLiveCryptoBot(id: string): Promise<void> {
  const instance = bots.get(id);
  if (!instance || !instance.running) return;

  try {
    const nowIso = new Date().toISOString();
    const cfg = instance.config;
    instance.lastTickAt = nowIso;
    instance.lastError = null;
    instance.lastRiskBlock = null;
    instance.lastDecision = "hold";

    const range = cfg.timeframe === "1Hour" ? null : "2y";
    const { bars: rawBars } = await fetchMarketBars({
      symbol: cfg.symbol,
      range,
      timeframe: cfg.timeframe,
      preferStoredHourlyCryptoBars: false,
    });

    if (rawBars.length < MIN_SIGNAL_BARS) {
      throw new Error(
        `Insufficient bar history (${rawBars.length}) for signal computation`
      );
    }

    const bars: Bar[] = rawBars.map((bar) => ({
      t: bar.t,
      o: bar.o,
      h: bar.h,
      l: bar.l,
      c: bar.c,
      v: bar.v ?? 0,
    }));
    const lastIdx = bars.length - 1;
    const currentPrice = bars[lastIdx].c;
    const currentBarTs = bars[lastIdx].t;
    const score = compositeScore(cfg.signals, bars, lastIdx);
    const selloffScore = compositeScore(cfg.selloffSignals, bars, lastIdx);
    if (selloffScore >= cfg.selloffStartThreshold) {
      instance.selloffActive = true;
    } else if (selloffScore <= cfg.selloffEndThreshold) {
      instance.selloffActive = false;
    }
    const rationale = scoreRationale(cfg.signals, bars, lastIdx, false);
    const trend = computeTrendDirection(
      bars,
      lastIdx,
      cfg.timeframe,
      cfg.trendLookbackDays,
      cfg.trendBandPct
    );
    instance.lastSignalScore = score;
    instance.lastSignalRationale = rationale;
    instance.lastSelloffScore = selloffScore;
    instance.lastTrendDirection = trend.direction;
    instance.lastTrendReturn = trend.returnPct;
    instance.consecutiveErrors = 0;

    await syncPosition(instance, currentPrice);

    if (cfg.directionMode === "trend_short_selloff") {
      const positionSide = instance.position?.side ?? null;
      const positionQty = Math.max(0, instance.position?.qty ?? 0);

      if (
        positionSide === "long" &&
        positionQty > 0 &&
        (trend.direction === "down" || score <= cfg.sellThreshold)
      ) {
        const riskBlock = evaluateRisk(instance, {
          intent: "close_long",
          side: "sell",
          notional: positionQty * currentPrice,
          qty: positionQty,
          currentPrice,
          currentBarTs,
        });
        if (riskBlock) {
          instance.lastRiskBlock = riskBlock;
          instance.lastDecision = `close-long blocked: ${riskBlock}`;
          return;
        }
        const reason =
          trend.direction === "down"
            ? `Trend flipped down (${formatSignedPct(trend.returnPct)} over ${cfg.trendLookbackDays}d).`
            : `Buy score cooled below sell threshold (${score.toFixed(3)} <= ${cfg.sellThreshold.toFixed(3)}).`;
        await placeSellOrder(
          instance,
          "close_long",
          positionQty,
          positionQty * currentPrice,
          score,
          `${rationale} | ${reason}`,
          currentPrice,
          currentBarTs,
          trend.direction,
          selloffScore
        );
        return;
      }

      if (
        positionSide === "short" &&
        positionQty > 0 &&
        (trend.direction === "up" || !instance.selloffActive || score >= cfg.buyThreshold)
      ) {
        const riskBlock = evaluateRisk(instance, {
          intent: "close_short",
          side: "buy",
          notional: positionQty * currentPrice,
          qty: positionQty,
          currentPrice,
          currentBarTs,
        });
        if (riskBlock) {
          instance.lastRiskBlock = riskBlock;
          instance.lastDecision = `cover blocked: ${riskBlock}`;
          return;
        }
        const reason =
          trend.direction === "up"
            ? `Trend flipped up (${formatSignedPct(trend.returnPct)} over ${cfg.trendLookbackDays}d).`
            : !instance.selloffActive
              ? `Selloff stress cooled (${selloffScore.toFixed(3)} <= ${cfg.selloffEndThreshold.toFixed(3)}).`
              : `Buy score recovered above buy threshold (${score.toFixed(3)} >= ${cfg.buyThreshold.toFixed(3)}).`;
        await placeBuyOrder(
          instance,
          "close_short",
          positionQty,
          positionQty * currentPrice,
          score,
          `${rationale} | ${reason}`,
          currentPrice,
          currentBarTs,
          trend.direction,
          selloffScore
        );
        return;
      }

      if (!positionSide || positionQty <= 0) {
        if (trend.direction === "down" && instance.selloffActive) {
          const shortQty = cfg.allocationUsd / Math.max(currentPrice, 1e-9);
          const riskBlock = evaluateRisk(instance, {
            intent: "open_short",
            side: "sell",
            notional: cfg.allocationUsd,
            qty: shortQty,
            currentPrice,
            currentBarTs,
          });
          if (riskBlock) {
            instance.lastRiskBlock = riskBlock;
            instance.lastDecision = `short blocked: ${riskBlock}`;
            return;
          }
          await placeSellOrder(
            instance,
            "open_short",
            shortQty,
            cfg.allocationUsd,
            score,
            `${rationale} | Selloff active (${selloffScore.toFixed(3)} >= ${cfg.selloffStartThreshold.toFixed(3)}) in downtrend (${formatSignedPct(trend.returnPct)} over ${cfg.trendLookbackDays}d).`,
            currentPrice,
            currentBarTs,
            trend.direction,
            selloffScore
          );
          return;
        }

        if (trend.direction === "up" && score >= cfg.buyThreshold) {
          const riskBlock = evaluateRisk(instance, {
            intent: "open_long",
            side: "buy",
            notional: cfg.allocationUsd,
            qty: cfg.allocationUsd / Math.max(currentPrice, 1e-9),
            currentPrice,
            currentBarTs,
          });
          if (riskBlock) {
            instance.lastRiskBlock = riskBlock;
            instance.lastDecision = `buy blocked: ${riskBlock}`;
            return;
          }
          await placeBuyOrder(
            instance,
            "open_long",
            cfg.allocationUsd / Math.max(currentPrice, 1e-9),
            cfg.allocationUsd,
            score,
            `${rationale} | Uptrend confirmed (${formatSignedPct(trend.returnPct)} over ${cfg.trendLookbackDays}d).`,
            currentPrice,
            currentBarTs,
            trend.direction,
            selloffScore
          );
          return;
        }

        instance.lastDecision =
          `hold: trend ${trend.direction} (${formatSignedPct(trend.returnPct)} over ${cfg.trendLookbackDays}d), ` +
          `score ${score.toFixed(3)}, selloff ${selloffScore.toFixed(3)} (${instance.selloffActive ? "active" : "inactive"})`;
        return;
      }

      instance.lastDecision =
        `hold: ${positionSide} position active, trend ${trend.direction} (${formatSignedPct(trend.returnPct)} over ${cfg.trendLookbackDays}d)`;
      return;
    }

    if (score >= cfg.buyThreshold) {
      const riskBlock = evaluateRisk(instance, {
        intent: "open_long",
        side: "buy",
        notional: cfg.allocationUsd,
        qty: cfg.allocationUsd / Math.max(currentPrice, 1e-9),
        currentPrice,
        currentBarTs,
      });
      if (riskBlock) {
        instance.lastRiskBlock = riskBlock;
        instance.lastDecision = `buy blocked: ${riskBlock}`;
        return;
      }
      await placeBuyOrder(
        instance,
        "open_long",
        cfg.allocationUsd / Math.max(currentPrice, 1e-9),
        cfg.allocationUsd,
        score,
        rationale,
        currentPrice,
        currentBarTs,
        trend.direction,
        selloffScore
      );
      return;
    }

    if (score <= cfg.sellThreshold) {
      const sellQty = resolveLongQty(instance);
      if (sellQty <= 0) {
        instance.lastDecision = "sell skipped: no open position";
        return;
      }
      const riskBlock = evaluateRisk(instance, {
        intent: "close_long",
        side: "sell",
        notional: sellQty * currentPrice,
        qty: sellQty,
        currentPrice,
        currentBarTs,
      });
      if (riskBlock) {
        instance.lastRiskBlock = riskBlock;
        instance.lastDecision = `sell blocked: ${riskBlock}`;
        return;
      }
      await placeSellOrder(
        instance,
        "close_long",
        sellQty,
        sellQty * currentPrice,
        score,
        rationale,
        currentPrice,
        currentBarTs,
        trend.direction,
        selloffScore
      );
      return;
    }

    instance.lastDecision = `hold: score ${score.toFixed(3)} in neutral zone`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    instance.lastError = message;
    instance.consecutiveErrors += 1;
    instance.lastDecision = `error: ${message}`;
    console.error(`[live-crypto:${id.slice(0, 8)}] tick error: ${message}`);

    if (instance.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      instance.lastError = `Stopped after ${instance.consecutiveErrors} consecutive errors: ${message}`;
      stopLiveCryptoBot(id);
    }
  }
}

async function placeBuyOrder(
  instance: LiveCryptoBotInstance,
  intent: "open_long" | "close_short",
  qty: number,
  notional: number,
  signalScore: number,
  rationale: string,
  currentPrice: number,
  barTs: string,
  trendDirection: TrendDirection,
  selloffScore: number
): Promise<void> {
  const mode = instance.config.mode;
  if (mode === "dry_run") {
    if (intent === "open_long") {
      const buyQty = notional / Math.max(currentPrice, 1e-9);
      instance.simulatedQty += buyQty;
      instance.simulatedCostBasis += notional;
      appendTrade(instance, {
        id: randomUUID(),
        date: new Date().toISOString(),
        mode,
        side: "buy",
        intent,
        trendDirection,
        selloffScore,
        status: "simulated",
        price: currentPrice,
        qty: buyQty,
        notional,
        signalScore,
        rationale,
        orderId: "dry-run",
      });
      instance.lastDecision = `buy simulated: $${notional.toFixed(2)}`;
    } else {
      const coverQty = Math.max(0, Math.min(qty, instance.simulatedShortQty));
      if (coverQty <= 0) {
        instance.lastDecision = "cover skipped: no simulated short position";
        return;
      }
      const avgEntryPrice =
        instance.simulatedShortQty > 0
          ? instance.simulatedShortEntryNotional / instance.simulatedShortQty
          : currentPrice;
      const releasedEntryNotional = avgEntryPrice * coverQty;
      instance.simulatedShortQty -= coverQty;
      instance.simulatedShortEntryNotional = Math.max(
        0,
        instance.simulatedShortEntryNotional - releasedEntryNotional
      );
      appendTrade(instance, {
        id: randomUUID(),
        date: new Date().toISOString(),
        mode,
        side: "buy",
        intent,
        trendDirection,
        selloffScore,
        status: "simulated",
        price: currentPrice,
        qty: coverQty,
        notional: coverQty * currentPrice,
        signalScore,
        rationale,
        orderId: "dry-run",
      });
      instance.lastDecision = `cover simulated: ${coverQty.toFixed(8)} ${instance.config.symbol}`;
    }
    instance.lastOrderAt = new Date().toISOString();
    instance.lastActionBarTsBySide.buy = barTs;
    await syncPosition(instance, currentPrice);
    void persistAllLiveCryptoBots();
    return;
  }

  const body =
    intent === "open_long"
      ? {
          symbol: normalizeAlpacaCryptoSymbol(instance.config.symbol),
          notional: notional.toFixed(2),
          side: "buy",
          type: "market",
          time_in_force: "gtc",
        }
      : {
          symbol: normalizeAlpacaCryptoSymbol(instance.config.symbol),
          qty: qty.toFixed(8),
          side: "buy",
          type: "market",
          time_in_force: "gtc",
        };
  const result = await submitAlpacaOrder(body, mode);
  const status = result.error ? "error" : "submitted";
  appendTrade(instance, {
    id: randomUUID(),
    date: new Date().toISOString(),
    mode,
    side: "buy",
    intent,
    trendDirection,
    selloffScore,
    status,
    price: currentPrice,
    qty: intent === "open_long" ? null : qty,
    notional,
    signalScore,
    rationale,
    orderId: result.id ?? null,
    errorMsg: result.error,
  });
  instance.lastDecision = result.error
    ? `${intent === "open_long" ? "buy" : "cover"} failed: ${result.error}`
    : intent === "open_long"
      ? `buy submitted: $${notional.toFixed(2)}`
      : `cover submitted: ${qty.toFixed(8)} ${instance.config.symbol}`;
  instance.lastOrderAt = new Date().toISOString();
  instance.lastActionBarTsBySide.buy = barTs;
  if (result.error) {
    instance.lastError = result.error;
  }
  void persistAllLiveCryptoBots();
}

async function placeSellOrder(
  instance: LiveCryptoBotInstance,
  intent: "close_long" | "open_short",
  qty: number,
  notional: number,
  signalScore: number,
  rationale: string,
  currentPrice: number,
  barTs: string,
  trendDirection: TrendDirection,
  selloffScore: number
): Promise<void> {
  const mode = instance.config.mode;
  if (mode === "dry_run") {
    if (intent === "close_long") {
      const sellQty = Math.max(0, Math.min(qty, instance.simulatedQty));
      if (sellQty <= 0) {
        instance.lastDecision = "sell skipped: no simulated position";
        return;
      }
      const avgEntryPrice =
        instance.simulatedQty > 0
          ? instance.simulatedCostBasis / instance.simulatedQty
          : currentPrice;
      const releasedCostBasis = avgEntryPrice * sellQty;
      instance.simulatedQty -= sellQty;
      instance.simulatedCostBasis = Math.max(0, instance.simulatedCostBasis - releasedCostBasis);
      appendTrade(instance, {
        id: randomUUID(),
        date: new Date().toISOString(),
        mode,
        side: "sell",
        intent,
        trendDirection,
        selloffScore,
        status: "simulated",
        price: currentPrice,
        qty: sellQty,
        notional: sellQty * currentPrice,
        signalScore,
        rationale,
        orderId: "dry-run",
      });
      instance.lastDecision = `sell simulated: ${sellQty.toFixed(8)} ${instance.config.symbol}`;
    } else {
      const shortQty = Math.max(0, qty);
      if (shortQty <= 0) {
        instance.lastDecision = "short skipped: zero quantity";
        return;
      }
      instance.simulatedShortQty += shortQty;
      instance.simulatedShortEntryNotional += shortQty * currentPrice;
      appendTrade(instance, {
        id: randomUUID(),
        date: new Date().toISOString(),
        mode,
        side: "sell",
        intent,
        trendDirection,
        selloffScore,
        status: "simulated",
        price: currentPrice,
        qty: shortQty,
        notional: shortQty * currentPrice,
        signalScore,
        rationale,
        orderId: "dry-run",
      });
      instance.lastDecision = `short simulated: ${shortQty.toFixed(8)} ${instance.config.symbol}`;
    }
    instance.lastOrderAt = new Date().toISOString();
    instance.lastActionBarTsBySide.sell = barTs;
    await syncPosition(instance, currentPrice);
    void persistAllLiveCryptoBots();
    return;
  }

  const body = {
    symbol: normalizeAlpacaCryptoSymbol(instance.config.symbol),
    qty: qty.toFixed(8),
    side: "sell",
    type: "market",
    time_in_force: "gtc",
  };
  const result = await submitAlpacaOrder(body, mode);
  const status = result.error ? "error" : "submitted";
  appendTrade(instance, {
    id: randomUUID(),
    date: new Date().toISOString(),
    mode,
    side: "sell",
    intent,
    trendDirection,
    selloffScore,
    status,
    price: currentPrice,
    qty,
    notional,
    signalScore,
    rationale,
    orderId: result.id ?? null,
    errorMsg: result.error,
  });
  instance.lastDecision = result.error
    ? `${intent === "open_short" ? "short" : "sell"} failed: ${result.error}`
    : intent === "open_short"
      ? `short submitted: ${qty.toFixed(8)} ${instance.config.symbol}`
      : `sell submitted: ${qty.toFixed(8)} ${instance.config.symbol}`;
  instance.lastOrderAt = new Date().toISOString();
  instance.lastActionBarTsBySide.sell = barTs;
  if (result.error) {
    instance.lastError = result.error;
  }
  void persistAllLiveCryptoBots();
}

async function syncPosition(
  instance: LiveCryptoBotInstance,
  currentPrice: number
): Promise<void> {
  if (instance.config.mode === "dry_run") {
    const longQty = Math.max(0, instance.simulatedQty);
    const shortQty = Math.max(0, instance.simulatedShortQty);
    if (longQty > 1e-10) {
      const costBasis = Math.max(0, instance.simulatedCostBasis);
      const marketValue = longQty * currentPrice;
      const unrealizedPl = marketValue - costBasis;
      instance.position = {
        symbol: instance.config.symbol,
        side: "long",
        qty: longQty,
        avgEntryPrice: costBasis / Math.max(longQty, 1e-9),
        costBasis,
        marketValue,
        unrealizedPl,
        unrealizedPlpc: costBasis > 0 ? unrealizedPl / costBasis : null,
      };
    } else if (shortQty > 1e-10) {
      const entryNotional = Math.max(0, instance.simulatedShortEntryNotional);
      const marketValue = shortQty * currentPrice;
      const unrealizedPl = entryNotional - marketValue;
      instance.position = {
        symbol: instance.config.symbol,
        side: "short",
        qty: shortQty,
        avgEntryPrice: entryNotional / Math.max(shortQty, 1e-9),
        costBasis: entryNotional,
        marketValue,
        unrealizedPl,
        unrealizedPlpc: entryNotional > 0 ? unrealizedPl / entryNotional : null,
      };
    } else {
      instance.position = null;
    }
    instance.availableCash = null;
    instance.availableBuyingPower = null;
    return;
  }

  const snapshot = await fetchAlpacaAccountSnapshot({
    keyId: ALPACA_API_KEY_ID,
    secretKey: ALPACA_API_SECRET_KEY,
    paper: instance.config.mode !== "live",
  });
  instance.availableCash = snapshot.account.cash;
  instance.availableBuyingPower = snapshot.account.buyingPower;
  const normalizedSymbol = normalizeAlpacaCryptoSymbol(instance.config.symbol);
  const matchingPosition = snapshot.positions.find(
    (position) => normalizeAlpacaCryptoSymbol(position.symbol) === normalizedSymbol
  );

  if (!matchingPosition || matchingPosition.qty <= 0) {
    instance.position = null;
    return;
  }

  instance.position = {
    symbol: instance.config.symbol,
    side: matchingPosition.side,
    qty: matchingPosition.qty,
    avgEntryPrice: matchingPosition.avgEntryPrice,
    costBasis: matchingPosition.costBasis,
    marketValue: matchingPosition.marketValue,
    unrealizedPl: matchingPosition.unrealizedPl,
    unrealizedPlpc: matchingPosition.unrealizedPlpc,
  };
}

function computeTrendDirection(
  bars: Bar[],
  index: number,
  timeframe: LiveCryptoBotConfig["timeframe"],
  lookbackDays: number,
  bandPct: number
): { direction: TrendDirection; returnPct: number } {
  const barsPerDay = timeframe === "1Hour" ? 24 : 1;
  const lookbackBars = Math.max(2, Math.round(lookbackDays * barsPerDay));
  if (index < lookbackBars) {
    return { direction: "neutral", returnPct: 0 };
  }
  const baseIdx = index - lookbackBars;
  const basePrice = bars[baseIdx]?.c ?? 0;
  const currentPrice = bars[index]?.c ?? 0;
  if (!Number.isFinite(basePrice) || !Number.isFinite(currentPrice) || basePrice <= 0) {
    return { direction: "neutral", returnPct: 0 };
  }
  const move = (currentPrice - basePrice) / basePrice;
  if (move >= bandPct) return { direction: "up", returnPct: move };
  if (move <= -bandPct) return { direction: "down", returnPct: move };
  return { direction: "neutral", returnPct: move };
}

function formatSignedPct(value: number): string {
  const clamped = Number.isFinite(value) ? value : 0;
  const pct = (clamped * 100).toFixed(2);
  return `${clamped >= 0 ? "+" : ""}${pct}%`;
}

function evaluateRisk(
  instance: LiveCryptoBotInstance,
  input: RiskCheckInput
): string | null {
  const cfg = instance.config;
  const ordersToday = countOrdersPlacedToday(instance.trades);
  if (ordersToday >= cfg.maxDailyOrders) {
    return `daily order cap reached (${cfg.maxDailyOrders})`;
  }

  const lastOrderTs = lastSuccessfulOrderTs(instance.trades);
  if (lastOrderTs !== null) {
    const elapsedMs = Date.now() - lastOrderTs;
    if (elapsedMs < cfg.cooldownMinutes * MINUTE_MS) {
      const waitMin = Math.ceil((cfg.cooldownMinutes * MINUTE_MS - elapsedMs) / MINUTE_MS);
      return `cooldown active (${waitMin} min remaining)`;
    }
  }

  if (instance.lastActionBarTsBySide[input.side] === input.currentBarTs) {
    return `already attempted ${input.side} on this bar`;
  }

  const position = instance.position;
  const positionSide = position?.side ?? null;
  const positionQty = Math.max(0, position?.qty ?? 0);
  const positionValue = positionQty * input.currentPrice;

  if (input.intent === "open_long") {
    if (input.notional < 1) return "allocationUsd must be >= 1";
    if (positionSide === "short" && positionQty > 0) {
      return "close short position before opening a long position";
    }
    if (instance.availableCash !== null && input.notional > instance.availableCash) {
      return `insufficient cash for allocation ($${input.notional.toFixed(2)})`;
    }
    if (positionValue + input.notional > cfg.maxPositionUsd) {
      return `maxPositionUsd cap reached ($${cfg.maxPositionUsd.toFixed(2)})`;
    }
  }

  if (input.intent === "close_long") {
    if (positionSide !== "long" || positionQty <= 0) return "no long position to sell";
    if (input.qty <= 0) return "sell quantity must be positive";
  }

  if (input.intent === "open_short") {
    if (cfg.directionMode !== "trend_short_selloff") {
      return "shorting is disabled for this bot mode";
    }
    if (input.notional < 1) return "allocationUsd must be >= 1";
    if (positionSide === "long" && positionQty > 0) {
      return "close long position before opening a short position";
    }
    if (instance.availableBuyingPower !== null && input.notional > instance.availableBuyingPower) {
      return `insufficient buying power for short allocation ($${input.notional.toFixed(2)})`;
    }
    if (positionValue + input.notional > cfg.maxPositionUsd) {
      return `maxPositionUsd cap reached ($${cfg.maxPositionUsd.toFixed(2)})`;
    }
  }

  if (input.intent === "close_short") {
    if (positionSide !== "short" || positionQty <= 0) return "no short position to cover";
    if (input.qty <= 0) return "cover quantity must be positive";
  }

  return null;
}

function resolveLongQty(instance: LiveCryptoBotInstance): number {
  const position = instance.position;
  if (!position || position.side !== "long") return 0;
  return Math.max(0, position.qty);
}

interface AlpacaOrderResult {
  id?: string;
  error?: string;
}

async function submitAlpacaOrder(
  body: Record<string, string | undefined>,
  mode: "paper" | "live"
): Promise<AlpacaOrderResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const baseUrl = mode === "live" ? LIVE_TRADING_BASE_URL : PAPER_TRADING_BASE_URL;
  try {
    const response = await fetch(`${baseUrl}/orders`, {
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

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message =
        typeof payload.message === "string"
          ? payload.message
          : `Alpaca order rejected (${response.status})`;
      return { error: message };
    }

    return { id: typeof payload.id === "string" ? payload.id : undefined };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeLiveCryptoConfig(input: LiveCryptoBotStartRequest | LiveCryptoBotConfig): LiveCryptoBotConfig {
  const symbol = normalizeAlpacaCryptoSymbol(input.symbol);
  const timeframe = input.timeframe === "1Day" ? "1Day" : "1Hour";
  const mode = input.mode === "paper" || input.mode === "live" ? input.mode : "dry_run";
  const directionMode =
    input.directionMode === "trend_short_selloff"
      ? "trend_short_selloff"
      : DEFAULT_DIRECTION_MODE;
  const allocationUsd = normalizeFinitePositive(input.allocationUsd, 100);
  const buyThreshold = normalizeThreshold(input.buyThreshold, 0.68);
  const sellThreshold = normalizeThreshold(input.sellThreshold, 0.32);
  if (sellThreshold >= buyThreshold) {
    throw new Error("sellThreshold must be lower than buyThreshold.");
  }
  const maxPositionUsd = Math.max(
    normalizeFinitePositive(input.maxPositionUsd, allocationUsd * 4),
    allocationUsd
  );
  const maxDailyOrders = clampInt(normalizeFinitePositive(input.maxDailyOrders, 6), 1, 500);
  const cooldownMinutes = clampInt(
    normalizeFinitePositive(
      input.cooldownMinutes,
      timeframe === "1Hour" ? 60 : 12 * 60
    ),
    1,
    7 * 24 * 60
  );
  const trendLookbackDays = clampInt(
    normalizeFinitePositive(input.trendLookbackDays, DEFAULT_TREND_LOOKBACK_DAYS),
    2,
    180
  );
  const trendBandPct = clamp(
    normalizeFinitePositive(input.trendBandPct, DEFAULT_TREND_BAND_PCT),
    0.001,
    0.35
  );
  const selloffStartThreshold = normalizeThreshold(
    input.selloffStartThreshold,
    DEFAULT_SELLOFF_START_THRESHOLD
  );
  const selloffEndThreshold = normalizeThreshold(
    input.selloffEndThreshold,
    DEFAULT_SELLOFF_END_THRESHOLD
  );
  if (selloffEndThreshold >= selloffStartThreshold) {
    throw new Error("selloffEndThreshold must be lower than selloffStartThreshold.");
  }
  const signals = normalizeSignalWeights(
    Array.isArray(input.signals) && input.signals.length > 0 ? input.signals : DEFAULT_SIGNALS
  );
  if (signals.length === 0) {
    throw new Error("signals must include at least one weighted signal.");
  }
  const selloffSignals = normalizeSignalWeights(
    Array.isArray(input.selloffSignals) && input.selloffSignals.length > 0
      ? input.selloffSignals
      : DEFAULT_SELLOFF_SIGNALS
  );
  if (selloffSignals.length === 0) {
    throw new Error("selloffSignals must include at least one weighted signal.");
  }

  return {
    label: (input.label ?? "").trim() || `Live Crypto Bot ${symbol}`,
    symbol,
    timeframe,
    mode,
    allocationUsd,
    buyThreshold,
    sellThreshold,
    maxPositionUsd,
    maxDailyOrders,
    cooldownMinutes,
    signals,
    directionMode,
    trendLookbackDays,
    trendBandPct,
    selloffStartThreshold,
    selloffEndThreshold,
    selloffSignals,
  };
}

function normalizeSignalWeights(signals: SignalWeight[]): SignalWeight[] {
  const rows = signals
    .filter((row) => row && row.signal && Number.isFinite(row.weight) && row.weight > 0)
    .map((row) => ({
      signal: cloneSignal(row.signal),
      weight: row.weight,
    }));
  if (rows.length === 0) return [];
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  return rows.map((row) => ({ signal: row.signal, weight: row.weight / total }));
}

function cloneSignal(signal: SignalType): SignalType {
  if (signal.type === "bollinger_band") {
    return {
      type: "bollinger_band",
      period: clampInt(signal.period, 2, 500),
      std_dev: clamp(normalizeFinitePositive(signal.std_dev, 2), 0.1, 10),
    };
  }

  return {
    ...signal,
    period: clampInt(signal.period, 2, 500),
  };
}

function normalizeTrades(input: unknown): LiveCryptoTrade[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((row) => row && typeof row === "object")
    .map((row) => row as LiveCryptoTrade)
    .filter((trade) => typeof trade.id === "string" && typeof trade.side === "string")
    .slice(0, MAX_RECENT_TRADES);
}

function appendTrade(instance: LiveCryptoBotInstance, trade: LiveCryptoTrade): void {
  instance.trades.unshift(trade);
  if (instance.trades.length > MAX_RECENT_TRADES) {
    instance.trades.length = MAX_RECENT_TRADES;
  }
}

async function persistAllLiveCryptoBots(): Promise<void> {
  persistChain = persistChain
    .catch(() => undefined)
    .then(async () => {
      const running = Array.from(bots.values()).filter((bot) => bot.running);
      if (running.length === 0) {
        await clearAllPersistedLiveCryptoBots();
        return;
      }
      const payload: PersistedLiveCryptoBot[] = running.map((bot) => ({
        id: bot.id,
        config: bot.config,
        trades: bot.trades,
        simulatedQty: bot.simulatedQty,
        simulatedCostBasis: bot.simulatedCostBasis,
        simulatedShortQty: bot.simulatedShortQty,
        simulatedShortEntryNotional: bot.simulatedShortEntryNotional,
      }));
      await writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
    })
    .catch((err) => {
      console.error("[live-crypto] failed to persist state:", err);
    });
  await persistChain;
}

async function removePersistedLiveCryptoBot(id: string): Promise<void> {
  persistChain = persistChain
    .catch(() => undefined)
    .then(async () => {
      const running = Array.from(bots.values()).filter((bot) => bot.running && bot.id !== id);
      if (running.length === 0) {
        await clearAllPersistedLiveCryptoBots();
        return;
      }
      const payload: PersistedLiveCryptoBot[] = running.map((bot) => ({
        id: bot.id,
        config: bot.config,
        trades: bot.trades,
        simulatedQty: bot.simulatedQty,
        simulatedCostBasis: bot.simulatedCostBasis,
        simulatedShortQty: bot.simulatedShortQty,
        simulatedShortEntryNotional: bot.simulatedShortEntryNotional,
      }));
      await writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
    })
    .catch((err) => {
      console.error("[live-crypto] failed to update persisted state:", err);
    });
  await persistChain;
}

async function clearAllPersistedLiveCryptoBots(): Promise<void> {
  try {
    await unlink(STATE_FILE);
  } catch {
    // file may not exist
  }
}

function deriveLastActionBarTsBySide(
  trades: LiveCryptoTrade[]
): { buy: string | null; sell: string | null } {
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

function countOrdersPlacedToday(trades: LiveCryptoTrade[]): number {
  const today = new Date().toISOString().slice(0, 10);
  return trades.filter((trade) => {
    if (trade.status !== "submitted" && trade.status !== "simulated") return false;
    const day = isoDay(trade.date);
    return day === today;
  }).length;
}

function lastSuccessfulOrderTs(trades: LiveCryptoTrade[]): number | null {
  for (const trade of trades) {
    if (trade.status !== "submitted" && trade.status !== "simulated") continue;
    const ts = Date.parse(trade.date);
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

function normalizeAlpacaCryptoSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase().replace(/[-_]/g, "/");
  if (upper.includes("/")) return upper;
  const quotes = ["USDT", "USDC", "USD", "BTC", "ETH"];
  for (const quote of quotes) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return `${upper.slice(0, -quote.length)}/${quote}`;
    }
  }
  return upper;
}

function hasAlpacaCredentials(): boolean {
  return Boolean(ALPACA_API_KEY_ID && ALPACA_API_SECRET_KEY);
}

function normalizeFinitePositive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeThreshold(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, 0, 1);
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDay(value: string): string | null {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString().slice(0, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function backendManagedBotId(
  symbol: string,
  timeframe: LiveCryptoBotConfig["timeframe"]
): string {
  const safeSymbol = symbol.replace(/[^A-Z0-9]+/g, "_");
  return `backend-paper-${safeSymbol}-${timeframe.toLowerCase()}`;
}

function toStatus(instance: LiveCryptoBotInstance): LiveCryptoBotStatus {
  const {
    timer: _timer,
    simulatedQty: _simQty,
    simulatedCostBasis: _simCost,
    simulatedShortQty: _simShortQty,
    simulatedShortEntryNotional: _simShortNotional,
    lastActionBarTsBySide: _bars,
    ...status
  } = instance;
  return { ...status, trades: [...status.trades] };
}
