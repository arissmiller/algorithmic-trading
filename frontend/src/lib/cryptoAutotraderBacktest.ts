import { Bar, SignalWeight, buyScore, compositeScore } from "./signals";
import { runCryptoSelloffDetectionBacktest } from "./cryptoSelloffDetectionBacktest";

const DAY_MS = 86_400_000;
const EPSILON = 1e-9;

export type TrendDirection = "up" | "down" | "neutral";
export type CryptoAutotraderTradeIntent =
  | "open_long"
  | "close_long"
  | "open_short"
  | "cover_short";
export type LongExitStyle = "trend" | "momentum";

export interface CryptoAutotraderBacktestConfig {
  symbol: string;
  bars: Bar[];
  startDate: string;
  endDate: string;
  totalAmount: number;
  timeframe?: "1Hour" | "1Day";
  signals: SignalWeight[];
  selloffSignals: SignalWeight[];
  selloffStartThreshold: number;
  selloffEndThreshold: number;
  longTrailingStopPct?: number;
  trailingActivationPct?: number;
  atrPeriod?: number;
  shortStopAtrMult?: number;
  shortTakeProfitRR?: number;
  shortMaxHoldBars?: number;
  shortBreakEvenActivationRR?: number;
  shortBreakEvenLockRR?: number;
  shortTrailActivationRR?: number;
  shortTrailAtrMult?: number;
  longEntrySlopeThreshold?: number;
  longExitSlopeThreshold?: number;
  longExitStyle?: LongExitStyle;
  longStopAtrMult?: number;
  longTakeProfitRR?: number;
  longTrailAtrMult?: number;
  longBreakEvenActivationRR?: number;
  longBreakEvenLockRR?: number;
  longTrailActivationRR?: number;
  allocationUsd?: number;
  slippageBps?: number;
  feeBps?: number;
}

export interface CryptoAutotraderTrade {
  date: string;
  side: "buy" | "sell";
  intent: CryptoAutotraderTradeIntent;
  trendDirection: TrendDirection;
  score: number;
  selloffScore: number;
  price: number;
  qty: number;
  notionalUsd: number;
  positionSideAfter: "long" | "short" | "flat";
  positionQtyAfter: number;
  cashAfter: number;
  avgEntryPriceAfter: number;
}

export interface CryptoAutotraderEquityPoint {
  t: string;
  equity: number;
  cash: number;
  positionValueSigned: number;
  positionQtySigned: number;
  emaSlopeScore: number;
  trendDirection: TrendDirection;
  score: number;
  selloffScore: number;
  selloffActive: boolean;
}

export interface CryptoAutotraderBacktestResult {
  symbol: string;
  startDate: string;
  endDate: string;
  trades: CryptoAutotraderTrade[];
  equityCurve: CryptoAutotraderEquityPoint[];
  finalCash: number;
  finalPositionSide: "long" | "short" | "flat";
  finalPositionQty: number;
  finalPositionValueSigned: number;
  totalEquity: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  maxDrawdownPct: number;
  openLongCount: number;
  closeLongCount: number;
  openShortCount: number;
  coverShortCount: number;
}

function applySlippage(price: number, side: "buy" | "sell", bps: number): number {
  const factor = bps / 10_000;
  return side === "buy" ? price * (1 + factor) : price * (1 - factor);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function safeThreshold(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, 0, 1);
}

function emaSlopeDirection(score: number): TrendDirection {
  if (score > 0.5) return "up";
  if (score < 0.5) return "down";
  return "neutral";
}

function resolveSelloffDetectionTimeframe(
  bars: Bar[],
  windowBars: Bar[],
  timeframe?: "1Hour" | "1Day"
): "1Hour" | "1Day" {
  if (timeframe) return timeframe;
  const source = windowBars.length > 1 ? windowBars : bars;
  const gapsMs: number[] = [];
  for (let i = 1; i < source.length; i += 1) {
    const prevTs = Date.parse(source[i - 1].t);
    const currTs = Date.parse(source[i].t);
    const gapMs = currTs - prevTs;
    if (Number.isFinite(gapMs) && gapMs > 0) gapsMs.push(gapMs);
    if (gapsMs.length >= 60) break;
  }
  if (gapsMs.length === 0) return "1Hour";
  gapsMs.sort((a, b) => a - b);
  const medianGapMs = gapsMs[Math.floor(gapsMs.length / 2)];
  return medianGapMs >= 12 * 60 * 60 * 1000 ? "1Day" : "1Hour";
}

function trueRange(bar: Bar, prevClose: number): number {
  const hl = bar.h - bar.l;
  const hc = Math.abs(bar.h - prevClose);
  const lc = Math.abs(bar.l - prevClose);
  return Math.max(hl, hc, lc);
}

function buildAtrSeries(bars: Bar[], period: number): number[] {
  if (bars.length === 0) return [];
  const atr = new Array<number>(bars.length).fill(Number.NaN);
  const safePeriod = Math.max(2, period);

  let trSum = 0;
  let prevClose = bars[0].c;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const tr = i === 0 ? Math.max(bar.h - bar.l, 0) : Math.max(trueRange(bar, prevClose), 0);
    prevClose = bar.c;

    if (i < safePeriod) {
      trSum += tr;
      if (i === safePeriod - 1) {
        atr[i] = trSum / safePeriod;
      }
      continue;
    }

    const prevAtr = Number.isFinite(atr[i - 1]) ? atr[i - 1] : tr;
    atr[i] = ((prevAtr * (safePeriod - 1)) + tr) / safePeriod;
  }

  const firstDefinedAtr = atr.find((value) => Number.isFinite(value) && value > EPSILON);
  if (firstDefinedAtr && firstDefinedAtr > EPSILON) {
    for (let i = 0; i < atr.length; i += 1) {
      if (Number.isFinite(atr[i]) && atr[i] > EPSILON) break;
      atr[i] = firstDefinedAtr;
    }
  }

  return atr;
}

function resolveAtrAtIndex(atr: number[], bars: Bar[], index: number): number {
  const direct = atr[index];
  if (Number.isFinite(direct) && direct > EPSILON) return direct;

  for (let i = index - 1; i >= 0; i -= 1) {
    const fallback = atr[i];
    if (Number.isFinite(fallback) && fallback > EPSILON) return fallback;
  }

  const bar = bars[index];
  if (!bar) return 1;
  const range = Math.max(bar.h - bar.l, 0);
  if (range > EPSILON) return range;
  return Math.max(bar.c * 0.01, 1e-6);
}

export function runCryptoAutotraderBacktest(
  cfg: CryptoAutotraderBacktestConfig
): CryptoAutotraderBacktestResult | null {
  const slippageBps = Number.isFinite(cfg.slippageBps) ? Math.max(0, cfg.slippageBps ?? 0) : 10;
  const feeBps = Number.isFinite(cfg.feeBps) ? Math.max(0, cfg.feeBps ?? 0) : 25;
  const allocationUsd =
    Number.isFinite(cfg.allocationUsd) && (cfg.allocationUsd ?? 0) > 0
      ? cfg.allocationUsd!
      : cfg.totalAmount / 4;
  const selloffStartThreshold = safeThreshold(cfg.selloffStartThreshold, 0.7);
  const selloffEndThreshold = safeThreshold(cfg.selloffEndThreshold, 0.52);

  const atrPeriod = clampInt(
    Number.isFinite(cfg.atrPeriod) ? cfg.atrPeriod ?? 14 : 14,
    3,
    200
  );
  const shortStopAtrMult = clamp(
    Number.isFinite(cfg.shortStopAtrMult) ? cfg.shortStopAtrMult ?? 1.0 : 1.0,
    0.2,
    20
  );
  const shortTakeProfitRR = clamp(
    Number.isFinite(cfg.shortTakeProfitRR) ? cfg.shortTakeProfitRR ?? 1.3 : 1.3,
    0.2,
    20
  );
  const shortMaxHoldBars = clampInt(
    Number.isFinite(cfg.shortMaxHoldBars)
      ? cfg.shortMaxHoldBars ?? (cfg.timeframe === "1Day" ? 4 : 8)
      : cfg.timeframe === "1Day"
        ? 4
        : 8,
    1,
    1_000
  );
  const shortBreakEvenActivationRR = clamp(
    Number.isFinite(cfg.shortBreakEvenActivationRR) ? cfg.shortBreakEvenActivationRR ?? 0.7 : 0.7,
    0.1,
    10
  );
  const shortBreakEvenLockRR = clamp(
    Number.isFinite(cfg.shortBreakEvenLockRR) ? cfg.shortBreakEvenLockRR ?? 0.05 : 0.05,
    0,
    5
  );
  const shortTrailActivationRR = clamp(
    Number.isFinite(cfg.shortTrailActivationRR) ? cfg.shortTrailActivationRR ?? 1.0 : 1.0,
    0.1,
    10
  );
  const shortTrailAtrMult = clamp(
    Number.isFinite(cfg.shortTrailAtrMult) ? cfg.shortTrailAtrMult ?? 1.2 : 1.2,
    0.2,
    20
  );

  const longExitStyle: LongExitStyle = cfg.longExitStyle === "momentum" ? "momentum" : "trend";
  const longEntrySlopeThreshold = clamp(
    Number.isFinite(cfg.longEntrySlopeThreshold) ? cfg.longEntrySlopeThreshold ?? 0.53 : 0.53,
    0.45,
    0.8
  );
  const longExitSlopeThreshold = clamp(
    Number.isFinite(cfg.longExitSlopeThreshold) ? cfg.longExitSlopeThreshold ?? 0.44 : 0.44,
    0.2,
    0.55
  );
  const longStopAtrMult = clamp(
    Number.isFinite(cfg.longStopAtrMult) ? cfg.longStopAtrMult ?? 1.6 : 1.6,
    0.2,
    20
  );
  const longTakeProfitRR = clamp(
    Number.isFinite(cfg.longTakeProfitRR) ? cfg.longTakeProfitRR ?? 1.8 : 1.8,
    0.2,
    20
  );
  const longTrailAtrMult = clamp(
    Number.isFinite(cfg.longTrailAtrMult) ? cfg.longTrailAtrMult ?? 2.4 : 2.4,
    0.2,
    20
  );
  const longBreakEvenActivationRR = clamp(
    Number.isFinite(cfg.longBreakEvenActivationRR) ? cfg.longBreakEvenActivationRR ?? 0.8 : 0.8,
    0.1,
    10
  );
  const longBreakEvenLockRR = clamp(
    Number.isFinite(cfg.longBreakEvenLockRR) ? cfg.longBreakEvenLockRR ?? 0.05 : 0.05,
    0,
    5
  );
  const longTrailActivationRR = clamp(
    Number.isFinite(cfg.longTrailActivationRR) ? cfg.longTrailActivationRR ?? 1.1 : 1.1,
    0.1,
    10
  );

  const longTrailingStopPct = clamp(
    Number.isFinite(cfg.longTrailingStopPct) ? cfg.longTrailingStopPct ?? 0.04 : 0.04,
    0.001,
    0.5
  );
  const trailingActivationPct = clamp(
    Number.isFinite(cfg.trailingActivationPct) ? cfg.trailingActivationPct ?? 0.01 : 0.01,
    0,
    0.5
  );

  const startTs = Date.parse(`${cfg.startDate}T00:00:00Z`);
  const endTs = Date.parse(`${cfg.endDate}T00:00:00Z`) + DAY_MS;
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
    return null;
  }

  const windowBars = cfg.bars.filter((bar) => {
    const ts = Date.parse(bar.t);
    return Number.isFinite(ts) && ts >= startTs && ts < endTs && bar.c > 0;
  });
  if (windowBars.length < 20) return null;

  const selloffDetectionTimeframe = resolveSelloffDetectionTimeframe(
    cfg.bars,
    windowBars,
    cfg.timeframe
  );
  const minGapBars = selloffDetectionTimeframe === "1Day" ? 3 : 2;
  const volumeLookbackPeriod = selloffDetectionTimeframe === "1Day" ? 30 : 20;
  const barIndexMap = new Map<string, number>();
  cfg.bars.forEach((bar, i) => barIndexMap.set(bar.t, i));

  const selloffDetection = runCryptoSelloffDetectionBacktest({
    symbol: cfg.symbol,
    bars: cfg.bars,
    startDate: cfg.startDate,
    endDate: cfg.endDate,
    signals: cfg.selloffSignals,
    selloffStartThreshold,
    selloffEndThreshold,
    minSelloffBars: 2,
    minGapBars,
    volumeLookbackPeriod,
    simulateBarFormation: true,
    barFormationSlices: selloffDetectionTimeframe === "1Day" ? 6 : 8,
  });
  const eventTypeByBarTs = new Map<
    string,
    { started: boolean; ended: boolean; peakScore: number }
  >();
  for (const event of selloffDetection.events) {
    const existing = eventTypeByBarTs.get(event.date) ?? {
      started: false,
      ended: false,
      peakScore: 0,
    };
    if (event.type === "selloff_started") {
      existing.started = true;
    } else {
      existing.ended = true;
    }
    existing.peakScore = Math.max(existing.peakScore, event.score);
    eventTypeByBarTs.set(event.date, existing);
  }

  const atrSeries = buildAtrSeries(cfg.bars, atrPeriod);

  let cash = cfg.totalAmount;
  let longQty = 0;
  let longEntryNotional = 0;
  let longEntryRiskNotional = 0;
  let longPeakPrice = 0;
  let longBarsHeld = 0;

  let shortQty = 0;
  let shortEntryNotional = 0;
  let shortEntryRiskNotional = 0;
  let shortBarsHeld = 0;
  let shortTroughPrice = 0;

  let realizedPnlUsd = 0;
  let selloffActive = false;

  let peakEquity = cfg.totalAmount;
  let maxDrawdownPct = 0;

  const trades: CryptoAutotraderTrade[] = [];
  const equityCurve: CryptoAutotraderEquityPoint[] = [];

  for (const bar of windowBars) {
    const globalIdx = barIndexMap.get(bar.t);
    if (globalIdx == null) continue;

    const atr = resolveAtrAtIndex(atrSeries, cfg.bars, globalIdx);
    const score = compositeScore(cfg.signals, cfg.bars, globalIdx);
    const emaSlopeScore = buyScore({ type: "ema_slope_7d" }, cfg.bars, globalIdx);
    const trendDirection = emaSlopeDirection(emaSlopeScore);

    const eventState = eventTypeByBarTs.get(bar.t);
    const selloffScore =
      eventState?.peakScore ??
      compositeScore(cfg.selloffSignals, cfg.bars, globalIdx);
    const selloffStartedNow = Boolean(eventState?.started);
    const selloffEndedNow = Boolean(eventState?.ended);
    if (selloffStartedNow) selloffActive = true;
    if (selloffEndedNow) selloffActive = false;

    const longEntrySignal = emaSlopeScore >= longEntrySlopeThreshold && selloffEndedNow;
    const shortEntrySignal = trendDirection === "down" && selloffStartedNow;

    const pushTrade = (trade: CryptoAutotraderTrade) => {
      trades.push(trade);
    };

    if (longQty > 0) {
      longBarsHeld += 1;
      longPeakPrice = Math.max(longPeakPrice, bar.h);
    } else {
      longBarsHeld = 0;
      longPeakPrice = 0;
    }

    if (shortQty > 0) {
      shortBarsHeld += 1;
      shortTroughPrice = shortTroughPrice > 0 ? Math.min(shortTroughPrice, bar.l) : bar.l;
    } else {
      shortBarsHeld = 0;
      shortTroughPrice = 0;
    }

    // Long exits: slope flip, ATR/pct trailing stop, and optional momentum TP.
    if (longQty > 0) {
      const longAvgEntryPrice = longEntryNotional / Math.max(longQty, EPSILON);
      const longRiskPerUnit = longEntryRiskNotional / Math.max(longQty, EPSILON);
      const favorableMove = Math.max(0, longPeakPrice - longAvgEntryPrice);
      const atrTrailStop = longPeakPrice - (atr * longTrailAtrMult);
      const pctTrailingArmed = longPeakPrice >= longAvgEntryPrice * (1 + trailingActivationPct);
      const pctTrailingStop = longPeakPrice * (1 - longTrailingStopPct);
      const longBreakEvenActive = favorableMove >= longRiskPerUnit * longBreakEvenActivationRR;
      const longBreakEvenStop = longAvgEntryPrice + (longRiskPerUnit * longBreakEvenLockRR);
      const atrTrailingArmed = favorableMove >= longRiskPerUnit * longTrailActivationRR;
      let longStopPrice = longAvgEntryPrice - longRiskPerUnit;
      if (longBreakEvenActive) {
        longStopPrice = Math.max(longStopPrice, longBreakEvenStop);
      }
      if (pctTrailingArmed) {
        longStopPrice = Math.max(longStopPrice, pctTrailingStop);
      }
      if (atrTrailingArmed) {
        longStopPrice = Math.max(longStopPrice, atrTrailStop);
      }
      const longMomentumTakeProfit = longAvgEntryPrice + (longRiskPerUnit * longTakeProfitRR);

      const longStopTriggered = bar.l <= longStopPrice;
      const longMomentumTakeProfitHit = longExitStyle === "momentum" && bar.h >= longMomentumTakeProfit;
      const longTrendFlip = emaSlopeScore <= longExitSlopeThreshold;

      if (longTrendFlip || longStopTriggered || longMomentumTakeProfitHit) {
        const rawExitPrice = longStopTriggered
          ? bar.o < longStopPrice
            ? bar.o
            : longStopPrice
          : longMomentumTakeProfitHit
            ? longMomentumTakeProfit
            : bar.c;
        const execPrice = applySlippage(rawExitPrice, "sell", slippageBps);
        const qty = longQty;
        const grossProceeds = qty * execPrice;
        const feeUsd = (grossProceeds * feeBps) / 10_000;
        const netProceeds = grossProceeds - feeUsd;
        const allocatedCostBasis = (longEntryNotional * qty) / Math.max(longQty, EPSILON);
        realizedPnlUsd += netProceeds - allocatedCostBasis;
        cash += netProceeds;
        longQty = 0;
        longEntryNotional = 0;
        longEntryRiskNotional = 0;
        longPeakPrice = 0;
        longBarsHeld = 0;
        pushTrade({
          date: bar.t,
          side: "sell",
          intent: "close_long",
          trendDirection,
          score,
          selloffScore,
          price: execPrice,
          qty,
          notionalUsd: netProceeds,
          positionSideAfter: "flat",
          positionQtyAfter: 0,
          cashAfter: cash,
          avgEntryPriceAfter: 0,
        });
      }
    }

    // Short exits: trend flip / long entry, ATR stop, fixed RR take-profit, time-stop.
    if (shortQty > 0) {
      const shortAvgEntryPrice = shortEntryNotional / Math.max(shortQty, EPSILON);
      const shortRiskPerUnit = shortEntryRiskNotional / Math.max(shortQty, EPSILON);
      const favorableMove = Math.max(0, shortAvgEntryPrice - shortTroughPrice);
      const shortInitialStopPrice = shortAvgEntryPrice + shortRiskPerUnit;
      const shortBreakEvenActive = favorableMove >= shortRiskPerUnit * shortBreakEvenActivationRR;
      const shortBreakEvenStop = shortAvgEntryPrice - (shortRiskPerUnit * shortBreakEvenLockRR);
      const shortTrailActive = favorableMove >= shortRiskPerUnit * shortTrailActivationRR;
      const shortTrailStop = shortTroughPrice + (atr * shortTrailAtrMult);
      let shortStopPrice = shortInitialStopPrice;
      if (shortBreakEvenActive) {
        shortStopPrice = Math.min(shortStopPrice, shortBreakEvenStop);
      }
      if (shortTrailActive) {
        shortStopPrice = Math.min(shortStopPrice, shortTrailStop);
      }
      const shortTakeProfitPrice = shortAvgEntryPrice - (shortRiskPerUnit * shortTakeProfitRR);
      const shortStopTriggered = bar.h >= shortStopPrice;
      const shortTakeProfitHit = bar.l <= shortTakeProfitPrice;
      const shortTimeStopHit = shortBarsHeld >= shortMaxHoldBars;
      const shortTrendFlip = trendDirection === "up" || longEntrySignal;

      if (shortTrendFlip || shortStopTriggered || shortTakeProfitHit || shortTimeStopHit) {
        const rawExitPrice = shortStopTriggered
          ? bar.o > shortStopPrice
            ? bar.o
            : shortStopPrice
          : shortTakeProfitHit
            ? shortTakeProfitPrice
            : bar.c;
        const execPrice = applySlippage(rawExitPrice, "buy", slippageBps);
        const qty = shortQty;
        const grossCost = qty * execPrice;
        const feeUsd = (grossCost * feeBps) / 10_000;
        const netCost = grossCost + feeUsd;
        const allocatedShortBasis = (shortEntryNotional * qty) / Math.max(shortQty, EPSILON);
        realizedPnlUsd += allocatedShortBasis - netCost;
        cash -= netCost;
        shortQty = 0;
        shortEntryNotional = 0;
        shortEntryRiskNotional = 0;
        shortBarsHeld = 0;
        shortTroughPrice = 0;
        pushTrade({
          date: bar.t,
          side: "buy",
          intent: "cover_short",
          trendDirection,
          score,
          selloffScore,
          price: execPrice,
          qty,
          notionalUsd: netCost,
          positionSideAfter: "flat",
          positionQtyAfter: 0,
          cashAfter: cash,
          avgEntryPriceAfter: 0,
        });
      }
    }

    // Entries are event-driven and can scale into an existing side.
    if (shortEntrySignal && longQty <= 0) {
      const execPrice = applySlippage(bar.c, "sell", slippageBps);
      const qty = allocationUsd / Math.max(execPrice, EPSILON);
      const grossProceeds = qty * execPrice;
      const feeUsd = (grossProceeds * feeBps) / 10_000;
      const netProceeds = grossProceeds - feeUsd;
      const riskPerUnit = atr * shortStopAtrMult;

      cash += netProceeds;
      shortQty += qty;
      shortEntryNotional += netProceeds;
      shortEntryRiskNotional += qty * riskPerUnit;
      if (shortBarsHeld <= 0) shortBarsHeld = 1;
      shortTroughPrice = shortTroughPrice > 0 ? Math.min(shortTroughPrice, execPrice) : execPrice;

      pushTrade({
        date: bar.t,
        side: "sell",
        intent: "open_short",
        trendDirection,
        score,
        selloffScore,
        price: execPrice,
        qty,
        notionalUsd: netProceeds,
        positionSideAfter: "short",
        positionQtyAfter: shortQty,
        cashAfter: cash,
        avgEntryPriceAfter: shortEntryNotional / Math.max(shortQty, EPSILON),
      });
    } else if (longEntrySignal && shortQty <= 0) {
      const execPrice = applySlippage(bar.c, "buy", slippageBps);
      const qty = allocationUsd / Math.max(execPrice, EPSILON);
      const grossCost = qty * execPrice;
      const feeUsd = (grossCost * feeBps) / 10_000;
      const totalCost = grossCost + feeUsd;
      if (cash >= totalCost) {
        const riskPerUnit = atr * longStopAtrMult;
        cash -= totalCost;
        longQty += qty;
        longEntryNotional += totalCost;
        longEntryRiskNotional += qty * riskPerUnit;
        if (longPeakPrice <= 0) longPeakPrice = execPrice;
        else longPeakPrice = Math.max(longPeakPrice, execPrice);
        if (longBarsHeld <= 0) longBarsHeld = 1;

        pushTrade({
          date: bar.t,
          side: "buy",
          intent: "open_long",
          trendDirection,
          score,
          selloffScore,
          price: execPrice,
          qty,
          notionalUsd: totalCost,
          positionSideAfter: "long",
          positionQtyAfter: longQty,
          cashAfter: cash,
          avgEntryPriceAfter: longEntryNotional / Math.max(longQty, EPSILON),
        });
      }
    }

    const longValue = longQty * bar.c;
    const shortLiability = shortQty * bar.c;
    const positionValueSigned = longValue - shortLiability;
    const positionQtySigned = longQty > 0 ? longQty : shortQty > 0 ? -shortQty : 0;
    const equity = cash + positionValueSigned;
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) {
      const dd = ((peakEquity - equity) / peakEquity) * 100;
      maxDrawdownPct = Math.max(maxDrawdownPct, dd);
    }

    equityCurve.push({
      t: bar.t,
      equity,
      cash,
      positionValueSigned,
      positionQtySigned,
      emaSlopeScore,
      trendDirection,
      score,
      selloffScore,
      selloffActive,
    });
  }

  if (equityCurve.length === 0) return null;
  const finalBar = windowBars[windowBars.length - 1];
  const finalPositionValueSigned = longQty > 0 ? longQty * finalBar.c : shortQty > 0 ? -shortQty * finalBar.c : 0;
  const totalEquity = cash + finalPositionValueSigned;
  const longUnrealized = longQty > 0 ? longQty * finalBar.c - longEntryNotional : 0;
  const shortUnrealized = shortQty > 0 ? shortEntryNotional - shortQty * finalBar.c : 0;
  const unrealizedPnlUsd = longUnrealized + shortUnrealized;
  const totalPnlUsd = realizedPnlUsd + unrealizedPnlUsd;
  const totalPnlPct = cfg.totalAmount > 0 ? (totalPnlUsd / cfg.totalAmount) * 100 : 0;

  const openLongCount = trades.filter((trade) => trade.intent === "open_long").length;
  const closeLongCount = trades.filter((trade) => trade.intent === "close_long").length;
  const openShortCount = trades.filter((trade) => trade.intent === "open_short").length;
  const coverShortCount = trades.filter((trade) => trade.intent === "cover_short").length;

  return {
    symbol: cfg.symbol,
    startDate: cfg.startDate,
    endDate: cfg.endDate,
    trades,
    equityCurve,
    finalCash: cash,
    finalPositionSide: longQty > 0 ? "long" : shortQty > 0 ? "short" : "flat",
    finalPositionQty: longQty > 0 ? longQty : shortQty > 0 ? shortQty : 0,
    finalPositionValueSigned,
    totalEquity,
    realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd,
    totalPnlPct,
    maxDrawdownPct,
    openLongCount,
    closeLongCount,
    openShortCount,
    coverShortCount,
  };
}
