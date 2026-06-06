import { Bar } from "./signals";

export interface CryptoTrailingGridBacktestConfig {
  symbol: string;
  bars: Bar[];
  startDate: string;
  endDate: string;
  maPeriod: number;              // SMA period used to track grid center (e.g. 20)
  rebalanceThresholdPct: number; // % shift in MA before recentering grid (e.g. 3)
  halfRangePct: number;          // grid extends ±halfRangePct% from MA center (e.g. 10)
  gridCount: number;             // number of cells
  spacing: "arithmetic" | "geometric";
  totalCapital: number;
  feeBps: number;
  slippageBps: number;
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
  rebalanceIndex: number; // which epoch this trade belongs to
}

export interface RebalanceEvent {
  t: string;
  maValue: number;
  newLevels: number[];
}

export interface TrailingGridEquityPoint {
  t: string;
  equity: number;
  cash: number;
  positionValue: number;
  positionQty: number;
  price: number;
  maValue: number | null;
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
      maxDrawdownPct: 0,
      buyAndHoldReturn: 0,
      buyAndHoldReturnPct: 0,
    },
    trades: [],
    equityCurve: [],
    rebalanceEvents: [],
    barsUsed: [],
  };
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
  } = config;

  if (gridCount < 2 || totalCapital <= 0 || halfRangePct <= 0 || maPeriod < 2) {
    return emptyResult(symbol, startDate, endDate, totalCapital);
  }

  const totalBps = feeBps + slippageBps;
  const capitalPerCell = totalCapital / gridCount;

  // Need enough bars before startDate for MA warmup
  const allBarsInRange = bars.filter((b) => b.t >= startDate && b.t <= endDate);
  if (allBarsInRange.length === 0) return emptyResult(symbol, startDate, endDate, totalCapital);

  // Build SMA over all bars (including pre-startDate), then index them
  const smaFull = buildSMA(bars, maPeriod);
  // Map bar timestamps to their SMA values
  const smaByTime = new Map<string, number | null>();
  for (let i = 0; i < bars.length; i++) smaByTime.set(bars[i].t, smaFull[i]);

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

  // pendingBuys: buyPrice → sellPrice (both are grid level prices)
  const pendingBuys = new Map<number, number>();

  // pendingSells: sellPrice → { qty, buyCost }
  const pendingSells = new Map<number, { qty: number; buyCost: number }>();

  let gridCenter: number | null = null;

  function rebalance(bar: Bar, maValue: number): void {
    const levels = buildGridLevels(maValue, halfRangePct, gridCount, spacing);
    gridCenter = maValue;

    rebalanceEvents.push({ t: bar.t, maValue, newLevels: levels });

    // Cancel all pending buys — capital wasn't reserved, so no effect on cash
    pendingBuys.clear();

    // Arm new buy orders for levels below current price
    for (let i = 0; i < gridCount; i++) {
      const buyPrice = levels[i];
      const sellPrice = levels[i + 1];
      if (buyPrice >= bar.c) continue; // only arm buys below current price
      // Skip if we already have a pending sell targeting this sell level (would double-buy same cell)
      if (pendingSells.has(sellPrice)) continue;
      pendingBuys.set(buyPrice, sellPrice);
    }
  }

  for (const bar of allBarsInRange) {
    const maValue = smaByTime.get(bar.t) ?? null;

    // Check if we need to initialize or rebalance
    if (maValue !== null) {
      if (gridCenter === null) {
        // First valid MA — initialize the grid
        rebalance(bar, maValue);
      } else {
        const shift = Math.abs(maValue - gridCenter) / gridCenter;
        if (shift * 100 >= rebalanceThresholdPct) {
          rebalance(bar, maValue);
        }
      }
    }

    const bullish = bar.c >= bar.o;
    const currentEpoch = rebalanceEvents.length - 1;

    function tryBuy(buyPrice: number, sellPrice: number): void {
      if (bar.l > buyPrice) return;
      const execPrice = withFriction(buyPrice, "buy", totalBps);
      const qty = capitalPerCell / execPrice;
      const cost = qty * execPrice;
      if (cash < cost) return;

      cash -= cost;
      positionQty += qty;
      totalFeesPaid += qty * (execPrice - buyPrice);
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
        rebalanceIndex: currentEpoch,
      });

      // Place sell at sellPrice — if already occupied, place at same price with combined qty
      const existing = pendingSells.get(sellPrice);
      if (existing) {
        // Merge: combine qty and cost (weighted average isn't needed; track total)
        pendingSells.set(sellPrice, {
          qty: existing.qty + qty,
          buyCost: existing.buyCost + cost,
        });
      } else {
        pendingSells.set(sellPrice, { qty, buyCost: cost });
      }
    }

    function trySell(sellPrice: number, position: { qty: number; buyCost: number }): void {
      if (bar.h < sellPrice) return;
      const execPrice = withFriction(sellPrice, "sell", totalBps);
      const proceeds = position.qty * execPrice;
      const cyclePnL = proceeds - position.buyCost;

      cash += proceeds;
      positionQty -= position.qty;
      realizedPnL += cyclePnL;
      gridCyclesCompleted++;
      totalFeesPaid += position.qty * (sellPrice - execPrice);
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
        rebalanceIndex: currentEpoch,
      });
      // Capital returns to cash; next rebalance will re-deploy if appropriate
    }

    if (bullish) {
      for (const [buyPrice, sellPrice] of Array.from(pendingBuys.entries())) tryBuy(buyPrice, sellPrice);
      for (const [sellPrice, pos] of Array.from(pendingSells.entries())) trySell(sellPrice, pos);
    } else {
      for (const [sellPrice, pos] of Array.from(pendingSells.entries())) trySell(sellPrice, pos);
      for (const [buyPrice, sellPrice] of Array.from(pendingBuys.entries())) tryBuy(buyPrice, sellPrice);
    }

    const positionValue = positionQty * bar.c;
    equityCurve.push({
      t: bar.t,
      equity: cash + positionValue,
      cash,
      positionValue,
      positionQty,
      price: bar.c,
      maValue,
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
      maxDrawdownPct,
      buyAndHoldReturn,
      buyAndHoldReturnPct: totalCapital > 0 ? (buyAndHoldReturn / totalCapital) * 100 : 0,
    },
    trades,
    equityCurve,
    rebalanceEvents,
    barsUsed: allBarsInRange,
  };
}
