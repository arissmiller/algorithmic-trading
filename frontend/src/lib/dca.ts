import { Bar, SignalWeight, compositeScore, scoreRationale } from "./signals";

export type Direction = "scale_in" | "scale_out";

export interface ScheduledTrade {
  date: string;
  amountUsd: number;
  signalScore: number;
  rationale: string;
}

/**
 * Generate a smart-weighted DCA schedule.
 *
 * The window is divided into `nTranches` equal time segments.
 * Within each segment the bar with the highest directional score is selected.
 * Allocation is blended between equal-DCA (aggressiveness=0) and
 * fully signal-weighted (aggressiveness=1), then normalised to totalAmount.
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
  const isScaleOut = direction === "scale_out";

  // Indices of bars that fall inside the window
  const windowIdxs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const t = new Date(bars[i].t).getTime();
    if (t >= start && t < end) windowIdxs.push(i);
  }
  if (windowIdxs.length === 0) return [];

  // Directional score for every bar in the window
  const scores = windowIdxs.map((globalIdx) => {
    const raw = compositeScore(signals, bars, globalIdx);
    return isScaleOut ? 1 - raw : raw;
  });

  const n = Math.min(nTranches, windowIdxs.length);
  const segF = windowIdxs.length / n;
  const baseAmount = totalAmount / n;
  const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length || 1;

  const trades: ScheduledTrade[] = [];

  for (let t = 0; t < n; t++) {
    const segStart = Math.round(t * segF);
    const segEnd = Math.min(Math.round((t + 1) * segF), windowIdxs.length);

    // Best-scoring bar in this segment
    let bestLocal = segStart;
    for (let i = segStart + 1; i < segEnd; i++) {
      if (scores[i] > scores[bestLocal]) bestLocal = i;
    }

    const globalIdx = windowIdxs[bestLocal];
    const score = scores[bestLocal];

    // Blend equal DCA with signal-weighted allocation
    const smartAmount = (score / avgScore) * baseAmount;
    const blended =
      (1 - aggressiveness) * baseAmount + aggressiveness * smartAmount;
    // Floor: no tranche gets less than 20% of the equal share
    const amount = Math.max(blended, baseAmount * 0.2);

    trades.push({
      date: bars[globalIdx].t.split("T")[0],
      amountUsd: amount,
      signalScore: score,
      rationale: scoreRationale(signals, bars, globalIdx, isScaleOut),
    });
  }

  // Normalise to exactly totalAmount
  const total = trades.reduce((s, t) => s + t.amountUsd, 0);
  const scale = totalAmount / total;
  return trades.map((t) => ({
    ...t,
    amountUsd: Math.round(t.amountUsd * scale * 100) / 100,
  }));
}
