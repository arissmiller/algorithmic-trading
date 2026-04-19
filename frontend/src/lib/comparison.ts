export interface BacktestComparisonRow {
  id: string;
  createdAt: string;
  label: string;
  symbol: string;
  totalAmount: number;
  startDate: string;
  scaleInWindowDays: number;
  scaleOutWindowDays: number;
  walkForwardRuns: number;
  walkForwardStepDays: number;
  cadenceDays: number;
  aggressiveness: number;
  randomEnsembleSamples: number;
  observations: number;
  inVsLumpMean: number;
  inVsRandomMean: number;
  outVsLumpMean: number;
  outVsRandomMean: number;
}

export function makeRegimeKey(row: Pick<
  BacktestComparisonRow,
  "startDate" | "scaleInWindowDays" | "scaleOutWindowDays" | "walkForwardRuns" | "walkForwardStepDays"
>): string {
  return `${row.startDate}|IN:${row.scaleInWindowDays}|OUT:${row.scaleOutWindowDays}|WF:${row.walkForwardRuns}x${row.walkForwardStepDays}`;
}
