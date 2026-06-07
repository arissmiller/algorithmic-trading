import type { StrategyForm } from "../../components/StrategyBuilder";
import { addDaysIso, deriveInclusiveDaySpan } from "./dateUtils";

export type BacktestWindow = {
  startDate: string;
  scaleOutStartDate: string;
  scaleInWindowDays: number;
  scaleOutWindowDays: number;
};

export function resolveIntradayFetchWindow(form: StrategyForm): { startDate: string; endDate: string } | null {
  if (form.timeframe !== "15Min" && form.timeframe !== "5Min") {
    return null;
  }

  const windows = resolveBacktestWindows(form);
  return {
    startDate: windows.startDate,
    endDate: addDaysIso(windows.scaleOutStartDate, windows.scaleOutWindowDays - 1),
  };
}

export function resolveBacktestWindows(form: StrategyForm): BacktestWindow {
  if (form.strategyMode !== "continuous_range") {
    return {
      startDate: form.startDate,
      scaleOutStartDate: form.scaleOutStartDate,
      scaleInWindowDays: Math.max(1, Math.round(form.scaleInWindowDays)),
      scaleOutWindowDays: Math.max(1, Math.round(form.scaleOutWindowDays)),
    };
  }

  const daySpan = deriveInclusiveDaySpan(form.startDate, form.endDate);
  return {
    startDate: form.startDate,
    scaleOutStartDate: form.startDate,
    scaleInWindowDays: daySpan,
    scaleOutWindowDays: daySpan,
  };
}
