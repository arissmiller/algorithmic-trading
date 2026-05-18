import { compositeScore, SignalWeight, Bar } from "./signals";

export interface PerpetualSelloffProtectionConfig {
  signals: SignalWeight[];
  selloffStartThreshold: number;
  selloffEndThreshold: number;
}

export interface PerpetualBacktestConfig {
  symbol: string;
  bars: Bar[];
  startDate: string;
  endDate: string;
  totalAmount: number;
  cadenceDays: number;
  buyThreshold: number;
  sellThreshold: number;
  signals: SignalWeight[];
  selloffProtection?: PerpetualSelloffProtectionConfig;
  slippageBps?: number;
  feeBps?: number;
}

export type PerpetualTradeReason =
  | "buy_signal"
  | "sell_signal"
  | "selloff_exit"
  | "selloff_reentry";

export interface PerpetualTrade {
  date: string;
  side: "buy" | "sell";
  reason: PerpetualTradeReason;
  price: number;
  qty: number;
  notionalUsd: number;
  score: number;
  positionQtyAfter: number;
  cashAfter: number;
  avgCostBasis: number;
}

export interface PerpetualEquityPoint {
  t: string;
  equity: number;
  positionValue: number;
  cash: number;
  score: number;
  buyPaused: boolean;
}

export interface PerpetualBacktestResult {
  symbol: string;
  startDate: string;
  endDate: string;
  trades: PerpetualTrade[];
  equityCurve: PerpetualEquityPoint[];
  totalInvested: number;
  totalProceeds: number;
  finalCash: number;
  finalPositionQty: number;
  finalPositionValue: number;
  totalEquity: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  maxDrawdownPct: number;
  buyCount: number;
  sellCount: number;
  buyPauseCount: number;
}

const DAY_MS = 86_400_000;
const ALLOW_FRACTIONAL = true;
const EPSILON = 1e-9;

function applySlippage(price: number, side: "buy" | "sell", bps: number): number {
  const factor = bps / 10_000;
  return side === "buy" ? price * (1 + factor) : price * (1 - factor);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function runPerpetualBacktest(
  cfg: PerpetualBacktestConfig
): PerpetualBacktestResult | null {
  const slippageBps = cfg.slippageBps ?? 10;
  const feeBps = cfg.feeBps ?? 25;
  const allocationUsd = cfg.totalAmount / 4;
  const hasSelloffProtection = Boolean(
    cfg.selloffProtection &&
      Array.isArray(cfg.selloffProtection.signals) &&
      cfg.selloffProtection.signals.length > 0
  );
  const selloffStartThreshold = hasSelloffProtection
    ? clamp(cfg.selloffProtection!.selloffStartThreshold, 0.05, 0.99)
    : 1;
  const selloffEndThreshold = hasSelloffProtection
    ? clamp(
        Math.min(cfg.selloffProtection!.selloffEndThreshold, selloffStartThreshold - 0.01),
        0.01,
        selloffStartThreshold - 0.01
      )
    : 0;

  const startTs = Date.parse(cfg.startDate);
  const endTs = Date.parse(cfg.endDate) + DAY_MS;
  const windowBars = cfg.bars.filter((b) => {
    const t = Date.parse(b.t);
    return t >= startTs && t < endTs && b.c > 0;
  });

  if (windowBars.length < 2) return null;

  const barIndexMap = new Map<string, number>();
  cfg.bars.forEach((b, i) => barIndexMap.set(b.t, i));

  let cash = cfg.totalAmount;
  let positionQty = 0;
  let avgCostBasis = 0;
  let realizedPnl = 0;
  let totalInvested = 0;
  let totalProceeds = 0;
  let lastBuyTs = -Infinity;
  let lastSellTs = -Infinity;
  let selloffActive = false;
  let buyPauseCount = 0;
  const cadenceMs = cfg.cadenceDays * DAY_MS;

  let peakEquity = cfg.totalAmount;
  let maxDrawdownPct = 0;

  const trades: PerpetualTrade[] = [];
  const equityCurve: PerpetualEquityPoint[] = [];

  for (const bar of windowBars) {
    const barTs = Date.parse(bar.t);
    const globalIdx = barIndexMap.get(bar.t) ?? -1;
    if (globalIdx < 0) continue;

    const score = compositeScore(cfg.signals, cfg.bars, globalIdx);
    const selloffScore = hasSelloffProtection
      ? compositeScore(cfg.selloffProtection!.signals, cfg.bars, globalIdx)
      : 0.5;
    const selloffStartedNow =
      hasSelloffProtection && !selloffActive && selloffScore >= selloffStartThreshold;
    const selloffEndedNow =
      hasSelloffProtection && selloffActive && selloffScore <= selloffEndThreshold;

    if (selloffStartedNow) {
      selloffActive = true;
      buyPauseCount += 1;
    } else if (selloffEndedNow) {
      selloffActive = false;
    }

    let protectionTradedThisBar = false;

    // Forced risk-off liquidation when a selloff starts.
    if (selloffStartedNow && positionQty > 0) {
      const execPrice = applySlippage(bar.c, "sell", slippageBps);
      const qty = ALLOW_FRACTIONAL ? positionQty : Math.floor(positionQty);
      if (qty > 0) {
        const grossProceeds = qty * execPrice;
        const feeUsd = (grossProceeds * feeBps) / 10_000;
        const netProceeds = grossProceeds - feeUsd;
        realizedPnl += netProceeds - qty * avgCostBasis;
        totalProceeds += netProceeds;
        positionQty = Math.max(0, positionQty - qty);
        if (positionQty <= EPSILON) {
          positionQty = 0;
          avgCostBasis = 0;
        }
        cash += netProceeds;
        lastSellTs = barTs;
        protectionTradedThisBar = true;
        trades.push({
          date: bar.t,
          side: "sell",
          reason: "selloff_exit",
          price: execPrice,
          qty,
          notionalUsd: netProceeds,
          score,
          positionQtyAfter: positionQty,
          cashAfter: cash,
          avgCostBasis,
        });
      }
    }

    // Forced full re-entry when selloff stress cools.
    if (selloffEndedNow && cash > 0) {
      const grossBudget = cash;
      const execPrice = applySlippage(bar.c, "buy", slippageBps);
      const feeUsd = (grossBudget * feeBps) / 10_000;
      const netSpend = Math.max(0, grossBudget - feeUsd);
      const qty = ALLOW_FRACTIONAL ? netSpend / execPrice : Math.floor(netSpend / execPrice);
      if (qty > 0) {
        const prevValue = positionQty * avgCostBasis;
        positionQty += qty;
        avgCostBasis = (prevValue + netSpend) / positionQty;
        cash -= grossBudget;
        totalInvested += grossBudget;
        lastBuyTs = barTs;
        protectionTradedThisBar = true;
        trades.push({
          date: bar.t,
          side: "buy",
          reason: "selloff_reentry",
          price: execPrice,
          qty,
          notionalUsd: grossBudget,
          score,
          positionQtyAfter: positionQty,
          cashAfter: cash,
          avgCostBasis,
        });
      }
    }

    if (!selloffActive && !protectionTradedThisBar) {
      // BUY
      if (
        score >= cfg.buyThreshold &&
        cash >= allocationUsd &&
        barTs - lastBuyTs >= cadenceMs
      ) {
        const execPrice = applySlippage(bar.c, "buy", slippageBps);
        const feeUsd = (allocationUsd * feeBps) / 10_000;
        const netSpend = allocationUsd - feeUsd;
        const qty = ALLOW_FRACTIONAL
          ? netSpend / execPrice
          : Math.floor(netSpend / execPrice);
        if (qty > 0) {
          const prevValue = positionQty * avgCostBasis;
          positionQty += qty;
          avgCostBasis = (prevValue + netSpend) / positionQty;
          cash -= allocationUsd;
          totalInvested += allocationUsd;
          lastBuyTs = barTs;
          trades.push({
            date: bar.t,
            side: "buy",
            reason: "buy_signal",
            price: execPrice,
            qty,
            notionalUsd: allocationUsd,
            score,
            positionQtyAfter: positionQty,
            cashAfter: cash,
            avgCostBasis,
          });
        }
      }

      // SELL
      if (
        score <= cfg.sellThreshold &&
        positionQty > 0 &&
        barTs - lastSellTs >= cadenceMs
      ) {
        const execPrice = applySlippage(bar.c, "sell", slippageBps);
        const maxSellValue = positionQty * execPrice;
        const targetValue = Math.min(allocationUsd, maxSellValue);
        const qty = ALLOW_FRACTIONAL
          ? targetValue / execPrice
          : Math.min(Math.floor(targetValue / execPrice), positionQty);
        if (qty > 0) {
          const grossProceeds = qty * execPrice;
          const feeUsd = (grossProceeds * feeBps) / 10_000;
          const netProceeds = grossProceeds - feeUsd;
          realizedPnl += netProceeds - qty * avgCostBasis;
          totalProceeds += netProceeds;
          positionQty = Math.max(0, positionQty - qty);
          if (positionQty <= EPSILON) {
            positionQty = 0;
            avgCostBasis = 0;
          }
          cash += netProceeds;
          lastSellTs = barTs;
          trades.push({
            date: bar.t,
            side: "sell",
            reason: "sell_signal",
            price: execPrice,
            qty,
            notionalUsd: netProceeds,
            score,
            positionQtyAfter: positionQty,
            cashAfter: cash,
            avgCostBasis,
          });
        }
      }
    }

    // Equity curve snapshot after all trades this bar
    const positionValue = positionQty * bar.c;
    const equity = cash + positionValue;
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) {
      const drawdown = ((peakEquity - equity) / peakEquity) * 100;
      maxDrawdownPct = Math.max(maxDrawdownPct, drawdown);
    }
    equityCurve.push({
      t: bar.t,
      equity,
      positionValue,
      cash,
      score,
      buyPaused: selloffActive,
    });
  }

  const finalBar = windowBars[windowBars.length - 1];
  const finalPositionValue = positionQty * finalBar.c;
  const totalEquity = cash + finalPositionValue;
  const unrealizedPnl =
    positionQty > 0 ? finalPositionValue - positionQty * avgCostBasis : 0;
  const totalPnlUsd = realizedPnl + unrealizedPnl;
  const totalPnlPct =
    cfg.totalAmount > 0 ? (totalPnlUsd / cfg.totalAmount) * 100 : 0;

  return {
    symbol: cfg.symbol,
    startDate: cfg.startDate,
    endDate: cfg.endDate,
    trades,
    equityCurve,
    totalInvested,
    totalProceeds,
    finalCash: cash,
    finalPositionQty: positionQty,
    finalPositionValue,
    totalEquity,
    realizedPnlUsd: realizedPnl,
    unrealizedPnlUsd: unrealizedPnl,
    totalPnlUsd,
    totalPnlPct,
    maxDrawdownPct,
    buyCount: trades.filter((t) => t.side === "buy").length,
    sellCount: trades.filter((t) => t.side === "sell").length,
    buyPauseCount,
  };
}
