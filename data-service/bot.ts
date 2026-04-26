import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { ApiHttpError, fetchAlpacaAccountSnapshot, fetchMarketBars } from "./core";
import { compositeScore, scoreRationale, SignalWeight, Bar } from "./botSignals";

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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BotConfig {
  label: string;
  symbol: string;
  timeframe: "1Day" | "1Hour";
  signals: SignalWeight[];
  allocationMode: "fixed_usd" | "pct_of_cash";
  allocationFixed: number;
  allocationPct: number;
  buyThreshold: number;
  sellThreshold: number;
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
  lastTickAt: string | null;
  lastError: string | null;
  availableCash: number | null;
}

interface BotInstance extends BotStatus {
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

export function startBot(cfg: BotConfig, existingId?: string): string {
  const id = existingId ?? randomUUID();

  // Stop existing instance with this id if any
  const existing = bots.get(id);
  if (existing?.timer) clearInterval(existing.timer);

  const instance: BotInstance = {
    id,
    running: true,
    config: cfg,
    position: existing?.position ?? null,
    trades: existing?.trades ?? [],
    lastSignalScore: existing?.lastSignalScore ?? null,
    lastSignalRationale: existing?.lastSignalRationale ?? null,
    lastTickAt: existing?.lastTickAt ?? null,
    lastError: null,
    availableCash: existing?.availableCash ?? null,
    timer: null,
  };

  bots.set(id, instance);
  instance.timer = setInterval(() => void tick(id), POLL_INTERVALS[cfg.timeframe]);
  void tick(id);
  void persistAllBots();
  console.log(`[bot:${id.slice(0, 8)}] started — ${cfg.symbol} ${cfg.timeframe} "${cfg.label}"`);
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
        config: entry.config,
        position: null,
        trades: Array.isArray(entry.trades) ? entry.trades : [],
        lastSignalScore: null,
        lastSignalRationale: null,
        lastTickAt: null,
        lastError: null,
        availableCash: null,
        timer: null,
      };
      bots.set(entry.id, placeholder);
      startBot(entry.config, entry.id);
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
    const score = compositeScore(cfg.signals, bars, lastIdx);
    const rationale = scoreRationale(cfg.signals, bars, lastIdx, false);
    instance.lastSignalScore = score;
    instance.lastSignalRationale = rationale;
    instance.lastTickAt = new Date().toISOString();
    instance.lastError = null;

    console.log(`[bot:${id.slice(0, 8)}] ${cfg.symbol} ${cfg.timeframe} score=${score.toFixed(3)}`);

    await syncPosition(instance);

    const snapshot = await fetchAlpacaAccountSnapshot();
    instance.availableCash = snapshot.account.cash;

    if (score >= cfg.buyThreshold && !instance.position) {
      const amount = resolveAllocationAmount(cfg, instance.availableCash);
      if (amount < 1) {
        instance.lastError = `Allocation too small: $${amount.toFixed(2)}`;
        return;
      }
      await placeBuyOrder(instance, amount, score, rationale, bars[lastIdx].c);
    } else if (score <= cfg.sellThreshold && instance.position && instance.position.qty > 0) {
      await placeSellOrder(instance, instance.position.qty, score, rationale, bars[lastIdx].c);
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
  currentPrice: number
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
  void persistAllBots();
  console.log(`[bot:${instance.id.slice(0, 8)}] buy $${notional.toFixed(2)} ${instance.config.symbol}`);
}

async function placeSellOrder(
  instance: BotInstance,
  qty: number,
  signalScore: number,
  rationale: string,
  currentPrice: number
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
