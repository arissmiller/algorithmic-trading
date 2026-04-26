export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type SignalType =
  | { type: "price_vs_sma";   period: number }
  | { type: "rsi";            period: number }
  | { type: "bollinger_band"; period: number; std_dev: number }
  | { type: "volume";         period: number }
  | { type: "momentum";       period: number };

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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
