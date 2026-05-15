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
 * Cadence controls a maximum trade frequency, while signal values determine
 * actual trade timing.
 *
 * We scan bars chronologically, score each bar when reached (no lookahead),
 * and pick anchors with a minimum spacing derived from cadence (via `nTranches`).
 * Timing is signal-led while respecting frequency limits.
 * Scores from bars leading into the window seed the initial threshold so day 1
 * is treated like any other bar, not an automatic entry.
 * Allocation is blended between equal-DCA (aggressiveness=0) and
 * signal-weighted sizing (aggressiveness=1) based on selected anchor scores.
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
  const minSpacingMs = (end - start) / n;
  const preWindowScores = collectPreWindowScores(
    bars,
    windowBars[0].index,
    signals,
    isScaleOut,
    Math.max(30, n * 3)
  );
  const selectedAnchors = selectSignalAnchorsByCadence(
    windowBars,
    bars,
    signals,
    isScaleOut,
    n,
    minSpacingMs,
    clampedAggressiveness,
    preWindowScores
  );
  if (selectedAnchors.length === 0) return [];
  const selectedIdxs = selectedAnchors.map((anchor) => anchor.index);
  const scoreByIndex = new Map(
    selectedAnchors.map((anchor) => [anchor.index, anchor.score])
  );

  const rawAmounts: number[] = [];
  const scores: number[] = [];
  let remainingAmount = totalAmount;
  let runningScoreSum = 0;

  for (let i = 0; i < selectedIdxs.length; i++) {
    const globalIdx = selectedIdxs[i];
    const score = scoreByIndex.get(globalIdx) ?? 0.5;
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

function selectSignalAnchorsByCadence(
  windowBars: Array<{ index: number; ts: number }>,
  bars: Bar[],
  signals: SignalWeight[],
  isScaleOut: boolean,
  maxTrades: number,
  minSpacingMs: number,
  aggressiveness: number,
  initialSeenScores: number[]
): Array<{ index: number; ts: number; score: number }> {
  if (windowBars.length === 0 || maxTrades <= 0) return [];
  const spacingMs = Number.isFinite(minSpacingMs) ? Math.max(0, minSpacingMs) : 0;
  const maxGapMs = spacingMs > 0 ? spacingMs * 2 : 0;
  const scoreQuantile = 0.55 + clamp(aggressiveness, 0, 1) * 0.3;

  const seenScores: number[] = [...initialSeenScores];
  const chosen: Array<{ index: number; ts: number; score: number }> = [];
  const firstTs = windowBars[0].ts;
  let lastTradeTs = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < windowBars.length; i++) {
    if (chosen.length >= maxTrades) break;

    const bar = windowBars[i];
    const rawScore = compositeScore(signals, bars, bar.index);
    const score = isScaleOut ? 1 - rawScore : rawScore;

    const sinceLastTrade = chosen.length === 0 ? bar.ts - firstTs : bar.ts - lastTradeTs;
    const spacingSatisfied = chosen.length === 0 || sinceLastTrade >= spacingMs;
    const threshold = quantileFromSeenScores(seenScores, scoreQuantile);
    const signalTrigger = score >= threshold;
    const forceByGap = maxGapMs > 0 && sinceLastTrade >= maxGapMs;
    const remainingBars = windowBars.length - i;
    const remainingSlots = maxTrades - chosen.length;
    const forceBySlots = i > 0 && chosen.length > 0 && remainingBars <= remainingSlots;

    if (spacingSatisfied && (signalTrigger || forceByGap || forceBySlots)) {
      chosen.push({ index: bar.index, ts: bar.ts, score });
      lastTradeTs = bar.ts;
    }
    seenScores.push(score);
  }

  if (chosen.length === 0) {
    // Live-realistic fallback: if nothing triggered, execute "now" at the
    // latest available bar in the window instead of retroactively picking
    // an older bar using hindsight.
    const last = windowBars[windowBars.length - 1];
    if (last) {
      const rawScore = compositeScore(signals, bars, last.index);
      const score = isScaleOut ? 1 - rawScore : rawScore;
      chosen.push({ index: last.index, ts: last.ts, score });
    }
  }

  return chosen;
}

function collectPreWindowScores(
  bars: Bar[],
  firstWindowBarIndex: number,
  signals: SignalWeight[],
  isScaleOut: boolean,
  maxScores: number
): number[] {
  const out: number[] = [];
  const start = Math.max(0, firstWindowBarIndex - Math.max(0, Math.floor(maxScores)));
  for (let i = start; i < firstWindowBarIndex; i++) {
    const ts = new Date(bars[i].t).getTime();
    if (!Number.isFinite(ts)) continue;
    const rawScore = compositeScore(signals, bars, i);
    out.push(isScaleOut ? 1 - rawScore : rawScore);
  }
  return out;
}

function quantileFromSeenScores(values: number[], q: number): number {
  if (values.length === 0) return 0.5;
  const clampedQ = clamp(q, 0, 1);
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * clampedQ;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const mix = pos - lo;
  return sorted[lo] * (1 - mix) + sorted[hi] * mix;
}
