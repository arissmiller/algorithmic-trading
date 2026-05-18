export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type SignalType =
  | { type: "price_vs_sma";       period: number }
  | { type: "rsi";                period: number }
  | { type: "bollinger_band";     period: number; std_dev: number }
  | { type: "volume";             period: number }
  | { type: "momentum";           period: number }
  | { type: "selloff_pressure";   period: number }
  | { type: "breakout_momentum";  period: number }
  | { type: "bar_streak";         period: number }
  | { type: "squeeze_breakout";   period: number }
  | { type: "bullish_impulse";    period: number }
  | { type: "momentum_rsi";       period: number };

export interface SignalWeight {
  signal: SignalType;
  weight: number;
}

export function compositeScore(
  signals: SignalWeight[],
  bars: Bar[],
  index: number
): number {
  if (signals.length === 0) return 0.5;
  const totalWeight = signals.reduce((s, sw) => s + sw.weight, 0);
  if (totalWeight === 0) return 0.5;
  return (
    signals.reduce((s, sw) => s + buyScore(sw.signal, bars, index) * sw.weight, 0) /
    totalWeight
  );
}

export function scoreRationale(
  signals: SignalWeight[],
  bars: Bar[],
  index: number,
  isScaleOut: boolean
): string {
  const LABELS: Record<string, string> = {
    price_vs_sma: "Price vs SMA",
    rsi: "RSI",
    bollinger_band: "Bollinger Band",
    volume: "Volume",
    momentum: "Momentum",
    selloff_pressure: "Selloff Pressure",
    breakout_momentum: "Breakout Momentum",
    bar_streak: "Bar Streak",
    squeeze_breakout: "Squeeze Breakout",
    bullish_impulse: "Bullish Impulse",
    momentum_rsi: "Momentum RSI",
  };
  return signals
    .map((sw) => {
      const raw = buyScore(sw.signal, bars, index);
      const directional = isScaleOut ? 1 - raw : raw;
      const label = LABELS[sw.signal.type] ?? sw.signal.type;
      return `${label}: ${Math.round(directional * 100)}%`;
    })
    .join(" | ");
}

function buyScore(signal: SignalType, bars: Bar[], index: number): number {
  switch (signal.type) {
    case "price_vs_sma":
      return priceVsSmaScore(bars, index, signal.period);
    case "rsi":
      return rsiScore(bars, index, signal.period);
    case "bollinger_band":
      return bollingerScore(bars, index, signal.period, signal.std_dev);
    case "volume":
      return volumeScore(bars, index, signal.period);
    case "momentum":
      return momentumScore(bars, index, signal.period);
    case "selloff_pressure":
      return selloffPressureScore(bars, index, signal.period);
    case "breakout_momentum":
      return breakoutMomentumScore(bars, index, signal.period);
    case "bar_streak":
      return barStreakScore(bars, index, signal.period);
    case "squeeze_breakout":
      return squeezeBreakoutScore(bars, index, signal.period);
    case "bullish_impulse":
      return bullishImpulseScore(bars, index, signal.period);
    case "momentum_rsi":
      return momentumRsiScore(bars, index, signal.period);
  }
}

function sma(bars: Bar[], index: number, period: number): number | null {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index + 1 - period; i <= index; i++) sum += bars[i].c;
  return sum / period;
}

function bollingerBands(
  bars: Bar[],
  index: number,
  period: number,
  stdDev: number
): [lower: number, mid: number, upper: number] | null {
  const mid = sma(bars, index, period);
  if (mid === null) return null;
  let variance = 0;
  for (let i = index + 1 - period; i <= index; i++) {
    variance += (bars[i].c - mid) ** 2;
  }
  const sigma = Math.sqrt(variance / period);
  return [mid - stdDev * sigma, mid, mid + stdDev * sigma];
}

function rsi(bars: Bar[], index: number, period: number): number | null {
  if (index < period) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = bars[i].c - bars[i - 1].c;
    if (d > 0) avgGain += d;
    else avgLoss += -d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i <= index; i++) {
    const d = bars[i].c - bars[i - 1].c;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss < 1e-10) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function priceVsSmaScore(bars: Bar[], index: number, period: number): number {
  const ma = sma(bars, index, period);
  if (ma === null) return 0.5;
  const deviation = (ma - bars[index].c) / ma;
  return clamp(0.5 + deviation * 5, 0, 1);
}

function rsiScore(bars: Bar[], index: number, period: number): number {
  const r = rsi(bars, index, period);
  if (r === null) return 0.5;
  return 1 - r / 100;
}

function bollingerScore(
  bars: Bar[],
  index: number,
  period: number,
  stdDev: number
): number {
  const bands = bollingerBands(bars, index, period, stdDev);
  if (bands === null) return 0.5;
  const [lower, , upper] = bands;
  const width = upper - lower;
  if (width < 1e-10) return 0.5;
  const pctB = (bars[index].c - lower) / width;
  return clamp(1 - pctB, 0, 1);
}

function volumeScore(bars: Bar[], index: number, period: number): number {
  if (index < period) return 0.5;
  let avgVol = 0;
  for (let i = index - period; i < index; i++) avgVol += bars[i].v;
  avgVol /= period;
  if (avgVol < 1) return 0.5;
  const relVol = bars[index].v / avgVol;
  const priceChg = index > 0 ? bars[index].c - bars[index - 1].c : 0;
  if (priceChg < 0) {
    return clamp(0.5 + (relVol - 1) * 0.25, 0, 1);
  } else {
    return clamp(0.5 - (relVol - 1) * 0.15, 0, 1);
  }
}

function momentumScore(bars: Bar[], index: number, period: number): number {
  if (index < period) return 0.5;
  const oldPrice = bars[index - period].c;
  if (oldPrice < 1e-10) return 0.5;
  const momentum = (bars[index].c - oldPrice) / oldPrice;
  return clamp(0.5 - momentum * 5, 0, 1);
}

function selloffPressureScore(bars: Bar[], index: number, period: number): number {
  if (index < period || index <= 0) return 0.5;
  const lookbackClose = bars[index - period].c;
  const prevClose = bars[index - 1].c;
  const close = bars[index].c;
  if (lookbackClose <= 0 || prevClose <= 0 || close <= 0) return 0.5;

  const multiBarReturn = (close - lookbackClose) / lookbackClose;
  const oneBarReturn = (close - prevClose) / prevClose;
  const downMove = clamp(-multiBarReturn / 0.09, 0, 1);
  const shock = clamp(-oneBarReturn / 0.038, 0, 1);

  let avgRangePct = 0;
  let avgVol = 0;
  for (let i = index - period; i < index; i++) {
    const bar = bars[i];
    const denom = bar.c > 0 ? bar.c : 1;
    avgRangePct += (bar.h - bar.l) / denom;
    avgVol += bar.v;
  }
  avgRangePct /= period;
  avgVol /= period;

  const currentRangePct = (bars[index].h - bars[index].l) / close;
  const rangeRel = avgRangePct > 1e-10 ? currentRangePct / avgRangePct : 1;
  const rangeShock = clamp((rangeRel - 1) / 2, 0, 1);

  const relVol = avgVol > 1 ? bars[index].v / avgVol : 1;
  const volumeShock = oneBarReturn < 0 ? clamp((relVol - 1) / 2, 0, 1) : 0;

  return clamp(
    downMove * 0.4 + shock * 0.25 + rangeShock * 0.2 + volumeShock * 0.15,
    0,
    1
  );
}

// Scores 1.0 when price breaks above the N-bar high with strong volume.
// Returns 0 when price is at or below the prior range high.
function breakoutMomentumScore(bars: Bar[], index: number, period: number): number {
  if (index < period) return 0;
  let nBarHigh = -Infinity;
  let avgVol = 0;
  for (let i = index - period; i < index; i++) {
    if (bars[i].h > nBarHigh) nBarHigh = bars[i].h;
    avgVol += bars[i].v;
  }
  avgVol /= period;
  const close = bars[index].c;
  if (close <= nBarHigh) return 0;
  // Map 0%→1% breakout distance to [0.5, 1.0]
  const breakoutPct = (close - nBarHigh) / nBarHigh;
  const priceScore = 0.5 + clamp(breakoutPct / 0.01, 0, 1) * 0.5;
  // 2x average volume = full volume credit
  const relVol = avgVol > 0 ? bars[index].v / avgVol : 1;
  const volumeFactor = clamp(relVol / 2.0, 0, 1);
  return clamp(priceScore * volumeFactor, 0, 1);
}

// Scores 1.0 after `period` consecutive bullish bars each closing near their high.
// Returns 0 immediately when the streak is broken by a red candle.
function barStreakScore(bars: Bar[], index: number, period: number): number {
  const maxStreak = Math.max(period, 1);
  const bar = bars[index];
  if (bar.c <= bar.o) return 0;
  let streak = 0;
  for (let i = index; i >= 0 && streak < maxStreak; i--) {
    const b = bars[i];
    const range = b.h - b.l;
    const bullish = b.c > b.o;
    const closesHigh = range > 0 && (b.c - b.l) / range > 0.5;
    if (bullish && closesHigh) streak++;
    else break;
  }
  return clamp(streak / maxStreak, 0, 1);
}

// Scores 1.0 when price breaks above the upper Bollinger Band after a volatility squeeze.
// A squeeze is defined as ≥3 of the prior 6 bars having compressed band width.
function squeezeBreakoutScore(bars: Bar[], index: number, period: number): number {
  if (index < period + 6) return 0;
  const currBands = bollingerBands(bars, index, period, 2.0);
  if (!currBands || currBands[1] <= 0) return 0;
  const [, midCurr, upperCurr] = currBands;
  if (bars[index].c <= upperCurr) return 0;
  const currentWidth = (currBands[2] - currBands[0]) / midCurr;
  // Average band width over prior `period` bars
  let avgWidth = 0;
  let count = 0;
  for (let i = index - period; i < index; i++) {
    const b = bollingerBands(bars, i, period, 2.0);
    if (b && b[1] > 0) { avgWidth += (b[2] - b[0]) / b[1]; count++; }
  }
  if (count < Math.floor(period / 2)) return 0;
  avgWidth /= count;
  // Require squeeze: ≥3 of prior 6 bars were compressed
  let squeezeCount = 0;
  for (let i = Math.max(0, index - 6); i < index; i++) {
    const b = bollingerBands(bars, i, period, 2.0);
    if (b && b[1] > 0 && (b[2] - b[0]) / b[1] < avgWidth * 0.75) squeezeCount++;
  }
  if (squeezeCount < 3) return 0;
  const expansionRatio = avgWidth > 0 ? currentWidth / avgWidth : 1;
  const aboveUpper = (bars[index].c - upperCurr) / bars[index].c;
  return clamp(expansionRatio * 0.6 + aboveUpper * 10, 0, 1);
}

// Scores 1.0 on a large green candle body with a volume surge — the bullish mirror of selloff_pressure.
// Returns 0 on any red candle.
function bullishImpulseScore(bars: Bar[], index: number, period: number): number {
  const bar = bars[index];
  if (bar.c <= bar.o) return 0;
  const range = bar.h - bar.l;
  if (range < 1e-10) return 0;
  // Body ratio: marubozu = 1.0
  const bodyRatio = clamp((bar.c - bar.o) / range, 0, 1);
  if (index < period) return bodyRatio * 0.4; // no volume history yet
  let avgVol = 0;
  for (let i = index - period; i < index; i++) avgVol += bars[i].v;
  avgVol /= period;
  const relVol = avgVol > 0 ? bar.v / avgVol : 1;
  // 4x+ volume = full volume credit
  const volShock = clamp((relVol - 1.0) / 3.0, 0, 1);
  // 3%+ single-bar return = full return credit
  const barReturn = bar.o > 0 ? (bar.c - bar.o) / bar.o : 0;
  const returnScore = clamp(barReturn / 0.03, 0, 1);
  return clamp(bodyRatio * 0.4 + volShock * 0.35 + returnScore * 0.25, 0, 1);
}

// Scores 1.0 when RSI is trending strongly upward (RSI 70+) in an uptrend (price > SMA20).
// Returns 0 when price is below SMA20 or RSI is below 50 — avoids buying strength in a downtrend.
function momentumRsiScore(bars: Bar[], index: number, period: number): number {
  const r = rsi(bars, index, period);
  if (r === null) return 0;
  const score = clamp((r - 50) / 20, 0, 1);
  // Gate: only valid above the 20-bar moving average
  const ma = sma(bars, index, 20);
  if (ma === null || bars[index].c < ma) return 0;
  return score;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
