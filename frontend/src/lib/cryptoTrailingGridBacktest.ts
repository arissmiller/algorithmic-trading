import { Bar, SignalWeight } from "./signals";
import {
  runCryptoSelloffDetectionBacktest,
  SelloffDetectionEvent,
} from "./cryptoSelloffDetectionBacktest";

const DAY_MS = 86_400_000;

// Trailing-grid backtests use the bar that triggers a rebalance as immediately tradable.
// This is intentionally optimistic, but keeping it explicit makes the execution model
// easier to audit and change later if we want stricter next-bar activation.
const ORDER_ACTIVATION_POLICY = "same_bar";

const DEFAULT_PROTECTION_SIGNALS: SignalWeight[] = [
  { signal: { type: "selloff_pressure", period: 8 }, weight: 0.4 },
  { signal: { type: "volume", period: 20 }, weight: 0.25 },
  { signal: { type: "rsi", period: 7 }, weight: 0.15 },
  { signal: { type: "bollinger_band", period: 20, std_dev: 2.5 }, weight: 0.2 },
];

export interface SelloffProtectionConfig {
  enabled: boolean;
  signals?: SignalWeight[];
  selloffStartThreshold: number;  // e.g. 0.74
  selloffEndThreshold: number;    // e.g. 0.56
  liquidateOnSelloff: boolean;    // close all open positions on selloff start
  cooldownBarsAfterEnd: number;   // bars to wait before re-arming buys after selloff ends
}

export interface CryptoTrailingGridBacktestConfig {
  symbol: string;
  bars: Bar[];
  startDate: string;
  endDate: string;
  maPeriod: number;
  rebalanceThresholdPct: number;
  halfRangePct: number;
  gridCount: number;
  spacing: "arithmetic" | "geometric";
  totalCapital: number;
  feeBps: number;
  slippageBps: number;
  selloffProtection?: SelloffProtectionConfig;
}

export interface TrailingGridTrade {
  t: string;
  side: "buy" | "sell";
  gridLevel: number;
  execPrice: number;
  qty: number;
  notionalUsd: number;
  cashAfter: number;
  positionQtyAfter: number;
  rebalanceIndex: number;
  isProtectionLiquidation?: boolean;
}

export interface RebalanceEvent {
  t: string;
  maValue: number;
  newLevels: number[];
}

export interface TrailingGridMovingAveragePoint {
  t: string;
  value: number;
}

export interface TrailingGridOrderSegment {
  startDate: string;
  endDate: string;
  price: number;
  kind: "buy" | "sell";
}

export interface TrailingGridEquityPoint {
  t: string;
  equity: number;
  cash: number;
  positionValue: number;
  positionQty: number;
  price: number;
  maValue: number | null;
  selloffActive: boolean;
}

export interface TrailingGridSummary {
  totalCapital: number;
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;
  totalPnLPct: number;
  totalFeesPaid: number;
  gridCyclesCompleted: number;
  avgPnLPerCycle: number;
  rebalanceCount: number;
  protectionEventsCount: number;
  maxDrawdownPct: number;
  buyAndHoldReturn: number;
  buyAndHoldReturnPct: number;
}

export interface TrailingGridBacktestResult {
  symbol: string;
  startDate: string;
  endDate: string;
  summary: TrailingGridSummary;
  trades: TrailingGridTrade[];
  equityCurve: TrailingGridEquityPoint[];
  rebalanceEvents: RebalanceEvent[];
  protectionEvents: SelloffDetectionEvent[];
  movingAveragePoints: TrailingGridMovingAveragePoint[];
  orderSegments: TrailingGridOrderSegment[];
  barsUsed: Bar[];
}

function buildGridLevels(
  center: number,
  halfRangePct: number,
  count: number,
  spacing: "arithmetic" | "geometric"
): number[] {
  const lower = center * (1 - halfRangePct / 100);
  const upper = center * (1 + halfRangePct / 100);
  const levels: number[] = [];
  for (let i = 0; i <= count; i++) {
    if (spacing === "geometric") {
      levels.push(lower * Math.pow(upper / lower, i / count));
    } else {
      levels.push(lower + (i / count) * (upper - lower));
    }
  }
  return levels;
}

function buildSMA(bars: Bar[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(bars.length).fill(null);
  if (period < 1 || period > bars.length) return result;
  let sum = 0;
  for (let i = 0; i < period - 1; i++) sum += bars[i].c;
  for (let i = period - 1; i < bars.length; i++) {
    sum += bars[i].c;
    result[i] = sum / period;
    sum -= bars[i - period + 1].c;
  }
  return result;
}

function withFriction(price: number, side: "buy" | "sell", totalBps: number): number {
  const impact = totalBps / 10_000;
  return side === "buy" ? price * (1 + impact) : price * (1 - impact);
}

function emptyResult(
  symbol: string,
  startDate: string,
  endDate: string,
  totalCapital: number
): TrailingGridBacktestResult {
  return {
    symbol,
    startDate,
    endDate,
    summary: {
      totalCapital,
      realizedPnL: 0,
      unrealizedPnL: 0,
      totalPnL: 0,
      totalPnLPct: 0,
      totalFeesPaid: 0,
      gridCyclesCompleted: 0,
      avgPnLPerCycle: 0,
      rebalanceCount: 0,
      protectionEventsCount: 0,
      maxDrawdownPct: 0,
      buyAndHoldReturn: 0,
      buyAndHoldReturnPct: 0,
    },
    trades: [],
    equityCurve: [],
    rebalanceEvents: [],
    protectionEvents: [],
    movingAveragePoints: [],
    orderSegments: [],
    barsUsed: [],
  };
}

function selectBarsInWindow(bars: Bar[], startDate: string, endDate: string): Bar[] {
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  const endTsExclusive = Date.parse(`${endDate}T00:00:00Z`) + DAY_MS;
  return bars.filter((bar) => {
    const ts = Date.parse(bar.t);
    return Number.isFinite(ts) && ts >= startTs && ts < endTsExclusive;
  });
}

function orderIsActiveOnBar(openedAt: string, barTime: string): boolean {
  if (ORDER_ACTIVATION_POLICY === "same_bar") {
    return openedAt <= barTime;
  }
  return openedAt < barTime;
}

export function runCryptoTrailingGridBacktest(
  config: CryptoTrailingGridBacktestConfig
): TrailingGridBacktestResult {
  const {
    symbol,
    bars,
    startDate,
    endDate,
    maPeriod,
    rebalanceThresholdPct,
    halfRangePct,
    gridCount,
    spacing,
    totalCapital,
    feeBps,
    slippageBps,
    selloffProtection,
  } = config;

  if (gridCount < 2 || totalCapital <= 0 || halfRangePct <= 0 || maPeriod < 2) {
    return emptyResult(symbol, startDate, endDate, totalCapital);
  }

  const totalBps = feeBps + slippageBps;
  const capitalPerCell = totalCapital / gridCount;

  const allBarsInRange = selectBarsInWindow(bars, startDate, endDate);
  if (allBarsInRange.length === 0) return emptyResult(symbol, startDate, endDate, totalCapital);

  // --- Selloff protection pre-pass ---
  let selloffActiveMap: Map<string, boolean> | null = null;
  let protectionEvents: SelloffDetectionEvent[] = [];

  if (selloffProtection?.enabled) {
    const detectionResult = runCryptoSelloffDetectionBacktest({
      symbol,
      bars, // full array for signal warmup
      startDate,
      endDate,
      signals: selloffProtection.signals ?? DEFAULT_PROTECTION_SIGNALS,
      selloffStartThreshold: selloffProtection.selloffStartThreshold,
      selloffEndThreshold: selloffProtection.selloffEndThreshold,
      minSelloffBars: 2,
      minGapBars: 2,
      volumeLookbackPeriod: 20,
      simulateBarFormation: false,
    });
    selloffActiveMap = new Map(
      detectionResult.scoreTimeline.map((pt) => [pt.date, pt.inSelloff])
    );
    protectionEvents = detectionResult.events;
  }

  // --- SMA series ---
  const smaFull = buildSMA(bars, maPeriod);
  const smaByTime = new Map<string, number | null>();
  for (let i = 0; i < bars.length; i++) smaByTime.set(bars[i].t, smaFull[i]);
  const movingAveragePoints: TrailingGridMovingAveragePoint[] = allBarsInRange.flatMap((bar) => {
    const value = smaByTime.get(bar.t) ?? null;
    return value === null ? [] : [{ t: bar.t, value }];
  });

  const entryPrice = allBarsInRange[0].c;
  const buyAndHoldQty = totalCapital / entryPrice;

  let cash = totalCapital;
  let positionQty = 0;
  let realizedPnL = 0;
  let totalFeesPaid = 0;
  let gridCyclesCompleted = 0;

  const trades: TrailingGridTrade[] = [];
  const equityCurve: TrailingGridEquityPoint[] = [];
  const rebalanceEvents: RebalanceEvent[] = [];
  const orderSegments: TrailingGridOrderSegment[] = [];

  const pendingBuys = new Map<number, { sellPrice: number; openedAt: string }>();
  const pendingSells = new Map<number, { qty: number; buyCost: number; openedAt: string }>();

  let gridCenter: number | null = null;
  let wasInSelloff = false;
  let cooldownBarsRemaining = 0;

  function closePendingBuySegments(endDateValue: string): void {
    for (const [buyPrice, pendingBuy] of Array.from(pendingBuys.entries())) {
      orderSegments.push({
        startDate: pendingBuy.openedAt,
        endDate: endDateValue,
        price: buyPrice,
        kind: "buy",
      });
    }
    pendingBuys.clear();
  }

  function closePendingSellSegments(endDateValue: string): void {
    for (const [sellPrice, position] of Array.from(pendingSells.entries())) {
      orderSegments.push({
        startDate: position.openedAt,
        endDate: endDateValue,
        price: sellPrice,
        kind: "sell",
      });
    }
    pendingSells.clear();
  }

  function rebalance(bar: Bar, maValue: number): void {
    const levels = buildGridLevels(maValue, halfRangePct, gridCount, spacing);
    gridCenter = maValue;
    rebalanceEvents.push({ t: bar.t, maValue, newLevels: levels });
    closePendingBuySegments(bar.t);
    for (let i = 0; i < gridCount; i++) {
      const buyPrice = levels[i];
      const sellPrice = levels[i + 1];
      if (buyPrice >= bar.c) continue;
      if (pendingSells.has(sellPrice)) continue;
      pendingBuys.set(buyPrice, { sellPrice, openedAt: bar.t });
    }
  }

  for (const bar of allBarsInRange) {
    const maValue = smaByTime.get(bar.t) ?? null;
    const inSelloff = selloffActiveMap?.get(bar.t) ?? false;
    const currentEpoch = rebalanceEvents.length - 1;

    // --- Selloff transition: start ---
    if (inSelloff && !wasInSelloff) {
      closePendingBuySegments(bar.t);

      if (selloffProtection?.liquidateOnSelloff && pendingSells.size > 0) {
        for (const [sellPrice, position] of Array.from(pendingSells.entries())) {
          const execPrice = withFriction(bar.c, "sell", totalBps);
          const proceeds = position.qty * execPrice;
          const cyclePnL = proceeds - position.buyCost;
          cash += proceeds;
          positionQty -= position.qty;
          realizedPnL += cyclePnL;
          totalFeesPaid += position.qty * Math.abs(bar.c - execPrice);
          trades.push({
            t: bar.t,
            side: "sell",
            gridLevel: sellPrice,
            execPrice,
            qty: position.qty,
            notionalUsd: proceeds,
            cashAfter: cash,
            positionQtyAfter: positionQty,
            rebalanceIndex: Math.max(0, currentEpoch),
            isProtectionLiquidation: true,
          });
        }
        closePendingSellSegments(bar.t);
      }
    }

    // --- Selloff transition: end ---
    if (!inSelloff && wasInSelloff) {
      cooldownBarsRemaining = selloffProtection?.cooldownBarsAfterEnd ?? 0;
    }

    // --- Rebalancing (skipped during selloff and cooldown) ---
    if (!inSelloff && cooldownBarsRemaining <= 0 && maValue !== null) {
      if (gridCenter === null) {
        rebalance(bar, maValue);
      } else {
        const shift = Math.abs(maValue - gridCenter) / gridCenter;
        if (shift * 100 >= rebalanceThresholdPct) {
          rebalance(bar, maValue);
        }
      }
    }

    // Decrement cooldown after possibly triggering rebalance above
    if (cooldownBarsRemaining > 0) {
      cooldownBarsRemaining--;
      // Rebalance on the bar that ends the cooldown
      if (cooldownBarsRemaining === 0 && maValue !== null) {
        rebalance(bar, maValue);
      }
    }

    function tryBuy(buyPrice: number, pendingBuy: { sellPrice: number; openedAt: string }): void {
      if (!orderIsActiveOnBar(pendingBuy.openedAt, bar.t)) return;
      if (bar.l > buyPrice) return;
      const execPrice = withFriction(buyPrice, "buy", totalBps);
      const qty = capitalPerCell / execPrice;
      const cost = qty * execPrice;
      if (cash < cost) return;

      cash -= cost;
      positionQty += qty;
      totalFeesPaid += qty * (execPrice - buyPrice);
      orderSegments.push({
        startDate: pendingBuy.openedAt,
        endDate: bar.t,
        price: buyPrice,
        kind: "buy",
      });
      pendingBuys.delete(buyPrice);

      trades.push({
        t: bar.t,
        side: "buy",
        gridLevel: buyPrice,
        execPrice,
        qty,
        notionalUsd: cost,
        cashAfter: cash,
        positionQtyAfter: positionQty,
        rebalanceIndex: Math.max(0, rebalanceEvents.length - 1),
      });

      const existing = pendingSells.get(pendingBuy.sellPrice);
      if (existing) {
        pendingSells.set(pendingBuy.sellPrice, {
          qty: existing.qty + qty,
          buyCost: existing.buyCost + cost,
          openedAt: existing.openedAt,
        });
      } else {
        pendingSells.set(pendingBuy.sellPrice, { qty, buyCost: cost, openedAt: bar.t });
      }
    }

    function trySell(
      sellPrice: number,
      position: { qty: number; buyCost: number; openedAt: string }
    ): void {
      if (!orderIsActiveOnBar(position.openedAt, bar.t)) return;
      if (bar.h < sellPrice) return;
      const execPrice = withFriction(sellPrice, "sell", totalBps);
      const proceeds = position.qty * execPrice;
      const cyclePnL = proceeds - position.buyCost;

      cash += proceeds;
      positionQty -= position.qty;
      realizedPnL += cyclePnL;
      gridCyclesCompleted++;
      totalFeesPaid += position.qty * (sellPrice - execPrice);
      orderSegments.push({
        startDate: position.openedAt,
        endDate: bar.t,
        price: sellPrice,
        kind: "sell",
      });
      pendingSells.delete(sellPrice);

      trades.push({
        t: bar.t,
        side: "sell",
        gridLevel: sellPrice,
        execPrice,
        qty: position.qty,
        notionalUsd: proceeds,
        cashAfter: cash,
        positionQtyAfter: positionQty,
        rebalanceIndex: Math.max(0, rebalanceEvents.length - 1),
      });
    }

    const bullish = bar.c >= bar.o;

    if (bullish) {
      // Buys only fire when protection is not active
      if (!inSelloff && cooldownBarsRemaining <= 0) {
        for (const [buyPrice, pendingBuy] of Array.from(pendingBuys.entries()))
          tryBuy(buyPrice, pendingBuy);
      }
      // Sells always fire — let existing positions exit on recovery
      for (const [sellPrice, pos] of Array.from(pendingSells.entries()))
        trySell(sellPrice, pos);
    } else {
      for (const [sellPrice, pos] of Array.from(pendingSells.entries()))
        trySell(sellPrice, pos);
      if (!inSelloff && cooldownBarsRemaining <= 0) {
        for (const [buyPrice, pendingBuy] of Array.from(pendingBuys.entries()))
          tryBuy(buyPrice, pendingBuy);
      }
    }

    wasInSelloff = inSelloff;

    const positionValue = positionQty * bar.c;
    equityCurve.push({
      t: bar.t,
      equity: cash + positionValue,
      cash,
      positionValue,
      positionQty,
      price: bar.c,
      maValue,
      selloffActive: inSelloff,
    });
  }

  const finalPrice = allBarsInRange[allBarsInRange.length - 1].c;
  const finalEquity = cash + positionQty * finalPrice;
  const totalPnL = finalEquity - totalCapital;
  const unrealizedPnL = totalPnL - realizedPnL;
  const buyAndHoldReturn = buyAndHoldQty * finalPrice - totalCapital;

  let maxDrawdownPct = 0;
  let peakEquity = totalCapital;
  for (const pt of equityCurve) {
    if (pt.equity > peakEquity) peakEquity = pt.equity;
    const dd = peakEquity > 0 ? ((peakEquity - pt.equity) / peakEquity) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  const protectionEventsCount = protectionEvents.filter(
    (e) => e.type === "selloff_started"
  ).length;
  const finalBarTime = allBarsInRange[allBarsInRange.length - 1].t;
  closePendingBuySegments(finalBarTime);
  closePendingSellSegments(finalBarTime);

  return {
    symbol,
    startDate,
    endDate,
    summary: {
      totalCapital,
      realizedPnL,
      unrealizedPnL,
      totalPnL,
      totalPnLPct: totalCapital > 0 ? (totalPnL / totalCapital) * 100 : 0,
      totalFeesPaid,
      gridCyclesCompleted,
      avgPnLPerCycle: gridCyclesCompleted > 0 ? realizedPnL / gridCyclesCompleted : 0,
      rebalanceCount: rebalanceEvents.length,
      protectionEventsCount,
      maxDrawdownPct,
      buyAndHoldReturn,
      buyAndHoldReturnPct: totalCapital > 0 ? (buyAndHoldReturn / totalCapital) * 100 : 0,
    },
    trades,
    equityCurve,
    rebalanceEvents,
    protectionEvents,
    movingAveragePoints,
    orderSegments,
    barsUsed: allBarsInRange,
  };
}
