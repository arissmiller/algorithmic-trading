import { Bar } from "./signals";

export interface CryptoGridBacktestConfig {
  symbol: string;
  bars: Bar[];
  startDate: string;
  endDate: string;
  lowerBound: number;
  upperBound: number;
  gridCount: number;
  spacing: "arithmetic" | "geometric";
  gridType: "long" | "neutral";
  totalCapital: number;
  feeBps: number;
  slippageBps: number;
}

export interface GridBacktestTrade {
  t: string;
  side: "buy" | "sell";
  gridLevel: number;
  levelIndex: number;
  execPrice: number;
  qty: number;
  notionalUsd: number;
  cashAfter: number;
  positionQtyAfter: number;
  pairedBuyIndex?: number;
}

export interface GridBacktestSummary {
  totalCapital: number;
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;
  totalPnLPct: number;
  totalFeesPaid: number;
  gridCyclesCompleted: number;
  avgPnLPerCycle: number;
  maxDrawdownPct: number;
  buyAndHoldReturn: number;
  buyAndHoldReturnPct: number;
}

export interface GridEquityPoint {
  t: string;
  equity: number;
  cash: number;
  positionValue: number;
  positionQty: number;
  price: number;
}

export interface GridBacktestResult {
  symbol: string;
  startDate: string;
  endDate: string;
  gridLevels: number[];
  summary: GridBacktestSummary;
  trades: GridBacktestTrade[];
  equityCurve: GridEquityPoint[];
  barsUsed: Bar[];
}

function buildGridLevels(
  lower: number,
  upper: number,
  count: number,
  spacing: "arithmetic" | "geometric"
): number[] {
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

// Applies fee+slippage as a price impact. Buys cost more; sells receive less.
function withFriction(price: number, side: "buy" | "sell", totalBps: number): number {
  const impact = totalBps / 10_000;
  return side === "buy" ? price * (1 + impact) : price * (1 - impact);
}

function emptyResult(
  symbol: string,
  startDate: string,
  endDate: string,
  levels: number[],
  totalCapital: number
): GridBacktestResult {
  return {
    symbol,
    startDate,
    endDate,
    gridLevels: levels,
    summary: {
      totalCapital,
      realizedPnL: 0,
      unrealizedPnL: 0,
      totalPnL: 0,
      totalPnLPct: 0,
      totalFeesPaid: 0,
      gridCyclesCompleted: 0,
      avgPnLPerCycle: 0,
      maxDrawdownPct: 0,
      buyAndHoldReturn: 0,
      buyAndHoldReturnPct: 0,
    },
    trades: [],
    equityCurve: [],
    barsUsed: [],
  };
}

export function runCryptoGridBacktest(config: CryptoGridBacktestConfig): GridBacktestResult {
  const {
    symbol,
    bars,
    startDate,
    endDate,
    lowerBound,
    upperBound,
    gridCount,
    spacing,
    gridType,
    totalCapital,
    feeBps,
    slippageBps,
  } = config;

  if (lowerBound <= 0 || upperBound <= lowerBound || gridCount < 2 || totalCapital <= 0) {
    return emptyResult(symbol, startDate, endDate, [], totalCapital);
  }

  const totalBps = feeBps + slippageBps;
  const levels = buildGridLevels(lowerBound, upperBound, gridCount, spacing);
  const capitalPerCell = totalCapital / gridCount;

  const filteredBars = bars.filter((b) => b.t >= startDate && b.t <= endDate);
  if (filteredBars.length === 0) {
    return emptyResult(symbol, startDate, endDate, levels, totalCapital);
  }

  const entryPrice = filteredBars[0].c;
  const buyAndHoldQty = totalCapital / entryPrice;

  let cash = totalCapital;
  let positionQty = 0;
  let realizedPnL = 0;
  let totalFeesPaid = 0;
  let gridCyclesCompleted = 0;

  const trades: GridBacktestTrade[] = [];
  const equityCurve: GridEquityPoint[] = [];

  // Active order state keyed by level index
  const pendingBuys = new Set<number>();
  const pendingSells = new Set<number>();
  // For pending sells: cost of the buy that opened it, qty bought, and trades[] index
  const sellBuyCost = new Map<number, number>();
  const sellBuyQty = new Map<number, number>();
  const sellBuyTradeIdx = new Map<number, number>();

  // Initialize pending orders
  for (let i = 0; i <= gridCount; i++) {
    const levelPrice = levels[i];

    if (levelPrice < entryPrice) {
      // Level below entry → pending buy
      pendingBuys.add(i);
    } else if (gridType === "neutral" && levelPrice > entryPrice && i > 0) {
      // Level above entry → pre-buy inventory at entry price, then plan to sell at this level
      const qty = capitalPerCell / entryPrice;
      const execBuyPrice = withFriction(entryPrice, "buy", totalBps);
      const cost = qty * execBuyPrice;
      if (cash >= cost) {
        cash -= cost;
        positionQty += qty;
        totalFeesPaid += qty * (execBuyPrice - entryPrice);

        pendingSells.add(i);
        sellBuyCost.set(i, cost);
        sellBuyQty.set(i, qty);
        // No trades[] entry for initialization buys — they're pre-simulation setup
      }
    }
  }

  // Per-bar simulation
  for (const bar of filteredBars) {
    // Determine likely intrabar order: bullish bars go low→high; bearish go high→low
    const bullish = bar.c >= bar.o;

    function tryBuy(i: number): void {
      if (!pendingBuys.has(i)) return;
      const levelPrice = levels[i];
      if (bar.l > levelPrice) return; // didn't reach this level

      const execPrice = withFriction(levelPrice, "buy", totalBps);
      const qty = capitalPerCell / execPrice;
      const cost = qty * execPrice;
      if (cash < cost) return;

      cash -= cost;
      positionQty += qty;
      totalFeesPaid += qty * (execPrice - levelPrice);
      pendingBuys.delete(i);

      const tradeIdx = trades.length;
      trades.push({
        t: bar.t,
        side: "buy",
        gridLevel: levelPrice,
        levelIndex: i,
        execPrice,
        qty,
        notionalUsd: cost,
        cashAfter: cash,
        positionQtyAfter: positionQty,
      });

      // Place sell at the level above
      const sellIdx = i + 1;
      if (sellIdx <= gridCount) {
        pendingSells.add(sellIdx);
        sellBuyCost.set(sellIdx, cost);
        sellBuyQty.set(sellIdx, qty);
        sellBuyTradeIdx.set(sellIdx, tradeIdx);
      }
    }

    function trySell(i: number): void {
      if (!pendingSells.has(i)) return;
      const levelPrice = levels[i];
      if (bar.h < levelPrice) return; // didn't reach this level

      const qty = sellBuyQty.get(i) ?? 0;
      if (qty <= 0) return;

      const execPrice = withFriction(levelPrice, "sell", totalBps);
      const proceeds = qty * execPrice;
      const buyCost = sellBuyCost.get(i) ?? 0;
      const cyclePnL = proceeds - buyCost;

      cash += proceeds;
      positionQty -= qty;
      realizedPnL += cyclePnL;
      gridCyclesCompleted++;
      totalFeesPaid += qty * (levelPrice - execPrice);

      const pairedBuyIndex = sellBuyTradeIdx.get(i);
      pendingSells.delete(i);
      sellBuyCost.delete(i);
      sellBuyQty.delete(i);
      sellBuyTradeIdx.delete(i);

      trades.push({
        t: bar.t,
        side: "sell",
        gridLevel: levelPrice,
        levelIndex: i,
        execPrice,
        qty,
        notionalUsd: proceeds,
        cashAfter: cash,
        positionQtyAfter: positionQty,
        pairedBuyIndex,
      });

      // Re-arm the buy one level below
      const buyIdx = i - 1;
      if (buyIdx >= 0) {
        pendingBuys.add(buyIdx);
      }
    }

    if (bullish) {
      // Low first → process buys bottom-up, then sells bottom-up
      for (let i = 0; i <= gridCount; i++) tryBuy(i);
      for (let i = 0; i <= gridCount; i++) trySell(i);
    } else {
      // High first → process sells top-down, then buys top-down
      for (let i = gridCount; i >= 0; i--) trySell(i);
      for (let i = gridCount; i >= 0; i--) tryBuy(i);
    }

    const positionValue = positionQty * bar.c;
    equityCurve.push({
      t: bar.t,
      equity: cash + positionValue,
      cash,
      positionValue,
      positionQty,
      price: bar.c,
    });
  }

  const finalPrice = filteredBars[filteredBars.length - 1].c;
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
    gridLevels: levels,
    summary: {
      totalCapital,
      realizedPnL,
      unrealizedPnL,
      totalPnL,
      totalPnLPct: totalCapital > 0 ? (totalPnL / totalCapital) * 100 : 0,
      totalFeesPaid,
      gridCyclesCompleted,
      avgPnLPerCycle: gridCyclesCompleted > 0 ? realizedPnL / gridCyclesCompleted : 0,
      maxDrawdownPct,
      buyAndHoldReturn,
      buyAndHoldReturnPct: totalCapital > 0 ? (buyAndHoldReturn / totalCapital) * 100 : 0,
    },
    trades,
    equityCurve,
    barsUsed: filteredBars,
  };
}
