import { BOT_TUNING_PROFILES, BotTuningProfileKey } from "./botTuning.ts";
import { Bar, compositeScore, scoreRationale } from "./botSignals.ts";
import { fetchMarketBars } from "./core.ts";
import {
  LIVE_SIGNAL_HISTORY_LIMIT,
  LIVE_SIGNAL_PROFILES,
  LIVE_SIGNAL_SYMBOLS,
} from "./config.ts";

const MIN_SIGNAL_BARS = 30;
const POLL_INTERVALS: Record<LiveSignalTimeframe, number> = {
  "1Hour": 5 * 60 * 1000,
  "1Day": 30 * 60 * 1000,
};
const MAX_SIGNAL_HISTORY = clampInt(LIVE_SIGNAL_HISTORY_LIMIT, 50, 5_000);

export type LiveSignalTimeframe = "1Hour" | "1Day";
export type LiveSignalAction = "buy" | "sell" | "hold";

export interface LiveStrategySignal {
  id: string;
  symbol: string;
  profile: BotTuningProfileKey;
  timeframe: LiveSignalTimeframe;
  objective: "scale_in" | "selloff";
  action: LiveSignalAction;
  score: number | null;
  buyThreshold: number;
  sellThreshold: number;
  price: number | null;
  rationale: string | null;
  crashScore: number | null;
  crashTriggered: boolean;
  barTime: string | null;
  generatedAt: string;
  error: string | null;
}

export interface LiveSignalsMonitorStatus {
  running: boolean;
  configuredSymbolCount: number;
  configuredProfileCount: number;
  signalCount: number;
  lastRunByTimeframe: Record<LiveSignalTimeframe, string | null>;
  lastError: string | null;
}

interface LiveSignalsFilter {
  limit?: number;
  symbol?: string | null;
  profile?: BotTuningProfileKey | null;
  timeframe?: LiveSignalTimeframe | null;
  action?: LiveSignalAction | null;
}

const latestSignalById = new Map<string, LiveStrategySignal>();
const latestSignals: LiveStrategySignal[] = [];
const monitorTimers: Partial<Record<LiveSignalTimeframe, ReturnType<typeof setInterval>>> = {};
const lastRunByTimeframe: Record<LiveSignalTimeframe, string | null> = {
  "1Hour": null,
  "1Day": null,
};

let monitorRunning = false;
let lastError: string | null = null;

export function startLiveSignalsMonitor(): void {
  if (monitorRunning) return;

  const symbols = resolveConfiguredSymbols();
  const profiles = resolveConfiguredProfiles();
  if (symbols.length === 0 || profiles.length === 0) {
    console.log("[live-signals] skipped start: no symbols/profiles configured");
    return;
  }

  monitorRunning = true;

  (Object.keys(POLL_INTERVALS) as LiveSignalTimeframe[]).forEach((timeframe) => {
    monitorTimers[timeframe] = setInterval(
      () => void runLiveSignalsScanNow(timeframe),
      POLL_INTERVALS[timeframe]
    );
    void runLiveSignalsScanNow(timeframe);
  });

  console.log(
    `[live-signals] started (${symbols.length} symbols, ${profiles.length} profiles)`
  );
}

export function stopLiveSignalsMonitor(): void {
  if (!monitorRunning) return;

  (Object.keys(monitorTimers) as LiveSignalTimeframe[]).forEach((timeframe) => {
    const timer = monitorTimers[timeframe];
    if (timer) {
      clearInterval(timer);
    }
    delete monitorTimers[timeframe];
  });

  monitorRunning = false;
  console.log("[live-signals] stopped");
}

export function getLiveSignals(filter: LiveSignalsFilter = {}): LiveStrategySignal[] {
  const limit = clampInt(filter.limit ?? 200, 1, MAX_SIGNAL_HISTORY);
  const wantedSymbol = normalizeSymbolOrNull(filter.symbol);
  const wantedProfile = filter.profile ?? null;
  const wantedTimeframe = filter.timeframe ?? null;
  const wantedAction = filter.action ?? null;

  return latestSignals
    .filter((signal) => {
      if (wantedSymbol && signal.symbol !== wantedSymbol) return false;
      if (wantedProfile && signal.profile !== wantedProfile) return false;
      if (wantedTimeframe && signal.timeframe !== wantedTimeframe) return false;
      if (wantedAction && signal.action !== wantedAction) return false;
      return true;
    })
    .slice(0, limit)
    .map(cloneSignal);
}

export function getLiveSignalsMonitorStatus(): LiveSignalsMonitorStatus {
  return {
    running: monitorRunning,
    configuredSymbolCount: resolveConfiguredSymbols().length,
    configuredProfileCount: resolveConfiguredProfiles().length,
    signalCount: latestSignals.length,
    lastRunByTimeframe: { ...lastRunByTimeframe },
    lastError,
  };
}

export async function runLiveSignalsScanNow(
  timeframe?: LiveSignalTimeframe
): Promise<void> {
  const symbols = resolveConfiguredSymbols();
  const profiles = resolveConfiguredProfiles();
  if (symbols.length === 0 || profiles.length === 0) {
    return;
  }

  const timeframes: LiveSignalTimeframe[] = timeframe
    ? [timeframe]
    : (Object.keys(POLL_INTERVALS) as LiveSignalTimeframe[]);

  for (const activeTimeframe of timeframes) {
    await runScanForTimeframe(activeTimeframe, symbols, profiles);
  }
}

async function runScanForTimeframe(
  timeframe: LiveSignalTimeframe,
  symbols: string[],
  profiles: BotTuningProfileKey[]
): Promise<void> {
  const timeframeProfiles = profiles.filter(
    (profileKey) => BOT_TUNING_PROFILES[profileKey].timeframe === timeframe
  );
  if (timeframeProfiles.length === 0) {
    return;
  }

  const generatedAt = new Date().toISOString();
  let scanError: string | null = null;

  for (const symbol of symbols) {
    let bars: Bar[];
    let lastPrice: number | null = null;
    let barTime: string | null = null;

    try {
      const range = timeframe === "1Hour" ? null : "2y";
      const payload = await fetchMarketBars({
        symbol,
        range,
        timeframe,
      });
      if (payload.bars.length < MIN_SIGNAL_BARS) {
        throw new Error(
          `Insufficient bar history (${payload.bars.length}) for signal computation`
        );
      }
      bars = payload.bars.map((bar) => ({
        t: bar.t,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        v: bar.v ?? 0,
      }));
      const latestBar = bars[bars.length - 1];
      lastPrice = latestBar.c;
      barTime = latestBar.t;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scanError = message;
      for (const profileKey of timeframeProfiles) {
        upsertSignal({
          id: signalId(symbol, profileKey),
          symbol,
          profile: profileKey,
          timeframe,
          objective: BOT_TUNING_PROFILES[profileKey].objective,
          action: "hold",
          score: null,
          buyThreshold: BOT_TUNING_PROFILES[profileKey].buyThreshold,
          sellThreshold: BOT_TUNING_PROFILES[profileKey].sellThreshold,
          price: null,
          rationale: null,
          crashScore: null,
          crashTriggered: false,
          barTime: null,
          generatedAt,
          error: message,
        });
      }
      continue;
    }

    const lastIndex = bars.length - 1;
    for (const profileKey of timeframeProfiles) {
      const profile = BOT_TUNING_PROFILES[profileKey];
      const score = compositeScore(profile.signals, bars, lastIndex);
      const rationale = scoreRationale(
        profile.signals,
        bars,
        lastIndex,
        profile.objective === "selloff"
      );

      let action: LiveSignalAction = "hold";
      let crashTriggered = false;
      let crashScore: number | null = null;

      if (profile.objective === "scale_in") {
        if (score >= profile.buyThreshold) {
          action = "buy";
        }
      } else {
        if (profile.crashDetection?.enabled) {
          const crashSignals =
            profile.crashDetection.signals?.length > 0
              ? profile.crashDetection.signals
              : profile.signals;
          crashScore = compositeScore(crashSignals, bars, lastIndex);
          crashTriggered = crashScore >= profile.crashDetection.threshold;
        }
        if (crashTriggered || score <= profile.sellThreshold) {
          action = "sell";
        }
      }

      upsertSignal({
        id: signalId(symbol, profileKey),
        symbol,
        profile: profileKey,
        timeframe,
        objective: profile.objective,
        action,
        score,
        buyThreshold: profile.buyThreshold,
        sellThreshold: profile.sellThreshold,
        price: lastPrice,
        rationale,
        crashScore,
        crashTriggered,
        barTime,
        generatedAt,
        error: null,
      });
    }
  }

  lastRunByTimeframe[timeframe] = generatedAt;
  lastError = scanError;
}

function upsertSignal(next: LiveStrategySignal): void {
  latestSignalById.set(next.id, next);
  latestSignals.length = 0;
  latestSignals.push(...Array.from(latestSignalById.values()));
  latestSignals.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  if (latestSignals.length > MAX_SIGNAL_HISTORY) {
    const trimmed = latestSignals.slice(0, MAX_SIGNAL_HISTORY);
    latestSignals.length = 0;
    latestSignals.push(...trimmed);
    latestSignalById.clear();
    for (const signal of latestSignals) {
      latestSignalById.set(signal.id, signal);
    }
  }
}

function resolveConfiguredSymbols(): string[] {
  const out = new Set<string>();
  for (const raw of LIVE_SIGNAL_SYMBOLS) {
    const symbol = normalizeSymbolOrNull(raw);
    if (symbol) out.add(symbol);
  }
  return Array.from(out);
}

function resolveConfiguredProfiles(): BotTuningProfileKey[] {
  if (LIVE_SIGNAL_PROFILES.length === 0) {
    return Object.keys(BOT_TUNING_PROFILES) as BotTuningProfileKey[];
  }

  const out = new Set<BotTuningProfileKey>();
  for (const raw of LIVE_SIGNAL_PROFILES) {
    const key = raw.trim() as BotTuningProfileKey;
    if (key in BOT_TUNING_PROFILES) {
      out.add(key);
    }
  }
  return Array.from(out);
}

function normalizeSymbolOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  if (!/^[A-Z0-9./_-]+$/.test(normalized)) return null;
  return normalized;
}

function signalId(symbol: string, profile: BotTuningProfileKey): string {
  return `${symbol}|${profile}`;
}

function cloneSignal(signal: LiveStrategySignal): LiveStrategySignal {
  return { ...signal };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
