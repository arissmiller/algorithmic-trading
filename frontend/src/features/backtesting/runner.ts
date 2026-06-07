import type { BacktestRun } from "../../components/RunQueueBuilder";
import { STRATEGY_PRESETS, type StrategyForm } from "../../components/StrategyBuilder";
import { runBacktest } from "../../lib/backtest";
import { runCryptoAutotraderBacktest } from "../../lib/cryptoAutotraderBacktest";
import { runCryptoShortSelloffBacktest } from "../../lib/cryptoShortSelloffBacktest";
import { runCryptoTrendConfidenceBacktest } from "../../lib/cryptoTrendConfidenceBacktest";
import { analyzeMarketCondition } from "../../lib/marketConditions";
import { runPerpetualBacktest } from "../../lib/perpetualBacktest";
import type { Bar } from "../../lib/signals";
import type { FetchBars, RunQueueResult } from "./types";
import { addDaysIso } from "./dateUtils";
import { rangeForStartDate } from "./rangeUtils";
import { isLikelyCryptoSymbol, normalizeSymbol } from "./symbolUtils";
import { resolveBacktestWindows, resolveIntradayFetchWindow } from "./windowUtils";

export function buildFormFromRun(run: BacktestRun): StrategyForm {
  const preset = STRATEGY_PRESETS.find((candidate) => candidate.key === run.presetKey) ?? STRATEGY_PRESETS[0];
  const strategyMode = preset.strategyMode ?? "two_phase";
  const presetPhase = preset.phase;

  let scaleInDays: number;
  let scaleOutDays: number;

  if (strategyMode === "continuous_range") {
    scaleInDays = run.durationDays;
    scaleOutDays = run.durationDays;
  } else if (presetPhase === "scale_in") {
    scaleInDays = run.durationDays;
    scaleOutDays = 1;
  } else if (presetPhase === "scale_out") {
    scaleInDays = 1;
    scaleOutDays = run.durationDays;
  } else {
    const presetScaleIn = preset.config.scaleInWindowDays;
    const presetScaleOut = preset.config.scaleOutWindowDays;
    const presetTotal = presetScaleIn + presetScaleOut;
    scaleInDays = Math.max(1, Math.round((run.durationDays * presetScaleIn) / presetTotal));
    scaleOutDays = Math.max(1, run.durationDays - scaleInDays);
  }

  const scaleOutStartDate = presetPhase === "scale_out" ? run.startDate : addDaysIso(run.startDate, scaleInDays);
  const endDate = addDaysIso(scaleOutStartDate, scaleOutDays);
  const symbol = normalizeSymbol(run.symbol);

  return {
    symbol,
    timeframe: preset.timeframe ?? "1Day",
    strategyMode,
    phase: presetPhase,
    totalAmount: run.totalAmount,
    cadenceDays: run.cadenceDays,
    startDate: run.startDate,
    endDate,
    scaleInWindowDays: scaleInDays,
    scaleOutStartDate,
    scaleOutWindowDays: scaleOutDays,
    randomEnsembleSamples: 400,
    aggressiveness: preset.config.aggressiveness,
    accountType: isLikelyCryptoSymbol(symbol) ? "tax_advantaged" : "taxable",
    washSaleWindowDays: 30,
    signals: preset.config.signals.map((signalWeight) => ({ ...signalWeight, signal: { ...signalWeight.signal } })),
  };
}

export async function executeBacktestRun({
  run,
  form,
  benchmarkSymbol,
  fetchBars,
}: {
  run: BacktestRun;
  form: StrategyForm;
  benchmarkSymbol: string;
  fetchBars: FetchBars;
}): Promise<RunQueueResult> {
  const symbol = normalizeSymbol(form.symbol);
  const intradayFetchWindow = resolveIntradayFetchWindow(form);
  const neededRange = rangeForStartDate(form.startDate);
  const assetData = await fetchBars(symbol, {
    timeframe: form.timeframe,
    range: neededRange,
    startDate: intradayFetchWindow?.startDate,
    endDate: intradayFetchWindow?.endDate,
  });
  const assetBars = assetData.bars;
  const assetEarningsEvents = assetData.earningsEvents;
  const marketRecommendation = analyzeMarketCondition(assetBars);

  if (assetBars.length === 0) {
    throw new Error("No bars loaded for symbol.");
  }

  const benchmarkBars = await loadBenchmarkBars({
    benchmarkSymbol,
    symbol,
    assetBars,
    fetchBars,
  });

  if (run.presetKey === "perpetual" || run.presetKey === "crypto_perpetual_selloff_protection") {
    return executePerpetualRun({ run, form, assetBars, assetEarningsEvents, marketRecommendation });
  }

  if (run.presetKey === "crypto_autotrader") {
    return executeAutotraderRun({ run, form, assetBars, assetEarningsEvents, marketRecommendation });
  }

  if (run.presetKey === "crypto_short_selloff") {
    return executeShortSelloffRun({
      run,
      form,
      assetBars,
      marketRecommendation,
      fetchBars,
      neededRange,
    });
  }

  if (run.presetKey === "crypto_trend_confidence") {
    return executeTrendConfidenceRun({ run, form, assetBars, assetEarningsEvents, marketRecommendation });
  }

  return {
    run,
    form,
    result: computeResultForForm(form, assetBars, benchmarkBars, benchmarkSymbol),
    bars: assetBars,
    earningsEvents: assetEarningsEvents,
    marketRecommendation,
    error: null,
  };
}

async function loadBenchmarkBars({
  benchmarkSymbol,
  symbol,
  assetBars,
  fetchBars,
}: {
  benchmarkSymbol: string;
  symbol: string;
  assetBars: Bar[];
  fetchBars: FetchBars;
}): Promise<Bar[]> {
  if (normalizeSymbol(benchmarkSymbol) === symbol) {
    return assetBars;
  }

  try {
    return (await fetchBars(benchmarkSymbol, {})).bars;
  } catch {
    return [];
  }
}

function computeResultForForm(
  form: StrategyForm,
  assetBars: Bar[],
  benchmarkBars: Bar[],
  benchmarkSymbol: string
) {
  const symbol = normalizeSymbol(form.symbol);
  const applyWashSaleRule = !isLikelyCryptoSymbol(symbol);
  const windows = resolveBacktestWindows(form);
  const computed = runBacktest({
    symbol,
    bars: assetBars,
    benchmarkBars,
    benchmarkSymbol,
    totalAmount: form.totalAmount,
    cadenceDays: form.cadenceDays,
    startDate: windows.startDate,
    scaleOutStartDate: windows.scaleOutStartDate,
    scaleInWindowDays: windows.scaleInWindowDays,
    scaleOutWindowDays: windows.scaleOutWindowDays,
    phase: form.phase,
    randomEnsembleSamples: form.randomEnsembleSamples,
    aggressiveness: form.aggressiveness,
    accountType: form.accountType,
    washSaleWindowDays: form.washSaleWindowDays,
    applyWashSaleRule,
    signals: form.signals,
  });
  if (!computed) {
    throw new Error(
      "No trades were generated. Try increasing amount, changing dates/cadence, or using a different preset."
    );
  }
  return computed;
}

function executePerpetualRun({
  run,
  form,
  assetBars,
  assetEarningsEvents,
  marketRecommendation,
}: {
  run: BacktestRun;
  form: StrategyForm;
  assetBars: Bar[];
  assetEarningsEvents: RunQueueResult["earningsEvents"];
  marketRecommendation: RunQueueResult["marketRecommendation"];
}): RunQueueResult {
  const preset = STRATEGY_PRESETS.find((candidate) => candidate.key === run.presetKey)!;
  const endDate = addDaysIso(run.startDate, run.durationDays);
  const perpetualResult = runPerpetualBacktest({
    symbol: normalizeSymbol(form.symbol),
    bars: assetBars,
    startDate: run.startDate,
    endDate,
    totalAmount: run.totalAmount,
    cadenceDays: run.cadenceDays,
    buyThreshold: preset.buyThreshold ?? preset.config.aggressiveness,
    sellThreshold: preset.sellThreshold ?? (1 - (preset.buyThreshold ?? preset.config.aggressiveness)),
    signals: preset.config.signals,
    selloffProtection: preset.selloffProtection
      ? {
          signals: preset.selloffProtection.selloffSignals,
          selloffStartThreshold: preset.selloffProtection.selloffStartThreshold,
          selloffEndThreshold: preset.selloffProtection.selloffEndThreshold,
        }
      : undefined,
  });
  if (!perpetualResult) {
    throw new Error("No trades generated. Try a longer duration or different dates.");
  }
  return {
    run,
    form,
    result: null,
    perpetualResult,
    bars: assetBars,
    earningsEvents: assetEarningsEvents,
    marketRecommendation,
    error: null,
  };
}

function executeAutotraderRun({
  run,
  form,
  assetBars,
  assetEarningsEvents,
  marketRecommendation,
}: {
  run: BacktestRun;
  form: StrategyForm;
  assetBars: Bar[];
  assetEarningsEvents: RunQueueResult["earningsEvents"];
  marketRecommendation: RunQueueResult["marketRecommendation"];
}): RunQueueResult {
  const preset = STRATEGY_PRESETS.find((candidate) => candidate.key === "crypto_autotrader")!;
  const endDate = addDaysIso(run.startDate, run.durationDays);
  const autotraderCfg = preset.autotrader;
  if (!autotraderCfg) {
    throw new Error("Crypto autotrader preset is missing configuration.");
  }

  const autotraderResult = runCryptoAutotraderBacktest({
    symbol: normalizeSymbol(form.symbol),
    bars: assetBars,
    timeframe: form.timeframe === "1Day" ? "1Day" : "1Hour",
    startDate: run.startDate,
    endDate,
    totalAmount: run.totalAmount,
    signals: preset.config.signals,
    selloffSignals: autotraderCfg.selloffSignals,
    selloffStartThreshold: autotraderCfg.selloffStartThreshold,
    selloffEndThreshold: autotraderCfg.selloffEndThreshold,
    atrPeriod: autotraderCfg.atrPeriod,
    shortStopAtrMult: autotraderCfg.shortStopAtrMult,
    shortTakeProfitRR: autotraderCfg.shortTakeProfitRR,
    shortMaxHoldBars: autotraderCfg.shortMaxHoldBars,
    shortBreakEvenActivationRR: autotraderCfg.shortBreakEvenActivationRR,
    shortBreakEvenLockRR: autotraderCfg.shortBreakEvenLockRR,
    shortTrailActivationRR: autotraderCfg.shortTrailActivationRR,
    shortTrailAtrMult: autotraderCfg.shortTrailAtrMult,
    longEntrySlopeThreshold: autotraderCfg.longEntrySlopeThreshold,
    longExitSlopeThreshold: autotraderCfg.longExitSlopeThreshold,
    longExitStyle: autotraderCfg.longExitStyle,
    longStopAtrMult: autotraderCfg.longStopAtrMult,
    longTakeProfitRR: autotraderCfg.longTakeProfitRR,
    longTrailAtrMult: autotraderCfg.longTrailAtrMult,
    longBreakEvenActivationRR: autotraderCfg.longBreakEvenActivationRR,
    longBreakEvenLockRR: autotraderCfg.longBreakEvenLockRR,
    longTrailActivationRR: autotraderCfg.longTrailActivationRR,
    longTrailingStopPct: autotraderCfg.longTrailingStopPct,
    trailingActivationPct: autotraderCfg.trailingActivationPct,
  });
  if (!autotraderResult) {
    throw new Error(
      "No autotrader trades were generated. Try a longer duration, larger amount, or an earlier start date."
    );
  }
  return {
    run,
    form,
    result: null,
    autotraderResult,
    bars: assetBars,
    earningsEvents: assetEarningsEvents,
    marketRecommendation,
    error: null,
  };
}

async function executeShortSelloffRun({
  run,
  form,
  assetBars,
  marketRecommendation,
  fetchBars,
  neededRange,
}: {
  run: BacktestRun;
  form: StrategyForm;
  assetBars: Bar[];
  marketRecommendation: RunQueueResult["marketRecommendation"];
  fetchBars: FetchBars;
  neededRange: string;
}): Promise<RunQueueResult> {
  const preset = STRATEGY_PRESETS.find((candidate) => candidate.key === "crypto_short_selloff")!;
  const endDate = addDaysIso(run.startDate, run.durationDays);
  const autotraderCfg = preset.autotrader;
  if (!autotraderCfg) {
    throw new Error("Crypto short selloff preset is missing configuration.");
  }

  const intradayExecution = await fetchBars(normalizeSymbol(form.symbol), {
    timeframe: "5Min",
    range: neededRange,
    startDate: run.startDate,
    endDate,
  });
  const executionBars = intradayExecution.bars;
  if (executionBars.length === 0) {
    throw new Error("No 5Min bars loaded for short selloff execution window.");
  }

  const shortSelloffResult = runCryptoShortSelloffBacktest({
    symbol: normalizeSymbol(form.symbol),
    hourlyBars: assetBars,
    executionBars,
    startDate: run.startDate,
    endDate,
    totalAmount: run.totalAmount,
    signals: preset.config.signals,
    selloffSignals: autotraderCfg.selloffSignals,
    selloffStartThreshold: autotraderCfg.selloffStartThreshold,
    selloffEndThreshold: autotraderCfg.selloffEndThreshold,
  });
  if (!shortSelloffResult) {
    throw new Error(
      "No short selloff trades were generated. Try a longer duration or an earlier start date."
    );
  }

  return {
    run,
    form,
    result: null,
    autotraderResult: shortSelloffResult,
    bars: executionBars,
    earningsEvents: intradayExecution.earningsEvents,
    marketRecommendation,
    error: null,
  };
}

function executeTrendConfidenceRun({
  run,
  form,
  assetBars,
  assetEarningsEvents,
  marketRecommendation,
}: {
  run: BacktestRun;
  form: StrategyForm;
  assetBars: Bar[];
  assetEarningsEvents: RunQueueResult["earningsEvents"];
  marketRecommendation: RunQueueResult["marketRecommendation"];
}): RunQueueResult {
  const endDate = addDaysIso(run.startDate, run.durationDays);
  const trendConfidenceResult = runCryptoTrendConfidenceBacktest({
    symbol: normalizeSymbol(form.symbol),
    bars: assetBars,
    startDate: run.startDate,
    endDate,
  });
  if (!trendConfidenceResult) {
    throw new Error("No trend regions could be classified. Try a longer duration or an earlier start date.");
  }
  return {
    run,
    form,
    result: null,
    trendConfidenceResult,
    bars: assetBars,
    earningsEvents: assetEarningsEvents,
    marketRecommendation,
    error: null,
  };
}
