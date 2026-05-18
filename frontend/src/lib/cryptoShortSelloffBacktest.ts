import { Bar, SignalWeight, buyScore, compositeScore } from "./signals";
import {
  CryptoAutotraderBacktestResult,
  CryptoAutotraderTrade,
  TrendDirection,
} from "./cryptoAutotraderBacktest";
import { runCryptoSelloffDetectionBacktest } from "./cryptoSelloffDetectionBacktest";

const DAY_MS = 86_400_000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const EPSILON = 1e-9;

export interface CryptoShortSelloffBacktestConfig {
  symbol: string;
  hourlyBars: Bar[];
  executionBars: Bar[];
  startDate: string;
  endDate: string;
  totalAmount: number;
  signals: SignalWeight[];
  selloffSignals: SignalWeight[];
  selloffStartThreshold: number;
  selloffEndThreshold: number;
  shortEntryAllocationPct?: number;
  coverWindowHours?: number;
  coverCadenceMinMinutes?: number;
  coverCadenceMaxMinutes?: number;
  minProfitToCoverPct?: number;
  spikeDefenseLookbackMinutes?: number;
  spikeDefenseCooldownMinutes?: number;
  spikeDefensePartialLossPct?: number;
  spikeDefensePartialCoverPct?: number;
  spikeDefenseSevereLossPct?: number;
  spikeDefenseSevereCoverPct?: number;
  spikeDefenseFullStopLossPct?: number;
  slippageBps?: number;
  feeBps?: number;
}

type SelloffTrigger = {
  triggerTs: number;
  closeTs: number;
};

export function runCryptoShortSelloffBacktest(
  cfg: CryptoShortSelloffBacktestConfig
): CryptoAutotraderBacktestResult | null {
  const startTs = Date.parse(`${cfg.startDate}T00:00:00Z`);
  const endTsExclusive = Date.parse(`${cfg.endDate}T00:00:00Z`) + DAY_MS;
  if (!Number.isFinite(startTs) || !Number.isFinite(endTsExclusive) || endTsExclusive <= startTs) {
    return null;
  }

  const shortEntryAllocationPct = clamp(
    Number.isFinite(cfg.shortEntryAllocationPct) ? cfg.shortEntryAllocationPct ?? 0.85 : 0.85,
    0.1,
    1
  );
  const coverWindowHours = clampInt(
    Number.isFinite(cfg.coverWindowHours) ? cfg.coverWindowHours ?? 10 : 10,
    2,
    48
  );
  const coverCadenceMinMinutes = clampInt(
    Number.isFinite(cfg.coverCadenceMinMinutes) ? cfg.coverCadenceMinMinutes ?? 20 : 20,
    5,
    120
  );
  const coverCadenceMaxMinutes = clampInt(
    Number.isFinite(cfg.coverCadenceMaxMinutes) ? cfg.coverCadenceMaxMinutes ?? 30 : 30,
    coverCadenceMinMinutes,
    180
  );
  const minProfitToCoverPct = clamp(
    Number.isFinite(cfg.minProfitToCoverPct) ? cfg.minProfitToCoverPct ?? 0.15 : 0.15,
    0,
    10
  );
  const spikeDefenseLookbackMinutes = clampInt(
    Number.isFinite(cfg.spikeDefenseLookbackMinutes) ? cfg.spikeDefenseLookbackMinutes ?? 90 : 90,
    5,
    24 * 60
  );
  const spikeDefenseCooldownMinutes = clampInt(
    Number.isFinite(cfg.spikeDefenseCooldownMinutes) ? cfg.spikeDefenseCooldownMinutes ?? 10 : 10,
    1,
    180
  );
  const spikeDefensePartialLossPct = clamp(
    Number.isFinite(cfg.spikeDefensePartialLossPct) ? cfg.spikeDefensePartialLossPct ?? 1.2 : 1.2,
    0.1,
    50
  );
  const spikeDefensePartialCoverPct = clamp(
    Number.isFinite(cfg.spikeDefensePartialCoverPct) ? cfg.spikeDefensePartialCoverPct ?? 0.35 : 0.35,
    0.05,
    0.95
  );
  const spikeDefenseSevereLossPct = clamp(
    Number.isFinite(cfg.spikeDefenseSevereLossPct) ? cfg.spikeDefenseSevereLossPct ?? 2.2 : 2.2,
    spikeDefensePartialLossPct + 0.1,
    80
  );
  const spikeDefenseSevereCoverPct = clamp(
    Number.isFinite(cfg.spikeDefenseSevereCoverPct) ? cfg.spikeDefenseSevereCoverPct ?? 0.6 : 0.6,
    0.1,
    0.99
  );
  const spikeDefenseFullStopLossPct = clamp(
    Number.isFinite(cfg.spikeDefenseFullStopLossPct) ? cfg.spikeDefenseFullStopLossPct ?? 4.5 : 4.5,
    spikeDefenseSevereLossPct + 0.1,
    99
  );
  const slippageBps = Number.isFinite(cfg.slippageBps) ? Math.max(0, cfg.slippageBps ?? 0) : 10;
  const feeBps = Number.isFinite(cfg.feeBps) ? Math.max(0, cfg.feeBps ?? 0) : 25;

  const hourlyWindow = cfg.hourlyBars.filter((bar) => {
    const ts = Date.parse(bar.t);
    return Number.isFinite(ts) && ts >= startTs && ts < endTsExclusive && bar.c > 0;
  });
  if (hourlyWindow.length < 24) {
    return null;
  }

  const executionWindow = cfg.executionBars.filter((bar) => {
    const ts = Date.parse(bar.t);
    return Number.isFinite(ts) && ts >= startTs && ts < endTsExclusive && bar.c > 0;
  });
  if (executionWindow.length < 60) {
    return null;
  }

  const selloffDetection = runCryptoSelloffDetectionBacktest({
    symbol: cfg.symbol,
    bars: cfg.hourlyBars,
    startDate: cfg.startDate,
    endDate: cfg.endDate,
    signals: cfg.selloffSignals,
    selloffStartThreshold: cfg.selloffStartThreshold,
    selloffEndThreshold: cfg.selloffEndThreshold,
    minSelloffBars: 2,
    minGapBars: 2,
    volumeLookbackPeriod: 20,
    simulateBarFormation: true,
    barFormationSlices: 8,
  });
  const triggers = buildSelloffTriggers(hourlyWindow, selloffDetection.events);

  let cash = cfg.totalAmount;
  let shortQty = 0;
  let shortEntryCredits = 0;
  let realizedPnlUsd = 0;

  let pendingTriggerCloseTs: number | null = null;
  let selloffModeActive = false;
  let selloffModeEndsTs: number | null = null;
  let selloffModeStartedTs: number | null = null;
  let selloffModeStartQty = 0;
  let nextCoverDueTs: number | null = null;
  let triggerCursor = 0;
  let shortOpenedTs: number | null = null;
  let spikeDefenseStage = 0;
  let lastSpikeDefenseCoverTs: number | null = null;

  let peakEquity = cfg.totalAmount;
  let maxDrawdownPct = 0;

  let openShortCount = 0;
  let coverShortCount = 0;
  const trades: CryptoAutotraderTrade[] = [];
  const equityCurve: CryptoAutotraderBacktestResult["equityCurve"] = [];

  let hourlyIndex = 0;
  for (let i = 0; i < executionWindow.length; i += 1) {
    const bar = executionWindow[i];
    const nowTs = Date.parse(bar.t);
    if (!Number.isFinite(nowTs)) continue;

    while (
      hourlyIndex + 1 < hourlyWindow.length &&
      Date.parse(hourlyWindow[hourlyIndex + 1].t) <= nowTs
    ) {
      hourlyIndex += 1;
    }

    const hourlyBar = hourlyWindow[hourlyIndex];
    if (!hourlyBar) continue;
    const emaSlopeScore = buyScore({ type: "ema_slope_7d" }, hourlyWindow, hourlyIndex);
    const trendDirection: TrendDirection = emaSlopeScore > 0.5 ? "up" : emaSlopeScore < 0.5 ? "down" : "neutral";
    const meanReversionScore = compositeScore(cfg.signals, executionWindow, i);
    const selloffScore = compositeScore(cfg.selloffSignals, executionWindow, i);

    if (pendingTriggerCloseTs !== null && nowTs >= pendingTriggerCloseTs && shortQty > EPSILON) {
      selloffModeActive = true;
      pendingTriggerCloseTs = null;
      selloffModeStartedTs = nowTs;
      selloffModeStartQty = shortQty;
      selloffModeEndsTs = nowTs + coverWindowHours * HOUR_MS;
      nextCoverDueTs =
        nowTs + nextCadenceMinutes(i, coverCadenceMinMinutes, coverCadenceMaxMinutes) * MINUTE_MS;
    }

    while (triggerCursor < triggers.length && nowTs >= triggers[triggerCursor].triggerTs) {
      const trigger = triggers[triggerCursor];
      triggerCursor += 1;

      if (shortQty > EPSILON || pendingTriggerCloseTs !== null || selloffModeActive) {
        continue;
      }

      const targetNotional = cfg.totalAmount * shortEntryAllocationPct;
      if (targetNotional <= 0) continue;
      const execPrice = applySlippage(bar.c, "sell", slippageBps);
      const qty = targetNotional / Math.max(execPrice, EPSILON);
      if (!Number.isFinite(qty) || qty <= EPSILON) continue;
      const grossProceeds = qty * execPrice;
      const feeUsd = (grossProceeds * feeBps) / 10_000;
      const netProceeds = grossProceeds - feeUsd;

      shortQty += qty;
      shortEntryCredits += netProceeds;
      cash += netProceeds;
      openShortCount += 1;

      trades.push({
        date: bar.t,
        side: "sell",
        intent: "open_short",
        trendDirection,
        score: meanReversionScore,
        selloffScore,
        price: execPrice,
        qty,
        notionalUsd: netProceeds,
        positionSideAfter: "short",
        positionQtyAfter: shortQty,
        cashAfter: cash,
        avgEntryPriceAfter: shortEntryCredits / Math.max(shortQty, EPSILON),
      });
      shortOpenedTs = nowTs;
      spikeDefenseStage = 0;
      lastSpikeDefenseCoverTs = null;

      pendingTriggerCloseTs = trigger.closeTs;
      selloffModeActive = false;
      selloffModeEndsTs = null;
      selloffModeStartedTs = null;
      selloffModeStartQty = 0;
      nextCoverDueTs = null;
    }

    let coveredThisBar = false;
    if (shortQty > EPSILON) {
      const entryCredits = Math.max(shortEntryCredits, EPSILON);
      const coverPriceNow = applySlippage(bar.c, "buy", slippageBps);
      const grossCoverCostNow = shortQty * coverPriceNow;
      const coverFeeNow = (grossCoverCostNow * feeBps) / 10_000;
      const fullCoverCostNow = grossCoverCostNow + coverFeeNow;
      const unrealizedPnlIfExitUsd = shortEntryCredits - fullCoverCostNow;
      const adverseLossPct =
        unrealizedPnlIfExitUsd < 0 ? ((-unrealizedPnlIfExitUsd) / entryCredits) * 100 : 0;
      const quickSpikeWindowActive =
        shortOpenedTs !== null &&
        nowTs - shortOpenedTs <= spikeDefenseLookbackMinutes * MINUTE_MS;
      const defenseCooldownActive =
        lastSpikeDefenseCoverTs !== null &&
        nowTs - lastSpikeDefenseCoverTs < spikeDefenseCooldownMinutes * MINUTE_MS;

      let defenseCoverQty = 0;
      let triggeredDefenseStage = spikeDefenseStage;
      let forceFlatFromDefense = false;

      if (adverseLossPct >= spikeDefenseFullStopLossPct) {
        defenseCoverQty = shortQty;
        forceFlatFromDefense = true;
        triggeredDefenseStage = 3;
      } else if (quickSpikeWindowActive && !defenseCooldownActive) {
        if (adverseLossPct >= spikeDefenseSevereLossPct && spikeDefenseStage < 2) {
          defenseCoverQty = shortQty * spikeDefenseSevereCoverPct;
          triggeredDefenseStage = 2;
        } else if (adverseLossPct >= spikeDefensePartialLossPct && spikeDefenseStage < 1) {
          defenseCoverQty = shortQty * spikeDefensePartialCoverPct;
          triggeredDefenseStage = 1;
        }
      }

      defenseCoverQty = clamp(defenseCoverQty, 0, shortQty);
      if (defenseCoverQty > EPSILON) {
        const qtyBefore = shortQty;
        const execPrice = applySlippage(bar.c, "buy", slippageBps);
        const grossCost = defenseCoverQty * execPrice;
        const feeUsd = (grossCost * feeBps) / 10_000;
        const totalCost = grossCost + feeUsd;
        const allocatedCredits =
          shortEntryCredits * (defenseCoverQty / Math.max(qtyBefore, EPSILON));
        const realizedSlicePnlUsd = allocatedCredits - totalCost;

        realizedPnlUsd += realizedSlicePnlUsd;
        cash -= totalCost;
        shortQty = Math.max(0, qtyBefore - defenseCoverQty);
        shortEntryCredits = Math.max(0, shortEntryCredits - allocatedCredits);
        coverShortCount += 1;
        spikeDefenseStage = triggeredDefenseStage;
        lastSpikeDefenseCoverTs = nowTs;
        coveredThisBar = true;

        trades.push({
          date: bar.t,
          side: "buy",
          intent: "cover_short",
          trendDirection,
          score: meanReversionScore,
          selloffScore,
          price: execPrice,
          qty: defenseCoverQty,
          notionalUsd: totalCost,
          positionSideAfter: shortQty > EPSILON ? "short" : "flat",
          positionQtyAfter: shortQty,
          cashAfter: cash,
          avgEntryPriceAfter: shortQty > EPSILON ? shortEntryCredits / shortQty : 0,
        });

        if (shortQty <= EPSILON || forceFlatFromDefense) {
          shortQty = 0;
          shortEntryCredits = 0;
          selloffModeActive = false;
          pendingTriggerCloseTs = null;
          selloffModeEndsTs = null;
          selloffModeStartedTs = null;
          selloffModeStartQty = 0;
          nextCoverDueTs = null;
          shortOpenedTs = null;
          spikeDefenseStage = 0;
          lastSpikeDefenseCoverTs = null;
        } else if (selloffModeActive || pendingTriggerCloseTs !== null) {
          nextCoverDueTs =
            nowTs + nextCadenceMinutes(i + 1, coverCadenceMinMinutes, coverCadenceMaxMinutes) * MINUTE_MS;
        }
      }
    }

    if (!coveredThisBar && selloffModeActive && shortQty > EPSILON && selloffModeEndsTs !== null) {
      const modeExpired = nowTs >= selloffModeEndsTs;
      const cadenceDue = nextCoverDueTs !== null && nowTs >= nextCoverDueTs;
      if (modeExpired || cadenceDue) {
        const qtyBefore = shortQty;
        const modeStartTs =
          selloffModeStartedTs ?? selloffModeEndsTs - coverWindowHours * HOUR_MS;
        const modeStartQty = Math.max(selloffModeStartQty, qtyBefore);
        const modeWindowMs = Math.max(MINUTE_MS, selloffModeEndsTs - modeStartTs);
        let coverQty = qtyBefore;

        if (!modeExpired) {
          // Time-scheduled unwind: cover proportionally to elapsed time in the 10-bar window.
          const elapsedRatio = clamp((nowTs - modeStartTs) / modeWindowMs, 0, 1);
          const targetCoveredQty = modeStartQty * elapsedRatio;
          const alreadyCoveredQty = Math.max(0, modeStartQty - qtyBefore);
          const scheduledQty = targetCoveredQty - alreadyCoveredQty;
          coverQty = clamp(scheduledQty, 0, qtyBefore);
          if (coverQty <= EPSILON) {
            nextCoverDueTs =
              nowTs + nextCadenceMinutes(i + 1, coverCadenceMinMinutes, coverCadenceMaxMinutes) * MINUTE_MS;
            continue;
          }
        }

        const execPrice = applySlippage(bar.c, "buy", slippageBps);
        const grossCost = coverQty * execPrice;
        const feeUsd = (grossCost * feeBps) / 10_000;
        const totalCost = grossCost + feeUsd;
        const allocatedCredits = shortEntryCredits * (coverQty / Math.max(qtyBefore, EPSILON));
        const realizedSlicePnlUsd = allocatedCredits - totalCost;
        const realizedSlicePnlPct =
          allocatedCredits > EPSILON ? (realizedSlicePnlUsd / allocatedCredits) * 100 : Number.NEGATIVE_INFINITY;

        // Only cover early if this slice clears the minimum net profit threshold.
        // At window expiry we always force full exit.
        if (!modeExpired && realizedSlicePnlPct < minProfitToCoverPct) {
          nextCoverDueTs =
            nowTs + nextCadenceMinutes(i + 1, coverCadenceMinMinutes, coverCadenceMaxMinutes) * MINUTE_MS;
          continue;
        }

        realizedPnlUsd += realizedSlicePnlUsd;
        cash -= totalCost;
        shortQty = Math.max(0, qtyBefore - coverQty);
        shortEntryCredits = Math.max(0, shortEntryCredits - allocatedCredits);
        coverShortCount += 1;

        trades.push({
          date: bar.t,
          side: "buy",
          intent: "cover_short",
          trendDirection,
          score: meanReversionScore,
          selloffScore,
          price: execPrice,
          qty: coverQty,
          notionalUsd: totalCost,
          positionSideAfter: shortQty > EPSILON ? "short" : "flat",
          positionQtyAfter: shortQty,
          cashAfter: cash,
          avgEntryPriceAfter: shortQty > EPSILON ? shortEntryCredits / shortQty : 0,
        });

        if (shortQty <= EPSILON || modeExpired) {
          shortQty = Math.max(0, shortQty);
          if (shortQty <= EPSILON) shortEntryCredits = 0;
          selloffModeActive = false;
          pendingTriggerCloseTs = null;
          selloffModeEndsTs = null;
          selloffModeStartedTs = null;
          selloffModeStartQty = 0;
          nextCoverDueTs = null;
          shortOpenedTs = null;
          spikeDefenseStage = 0;
          lastSpikeDefenseCoverTs = null;
        } else {
          nextCoverDueTs =
            nowTs + nextCadenceMinutes(i + 1, coverCadenceMinMinutes, coverCadenceMaxMinutes) * MINUTE_MS;
        }
      }
    }

    const positionValueSigned = -shortQty * bar.c;
    const equity = cash + positionValueSigned;
    if (equity > peakEquity) peakEquity = equity;
    if (peakEquity > EPSILON) {
      const drawdown = ((peakEquity - equity) / peakEquity) * 100;
      maxDrawdownPct = Math.max(maxDrawdownPct, drawdown);
    }

    equityCurve.push({
      t: bar.t,
      equity,
      cash,
      positionValueSigned,
      positionQtySigned: -shortQty,
      emaSlopeScore,
      trendDirection,
      score: meanReversionScore,
      selloffScore,
      selloffActive: selloffModeActive || pendingTriggerCloseTs !== null,
    });
  }

  const lastBar = executionWindow[executionWindow.length - 1];
  if (!lastBar) return null;

  if (shortQty > EPSILON) {
    const execPrice = applySlippage(lastBar.c, "buy", slippageBps);
    const grossCost = shortQty * execPrice;
    const feeUsd = (grossCost * feeBps) / 10_000;
    const totalCost = grossCost + feeUsd;
    realizedPnlUsd += shortEntryCredits - totalCost;
    cash -= totalCost;
    coverShortCount += 1;
    trades.push({
      date: lastBar.t,
      side: "buy",
      intent: "cover_short",
      trendDirection: "neutral",
      score: 0.5,
      selloffScore: 0.5,
      price: execPrice,
      qty: shortQty,
      notionalUsd: totalCost,
      positionSideAfter: "flat",
      positionQtyAfter: 0,
      cashAfter: cash,
      avgEntryPriceAfter: 0,
    });
    shortQty = 0;
    shortEntryCredits = 0;
    shortOpenedTs = null;
    spikeDefenseStage = 0;
    lastSpikeDefenseCoverTs = null;
  }

  const finalPrice = lastBar.c;
  const finalPositionValueSigned = -shortQty * finalPrice;
  const totalEquity = cash + finalPositionValueSigned;
  const unrealizedPnlUsd = shortEntryCredits - shortQty * finalPrice;
  const totalPnlUsd = totalEquity - cfg.totalAmount;
  const totalPnlPct = cfg.totalAmount > 0 ? (totalPnlUsd / cfg.totalAmount) * 100 : 0;

  return {
    symbol: cfg.symbol.trim().toUpperCase(),
    startDate: cfg.startDate,
    endDate: cfg.endDate,
    trades,
    equityCurve,
    finalCash: cash,
    finalPositionSide: shortQty > EPSILON ? "short" : "flat",
    finalPositionQty: shortQty,
    finalPositionValueSigned,
    totalEquity,
    realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd,
    totalPnlPct,
    maxDrawdownPct,
    openLongCount: 0,
    closeLongCount: 0,
    openShortCount,
    coverShortCount,
  };
}

function buildSelloffTriggers(
  hourlyWindow: Bar[],
  events: Array<{ type: string; date: string; reason: string }>
): SelloffTrigger[] {
  const indexByTs = new Map<string, number>();
  hourlyWindow.forEach((bar, idx) => indexByTs.set(bar.t, idx));
  const fallbackDurationMs = resolveBarDurationMs(hourlyWindow, HOUR_MS);
  const byBarTs = new Map<string, SelloffTrigger>();

  for (const event of events) {
    if (event.type !== "selloff_started") continue;
    const idx = indexByTs.get(event.date);
    if (idx == null) continue;
    const barTs = Date.parse(hourlyWindow[idx].t);
    if (!Number.isFinite(barTs)) continue;
    const nextTsRaw = idx + 1 < hourlyWindow.length ? Date.parse(hourlyWindow[idx + 1].t) : NaN;
    const closeTs = Number.isFinite(nextTsRaw) && nextTsRaw > barTs
      ? nextTsRaw
      : barTs + fallbackDurationMs;
    const progress = parseIntrabarProgress(event.reason);
    const triggerTs = barTs + Math.round((closeTs - barTs) * progress);

    const existing = byBarTs.get(event.date);
    if (!existing || triggerTs < existing.triggerTs) {
      byBarTs.set(event.date, { triggerTs, closeTs });
    }
  }

  return Array.from(byBarTs.values()).sort((a, b) => a.triggerTs - b.triggerTs);
}

function resolveBarDurationMs(bars: Bar[], fallbackMs: number): number {
  const gaps: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prevTs = Date.parse(bars[i - 1].t);
    const currTs = Date.parse(bars[i].t);
    const gap = currTs - prevTs;
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return fallbackMs;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? fallbackMs;
}

function parseIntrabarProgress(reason: string): number {
  const match = reason.match(/\(intrabar\s+(\d+)\s*\/\s*(\d+)\)/i);
  if (!match) return 1;
  const step = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0) return 1;
  return clamp(step / total, 0.05, 1);
}

function nextCadenceMinutes(indexSeed: number, minMinutes: number, maxMinutes: number): number {
  if (maxMinutes <= minMinutes) return minMinutes;
  const span = maxMinutes - minMinutes;
  const step = Math.abs((indexSeed * 17 + 13) % (span + 1));
  return minMinutes + step;
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
