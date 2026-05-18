import { Bar } from "./signals";

const DAY_MS = 86_400_000;

export type TrendRegionDirection = "uptrend" | "downtrend" | "range";
export type TrendRegionStatus = "realized" | "forming";

export interface CryptoTrendConfidenceBacktestConfig {
  symbol: string;
  bars: Bar[];
  startDate: string;
  endDate: string;
  fastEmaPeriod?: number;
  slowEmaPeriod?: number;
  confirmationBars?: number;
  neutralBandPct?: number;
  fullConfidenceSpreadPct?: number;
}

export interface TrendConfidenceRegion {
  id: string;
  status: TrendRegionStatus;
  direction: TrendRegionDirection;
  confidence: number;
  startDate: string;
  endDate: string;
  markerDate: string;
  barCount: number;
  startPrice: number;
  endPrice: number;
  returnPct: number;
  avgSpreadPct: number;
}

export interface TrendConfidencePoint {
  t: string;
  price: number;
  fastEma: number;
  slowEma: number;
  directionGuess: TrendRegionDirection;
  confidence: number;
  regionId: string;
}

export interface CryptoTrendConfidenceBacktestResult {
  symbol: string;
  startDate: string;
  endDate: string;
  fastEmaPeriod: number;
  slowEmaPeriod: number;
  confirmationBars: number;
  regions: TrendConfidenceRegion[];
  currentTrend: TrendConfidenceRegion | null;
  realizedRegionCount: number;
  averageRealizedConfidence: number;
  trendCounts: Record<TrendRegionDirection, number>;
  points: TrendConfidencePoint[];
}

type ClassifiedBar = {
  bar: Bar;
  fastEma: number;
  slowEma: number;
  spreadPct: number;
  directionGuess: TrendRegionDirection;
  confidence: number;
};

type RegionSlice = {
  startIndex: number;
  endIndex: number;
  directionGuess: TrendRegionDirection;
};

export function runCryptoTrendConfidenceBacktest(
  cfg: CryptoTrendConfidenceBacktestConfig
): CryptoTrendConfidenceBacktestResult | null {
  const fastEmaPeriod = normalizePeriod(cfg.fastEmaPeriod, 21, 5, 200);
  const slowEmaPeriod = normalizePeriod(cfg.slowEmaPeriod, 55, fastEmaPeriod + 1, 300);
  const neutralBandPct = clamp(
    Number.isFinite(cfg.neutralBandPct) ? cfg.neutralBandPct ?? 0 : 0.003,
    0.0005,
    0.05
  );
  const fullConfidenceSpreadPct = clamp(
    Number.isFinite(cfg.fullConfidenceSpreadPct) ? cfg.fullConfidenceSpreadPct ?? 0 : 0.03,
    neutralBandPct,
    0.25
  );

  const startTs = Date.parse(`${cfg.startDate}T00:00:00Z`);
  const endTs = Date.parse(`${cfg.endDate}T00:00:00Z`) + DAY_MS;
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
    return null;
  }

  const windowBars = cfg.bars.filter((bar) => {
    const ts = Date.parse(bar.t);
    return Number.isFinite(ts) && ts >= startTs && ts < endTs && bar.c > 0;
  });
  if (windowBars.length < slowEmaPeriod + 5) return null;

  const barsPerDay = inferBarsPerDay(windowBars);
  const confirmationBars = Math.max(
    3,
    Math.round(
      Number.isFinite(cfg.confirmationBars)
        ? cfg.confirmationBars ?? barsPerDay
        : barsPerDay
    )
  );
  const minSegmentBars = Math.max(2, Math.floor(confirmationBars / 3));

  const closes = windowBars.map((bar) => bar.c);
  const fastEma = computeEma(closes, fastEmaPeriod);
  const slowEma = computeEma(closes, slowEmaPeriod);

  const classifiedBars: ClassifiedBar[] = [];
  let prevDirection: TrendRegionDirection = "range";
  let runLength = 0;

  for (let i = 0; i < windowBars.length; i++) {
    const bar = windowBars[i];
    const slow = slowEma[i];
    const fast = fastEma[i];
    if (!Number.isFinite(slow) || slow <= 0 || !Number.isFinite(fast)) continue;

    const spreadPct = (fast - slow) / slow;
    const directionGuess = classifyDirectionWithHysteresis(
      spreadPct,
      prevDirection,
      neutralBandPct
    );
    runLength = directionGuess === prevDirection ? runLength + 1 : 1;
    prevDirection = directionGuess;

    const spreadScore = clamp(Math.abs(spreadPct) / fullConfidenceSpreadPct, 0, 1);
    const persistenceScore = clamp(runLength / confirmationBars, 0, 1);
    const fastSlopePct = i > 0 && fastEma[i - 1] > 0 ? (fast - fastEma[i - 1]) / fastEma[i - 1] : 0;
    const slowSlopePct = i > 0 && slowEma[i - 1] > 0 ? (slow - slowEma[i - 1]) / slowEma[i - 1] : 0;
    const slopeScore = computeSlopeScore(directionGuess, fastSlopePct, slowSlopePct);
    const confidenceBase = directionGuess === "range"
      ? 0.18 + spreadScore * 0.18 + persistenceScore * 0.42
      : 0.25 + spreadScore * 0.45 + persistenceScore * 0.3;
    const confidence = clamp(confidenceBase * slopeScore, 0, 1);

    classifiedBars.push({
      bar,
      fastEma: fast,
      slowEma: slow,
      spreadPct,
      directionGuess,
      confidence,
    });
  }

  if (classifiedBars.length === 0) return null;

  const regionSlices = buildRegionSlices(classifiedBars);
  const mergedSlices = mergeSmallSlices(regionSlices, minSegmentBars);
  const regionIdByBarIndex = new Array<string>(classifiedBars.length).fill("R1");

  const regions = mergedSlices.map((slice, idx) => {
    const isLast = idx === mergedSlices.length - 1;
    const id = `R${idx + 1}`;
    for (let i = slice.startIndex; i <= slice.endIndex; i++) {
      regionIdByBarIndex[i] = id;
    }
    return buildRegion(
      id,
      slice,
      classifiedBars,
      isLast,
      confirmationBars,
      neutralBandPct,
      fullConfidenceSpreadPct
    );
  });

  const points: TrendConfidencePoint[] = classifiedBars.map((row, idx) => ({
    t: row.bar.t,
    price: row.bar.c,
    fastEma: row.fastEma,
    slowEma: row.slowEma,
    directionGuess: row.directionGuess,
    confidence: row.confidence,
    regionId: regionIdByBarIndex[idx],
  }));

  const currentTrend = regions.find((region) => region.status === "forming") ?? null;
  const realizedRegions = regions.filter((region) => region.status === "realized");
  const averageRealizedConfidence =
    realizedRegions.length > 0
      ? realizedRegions.reduce((sum, region) => sum + region.confidence, 0) / realizedRegions.length
      : 0;
  const trendCounts: Record<TrendRegionDirection, number> = {
    uptrend: regions.filter((region) => region.direction === "uptrend").length,
    downtrend: regions.filter((region) => region.direction === "downtrend").length,
    range: regions.filter((region) => region.direction === "range").length,
  };

  return {
    symbol: cfg.symbol,
    startDate: cfg.startDate,
    endDate: cfg.endDate,
    fastEmaPeriod,
    slowEmaPeriod,
    confirmationBars,
    regions,
    currentTrend,
    realizedRegionCount: realizedRegions.length,
    averageRealizedConfidence,
    trendCounts,
    points,
  };
}

function buildRegion(
  id: string,
  slice: RegionSlice,
  bars: ClassifiedBar[],
  isLast: boolean,
  confirmationBars: number,
  neutralBandPct: number,
  fullConfidenceSpreadPct: number
): TrendConfidenceRegion {
  const regionBars = bars.slice(slice.startIndex, slice.endIndex + 1);
  const startBar = regionBars[0];
  const endBar = regionBars[regionBars.length - 1];
  const markerBar = regionBars[Math.floor((regionBars.length - 1) / 2)];
  const avgSpreadPct = mean(regionBars.map((row) => row.spreadPct));
  const avgConfidence = mean(regionBars.map((row) => row.confidence));
  const barCount = regionBars.length;
  const returnPct = startBar.bar.c > 0
    ? ((endBar.bar.c - startBar.bar.c) / startBar.bar.c) * 100
    : 0;

  if (isLast) {
    const guessedDirection = deriveFormingDirection(slice.directionGuess, avgSpreadPct, neutralBandPct);
    const tailRun = countTrailingDirectionRun(bars, slice.directionGuess);
    const tailPersistence = clamp(tailRun / confirmationBars, 0, 1);
    const confidence = clamp(
      0.2 + avgConfidence * 0.45 + tailPersistence * 0.35,
      0,
      1
    ) * (guessedDirection === "range" ? 0.86 : 1);

    return {
      id,
      status: "forming",
      direction: guessedDirection,
      confidence: clamp(confidence, 0, 1),
      startDate: startBar.bar.t,
      endDate: endBar.bar.t,
      markerDate: markerBar.bar.t,
      barCount,
      startPrice: startBar.bar.c,
      endPrice: endBar.bar.c,
      returnPct,
      avgSpreadPct,
    };
  }

  const direction = classifyRealizedDirection(returnPct, avgSpreadPct, neutralBandPct);
  const lengthScore = clamp(barCount / confirmationBars, 0, 1);
  const spreadScore = clamp(Math.abs(avgSpreadPct) / fullConfidenceSpreadPct, 0, 1);
  const agreementScore = computeAgreementScore(direction, returnPct, avgSpreadPct, neutralBandPct);
  const confidence = clamp(
    (0.24 + lengthScore * 0.35 + spreadScore * 0.41) * agreementScore,
    0,
    1
  );

  return {
    id,
    status: "realized",
    direction,
    confidence,
    startDate: startBar.bar.t,
    endDate: endBar.bar.t,
    markerDate: markerBar.bar.t,
    barCount,
    startPrice: startBar.bar.c,
    endPrice: endBar.bar.c,
    returnPct,
    avgSpreadPct,
  };
}

function computeSlopeScore(
  direction: TrendRegionDirection,
  fastSlopePct: number,
  slowSlopePct: number
): number {
  if (direction === "range") return 0.65;
  const fastAligned = direction === "uptrend" ? fastSlopePct >= 0 : fastSlopePct <= 0;
  const slowAligned = direction === "uptrend" ? slowSlopePct >= 0 : slowSlopePct <= 0;
  if (fastAligned && slowAligned) return 1;
  if (fastAligned || slowAligned) return 0.74;
  return 0.48;
}

function classifyDirectionWithHysteresis(
  spreadPct: number,
  previousDirection: TrendRegionDirection,
  band: number
): TrendRegionDirection {
  const enterBand = band;
  const exitBand = band * 0.45;

  if (previousDirection === "uptrend") {
    if (spreadPct <= -enterBand) return "downtrend";
    if (spreadPct < -exitBand) return "range";
    return "uptrend";
  }
  if (previousDirection === "downtrend") {
    if (spreadPct >= enterBand) return "uptrend";
    if (spreadPct > exitBand) return "range";
    return "downtrend";
  }
  if (spreadPct >= enterBand) return "uptrend";
  if (spreadPct <= -enterBand) return "downtrend";
  return "range";
}

function classifyRealizedDirection(
  returnPct: number,
  avgSpreadPct: number,
  neutralBandPct: number
): TrendRegionDirection {
  if (returnPct >= 1.2 && avgSpreadPct > -neutralBandPct * 0.2) {
    return "uptrend";
  }
  if (returnPct <= -1.2 && avgSpreadPct < neutralBandPct * 0.2) {
    return "downtrend";
  }
  if (avgSpreadPct >= neutralBandPct * 1.2) return "uptrend";
  if (avgSpreadPct <= -neutralBandPct * 1.2) return "downtrend";
  return "range";
}

function deriveFormingDirection(
  directionGuess: TrendRegionDirection,
  avgSpreadPct: number,
  neutralBandPct: number
): TrendRegionDirection {
  if (directionGuess !== "range") return directionGuess;
  if (avgSpreadPct >= neutralBandPct * 0.7) return "uptrend";
  if (avgSpreadPct <= -neutralBandPct * 0.7) return "downtrend";
  return "range";
}

function computeAgreementScore(
  direction: TrendRegionDirection,
  returnPct: number,
  avgSpreadPct: number,
  neutralBandPct: number
): number {
  if (direction === "uptrend") {
    if (returnPct > 0 && avgSpreadPct > -neutralBandPct) return 1;
    if (returnPct > -0.4) return 0.72;
    return 0.48;
  }
  if (direction === "downtrend") {
    if (returnPct < 0 && avgSpreadPct < neutralBandPct) return 1;
    if (returnPct < 0.4) return 0.72;
    return 0.48;
  }
  if (Math.abs(returnPct) <= 1.1) return 0.95;
  return 0.62;
}

function countTrailingDirectionRun(
  bars: ClassifiedBar[],
  direction: TrendRegionDirection
): number {
  let run = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].directionGuess !== direction) break;
    run += 1;
  }
  return run;
}

function buildRegionSlices(bars: ClassifiedBar[]): RegionSlice[] {
  if (bars.length === 0) return [];
  const slices: RegionSlice[] = [];
  let startIndex = 0;
  let activeDirection = bars[0].directionGuess;

  for (let i = 1; i < bars.length; i++) {
    if (bars[i].directionGuess !== activeDirection) {
      slices.push({
        startIndex,
        endIndex: i - 1,
        directionGuess: activeDirection,
      });
      startIndex = i;
      activeDirection = bars[i].directionGuess;
    }
  }

  slices.push({
    startIndex,
    endIndex: bars.length - 1,
    directionGuess: activeDirection,
  });
  return slices;
}

function mergeSmallSlices(slices: RegionSlice[], minBars: number): RegionSlice[] {
  if (slices.length <= 1) return slices;
  const merged: RegionSlice[] = [];

  for (const slice of slices) {
    const barCount = slice.endIndex - slice.startIndex + 1;
    if (barCount >= minBars || merged.length === 0) {
      merged.push({ ...slice });
      continue;
    }

    const previous = merged[merged.length - 1];
    previous.endIndex = slice.endIndex;
  }

  if (merged.length >= 2) {
    const last = merged[merged.length - 1];
    const lastBarCount = last.endIndex - last.startIndex + 1;
    if (lastBarCount < minBars) {
      const previous = merged[merged.length - 2];
      previous.endIndex = last.endIndex;
      merged.pop();
    }
  }

  return merged;
}

function computeEma(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const smoothing = 2 / (period + 1);
  const out: number[] = [];
  let running = values[0];

  for (let i = 0; i < values.length; i++) {
    const price = values[i];
    running = i === 0 ? price : price * smoothing + running * (1 - smoothing);
    out.push(running);
  }

  return out;
}

function inferBarsPerDay(bars: Bar[]): number {
  if (bars.length < 10) return 1;
  const counts = new Map<string, number>();
  for (const bar of bars) {
    const day = bar.t.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const mode = Array.from(counts.values()).sort((a, b) => b - a)[0] ?? 1;
  return Math.max(1, mode);
}

function normalizePeriod(
  raw: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.round(raw ?? fallback)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
