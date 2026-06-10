import { Bar, SIGNAL_META, SignalWeight, buyScore, compositeScore, scoreRationale } from "./signals";

const DAY_MS = 86_400_000;
const ADAPTIVE_LOOKBACK_BARS = 300;
const ADAPTIVE_MIN_SAMPLES = 40;
const DEFAULT_BAR_FORMATION_SLICES = 8;
const MIN_BAR_FORMATION_SLICES = 2;
const MAX_BAR_FORMATION_SLICES = 24;

export type JumpEventType = "jump_started" | "jump_ended";

export interface JumpSignalInfluence {
  signalType: string;
  label: string;
  weight: number;
  score: number;
  weightedContribution: number;
  shareOfComposite: number;
}

export interface JumpDetectionEvent {
  id: string;
  type: JumpEventType;
  date: string;
  price: number;
  score: number;
  threshold: number;
  rationale: string;
  reason: string;
  influences: JumpSignalInfluence[];
  oneBarReturn: number;
  threeBarReturn: number;
  relVolume: number;
  jumpDurationBars: number | null;
}

export interface JumpScorePoint {
  date: string;
  price: number;
  score: number;
  inJump: boolean;
}

export interface CryptoJumpDetectionBacktestConfig {
  symbol: string;
  bars: Bar[];
  startDate: string;
  endDate: string;
  signals: SignalWeight[];
  jumpStartThreshold: number;
  jumpEndThreshold: number;
  minJumpBars?: number;
  minGapBars?: number;
  volumeLookbackPeriod?: number;
  simulateBarFormation?: boolean;
  barFormationSlices?: number;
}

export interface CryptoJumpDetectionBacktestResult {
  symbol: string;
  startDate: string;
  endDate: string;
  barsUsed: Bar[];
  events: JumpDetectionEvent[];
  scoreTimeline: JumpScorePoint[];
  totalJumpStarted: number;
  totalJumpEnded: number;
  activeJumpAtEnd: boolean;
  averageJumpDurationBars: number;
  maxJumpDurationBars: number;
}

export function runCryptoJumpDetectionBacktest(
  cfg: CryptoJumpDetectionBacktestConfig
): CryptoJumpDetectionBacktestResult {
  const normalizedStart = normalizeIsoDate(cfg.startDate);
  const normalizedEnd = normalizeIsoDate(cfg.endDate);
  if (!normalizedStart || !normalizedEnd) {
    throw new Error("Start and end dates must be YYYY-MM-DD.");
  }
  if (normalizedEnd < normalizedStart) {
    throw new Error("End date must be on or after start date.");
  }

  const windowBars = selectBarsInWindow(cfg.bars, normalizedStart, normalizedEnd);
  if (windowBars.length < 20) {
    throw new Error("Not enough bars in selected window for jump detection.");
  }

  const baseBars = cfg.bars;
  const windowFirstTs = Date.parse(`${normalizedStart}T00:00:00Z`);
  const firstWindowIndex = baseBars.findIndex((bar) => Date.parse(bar.t) >= windowFirstTs);
  if (firstWindowIndex < 0) {
    throw new Error("Window start not found in bar series.");
  }

  const startThreshold = clamp(cfg.jumpStartThreshold, 0.05, 0.99);
  const endThreshold = clamp(
    Math.min(cfg.jumpEndThreshold, startThreshold - 0.01),
    0.01,
    startThreshold - 0.01
  );
  const minJumpBars = Math.max(1, Math.floor(cfg.minJumpBars ?? 1));
  const minGapBars = Math.max(0, Math.floor(cfg.minGapBars ?? 2));
  const volumeLookback = Math.max(2, Math.floor(cfg.volumeLookbackPeriod ?? 20));
  const simulateBarFormation = cfg.simulateBarFormation === true;
  const barFormationSlices = clampInt(
    Math.floor(cfg.barFormationSlices ?? DEFAULT_BAR_FORMATION_SLICES),
    MIN_BAR_FORMATION_SLICES,
    MAX_BAR_FORMATION_SLICES
  );

  const closedScoreSamples = windowBars.map((bar, idx) =>
    compositeScore(cfg.signals, baseBars, firstWindowIndex + idx)
  );
  const analysisBars = baseBars.map((bar) => ({ ...bar }));
  const analysisWindowBars = windowBars.map((bar) => ({ ...bar }));

  let inJump = false;
  let jumpStartIndex = -1;
  let lastEventIndex = Number.NEGATIVE_INFINITY;
  let prevScore = 0.5;

  const events: JumpDetectionEvent[] = [];
  const scoreTimeline: JumpScorePoint[] = [];
  const jumpDurations: number[] = [];

  for (let i = 0; i < windowBars.length; i++) {
    const bar = windowBars[i];
    const baseIndex = firstWindowIndex + i;
    const historyStart = Math.max(0, i - ADAPTIVE_LOOKBACK_BARS);
    const historyScores = closedScoreSamples.slice(historyStart, i);
    const hasAdaptiveHistory = historyScores.length >= ADAPTIVE_MIN_SAMPLES;
    const adaptiveStartThreshold = hasAdaptiveHistory ? quantile(historyScores, 0.86) : startThreshold;
    const adaptiveEndThreshold = hasAdaptiveHistory ? quantile(historyScores, 0.48) : endThreshold;
    const startThresholdEffective = clamp(Math.min(startThreshold, adaptiveStartThreshold), 0.5, 0.99);
    const endThresholdEffective = clamp(
      Math.max(endThreshold, adaptiveEndThreshold),
      0.05,
      Math.max(0.05, startThresholdEffective - 0.02)
    );
    const gapReady = i - lastEventIndex >= minGapBars;
    const snapshots = simulateBarFormation
      ? buildBarFormationSnapshots(bar, barFormationSlices)
      : [{ ...bar }];

    let stepPrevScore = prevScore;
    let score = closedScoreSamples[i];
    let rationale = scoreRationale(cfg.signals, analysisBars, baseIndex, false);
    let oneBarReturn = i > 0 ? safeReturn(analysisWindowBars[i - 1].c, bar.c) : 0;
    let twoBarReturn = i >= 2 ? safeReturn(analysisWindowBars[i - 2].c, bar.c) : 0;
    let threeBarReturn = i >= 3 ? safeReturn(analysisWindowBars[i - 3].c, bar.c) : 0;
    let relVolume = relativeVolume(analysisWindowBars, i, volumeLookback);
    let influences = computeSignalInfluences(cfg.signals, analysisBars, baseIndex, score);

    for (let step = 0; step < snapshots.length; step++) {
      const snapshot = snapshots[step];
      analysisBars[baseIndex] = snapshot;
      analysisWindowBars[i] = snapshot;

      score = compositeScore(cfg.signals, analysisBars, baseIndex);
      rationale = scoreRationale(cfg.signals, analysisBars, baseIndex, false);
      oneBarReturn = i > 0 ? safeReturn(analysisWindowBars[i - 1].c, snapshot.c) : 0;
      twoBarReturn = i >= 2 ? safeReturn(analysisWindowBars[i - 2].c, snapshot.c) : 0;
      threeBarReturn = i >= 3 ? safeReturn(analysisWindowBars[i - 3].c, snapshot.c) : 0;
      relVolume = relativeVolume(analysisWindowBars, i, volumeLookback);
      influences = computeSignalInfluences(cfg.signals, analysisBars, baseIndex, score);

      const crossedStart = stepPrevScore < startThresholdEffective && score >= startThresholdEffective;
      const shortTermImpulse =
        oneBarReturn >= 0.008 || twoBarReturn >= 0.015 || threeBarReturn >= 0.024;
      const largeImpulse = oneBarReturn >= 0.02;
      const fastJumpStart = shortTermImpulse && (relVolume >= 1.2 || largeImpulse);
      const scoreImpulseStart = crossedStart && shortTermImpulse;

      if (!inJump && gapReady && (scoreImpulseStart || fastJumpStart)) {
        inJump = true;
        jumpStartIndex = i;
        lastEventIndex = i;
        const intrabarSuffix =
          simulateBarFormation && step < snapshots.length - 1
            ? ` (intrabar ${step + 1}/${snapshots.length})`
            : "";
        const startReason = scoreImpulseStart
          ? "Score crossed into upside jump regime while short-term upside momentum accelerated."
          : "Fast upside impulse triggered jump protection.";
        events.push({
          id: `${bar.t}-jump-started-${i}-${step}`,
          type: "jump_started",
          date: bar.t,
          price: snapshot.c,
          score,
          threshold: startThresholdEffective,
          rationale,
          reason: `${startReason}${intrabarSuffix}`,
          influences,
          oneBarReturn,
          threeBarReturn,
          relVolume,
          jumpDurationBars: null,
        });
      }

      stepPrevScore = score;
    }

    analysisBars[baseIndex] = { ...bar };
    analysisWindowBars[i] = { ...bar };

    if (inJump) {
      const barsInJump = jumpStartIndex >= 0 ? i - jumpStartIndex + 1 : 0;
      const calmComposite = score <= endThresholdEffective;
      const failedContinuation = oneBarReturn <= -0.002 || twoBarReturn <= 0.001;
      if (barsInJump >= minJumpBars && gapReady && (calmComposite || failedContinuation)) {
        inJump = false;
        lastEventIndex = i;
        jumpDurations.push(barsInJump);
        events.push({
          id: `${bar.t}-jump-ended-${i}`,
          type: "jump_ended",
          date: bar.t,
          price: analysisWindowBars[i].c,
          score,
          threshold: endThresholdEffective,
          rationale,
          reason: calmComposite
            ? "Upside jump score cooled back below the jump end threshold."
            : "Upside continuation stalled after the jump impulse.",
          influences,
          oneBarReturn,
          threeBarReturn,
          relVolume,
          jumpDurationBars: barsInJump,
        });
        jumpStartIndex = -1;
      }
    }

    scoreTimeline.push({
      date: bar.t,
      price: bar.c,
      score,
      inJump,
    });
    prevScore = score;
  }

  const starts = events.filter((event) => event.type === "jump_started").length;
  const ends = events.filter((event) => event.type === "jump_ended").length;
  const avgDuration =
    jumpDurations.length > 0
      ? jumpDurations.reduce((sum, value) => sum + value, 0) / jumpDurations.length
      : 0;
  const maxDuration = jumpDurations.length > 0 ? Math.max(...jumpDurations) : 0;

  return {
    symbol: cfg.symbol.trim().toUpperCase(),
    startDate: normalizedStart,
    endDate: normalizedEnd,
    barsUsed: windowBars,
    events,
    scoreTimeline,
    totalJumpStarted: starts,
    totalJumpEnded: ends,
    activeJumpAtEnd: inJump,
    averageJumpDurationBars: avgDuration,
    maxJumpDurationBars: maxDuration,
  };
}

function computeSignalInfluences(
  signals: SignalWeight[],
  bars: Bar[],
  index: number,
  composite: number
): JumpSignalInfluence[] {
  const positive = signals.filter((row) => Number.isFinite(row.weight) && row.weight > 0);
  if (positive.length === 0) return [];
  const totalWeight = positive.reduce((sum, row) => sum + row.weight, 0);
  const weightedRows = positive.map((row) => {
    const score = buyScore(row.signal, bars, index);
    const weightedContribution = totalWeight > 0 ? (score * row.weight) / totalWeight : 0;
    return { row, score, weightedContribution };
  });

  return weightedRows
    .map(({ row, score, weightedContribution }) => ({
      signalType: row.signal.type,
      label: SIGNAL_META[row.signal.type]?.label ?? row.signal.type,
      weight: row.weight,
      score,
      weightedContribution,
      shareOfComposite: composite > 1e-9 ? weightedContribution / composite : 0,
    }))
    .sort((a, b) => b.weightedContribution - a.weightedContribution);
}

function relativeVolume(bars: Bar[], index: number, lookback: number): number {
  if (index <= 0) return 1;
  const start = Math.max(0, index - lookback);
  if (start >= index) return 1;
  let sum = 0;
  for (let i = start; i < index; i++) {
    sum += bars[i].v;
  }
  const avg = sum / Math.max(1, index - start);
  if (avg <= 1e-9) return 1;
  return bars[index].v / avg;
}

function selectBarsInWindow(bars: Bar[], startDate: string, endDate: string): Bar[] {
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  const endTsExclusive = Date.parse(`${endDate}T00:00:00Z`) + DAY_MS;
  return bars.filter((bar) => {
    const ts = Date.parse(bar.t);
    return Number.isFinite(ts) && ts >= startTs && ts < endTsExclusive;
  });
}

function normalizeIsoDate(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ts = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  return trimmed;
}

function buildBarFormationSnapshots(bar: Bar, slices: number): Bar[] {
  const safeSlices = clampInt(Math.floor(slices), MIN_BAR_FORMATION_SLICES, MAX_BAR_FORMATION_SLICES);
  const snapshots: Bar[] = [];
  for (let i = 1; i <= safeSlices; i++) {
    const progress = i / safeSlices;
    const close = lerp(bar.o, bar.c, progress);
    const progressingHigh = lerp(bar.o, bar.h, progress);
    const progressingLow = lerp(bar.o, bar.l, progress);
    const high = Math.max(bar.o, close, progressingHigh);
    const low = Math.min(bar.o, close, progressingLow);
    snapshots.push({
      ...bar,
      h: high,
      l: low,
      c: close,
      v: Math.max(0, bar.v * progress),
    });
  }
  snapshots[snapshots.length - 1] = { ...bar };
  return snapshots;
}

function safeReturn(prev: number, next: number): number {
  if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0) return 0;
  return (next - prev) / prev;
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0.5;
  const sorted = [...values].sort((a, b) => a - b);
  const clampedQ = clamp(q, 0, 1);
  const pos = (sorted.length - 1) * clampedQ;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const mix = pos - lo;
  return sorted[lo] * (1 - mix) + sorted[hi] * mix;
}
