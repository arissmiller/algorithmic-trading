import { Bar, SignalWeight, compositeScore, scoreRationale } from "./signals";

export type Direction = "scale_in" | "scale_out";

export interface ScheduledTrade {
  // ISO timestamp of the scheduled decision/execution anchor.
  date: string;
  amountUsd: number;
  signalScore: number;
  rationale: string;
}

/**
 * Generate a smart-weighted DCA schedule.
 *
 * The window is divided into `nTranches` equal time segments.
 * For each segment we take the first available bar at/after the segment start,
 * so every decision is made with data available at that moment (causal, no lookahead).
 * Allocation is blended between equal-DCA (aggressiveness=0) and
 * signal-weighted sizing (aggressiveness=1) using only running scores observed so far.
 *
 * `bars` should include ~60 days of look-back before startDate so
 * indicators have enough warm-up data.
 */
export function generateSchedule(
  bars: Bar[],
  startDate: string,
  windowDays: number,
  nTranches: number,
  totalAmount: number,
  direction: Direction,
  aggressiveness: number,
  signals: SignalWeight[]
): ScheduledTrade[] {
  const start = new Date(startDate).getTime();
  const end = start + windowDays * 86_400_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  if (nTranches <= 0 || totalAmount <= 0) return [];

  const isScaleOut = direction === "scale_out";
  const clampedAggressiveness = clamp(aggressiveness, 0, 1);

  const windowBars: Array<{ index: number; ts: number }> = [];
  for (let i = 0; i < bars.length; i++) {
    const ts = new Date(bars[i].t).getTime();
    if (!Number.isFinite(ts)) continue;
    if (ts >= start && ts < end) {
      windowBars.push({ index: i, ts });
    }
  }
  if (windowBars.length === 0) return [];

  const n = Math.min(Math.max(1, Math.floor(nTranches)), windowBars.length);
  const segmentMs = (end - start) / n;
  const selectedIdxs: number[] = [];
  let cursor = 0;
  for (let tranche = 0; tranche < n; tranche++) {
    const segmentStartTs = start + tranche * segmentMs;
    while (cursor < windowBars.length && windowBars[cursor].ts < segmentStartTs) {
      cursor += 1;
    }
    if (cursor >= windowBars.length) break;
    selectedIdxs.push(windowBars[cursor].index);
    cursor += 1;
  }
  if (selectedIdxs.length === 0) return [];

  const rawAmounts: number[] = [];
  const scores: number[] = [];
  let remainingAmount = totalAmount;
  let runningScoreSum = 0;

  for (let i = 0; i < selectedIdxs.length; i++) {
    const globalIdx = selectedIdxs[i];
    const rawScore = compositeScore(signals, bars, globalIdx);
    const score = isScaleOut ? 1 - rawScore : rawScore;
    scores.push(score);

    const remainingTranches = selectedIdxs.length - i;
    const equalShare = remainingTranches > 0 ? remainingAmount / remainingTranches : 0;

    runningScoreSum += score;
    const runningAvgScore = runningScoreSum / (i + 1);
    const smartAmount =
      runningAvgScore > 1e-9 ? (score / runningAvgScore) * equalShare : equalShare;
    const blended =
      (1 - clampedAggressiveness) * equalShare + clampedAggressiveness * smartAmount;
    const floored = Math.max(blended, equalShare * 0.2);
    const amount =
      i === selectedIdxs.length - 1
        ? remainingAmount
        : Math.min(Math.max(floored, 0), remainingAmount);

    rawAmounts.push(amount);
    remainingAmount = Math.max(0, remainingAmount - amount);
  }

  const roundedAmounts = rawAmounts.map((amount) => roundToCents(amount));
  const roundedTotal = roundedAmounts.reduce((sum, amount) => sum + amount, 0);
  const roundingDelta = roundToCents(totalAmount - roundedTotal);
  if (roundedAmounts.length > 0) {
    const last = roundedAmounts.length - 1;
    roundedAmounts[last] = roundToCents(Math.max(0, roundedAmounts[last] + roundingDelta));
  }

  const trades: ScheduledTrade[] = [];
  for (let i = 0; i < selectedIdxs.length; i++) {
    const globalIdx = selectedIdxs[i];
    trades.push({
      date: bars[globalIdx].t,
      amountUsd: roundedAmounts[i],
      signalScore: scores[i],
      rationale: scoreRationale(signals, bars, globalIdx, isScaleOut),
    });
  }

  return trades;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}
