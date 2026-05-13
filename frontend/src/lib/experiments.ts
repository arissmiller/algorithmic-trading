import { WalkForwardRunResult } from "./backtest";

export interface SymbolWalkForwardResult {
  symbol: string;
  runs: WalkForwardRunResult[];
}

export interface ExperimentConfigSnapshot {
  totalAmount: number;
  cadenceDays: number;
  scaleInWindowDays: number;
  scaleOutWindowDays: number;
  walkForwardRuns: number;
  walkForwardStepDays: number;
  randomEnsembleSamples: number;
  aggressiveness: number;
}

export interface ExperimentSummary {
  observations: number;
  inVsLumpAvg: number;
  inVsRandomAvg: number;
  outVsLumpAvg: number;
  outVsRandomAvg: number;
}

export interface BacktestExperiment {
  id: string;
  label: string;
  createdAt: string;
  symbols: string[];
  config: ExperimentConfigSnapshot;
  symbolResults: SymbolWalkForwardResult[];
  summary: ExperimentSummary;
}

export function summarizeExperiment(symbolResults: SymbolWalkForwardResult[]): ExperimentSummary {
  let observations = 0;
  let inVsLumpTotal = 0;
  let inVsRandomTotal = 0;
  let outVsLumpTotal = 0;
  let outVsRandomTotal = 0;

  for (const symbolResult of symbolResults) {
    for (const run of symbolResult.runs) {
      observations += 1;
      inVsLumpTotal += run.result.scaleIn?.comparison.smartVsLumpPct ?? 0;
      inVsRandomTotal += run.result.scaleIn?.comparison.smartVsRandomPct ?? 0;
      outVsLumpTotal += run.result.scaleOut?.comparison.smartVsLumpPct ?? 0;
      outVsRandomTotal += run.result.scaleOut?.comparison.smartVsRandomPct ?? 0;
    }
  }

  if (observations === 0) {
    return {
      observations: 0,
      inVsLumpAvg: 0,
      inVsRandomAvg: 0,
      outVsLumpAvg: 0,
      outVsRandomAvg: 0,
    };
  }

  return {
    observations,
    inVsLumpAvg: inVsLumpTotal / observations,
    inVsRandomAvg: inVsRandomTotal / observations,
    outVsLumpAvg: outVsLumpTotal / observations,
    outVsRandomAvg: outVsRandomTotal / observations,
  };
}
