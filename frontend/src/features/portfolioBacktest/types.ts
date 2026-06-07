import type { BenchmarkPreset } from "../../lib/benchmarkPresets";
import type { Bar } from "../../lib/signals";

export type FormState = {
  allocationsText: string;
  benchmarkSymbolsText: string;
  initialCapital: number;
  startDate: string;
  endDate: string;
};

export type BarsApiPayload = {
  bars?: Bar[];
  error?: string;
};

export type ParsedAllocation = {
  symbol: string;
  requestedWeightPct: number;
  normalizedWeight: number;
};

export type ParsedAllocationSet = {
  allocations: ParsedAllocation[];
  totalRequestedWeightPct: number;
};

export type PortfolioEquityPoint = {
  date: string;
  portfolioValue: number;
};

export type BenchmarkEquityPoint = {
  date: string;
  portfolioValue: number;
  benchmarkValue: number;
};

export type HoldingResult = {
  symbol: string;
  requestedWeightPct: number;
  normalizedWeightPct: number;
  startPrice: number;
  endPrice: number;
  priceReturnPct: number;
  finalValue: number;
  finalWeightPct: number;
};

export type BenchmarkComparisonResult = {
  symbol: string;
  actualStartDate: string;
  actualEndDate: string;
  tradingDays: number;
  benchmarkInitialValue: number;
  benchmarkFinalValue: number;
  benchmarkReturnPct: number;
  benchmarkCagrPct: number | null;
  benchmarkMaxDrawdownPct: number;
  portfolioReturnAlignedPct: number;
  edgeVsBenchmarkPct: number;
  equityCurve: BenchmarkEquityPoint[];
};

export type PortfolioBacktestResult = {
  requestedStartDate: string;
  requestedEndDate: string;
  actualStartDate: string;
  actualEndDate: string;
  tradingDays: number;
  totalRequestedWeightPct: number;
  holdings: HoldingResult[];
  portfolioEquityCurve: PortfolioEquityPoint[];
  portfolioInitialValue: number;
  portfolioFinalValue: number;
  portfolioReturnPct: number;
  portfolioCagrPct: number | null;
  portfolioMaxDrawdownPct: number;
  benchmarks: BenchmarkComparisonResult[];
};

export type PortfolioBacktestInput = {
  allocations: ParsedAllocation[];
  totalRequestedWeightPct: number;
  barsBySymbol: Map<string, Bar[]>;
  benchmarkSymbols: string[];
  requestedStartDate: string;
  requestedEndDate: string;
  initialCapital: number;
};

export type NormalizedBenchmarkPreset = {
  id: string;
  label: string;
  symbols: string[];
  description: string | null;
};

export type PortfolioVsIndexesPageProps = {
  apiPrefix: string;
  title?: string;
  description?: string;
  fixedAllocationsText?: string | null;
  fixedAllocationsSourceLabel?: string;
  benchmarkInputLabel?: string;
  benchmarkInputHint?: string;
  defaultBenchmarkSymbols?: string[];
  benchmarkPresets?: BenchmarkPreset[];
};
