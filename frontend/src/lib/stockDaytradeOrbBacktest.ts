import type { Bar } from "./signals";

export type OrbTradeSide = "long" | "short";
export type OrbExitReason = "take_profit" | "stop_loss" | "session_close";

export interface OrbBacktestTrade {
  id: string;
  sessionDate: string;
  entryDate: string;
  exitDate: string;
  side: OrbTradeSide;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  exitPrice: number;
  qty: number;
  riskPerShare: number;
  plannedRiskUsd: number;
  pnlUsd: number;
  pnlR: number;
  returnPct: number;
  holdBars: number;
  exitReason: OrbExitReason;
  openingRangeHigh: number;
  openingRangeLow: number;
  openingRangeMid: number;
  candidateScore: {
    earningsWindow: boolean;
    liquidityPass: boolean;
    avgDailyDollarVolumeUsd: number | null;
  };
}

export interface OrbSessionRange {
  sessionDate: string;
  openingRangeStart: string;
  openingRangeEnd: string;
  sessionEnd: string;
  high: number;
  low: number;
  mid: number;
  traded: boolean;
  candidateEligible: boolean;
  candidateReasons: string[];
  avgDailyDollarVolumeUsd: number | null;
  earningsWindow: boolean;
}

export interface OrbEquityPoint {
  date: string;
  equity: number;
}

export interface OrbBacktestSummary {
  symbol: string;
  startDate: string;
  endDate: string;
  timeframe: "15Min";
  initialCapital: number;
  finalEquity: number;
  totalPnlUsd: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  tradeCount: number;
  winRatePct: number;
  avgPnlUsd: number;
  avgR: number;
  expectancyUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number | null;
  sessionsAnalyzed: number;
  sessionsWithOpeningRange: number;
  sessionsWithTrades: number;
  skippedSessionsNoOpeningRange: number;
  skippedTradesSizing: number;
  candidateSessions: number;
  candidateExcludedSessions: number;
}

export interface OrbBacktestResult {
  summary: OrbBacktestSummary;
  trades: OrbBacktestTrade[];
  barsUsed: Bar[];
  equityCurve: OrbEquityPoint[];
  sessionRanges: OrbSessionRange[];
}

export interface RunOrbBacktestConfig {
  symbol: string;
  bars: Bar[];
  startDate: string;
  endDate: string;
  initialCapital: number;
  riskPerTradePct: number;
  rewardRisk: number;
  allowLong: boolean;
  allowShort: boolean;
  maxTradesPerDay?: number;
  earningsDates?: string[];
  candidateFilter?: OrbCandidateFilterConfig;
}

export interface OrbCandidateFilterConfig {
  enabled: boolean;
  allowedSymbols?: string[];
  earningsWindowDaysBefore?: number;
  earningsWindowDaysAfter?: number;
  minAvgDailyDollarVolumeUsd?: number;
  liquidityLookbackDays?: number;
  minLiquiditySamples?: number;
}

type SessionBar = {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  ts: number;
  nyDate: string;
  minuteOfDay: number;
};

const NY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const REGULAR_SESSION_START_MINUTE = 9 * 60 + 30;
const REGULAR_SESSION_END_MINUTE = 16 * 60;
const DAY_MS = 86_400_000;
const BREAKOUT_VOLUME_LOOKBACK_BARS = 5;
const BREAKOUT_VOLUME_MULTIPLIER = 1.2;
const DEFAULT_LIQUID_TECH_UNIVERSE = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "META",
  "GOOGL",
  "NFLX",
  "AMD",
  "AVGO",
  "TSLA",
];

export function runStockDaytradeOrbBacktest(
  cfg: RunOrbBacktestConfig
): OrbBacktestResult | null {
  const symbol = cfg.symbol.trim().toUpperCase();
  const startDate = normalizeIsoDay(cfg.startDate);
  const endDate = normalizeIsoDay(cfg.endDate);
  if (!symbol || !startDate || !endDate || endDate < startDate) return null;

  const initialCapital = clamp(cfg.initialCapital, 100, Number.MAX_SAFE_INTEGER);
  const riskPerTradePct = clamp(cfg.riskPerTradePct, 0.001, 0.05);
  const rewardRisk = clamp(cfg.rewardRisk, 0.5, 10);
  const maxTradesPerDay = Math.max(1, Math.floor(cfg.maxTradesPerDay ?? 1));
  const candidateFilter = normalizeCandidateFilter(cfg.candidateFilter);
  const earningsDays = buildEarningsDayNumbers(cfg.earningsDates ?? []);
  const symbolAllowed = !candidateFilter.enabled || isAllowedSymbol(symbol, candidateFilter.allowedSymbols);

  const annotatedBars = annotateBars(cfg.bars)
    .filter((bar) => bar.nyDate >= startDate && bar.nyDate <= endDate)
    .filter((bar) => isRegularSessionMinute(bar.minuteOfDay));
  if (annotatedBars.length === 0) return null;

  const barsUsed: Bar[] = annotatedBars.map((bar) => ({
    t: bar.t,
    o: bar.o,
    h: bar.h,
    l: bar.l,
    c: bar.c,
    v: bar.v,
  }));

  const sessions = groupBarsBySession(annotatedBars);
  const sessionEntries = Array.from(sessions.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  let equity = initialCapital;
  let peakEquity = initialCapital;
  let maxDrawdownPct = 0;
  let skippedSessionsNoOpeningRange = 0;
  let skippedTradesSizing = 0;
  let candidateSessions = 0;
  let candidateExcludedSessions = 0;
  const dailyDollarVolumeHistory: number[] = [];

  const trades: OrbBacktestTrade[] = [];
  const equityCurve: OrbEquityPoint[] = [{ date: annotatedBars[0].t, equity: round2(equity) }];
  const sessionRanges: OrbSessionRange[] = [];

  for (const [sessionDate, sessionBars] of sessionEntries) {
    if (sessionBars.length < 2) {
      skippedSessionsNoOpeningRange += 1;
      continue;
    }

    const openingBarIdx = findOpeningRangeBarIndex(sessionBars);
    if (openingBarIdx < 0) {
      skippedSessionsNoOpeningRange += 1;
      continue;
    }

    const openingBar = sessionBars[openingBarIdx];
    const openingRangeHigh = Math.max(openingBar.h, openingBar.l);
    const openingRangeLow = Math.min(openingBar.h, openingBar.l);
    const openingRangeMid = round4((openingRangeHigh + openingRangeLow) / 2);
    const sessionEndBar = sessionBars[sessionBars.length - 1];
    const dayDollarVolume = sessionBars.reduce(
      (sum, bar) => sum + Math.max(0, bar.c) * Math.max(0, bar.v),
      0
    );
    const rollingLiquidity = averageTrailingValues(
      dailyDollarVolumeHistory,
      candidateFilter.liquidityLookbackDays
    );
    const hasEarningsEvents = earningsDays.length > 0;
    const enoughLiquiditySamples = dailyDollarVolumeHistory.length >= candidateFilter.minLiquiditySamples;
    const liquidityPass =
      !candidateFilter.enabled ||
      (enoughLiquiditySamples &&
        rollingLiquidity !== null &&
        rollingLiquidity >= candidateFilter.minAvgDailyDollarVolumeUsd);
    const earningsWindowPass =
      !candidateFilter.enabled ||
      (hasEarningsEvents &&
        isInEarningsWindow(
          sessionDate,
          earningsDays,
          candidateFilter.earningsWindowDaysBefore,
          candidateFilter.earningsWindowDaysAfter
        ));

    const candidateReasons: string[] = [];
    if (candidateFilter.enabled) {
      if (!symbolAllowed) {
        candidateReasons.push("symbol_not_in_allowed_universe");
      }
      if (!hasEarningsEvents) {
        candidateReasons.push("no_earnings_events");
      } else if (!earningsWindowPass) {
        candidateReasons.push("outside_earnings_window");
      }
      if (!enoughLiquiditySamples) {
        candidateReasons.push("insufficient_liquidity_history");
      } else if (!liquidityPass) {
        candidateReasons.push("low_liquidity");
      }
    }
    const candidateEligible = candidateReasons.length === 0;
    if (candidateEligible) candidateSessions += 1;
    else if (candidateFilter.enabled) candidateExcludedSessions += 1;

    let tradesToday = 0;
    let sessionTraded = false;

    if (candidateEligible) {
      for (
        let signalIdx = openingBarIdx + 1;
        signalIdx < sessionBars.length && tradesToday < maxTradesPerDay;
        signalIdx += 1
      ) {
        const signalBar = sessionBars[signalIdx];
        const breakoutVolumePass = hasBreakoutVolumeConfirmation(
          sessionBars,
          signalIdx,
          BREAKOUT_VOLUME_LOOKBACK_BARS,
          BREAKOUT_VOLUME_MULTIPLIER
        );
        if (!breakoutVolumePass) continue;

        const side = resolveBreakoutSide(signalBar, openingRangeHigh, openingRangeLow, cfg.allowLong, cfg.allowShort);
        if (!side) continue;

        // Live-like execution: signal is confirmed on bar close, then filled at the next bar open.
        const entryIdx = signalIdx + 1;
        if (entryIdx >= sessionBars.length) {
          // No next bar available to execute the order.
          break;
        }
        const entryBar = sessionBars[entryIdx];
        const entryPrice = entryBar.o;
        const stopPrice = openingRangeMid;
        const riskPerShare = side === "long" ? entryPrice - stopPrice : stopPrice - entryPrice;
        if (!(riskPerShare > 0)) {
          skippedTradesSizing += 1;
          break;
        }

        const riskBudgetUsd = Math.max(0, equity * riskPerTradePct);
        const qtyByRisk = Math.floor(riskBudgetUsd / riskPerShare);
        const qtyByCapital = Math.floor(equity / Math.max(entryPrice, 1e-9));
        const qty = Math.max(0, Math.min(qtyByRisk, qtyByCapital));
        if (qty < 1) {
          skippedTradesSizing += 1;
          break;
        }

        const targetPrice = side === "long"
          ? round4(entryPrice + rewardRisk * riskPerShare)
          : round4(entryPrice - rewardRisk * riskPerShare);
        const exit = simulateExit({
          side,
          sessionBars,
          entryIdx,
          stopPrice,
          targetPrice,
        });

        const plannedRiskUsd = qty * riskPerShare;
        const pnlUsd = side === "long"
          ? (exit.exitPrice - entryPrice) * qty
          : (entryPrice - exit.exitPrice) * qty;
        const pnlR = plannedRiskUsd > 0 ? pnlUsd / plannedRiskUsd : 0;
        const returnPct = (pnlUsd / Math.max(equity, 1e-9)) * 100;

        equity = round4(equity + pnlUsd);
        peakEquity = Math.max(peakEquity, equity);
        const drawdownPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
        maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);

        const tradeId = `${sessionDate}-${trades.length + 1}`;
        trades.push({
          id: tradeId,
          sessionDate,
          entryDate: entryBar.t,
          exitDate: exit.exitDate,
          side,
          entryPrice: round4(entryPrice),
          stopPrice: round4(stopPrice),
          targetPrice,
          exitPrice: round4(exit.exitPrice),
          qty,
          riskPerShare: round4(riskPerShare),
          plannedRiskUsd: round2(plannedRiskUsd),
          pnlUsd: round2(pnlUsd),
          pnlR: round4(pnlR),
          returnPct: round4(returnPct),
          holdBars: Math.max(1, exit.exitIdx - entryIdx + 1),
          exitReason: exit.reason,
          openingRangeHigh: round4(openingRangeHigh),
          openingRangeLow: round4(openingRangeLow),
          openingRangeMid: round4(openingRangeMid),
          candidateScore: {
            earningsWindow: earningsWindowPass,
            liquidityPass,
            avgDailyDollarVolumeUsd:
              rollingLiquidity !== null ? round2(rollingLiquidity) : null,
          },
        });
        equityCurve.push({ date: exit.exitDate, equity: round2(equity) });

        tradesToday += 1;
        sessionTraded = true;
        break;
      }
    }

    sessionRanges.push({
      sessionDate,
      openingRangeStart: openingBar.t,
      openingRangeEnd: addMinutesIso(openingBar.t, 15),
      sessionEnd: sessionEndBar.t,
      high: round4(openingRangeHigh),
      low: round4(openingRangeLow),
      mid: round4(openingRangeMid),
      traded: sessionTraded,
      candidateEligible,
      candidateReasons,
      avgDailyDollarVolumeUsd:
        rollingLiquidity !== null ? round2(rollingLiquidity) : null,
      earningsWindow: earningsWindowPass,
    });

    dailyDollarVolumeHistory.push(dayDollarVolume);
  }

  const wins = trades.filter((trade) => trade.pnlUsd > 0);
  const losses = trades.filter((trade) => trade.pnlUsd < 0);
  const grossProfitUsd = wins.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const grossLossUsdAbs = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlUsd, 0));
  const totalPnlUsd = trades.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const sessionsWithOpeningRange = sessions.size - skippedSessionsNoOpeningRange;
  const sessionsWithTrades = sessionRanges.filter((session) => session.traded).length;

  const summary: OrbBacktestSummary = {
    symbol,
    startDate,
    endDate,
    timeframe: "15Min",
    initialCapital: round2(initialCapital),
    finalEquity: round2(equity),
    totalPnlUsd: round2(totalPnlUsd),
    totalReturnPct: round4(((equity - initialCapital) / initialCapital) * 100),
    maxDrawdownPct: round4(maxDrawdownPct),
    tradeCount: trades.length,
    winRatePct: trades.length > 0 ? round4((wins.length / trades.length) * 100) : 0,
    avgPnlUsd: trades.length > 0 ? round2(totalPnlUsd / trades.length) : 0,
    avgR: trades.length > 0
      ? round4(trades.reduce((sum, trade) => sum + trade.pnlR, 0) / trades.length)
      : 0,
    expectancyUsd: trades.length > 0 ? round2(totalPnlUsd / trades.length) : 0,
    grossProfitUsd: round2(grossProfitUsd),
    grossLossUsd: round2(grossLossUsdAbs),
    profitFactor: grossLossUsdAbs > 0 ? round4(grossProfitUsd / grossLossUsdAbs) : null,
    sessionsAnalyzed: sessions.size,
    sessionsWithOpeningRange,
    sessionsWithTrades,
    skippedSessionsNoOpeningRange,
    skippedTradesSizing,
    candidateSessions,
    candidateExcludedSessions,
  };

  return {
    summary,
    trades,
    barsUsed,
    equityCurve,
    sessionRanges,
  };
}

function resolveBreakoutSide(
  bar: SessionBar,
  rangeHigh: number,
  rangeLow: number,
  allowLong: boolean,
  allowShort: boolean
): OrbTradeSide | null {
  if (allowLong && bar.c > rangeHigh) return "long";
  if (allowShort && bar.c < rangeLow) return "short";
  return null;
}

function hasBreakoutVolumeConfirmation(
  sessionBars: SessionBar[],
  signalIdx: number,
  lookbackBars: number,
  multiplier: number
): boolean {
  if (signalIdx <= 0) return false;
  const startIdx = Math.max(0, signalIdx - Math.max(1, lookbackBars));
  const priorVolumes = sessionBars
    .slice(startIdx, signalIdx)
    .map((bar) => Math.max(0, bar.v))
    .filter((value) => value > 0);
  if (priorVolumes.length === 0) return false;

  const baselineVolume =
    priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length;
  const signalVolume = Math.max(0, sessionBars[signalIdx]?.v ?? 0);
  return signalVolume >= baselineVolume * Math.max(1, multiplier);
}

function simulateExit(input: {
  side: OrbTradeSide;
  sessionBars: SessionBar[];
  entryIdx: number;
  stopPrice: number;
  targetPrice: number;
}): { exitDate: string; exitPrice: number; exitIdx: number; reason: OrbExitReason } {
  const { side, sessionBars, entryIdx, stopPrice, targetPrice } = input;
  for (let i = entryIdx; i < sessionBars.length; i += 1) {
    const bar = sessionBars[i];
    if (side === "long") {
      const stopHit = bar.l <= stopPrice;
      const targetHit = bar.h >= targetPrice;
      if (stopHit && targetHit) {
        return { exitDate: bar.t, exitPrice: stopPrice, exitIdx: i, reason: "stop_loss" };
      }
      if (stopHit) {
        return { exitDate: bar.t, exitPrice: stopPrice, exitIdx: i, reason: "stop_loss" };
      }
      if (targetHit) {
        return { exitDate: bar.t, exitPrice: targetPrice, exitIdx: i, reason: "take_profit" };
      }
    } else {
      const stopHit = bar.h >= stopPrice;
      const targetHit = bar.l <= targetPrice;
      if (stopHit && targetHit) {
        return { exitDate: bar.t, exitPrice: stopPrice, exitIdx: i, reason: "stop_loss" };
      }
      if (stopHit) {
        return { exitDate: bar.t, exitPrice: stopPrice, exitIdx: i, reason: "stop_loss" };
      }
      if (targetHit) {
        return { exitDate: bar.t, exitPrice: targetPrice, exitIdx: i, reason: "take_profit" };
      }
    }
  }

  const lastIdx = sessionBars.length - 1;
  const lastBar = sessionBars[lastIdx];
  return {
    exitDate: lastBar.t,
    exitPrice: lastBar.c,
    exitIdx: lastIdx,
    reason: "session_close",
  };
}

function findOpeningRangeBarIndex(sessionBars: SessionBar[]): number {
  const exactIdx = sessionBars.findIndex((bar) => bar.minuteOfDay === REGULAR_SESSION_START_MINUTE);
  if (exactIdx >= 0) return exactIdx;
  return sessionBars.findIndex(
    (bar) =>
      bar.minuteOfDay >= REGULAR_SESSION_START_MINUTE &&
      bar.minuteOfDay < REGULAR_SESSION_START_MINUTE + 15
  );
}

function annotateBars(bars: Bar[]): SessionBar[] {
  return bars
    .map((bar) => {
      const ts = Date.parse(bar.t);
      if (!Number.isFinite(ts)) return null;
      const ny = toNewYorkDateTimeParts(ts);
      if (!ny) return null;
      const v = Number.isFinite(bar.v) ? bar.v : 0;
      return {
        t: bar.t,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        v,
        ts,
        nyDate: ny.date,
        minuteOfDay: ny.hour * 60 + ny.minute,
      };
    })
    .filter((bar): bar is SessionBar => Boolean(bar))
    .sort((a, b) => a.ts - b.ts);
}

function groupBarsBySession(bars: SessionBar[]): Map<string, SessionBar[]> {
  const sessions = new Map<string, SessionBar[]>();
  for (const bar of bars) {
    const existing = sessions.get(bar.nyDate);
    if (existing) {
      existing.push(bar);
    } else {
      sessions.set(bar.nyDate, [bar]);
    }
  }
  return sessions;
}

function isRegularSessionMinute(minuteOfDay: number): boolean {
  return minuteOfDay >= REGULAR_SESSION_START_MINUTE && minuteOfDay < REGULAR_SESSION_END_MINUTE;
}

function toNewYorkDateTimeParts(ts: number): {
  date: string;
  hour: number;
  minute: number;
} | null {
  const parts = NY_FORMATTER.formatToParts(new Date(ts));
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type === "year" || part.type === "month" || part.type === "day" || part.type === "hour" || part.type === "minute") {
      values[part.type] = part.value;
    }
  }

  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour,
    minute,
  };
}

function addMinutesIso(iso: string, minutes: number): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts + minutes * 60_000).toISOString();
}

function normalizeCandidateFilter(
  input: OrbCandidateFilterConfig | undefined
): Required<OrbCandidateFilterConfig> {
  const allowedSymbols =
    input?.allowedSymbols && input.allowedSymbols.length > 0
      ? input.allowedSymbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)
      : DEFAULT_LIQUID_TECH_UNIVERSE;
  return {
    enabled: input?.enabled ?? false,
    allowedSymbols,
    earningsWindowDaysBefore: Math.max(0, Math.floor(input?.earningsWindowDaysBefore ?? 2)),
    earningsWindowDaysAfter: Math.max(0, Math.floor(input?.earningsWindowDaysAfter ?? 2)),
    minAvgDailyDollarVolumeUsd: Math.max(
      1_000_000,
      Number(input?.minAvgDailyDollarVolumeUsd ?? 1_500_000_000)
    ),
    liquidityLookbackDays: Math.max(1, Math.floor(input?.liquidityLookbackDays ?? 20)),
    minLiquiditySamples: Math.max(1, Math.floor(input?.minLiquiditySamples ?? 10)),
  };
}

function buildEarningsDayNumbers(earningsDates: string[]): number[] {
  return earningsDates
    .map((date) => normalizeIsoDay(date))
    .filter((date): date is string => Boolean(date))
    .map((date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS))
    .filter((dayNumber) => Number.isFinite(dayNumber))
    .sort((a, b) => a - b);
}

function isAllowedSymbol(symbol: string, allowedSymbols: string[]): boolean {
  if (allowedSymbols.length === 0) return true;
  return allowedSymbols.includes(symbol.trim().toUpperCase());
}

function isInEarningsWindow(
  sessionDate: string,
  earningsDayNumbers: number[],
  daysBefore: number,
  daysAfter: number
): boolean {
  if (earningsDayNumbers.length === 0) return false;
  const sessionDay = Math.floor(Date.parse(`${sessionDate}T00:00:00Z`) / DAY_MS);
  if (!Number.isFinite(sessionDay)) return false;

  for (const earningsDay of earningsDayNumbers) {
    const delta = sessionDay - earningsDay;
    if (delta >= -daysBefore && delta <= daysAfter) {
      return true;
    }
  }
  return false;
}

function averageTrailingValues(values: number[], lookback: number): number | null {
  if (values.length === 0 || lookback <= 0) return null;
  const slice = values.slice(Math.max(0, values.length - lookback));
  if (slice.length === 0) return null;
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / slice.length;
}

function normalizeIsoDay(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ts = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  return trimmed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
