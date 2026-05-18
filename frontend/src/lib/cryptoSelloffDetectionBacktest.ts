import { Bar, SIGNAL_META, SignalWeight, buyScore, compositeScore, scoreRationale } from "./signals";

const DAY_MS = 86_400_000;
const ADAPTIVE_LOOKBACK_BARS = 300;
const ADAPTIVE_MIN_SAMPLES = 40;
const DOJI_BODY_TO_RANGE_MAX = 0.12;
const ENGULFING_BODY_EXPANSION_MIN = 1.03;
const STRONG_BULL_BODY_MULTIPLIER = 1.05;
const MIN_PATTERN_SELLOFF_DROP = -0.012;
const MAX_CONFIRMATION_WAIT_BARS = 3;
const CONFIRMATION_MIN_BOUNCE = 0.002;
const CONFIRMATION_BREAK_BUFFER_RANGE_SHARE = 0.08;
const DEFAULT_BAR_FORMATION_SLICES = 8;
const MIN_BAR_FORMATION_SLICES = 2;
const MAX_BAR_FORMATION_SLICES = 24;

export type SelloffEventType = "selloff_started" | "selloff_ended";

export interface SelloffSignalInfluence {
  signalType: string;
  label: string;
  weight: number;
  score: number;
  weightedContribution: number;
  shareOfComposite: number;
}

export interface SelloffDetectionEvent {
  id: string;
  type: SelloffEventType;
  date: string;
  price: number;
  score: number;
  threshold: number;
  rationale: string;
  reason: string;
  influences: SelloffSignalInfluence[];
  oneBarReturn: number;
  threeBarReturn: number;
  relVolume: number;
  selloffDurationBars: number | null;
}

export interface SelloffScorePoint {
  date: string;
  price: number;
  score: number;
  inSelloff: boolean;
}

export interface CryptoSelloffDetectionBacktestConfig {
  symbol: string;
  bars: Bar[];
  startDate: string;
  endDate: string;
  signals: SignalWeight[];
  selloffStartThreshold: number;
  selloffEndThreshold: number;
  minSelloffBars?: number;
  minGapBars?: number;
  volumeLookbackPeriod?: number;
  simulateBarFormation?: boolean;
  barFormationSlices?: number;
}

export interface CryptoSelloffDetectionBacktestResult {
  symbol: string;
  startDate: string;
  endDate: string;
  barsUsed: Bar[];
  events: SelloffDetectionEvent[];
  scoreTimeline: SelloffScorePoint[];
  totalSelloffStarted: number;
  totalSelloffEnded: number;
  activeSelloffAtEnd: boolean;
  averageSelloffDurationBars: number;
  maxSelloffDurationBars: number;
}

type SelloffEndCandidateType = "doji" | "strong_bullish";

interface SelloffStartPatternMatch {
  reason: string;
}

interface SelloffEndCandidate {
  index: number;
  type: SelloffEndCandidateType;
  reason: string;
}

interface SelloffEndConfirmation {
  confirmed: boolean;
  invalidated: boolean;
  reason: string;
}

export function runCryptoSelloffDetectionBacktest(
  cfg: CryptoSelloffDetectionBacktestConfig
): CryptoSelloffDetectionBacktestResult {
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
    throw new Error("Not enough bars in selected window for selloff detection.");
  }

  const baseBars = cfg.bars;
  const windowFirstTs = Date.parse(`${normalizedStart}T00:00:00Z`);
  const firstWindowIndex = baseBars.findIndex((bar) => Date.parse(bar.t) >= windowFirstTs);
  if (firstWindowIndex < 0) {
    throw new Error("Window start not found in bar series.");
  }

  const startThreshold = clamp(cfg.selloffStartThreshold, 0.05, 0.99);
  const endThreshold = clamp(
    Math.min(cfg.selloffEndThreshold, startThreshold - 0.01),
    0.01,
    startThreshold - 0.01
  );
  const minSelloffBars = Math.max(1, Math.floor(cfg.minSelloffBars ?? 3));
  const minGapBars = Math.max(0, Math.floor(cfg.minGapBars ?? 4));
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

  let inSelloff = false;
  let selloffStartIndex = -1;
  let lastEventIndex = Number.NEGATIVE_INFINITY;
  let prevScore = 0.5;
  let pendingEndCandidate: SelloffEndCandidate | null = null;

  const events: SelloffDetectionEvent[] = [];
  const scoreTimeline: SelloffScorePoint[] = [];
  const selloffDurations: number[] = [];

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
        oneBarReturn <= -0.008 || twoBarReturn <= -0.015 || threeBarReturn <= -0.024;
      const largeImpulse = oneBarReturn <= -0.02;
      const fastSelloffStart = shortTermImpulse && (relVolume >= 1.2 || largeImpulse);
      const candleStartPattern = detectSelloffStartPattern(analysisWindowBars, i);
      const scoreImpulseStart = crossedStart && shortTermImpulse;

      if (!inSelloff && gapReady && (candleStartPattern !== null || scoreImpulseStart || fastSelloffStart)) {
        inSelloff = true;
        selloffStartIndex = i;
        lastEventIndex = i;
        pendingEndCandidate = null;
        const intrabarSuffix =
          simulateBarFormation && step < snapshots.length - 1
            ? ` (intrabar ${step + 1}/${snapshots.length})`
            : "";
        const startReason = candleStartPattern?.reason
          ?? (scoreImpulseStart
            ? "Score crossed into stress regime while downside momentum accelerated."
            : "Fast downside impulse triggered a selloff start.");
        events.push({
          id: `${bar.t}-selloff-started-${i}-${step}`,
          type: "selloff_started",
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
          selloffDurationBars: null,
        });
      }

      stepPrevScore = score;
    }

    // Ensure this index reflects the fully closed bar before evaluating exit logic and timeline.
    analysisBars[baseIndex] = { ...bar };
    analysisWindowBars[i] = { ...bar };

    if (inSelloff) {
      const barsInSelloff = selloffStartIndex >= 0 ? i - selloffStartIndex + 1 : 0;
      if (pendingEndCandidate && i > pendingEndCandidate.index) {
        const confirmation = evaluateSelloffEndConfirmation(analysisWindowBars, pendingEndCandidate, i);
        if (confirmation.invalidated) {
          pendingEndCandidate = null;
        } else if (confirmation.confirmed && barsInSelloff >= minSelloffBars && gapReady) {
          inSelloff = false;
          lastEventIndex = i;
          selloffDurations.push(barsInSelloff);
          const calmComposite = score <= endThresholdEffective + 0.08;
          const endReason = calmComposite
            ? `${confirmation.reason} Composite stress also cooled.`
            : confirmation.reason;
          events.push({
            id: `${bar.t}-selloff-ended-${i}`,
            type: "selloff_ended",
            date: bar.t,
            price: analysisWindowBars[i].c,
            score,
            threshold: endThresholdEffective,
            rationale,
            reason: endReason,
            influences,
            oneBarReturn,
            threeBarReturn,
            relVolume,
            selloffDurationBars: barsInSelloff,
          });
          selloffStartIndex = -1;
          pendingEndCandidate = null;
        }
      }

      if (inSelloff && !pendingEndCandidate) {
        const hasBearishContext = hasSelloffExhaustionContext(analysisWindowBars, i, selloffStartIndex);
        const candidate = hasBearishContext ? detectSelloffEndCandidate(analysisWindowBars, i) : null;
        if (candidate) {
          pendingEndCandidate = candidate;
        }
      }
    }

    scoreTimeline.push({
      date: bar.t,
      price: bar.c,
      score,
      inSelloff,
    });
    prevScore = score;
  }

  const starts = events.filter((event) => event.type === "selloff_started").length;
  const ends = events.filter((event) => event.type === "selloff_ended").length;
  const avgDuration =
    selloffDurations.length > 0
      ? selloffDurations.reduce((sum, value) => sum + value, 0) / selloffDurations.length
      : 0;
  const maxDuration = selloffDurations.length > 0 ? Math.max(...selloffDurations) : 0;

  return {
    symbol: cfg.symbol.trim().toUpperCase(),
    startDate: normalizedStart,
    endDate: normalizedEnd,
    barsUsed: windowBars,
    events,
    scoreTimeline,
    totalSelloffStarted: starts,
    totalSelloffEnded: ends,
    activeSelloffAtEnd: inSelloff,
    averageSelloffDurationBars: avgDuration,
    maxSelloffDurationBars: maxDuration,
  };
}

function computeSignalInfluences(
  signals: SignalWeight[],
  bars: Bar[],
  index: number,
  composite: number
): SelloffSignalInfluence[] {
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

function detectSelloffStartPattern(bars: Bar[], index: number): SelloffStartPatternMatch | null {
  if (index < 3) return null;
  const searchStart = Math.max(1, index - 6);
  for (let engulfIndex = index - 2; engulfIndex >= searchStart; engulfIndex--) {
    const preBull = bars[engulfIndex - 1];
    const engulf = bars[engulfIndex];
    if (!isBearishEngulfing(preBull, engulf)) continue;

    const followThroughCount = countBearishBars(bars, engulfIndex + 1, index);
    if (followThroughCount < 2) continue;

    const sequenceDrop = safeReturn(preBull.c, bars[index].c);
    const totalBearishBars = countBearishBars(bars, engulfIndex, index);
    if (sequenceDrop > MIN_PATTERN_SELLOFF_DROP || totalBearishBars < 3) continue;

    return {
      reason: "Bullish candle flipped to bearish engulfing with multi-candle downside follow-through.",
    };
  }
  return null;
}

function hasSelloffExhaustionContext(bars: Bar[], index: number, selloffStartIndex: number): boolean {
  if (index <= 0 || selloffStartIndex < 0) return false;
  const lookbackStart = Math.max(selloffStartIndex, index - 5);
  const bearishCount = countBearishBars(bars, lookbackStart, index - 1);
  if (bearishCount < 2) return false;

  const sequenceDrop = safeReturn(bars[lookbackStart].c, bars[index].c);
  let priorLow = Number.POSITIVE_INFINITY;
  for (let i = lookbackStart; i < index; i++) {
    priorLow = Math.min(priorLow, bars[i].l);
  }
  const nearLocalLow = Number.isFinite(priorLow) && bars[index].l <= priorLow * 1.005;
  return sequenceDrop <= -0.008 || nearLocalLow;
}

function detectSelloffEndCandidate(bars: Bar[], index: number): SelloffEndCandidate | null {
  if (index < 1) return null;
  const bar = bars[index];
  const prev = bars[index - 1];
  if (isDojiBar(bar)) {
    return {
      index,
      type: "doji",
      reason: "Doji appeared after sustained bearish pressure; waiting for bullish confirmation.",
    };
  }

  const previousBearBody = isBearishBar(prev)
    ? candleBodySize(prev)
    : averageBearishBodySize(bars, Math.max(0, index - 4), index - 1);
  const bullishReversal =
    isBullishBar(bar) &&
    previousBearBody > 1e-9 &&
    candleBodySize(bar) >= previousBearBody * STRONG_BULL_BODY_MULTIPLIER &&
    bar.c > prev.c;
  if (!bullishReversal) return null;

  return {
    index,
    type: "strong_bullish",
    reason: "Bullish reversal candle body exceeded the preceding bearish body; waiting for confirmation.",
  };
}

function evaluateSelloffEndConfirmation(
  bars: Bar[],
  candidate: SelloffEndCandidate,
  index: number
): SelloffEndConfirmation {
  if (index <= candidate.index) {
    return { confirmed: false, invalidated: false, reason: "" };
  }
  if (index - candidate.index > MAX_CONFIRMATION_WAIT_BARS) {
    return { confirmed: false, invalidated: true, reason: "" };
  }

  const candidateBar = bars[candidate.index];
  const bar = bars[index];
  const failedRetest = isBearishBar(bar) && bar.l < candidateBar.l * 0.998;
  if (failedRetest) {
    return { confirmed: false, invalidated: true, reason: "" };
  }

  const candidateRange = Math.max(candleRangeSize(candidateBar), candidateBar.c * 1e-6);
  const closesAboveCandidate = bar.c > candidateBar.c;
  const closeNearCandidateHigh =
    bar.c >= candidateBar.h - candidateRange * CONFIRMATION_BREAK_BUFFER_RANGE_SHARE;
  const bounceFromCandidate = safeReturn(candidateBar.c, bar.c) >= CONFIRMATION_MIN_BOUNCE;
  const bullishConfirmBody =
    isBullishBar(bar) &&
    candleBodySize(bar) >= Math.max(candidateRange * 0.18, candidateBar.c * 0.0005);
  const confirmed =
    bullishConfirmBody &&
    closesAboveCandidate &&
    (closeNearCandidateHigh || bounceFromCandidate);
  if (!confirmed) {
    return { confirmed: false, invalidated: false, reason: "" };
  }

  return {
    confirmed: true,
    invalidated: false,
    reason:
      candidate.type === "doji"
        ? "Doji reversal received a bullish confirmation candle."
        : "Strong bullish reversal received bullish continuation confirmation.",
  };
}

function countBearishBars(bars: Bar[], start: number, end: number): number {
  if (end < start) return 0;
  let count = 0;
  for (let i = start; i <= end; i++) {
    if (isBearishBar(bars[i])) count += 1;
  }
  return count;
}

function averageBearishBodySize(bars: Bar[], start: number, end: number): number {
  if (end < start) return 0;
  let sum = 0;
  let count = 0;
  for (let i = start; i <= end; i++) {
    if (!isBearishBar(bars[i])) continue;
    sum += candleBodySize(bars[i]);
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

function isBearishEngulfing(prev: Bar, current: Bar): boolean {
  if (!isBullishBar(prev) || !isBearishBar(current)) return false;
  const prevBody = candleBodySize(prev);
  const currentBody = candleBodySize(current);
  if (prevBody <= 1e-9 || currentBody <= 1e-9) return false;
  return (
    current.o >= prev.c &&
    current.c <= prev.o &&
    currentBody >= prevBody * ENGULFING_BODY_EXPANSION_MIN
  );
}

function isDojiBar(bar: Bar): boolean {
  const range = candleRangeSize(bar);
  if (range <= 1e-9) return false;
  return candleBodySize(bar) / range <= DOJI_BODY_TO_RANGE_MAX;
}

function isBullishBar(bar: Bar): boolean {
  return bar.c > bar.o;
}

function isBearishBar(bar: Bar): boolean {
  return bar.c < bar.o;
}

function candleBodySize(bar: Bar): number {
  return Math.abs(bar.c - bar.o);
}

function candleRangeSize(bar: Bar): number {
  return Math.max(0, bar.h - bar.l);
}

function safeReturn(prev: number, next: number): number {
  if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0) return 0;
  return (next - prev) / prev;
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
  // Last slice must be the real closed bar.
  snapshots[snapshots.length - 1] = { ...bar };
  return snapshots;
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
