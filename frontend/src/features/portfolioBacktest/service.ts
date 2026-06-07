import { defaultMarketBenchmarkSymbols, normalizeBenchmarkSymbolList } from "../../lib/benchmarkPresets";
import type { Bar } from "../../lib/signals";
import type {
  BenchmarkComparisonResult,
  BenchmarkEquityPoint,
  FormState,
  NormalizedBenchmarkPreset,
  ParsedAllocation,
  ParsedAllocationSet,
  PortfolioBacktestInput,
  PortfolioBacktestResult,
  PortfolioEquityPoint,
} from "./types";

export const EXAMPLE_ALLOCATIONS = "VOO: 40\nQQQ: 25\nSCHD: 20\nTLT: 15";
export const EXAMPLE_BENCHMARKS = defaultMarketBenchmarkSymbols().join("\n");

export function defaultForm(defaultBenchmarkSymbols?: string[]): FormState {
  const endDate = addDaysIso(todayIsoDate(), -1);
  const startDate = addDaysIso(endDate, -365 * 3);
  const benchmarkSymbols = normalizeBenchmarkSymbolList(defaultBenchmarkSymbols ?? []);
  const fallbackBenchmarks = defaultMarketBenchmarkSymbols();
  const resolvedBenchmarkSymbols = benchmarkSymbols.length > 0 ? benchmarkSymbols : fallbackBenchmarks;
  return {
    allocationsText: EXAMPLE_ALLOCATIONS,
    benchmarkSymbolsText: resolvedBenchmarkSymbols.join("\n"),
    initialCapital: 10_000,
    startDate,
    endDate,
  };
}

export function parseAllocationsInput(input: string): ParsedAllocationSet {
  const entries = input
    .replace(/\r/g, "\n")
    .split("\n")
    .flatMap((line) => line.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error("Enter at least one allocation.");
  }

  const weightsBySymbol = new Map<string, number>();
  for (const entry of entries) {
    const match = entry.match(/^([A-Z0-9.\^/_-]+)\s*(?::|=|\s)\s*([0-9]*\.?[0-9]+)\s*%?$/i);
    if (!match) {
      throw new Error(`Could not parse "${entry}". Use format like VOO: 40`);
    }

    const symbol = match[1].trim().toUpperCase();
    const weight = Number(match[2]);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`Weight for ${symbol} must be greater than 0.`);
    }

    weightsBySymbol.set(symbol, (weightsBySymbol.get(symbol) ?? 0) + weight);
  }

  if (weightsBySymbol.size === 0) {
    throw new Error("No valid symbols found.");
  }

  const totalRequestedWeightPct = Array.from(weightsBySymbol.values()).reduce((sum, value) => sum + value, 0);
  if (totalRequestedWeightPct <= 0) {
    throw new Error("Total allocation must be greater than 0%.");
  }

  const allocations = Array.from(weightsBySymbol.entries()).map(([symbol, requestedWeightPct]) => ({
    symbol,
    requestedWeightPct,
    normalizedWeight: requestedWeightPct / totalRequestedWeightPct,
  }));

  return { allocations, totalRequestedWeightPct };
}

export function parseBenchmarkSymbolsInput(input: string): string[] {
  const entries = input
    .replace(/\r/g, "\n")
    .split("\n")
    .flatMap((line) => line.split(","))
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error("Enter at least one benchmark symbol.");
  }

  const unique = new Set<string>();
  for (const symbol of entries) {
    if (!/^[A-Z0-9.\^/_-]+$/.test(symbol)) {
      throw new Error(`Invalid benchmark symbol "${symbol}".`);
    }
    unique.add(symbol);
  }

  if (unique.size === 0) {
    throw new Error("No valid benchmark symbols found.");
  }

  return Array.from(unique);
}

export function normalizeBenchmarkPresets(
  presets: { id?: string; label?: string; symbols: string[]; description?: string }[] | undefined
): NormalizedBenchmarkPreset[] {
  if (!Array.isArray(presets) || presets.length === 0) return [];

  const out: NormalizedBenchmarkPreset[] = [];
  const usedIds = new Set<string>();

  for (let index = 0; index < presets.length; index += 1) {
    const preset = presets[index];
    const rawSymbols = Array.isArray(preset.symbols) ? preset.symbols : [];
    const symbols = normalizeBenchmarkSymbolList(rawSymbols);
    if (symbols.length === 0) continue;

    const baseId = preset.id?.trim() || `preset_${index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    out.push({
      id,
      label: preset.label?.trim() || `Preset ${index + 1}`,
      symbols,
      description: preset.description?.trim() || null,
    });
  }

  return out;
}

export function areSameSymbolSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  if (leftSet.size !== right.length) return false;
  return right.every((symbol) => leftSet.has(symbol));
}

export function buildTruncationWarnings(
  result: PortfolioBacktestResult,
  requestedStartDate: string,
  requestedEndDate: string,
  allocations: ParsedAllocation[],
  barsBySymbol: Map<string, Bar[]>
): string[] {
  const warnings: string[] = [];

  const startGapDays =
    result.actualStartDate > requestedStartDate
      ? Math.round(
          (Date.parse(`${result.actualStartDate}T00:00:00Z`) -
            Date.parse(`${requestedStartDate}T00:00:00Z`)) /
            86_400_000
        )
      : 0;

  const endGapDays =
    result.actualEndDate < requestedEndDate
      ? Math.round(
          (Date.parse(`${requestedEndDate}T00:00:00Z`) -
            Date.parse(`${result.actualEndDate}T00:00:00Z`)) /
            86_400_000
        )
      : 0;

  if (startGapDays > 10) {
    const limitingSymbols = allocations
      .map((allocation) => {
        const closeMap = buildDailyCloseMap(barsBySymbol.get(allocation.symbol) ?? []);
        const firstDate = Array.from(closeMap.keys()).sort()[0] ?? "";
        return { symbol: allocation.symbol, firstDate };
      })
      .filter((entry) => entry.firstDate > requestedStartDate)
      .sort((a, b) => (a.firstDate < b.firstDate ? 1 : -1));
    const culprit = limitingSymbols[0];
    warnings.push(
      culprit
        ? `Backtest starts ${startGapDays} days late (${result.actualStartDate}) because ${culprit.symbol} has no data before ${culprit.firstDate}.`
        : `Backtest starts ${startGapDays} days later than requested (${result.actualStartDate}).`
    );
  }

  if (endGapDays > 10) {
    const limitingSymbols = allocations
      .map((allocation) => {
        const closeMap = buildDailyCloseMap(barsBySymbol.get(allocation.symbol) ?? []);
        const dates = Array.from(closeMap.keys()).sort();
        const lastDate = dates[dates.length - 1] ?? "";
        return { symbol: allocation.symbol, lastDate };
      })
      .filter((entry) => entry.lastDate < requestedEndDate)
      .sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
    const culprit = limitingSymbols[0];
    warnings.push(
      culprit
        ? `Backtest ends ${endGapDays} days early (${result.actualEndDate}) because ${culprit.symbol} data stops at ${culprit.lastDate} — it may be delisted or unavailable.`
        : `Backtest ends ${endGapDays} days earlier than requested (${result.actualEndDate}).`
    );
  }

  return warnings;
}

export function computePortfolioBacktest(input: PortfolioBacktestInput): PortfolioBacktestResult {
  const symbols = input.allocations.map((allocation) => allocation.symbol);
  if (symbols.length === 0) {
    throw new Error("Portfolio must include at least one symbol.");
  }
  if (input.benchmarkSymbols.length === 0) {
    throw new Error("At least one benchmark symbol is required.");
  }

  const closeBySymbol = new Map<string, Map<string, number>>();
  const allSymbols = [...symbols, ...input.benchmarkSymbols];
  for (const symbol of allSymbols) {
    const bars = input.barsBySymbol.get(symbol);
    if (!bars || bars.length === 0) {
      throw new Error(`Missing market data for ${symbol}.`);
    }
    closeBySymbol.set(symbol, buildDailyCloseMap(bars));
  }

  const sets = symbols.map((symbol) => new Set(closeBySymbol.get(symbol)?.keys() ?? []));
  const firstSet = sets[0];
  if (!firstSet || firstSet.size === 0) {
    throw new Error("No market data available for the selected symbols.");
  }

  const commonPortfolioDates = Array.from(firstSet)
    .filter((date) => {
      if (date < input.requestedStartDate || date > input.requestedEndDate) return false;
      return sets.every((set) => set.has(date));
    })
    .sort((a, b) => (a < b ? -1 : 1));

  if (commonPortfolioDates.length < 2) {
    throw new Error(
      "Not enough overlapping portfolio data across selected symbols for that date range. Try fewer symbols or a wider window."
    );
  }

  const actualStartDate = commonPortfolioDates[0];
  const actualEndDate = commonPortfolioDates[commonPortfolioDates.length - 1];

  const sharesBySymbol = new Map<string, number>();
  for (const allocation of input.allocations) {
    const closeMap = closeBySymbol.get(allocation.symbol);
    const startPrice = closeMap?.get(actualStartDate);
    if (!closeMap || !startPrice || startPrice <= 0) {
      throw new Error(`Unable to initialize ${allocation.symbol} at ${actualStartDate}.`);
    }
    const allocatedCapital = input.initialCapital * allocation.normalizedWeight;
    sharesBySymbol.set(allocation.symbol, allocatedCapital / startPrice);
  }

  const portfolioEquityCurve: PortfolioEquityPoint[] = [];
  for (const date of commonPortfolioDates) {
    let portfolioValue = 0;

    for (const allocation of input.allocations) {
      const close = closeBySymbol.get(allocation.symbol)?.get(date);
      const shares = sharesBySymbol.get(allocation.symbol);
      if (!close || close <= 0 || !shares) {
        throw new Error(`Missing ${allocation.symbol} price data on ${date}.`);
      }
      portfolioValue += shares * close;
    }

    portfolioEquityCurve.push({ date, portfolioValue });
  }

  const finalPoint = portfolioEquityCurve[portfolioEquityCurve.length - 1];
  if (!finalPoint) {
    throw new Error("No equity curve points computed.");
  }

  const portfolioFinalValue = finalPoint.portfolioValue;

  const holdings = input.allocations
    .map((allocation) => {
      const closeMap = closeBySymbol.get(allocation.symbol);
      const startPrice = closeMap?.get(actualStartDate);
      const endPrice = closeMap?.get(actualEndDate);
      const shares = sharesBySymbol.get(allocation.symbol);

      if (!closeMap || !startPrice || !endPrice || !shares) {
        throw new Error(`Could not compute holding summary for ${allocation.symbol}.`);
      }

      const finalValue = shares * endPrice;
      const priceReturnPct = ((endPrice - startPrice) / startPrice) * 100;
      return {
        symbol: allocation.symbol,
        requestedWeightPct: allocation.requestedWeightPct,
        normalizedWeightPct: allocation.normalizedWeight * 100,
        startPrice,
        endPrice,
        priceReturnPct,
        finalValue,
        finalWeightPct: portfolioFinalValue > 0 ? (finalValue / portfolioFinalValue) * 100 : 0,
      };
    })
    .sort((a, b) => b.finalWeightPct - a.finalWeightPct);

  const portfolioReturnPct = ((portfolioFinalValue - input.initialCapital) / input.initialCapital) * 100;

  const benchmarks = input.benchmarkSymbols.map((benchmarkSymbol) => {
    const benchmarkCloseMap = closeBySymbol.get(benchmarkSymbol);
    if (!benchmarkCloseMap) {
      throw new Error(`Missing benchmark data for ${benchmarkSymbol}.`);
    }
    return computeBenchmarkComparison({
      benchmarkSymbol,
      benchmarkCloseMap,
      portfolioEquityCurve,
      initialCapital: input.initialCapital,
    });
  });

  return {
    requestedStartDate: input.requestedStartDate,
    requestedEndDate: input.requestedEndDate,
    actualStartDate,
    actualEndDate,
    tradingDays: commonPortfolioDates.length,
    totalRequestedWeightPct: input.totalRequestedWeightPct,
    holdings,
    portfolioEquityCurve,
    portfolioInitialValue: input.initialCapital,
    portfolioFinalValue,
    portfolioReturnPct,
    portfolioCagrPct: computeCagrPct(input.initialCapital, portfolioFinalValue, actualStartDate, actualEndDate),
    portfolioMaxDrawdownPct: computeMaxDrawdownPct(portfolioEquityCurve.map((point) => point.portfolioValue)),
    benchmarks,
  };
}

function computeBenchmarkComparison(input: {
  benchmarkSymbol: string;
  benchmarkCloseMap: Map<string, number>;
  portfolioEquityCurve: PortfolioEquityPoint[];
  initialCapital: number;
}): BenchmarkComparisonResult {
  const alignedPoints = input.portfolioEquityCurve
    .map((point) => {
      const close = input.benchmarkCloseMap.get(point.date);
      if (!close || close <= 0) return null;
      return { date: point.date, portfolioValue: point.portfolioValue, benchmarkClose: close };
    })
    .filter((point): point is { date: string; portfolioValue: number; benchmarkClose: number } => point !== null);

  if (alignedPoints.length < 2) {
    throw new Error(`Not enough overlapping data between portfolio symbols and ${input.benchmarkSymbol}.`);
  }

  const actualStartDate = alignedPoints[0].date;
  const actualEndDate = alignedPoints[alignedPoints.length - 1].date;
  const benchmarkStartPrice = alignedPoints[0].benchmarkClose;
  const benchmarkShares = input.initialCapital / benchmarkStartPrice;

  const equityCurve: BenchmarkEquityPoint[] = alignedPoints.map((point) => ({
    date: point.date,
    portfolioValue: point.portfolioValue,
    benchmarkValue: benchmarkShares * point.benchmarkClose,
  }));

  const benchmarkFinalValue = equityCurve[equityCurve.length - 1].benchmarkValue;
  const benchmarkReturnPct = ((benchmarkFinalValue - input.initialCapital) / input.initialCapital) * 100;

  const alignedPortfolioInitial = alignedPoints[0].portfolioValue;
  const alignedPortfolioFinal = alignedPoints[alignedPoints.length - 1].portfolioValue;
  const portfolioReturnAlignedPct = ((alignedPortfolioFinal - alignedPortfolioInitial) / alignedPortfolioInitial) * 100;

  return {
    symbol: input.benchmarkSymbol,
    actualStartDate,
    actualEndDate,
    tradingDays: equityCurve.length,
    benchmarkInitialValue: input.initialCapital,
    benchmarkFinalValue,
    benchmarkReturnPct,
    benchmarkCagrPct: computeCagrPct(input.initialCapital, benchmarkFinalValue, actualStartDate, actualEndDate),
    benchmarkMaxDrawdownPct: computeMaxDrawdownPct(equityCurve.map((point) => point.benchmarkValue)),
    portfolioReturnAlignedPct,
    edgeVsBenchmarkPct: portfolioReturnAlignedPct - benchmarkReturnPct,
    equityCurve,
  };
}

function buildDailyCloseMap(bars: Bar[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const bar of bars) {
    const day = toUtcDate(bar.t);
    if (!day) continue;
    if (!Number.isFinite(bar.c) || bar.c <= 0) continue;
    out.set(day, bar.c);
  }
  return out;
}

function computeMaxDrawdownPct(values: number[]): number {
  if (values.length === 0) return 0;
  let peak = values[0];
  let maxDrawdown = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak <= 0) continue;
    const drawdown = ((peak - value) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return maxDrawdown;
}

function computeCagrPct(
  initialValue: number,
  finalValue: number,
  startDateIso: string,
  endDateIso: string
): number | null {
  if (!Number.isFinite(initialValue) || !Number.isFinite(finalValue) || initialValue <= 0 || finalValue <= 0) {
    return null;
  }
  const startDate = parseIsoDateToUtc(startDateIso);
  const endDate = parseIsoDateToUtc(endDateIso);
  if (!startDate || !endDate) return null;
  const years = (endDate.getTime() - startDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(years) || years <= 0) return null;
  return (Math.pow(finalValue / initialValue, 1 / years) - 1) * 100;
}

function todayIsoDate(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDateToUtc(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  return Number.isFinite(date.getTime()) ? date : null;
}

function toUtcDate(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toISOString().split("T")[0];
}

function addDaysIso(isoDate: string, days: number): string {
  const date = parseIsoDateToUtc(isoDate);
  if (!date) return isoDate;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split("T")[0];
}
