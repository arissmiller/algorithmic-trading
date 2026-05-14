import { Direction, generateSchedule, ScheduledTrade } from "./dca";
import { Bar, SignalWeight } from "./signals";

export type AccountType = "taxable" | "tax_advantaged";

export interface TradeTaxSummary {
  plannedSellShares: number;
  executedSellShares: number;
  avgCostBasis: number;
  realizedPnL: number;
  disallowedLoss: number;
  replacementShares: number;
  washAdjustedPnL: number;
  washSaleTriggered: boolean;
}

export interface BacktestTrade {
  date: string;
  price: number;
  amountUsd: number;
  shares: number;
  sharesHeld: number;
  signalScore: number;
  rationale: string;
  side: "buy" | "sell";
  tax?: TradeTaxSummary;
}

export interface WashSaleEvent {
  saleDate: string;
  lossPerShare: number;
  lossShares: number;
  replacementShares: number;
  disallowedLoss: number;
}

export interface TaxImpactSummary {
  accountType: AccountType;
  washSaleWindowDays: number;
  washRuleEligibleAsset: boolean;
  washRuleApplied: boolean;
  grossRealizedPnL: number;
  disallowedLossDeferred: number;
  washAdjustedRealizedPnL: number;
  washSaleEventCount: number;
  washSaleEvents: WashSaleEvent[];
}

export interface AvgPriceComparison {
  smartScale: number;
  lumpSum: number;
  randomScale: number;
  intervalScale: number;
  smartVsLumpPct: number;
  smartVsRandomPct: number;
  smartVsIntervalPct: number;
}

export interface DirectionalBacktestResult {
  direction: Direction;
  trades: BacktestTrade[];
  // For scale-in this is average buy cost basis; for scale-out average sell price.
  avgExecutionPrice: number;
  totalShares: number;
  totalAmount: number;
  comparison: AvgPriceComparison;
}

export interface BacktestResult {
  symbol: string;
  phase?: "scale_in" | "scale_out";
  scaleIn: DirectionalBacktestResult | null;
  scaleOut: DirectionalBacktestResult | null;
  performance: StrategyPerformance;
  benchmark: BenchmarkPerformance | null;
}

export interface ReturnSnapshot {
  avgBuyPrice: number;
  avgSellPrice: number;
  shares: number;
  proceeds: number;
  profitUsd: number;
  profitPct: number;
}

export interface ReturnComparison {
  lumpSum: ReturnSnapshot;
  randomEnsemble: ReturnSnapshot;
  intervalScale: ReturnSnapshot;
  strategyVsLumpPct: number;
  strategyVsRandomPct: number;
  strategyVsIntervalPct: number;
}

export interface StrategyPerformance {
  startDate: string;
  scaleOutStartDate: string;
  endDate: string;
  investedAmount: number;
  proceeds: number;
  sharesBought: number;
  avgCost: number;
  avgSalePrice: number;
  profitUsd: number;
  profitPct: number;
  returnComparison: ReturnComparison;
  tax: TaxImpactSummary;
}

export interface BenchmarkPerformance {
  symbol: string;
  startDate: string;
  endDate: string;
  startPrice: number;
  endPrice: number;
  finalValue: number;
  profitUsd: number;
  profitPct: number;
}

export interface ExecutionFrictionConfig {
  slippageBps: number;
  spreadBps: number;
  feeBps: number;
}

export interface BacktestConfig {
  symbol: string;
  bars: Bar[];
  benchmarkBars?: Bar[];
  benchmarkSymbol?: string;
  startDate: string;
  scaleOutStartDate?: string;
  scaleInWindowDays: number;
  scaleOutWindowDays: number;
  phase?: "scale_in" | "scale_out";
  cadenceDays: number;
  totalAmount: number;
  aggressiveness: number;
  signals: SignalWeight[];
  randomEnsembleSamples?: number;
  friction?: ExecutionFrictionConfig;
  accountType?: AccountType;
  washSaleWindowDays?: number;
  applyWashSaleRule?: boolean;
}

export interface WalkForwardConfig extends BacktestConfig {
  walkForwardRuns: number;
  walkForwardStepDays: number;
}

export interface WalkForwardRunResult {
  runNumber: number;
  startDate: string;
  result: BacktestResult;
}

export interface MetricDistribution {
  mean: number;
  median: number;
  stdev: number;
  min: number;
  max: number;
  winRatePct: number;
}

export interface WalkForwardSummary {
  runCount: number;
  inVsLump: MetricDistribution;
  inVsRandom: MetricDistribution;
  outVsLump: MetricDistribution;
  outVsRandom: MetricDistribution;
}

const DAY_MS = 86_400_000;

export function runBacktest(cfg: BacktestConfig): BacktestResult | null {
  const scaleInStartDate = cfg.startDate;
  const derivedScaleOutStartDate = addDaysIso(cfg.startDate, cfg.scaleInWindowDays);
  const scaleOutStartDate = normalizeIsoDate(cfg.scaleOutStartDate) ?? derivedScaleOutStartDate;
  const endDate = addDaysIso(scaleOutStartDate, cfg.scaleOutWindowDays);
  const phase = cfg.phase;
  const taxCfg = {
    accountType: cfg.accountType ?? "taxable",
    washSaleWindowDays: normalizeWashSaleWindow(cfg.washSaleWindowDays),
    applyWashSaleRule: cfg.applyWashSaleRule ?? !isLikelyCryptoSymbol(cfg.symbol),
  };

  if (phase === "scale_in") {
    const scaleIn = runDirectionalBacktest(cfg, "scale_in", cfg.scaleInWindowDays, scaleInStartDate);
    if (!scaleIn) return null;
    const tax = computeTaxImpact(scaleIn.trades, [], 0, taxCfg);
    const performance: StrategyPerformance = {
      startDate: scaleInStartDate,
      scaleOutStartDate: derivedScaleOutStartDate,
      endDate: derivedScaleOutStartDate,
      investedAmount: scaleIn.totalAmount,
      proceeds: 0,
      sharesBought: scaleIn.totalShares,
      avgCost: scaleIn.avgExecutionPrice,
      avgSalePrice: 0,
      profitUsd: 0,
      profitPct: 0,
      returnComparison: buildSinglePhaseReturnComparison(scaleIn),
      tax: tax.summary,
    };
    const benchmark = computeBenchmarkPerformance(
      cfg.benchmarkBars ?? [], cfg.benchmarkSymbol ?? "^GSPC",
      scaleInStartDate, derivedScaleOutStartDate, scaleIn.totalAmount
    );
    return { symbol: cfg.symbol, phase, scaleIn, scaleOut: null, performance, benchmark };
  }

  if (phase === "scale_out") {
    const scaleOut = runDirectionalBacktest(cfg, "scale_out", cfg.scaleOutWindowDays, scaleOutStartDate);
    if (!scaleOut) return null;
    const tax = computeTaxImpact([], scaleOut.trades, 0, taxCfg);
    const scaleOutWithTax: DirectionalBacktestResult = {
      ...scaleOut,
      trades: scaleOut.trades.map((trade, idx) => ({ ...trade, tax: tax.tradeTaxByIndex[idx] })),
    };
    const performance: StrategyPerformance = {
      startDate: scaleOutStartDate,
      scaleOutStartDate,
      endDate,
      investedAmount: 0,
      proceeds: scaleOut.totalAmount,
      sharesBought: 0,
      avgCost: 0,
      avgSalePrice: scaleOut.avgExecutionPrice,
      profitUsd: 0,
      profitPct: 0,
      returnComparison: buildSinglePhaseReturnComparison(scaleOut),
      tax: tax.summary,
    };
    const benchmark = computeBenchmarkPerformance(
      cfg.benchmarkBars ?? [], cfg.benchmarkSymbol ?? "^GSPC",
      scaleOutStartDate, endDate, scaleOut.totalAmount
    );
    return { symbol: cfg.symbol, phase, scaleIn: null, scaleOut: scaleOutWithTax, performance, benchmark };
  }

  const scaleIn = runDirectionalBacktest(cfg, "scale_in", cfg.scaleInWindowDays, scaleInStartDate);
  const scaleOut = runDirectionalBacktest(cfg, "scale_out", cfg.scaleOutWindowDays, scaleOutStartDate);
  if (!scaleIn || !scaleOut) return null;

  const tax = computeTaxImpact(scaleIn.trades, scaleOut.trades, scaleIn.totalShares, taxCfg);

  const scaleOutWithTax: DirectionalBacktestResult = {
    ...scaleOut,
    trades: scaleOut.trades.map((trade, idx) => ({
      ...trade,
      tax: tax.tradeTaxByIndex[idx],
    })),
  };

  const investedAmount = scaleIn.totalAmount;
  const sharesBought = scaleIn.totalShares;
  const proceeds = sharesBought * scaleOut.avgExecutionPrice;
  const profitUsd = proceeds - investedAmount;
  const profitPct = investedAmount > 0 ? (profitUsd / investedAmount) * 100 : 0;

  const performance: StrategyPerformance = {
    startDate: scaleInStartDate,
    scaleOutStartDate,
    endDate,
    investedAmount,
    proceeds,
    sharesBought,
    avgCost: scaleIn.avgExecutionPrice,
    avgSalePrice: scaleOut.avgExecutionPrice,
    profitUsd,
    profitPct,
    returnComparison: buildReturnComparison(investedAmount, profitPct, scaleIn, scaleOut),
    tax: tax.summary,
  };

  const benchmark = computeBenchmarkPerformance(
    cfg.benchmarkBars ?? [],
    cfg.benchmarkSymbol ?? "^GSPC",
    scaleInStartDate,
    endDate,
    investedAmount
  );

  return { symbol: cfg.symbol, scaleIn, scaleOut: scaleOutWithTax, performance, benchmark };
}

export function runWalkForwardBacktest(cfg: WalkForwardConfig): WalkForwardRunResult[] {
  const runs = Math.max(1, Math.floor(cfg.walkForwardRuns));
  const stepDays = Math.max(1, Math.floor(cfg.walkForwardStepDays));
  const out: WalkForwardRunResult[] = [];

  for (let i = 0; i < runs; i++) {
    const runStartDate = addDaysIso(cfg.startDate, i * stepDays);
    const runResult = runBacktest({
      ...cfg,
      startDate: runStartDate,
    });
    if (!runResult) continue;
    out.push({
      runNumber: i + 1,
      startDate: runStartDate,
      result: runResult,
    });
  }

  return out;
}

export function summarizeWalkForwardRuns(runs: WalkForwardRunResult[]): WalkForwardSummary {
  const inVsLump = runs.map((r) => r.result.scaleIn?.comparison.smartVsLumpPct ?? 0);
  const inVsRandom = runs.map((r) => r.result.scaleIn?.comparison.smartVsRandomPct ?? 0);
  const outVsLump = runs.map((r) => r.result.scaleOut?.comparison.smartVsLumpPct ?? 0);
  const outVsRandom = runs.map((r) => r.result.scaleOut?.comparison.smartVsRandomPct ?? 0);

  return {
    runCount: runs.length,
    inVsLump: summarizeMetric(inVsLump),
    inVsRandom: summarizeMetric(inVsRandom),
    outVsLump: summarizeMetric(outVsLump),
    outVsRandom: summarizeMetric(outVsRandom),
  };
}

function runDirectionalBacktest(
  cfg: BacktestConfig,
  direction: Direction,
  windowDays: number,
  startDate: string
): DirectionalBacktestResult | null {
  const startTs = new Date(startDate).getTime();
  const endTs = startTs + windowDays * DAY_MS;
  const windowBars = cfg.bars.filter((b) => {
    const t = new Date(b.t).getTime();
    return t >= startTs && t < endTs && b.c > 0;
  });
  if (windowBars.length === 0) return null;

  const trancheCount = deriveTrancheCount(windowDays, cfg.cadenceDays, windowBars.length);
  const smartSchedule = generateSchedule(
    cfg.bars,
    startDate,
    windowDays,
    trancheCount,
    cfg.totalAmount,
    direction,
    cfg.aggressiveness,
    cfg.signals
  );
  if (smartSchedule.length === 0) return null;

  const friction = normalizeFriction(cfg.friction);

  // For scale-out: derive starting whole-share count from position value at window's first bar.
  let startShares = 0;
  if (direction === "scale_out" && windowBars.length > 0) {
    const startPrice = applyExecutionPrice(windowBars[0].c, "scale_out", friction);
    startShares = startPrice > 0 ? Math.floor(cfg.totalAmount / startPrice) : 0;
  }

  const smartTrades = matchScheduledTrades(cfg.bars, smartSchedule, direction, friction, startShares);
  if (smartTrades.length === 0) return null;

  const smart = summariseTrades(smartTrades);
  if (smart.totalShares <= 0 || smart.totalAmount <= 0) return null;

  // Keep baseline budgets identical to what smart scale actually deployed.
  const comparisonBudget = smart.totalAmount;
  const comparisonTranches = Math.min(smartTrades.length, windowBars.length);
  const randomSeed = hash32(
    `${cfg.symbol}|${startDate}|${windowDays}|${comparisonTranches}|${direction}`
  );
  const randomSamples = Math.max(50, cfg.randomEnsembleSamples ?? 400);

  const lumpSum = lumpSumAvgPrice(windowBars, comparisonBudget);
  const randomScale = randomEnsembleAvgPrice(
    windowBars,
    comparisonBudget,
    comparisonTranches,
    randomSeed,
    randomSamples,
    direction,
    friction
  );
  const intervalScale = intervalScaleAvgPrice(
    windowBars,
    comparisonBudget,
    comparisonTranches,
    direction,
    friction
  );

  return {
    direction,
    trades: smartTrades,
    avgExecutionPrice: smart.avgExecutionPrice,
    totalShares: smart.totalShares,
    totalAmount: smart.totalAmount,
    comparison: {
      smartScale: smart.avgExecutionPrice,
      lumpSum,
      randomScale,
      intervalScale,
      smartVsLumpPct: smartAdvantagePct(smart.avgExecutionPrice, lumpSum, direction),
      smartVsRandomPct: smartAdvantagePct(smart.avgExecutionPrice, randomScale, direction),
      smartVsIntervalPct: smartAdvantagePct(
        smart.avgExecutionPrice,
        intervalScale,
        direction
      ),
    },
  };
}

function matchScheduledTrades(
  bars: Bar[],
  schedule: ScheduledTrade[],
  direction: Direction,
  friction: ExecutionFrictionConfig,
  startShares = 0
): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const isOut = direction === "scale_out";

  // For scale-out: convert signal-weighted USD amounts into whole-share allocations so
  // we're selling a fixed position (startShares) rather than a fixed dollar amount.
  const totalScheduleUsd = schedule.reduce((s, st) => s + st.amountUsd, 0);
  const sharesMode = isOut && startShares > 0 && totalScheduleUsd > 0;

  let runningShares = startShares;
  // Scale-in: carry unspent budget (from whole-share rounding) to the next tranche.
  let budgetCarry = 0;

  for (let i = 0; i < schedule.length; i++) {
    const st = schedule[i];
    const targetTs = new Date(st.date).getTime();
    const bar = bars.find((b) => new Date(b.t).getTime() >= targetTs && b.c > 0);
    if (!bar) continue;
    const execPrice = applyExecutionPrice(bar.c, direction, friction);
    if (execPrice <= 0) continue;

    let tradeShares: number;
    let tradeAmountUsd: number;

    if (sharesMode) {
      // Last tranche gets all remaining shares to avoid rounding leakage.
      const isLastScheduled = i === schedule.length - 1;
      tradeShares = isLastScheduled
        ? runningShares
        : Math.floor((st.amountUsd / totalScheduleUsd) * startShares);
      tradeAmountUsd = tradeShares * execPrice;
    } else {
      // Scale-in: buy whole shares only; carry unspent amount forward.
      const plannedAmount = st.amountUsd + budgetCarry;
      tradeShares = Math.floor(plannedAmount / execPrice);
      tradeAmountUsd = tradeShares * execPrice;
      budgetCarry = plannedAmount - tradeAmountUsd;
      if (tradeShares < 1) continue; // can't afford even 1 share yet — carry forward
    }

    runningShares = isOut
      ? Math.max(0, runningShares - tradeShares)
      : runningShares + tradeShares;

    trades.push({
      date: bar.t,
      price: execPrice,
      amountUsd: tradeAmountUsd,
      shares: tradeShares,
      sharesHeld: runningShares,
      signalScore: st.signalScore,
      rationale: st.rationale,
      side: isOut ? "sell" : "buy",
    });
  }
  return trades;
}

function summariseTrades(trades: BacktestTrade[]) {
  const totalAmount = trades.reduce((s, t) => s + t.amountUsd, 0);
  const totalShares = trades.reduce((s, t) => s + t.shares, 0);
  const avgExecutionPrice = totalShares > 0 ? totalAmount / totalShares : 0;
  return { totalAmount, totalShares, avgExecutionPrice };
}

function lumpSumAvgPrice(
  windowBars: Bar[],
  totalAmount: number,
  direction: Direction = "scale_in",
  friction: ExecutionFrictionConfig = normalizeFriction()
): number {
  const firstRawPrice = windowBars[0]?.c ?? 0;
  const firstPrice = applyExecutionPrice(firstRawPrice, direction, friction);
  if (firstPrice <= 0) return 0;
  const shares = totalAmount / firstPrice;
  return shares > 0 ? totalAmount / shares : 0;
}

function intervalScaleAvgPrice(
  windowBars: Bar[],
  totalAmount: number,
  tranches: number,
  direction: Direction = "scale_in",
  friction: ExecutionFrictionConfig = normalizeFriction()
): number {
  if (tranches <= 0) return 0;
  if (tranches === 1) return lumpSumAvgPrice(windowBars, totalAmount, direction, friction);
  const prices = regularIntervalIndices(windowBars.length, tranches).map(
    (idx) => applyExecutionPrice(windowBars[idx].c, direction, friction)
  );
  return avgPriceFromPrices(prices, totalAmount, direction === "scale_out");
}

function randomEnsembleAvgPrice(
  windowBars: Bar[],
  totalAmount: number,
  tranches: number,
  seed: number,
  samples: number,
  direction: Direction = "scale_in",
  friction: ExecutionFrictionConfig = normalizeFriction()
): number {
  if (tranches <= 0 || samples <= 0) return 0;
  const sharesMode = direction === "scale_out";
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const sampleSeed = (seed + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
    const prices = pickRandomIndices(tranches, windowBars.length, sampleSeed).map(
      (idx) => applyExecutionPrice(windowBars[idx].c, direction, friction)
    );
    total += avgPriceFromPrices(prices, totalAmount, sharesMode);
  }
  return total / samples;
}

function avgPriceFromPrices(prices: number[], totalAmount: number, sharesMode = false): number {
  const valid = prices.filter((p) => p > 0);
  if (valid.length === 0) return 0;
  if (sharesMode) {
    // Equal shares per tranche → arithmetic mean of prices.
    return valid.reduce((s, p) => s + p, 0) / valid.length;
  }
  if (totalAmount <= 0) return 0;
  const amountPerTrade = totalAmount / prices.length;
  const totalShares = prices.reduce((sum, p) => (p > 0 ? sum + amountPerTrade / p : sum), 0);
  return totalShares > 0 ? totalAmount / totalShares : 0;
}

function regularIntervalIndices(length: number, count: number): number[] {
  if (length <= 0 || count <= 0) return [];
  if (count === 1) return [0];
  const n = Math.min(count, length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round((i * (length - 1)) / (n - 1)));
  }
  return out;
}

function pickRandomIndices(count: number, length: number, seed: number): number[] {
  const n = Math.min(count, length);
  const idxs = Array.from({ length }, (_, i) => i);
  const rand = mulberry32(seed);

  for (let i = idxs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
  }

  return idxs.slice(0, n).sort((a, b) => a - b);
}

function smartAdvantagePct(
  smartAvgPrice: number,
  baselineAvgPrice: number,
  direction: Direction
): number {
  if (baselineAvgPrice <= 0) return 0;
  if (direction === "scale_out") {
    return ((smartAvgPrice - baselineAvgPrice) / baselineAvgPrice) * 100;
  }
  return ((baselineAvgPrice - smartAvgPrice) / baselineAvgPrice) * 100;
}

function buildSinglePhaseReturnComparison(result: DirectionalBacktestResult): ReturnComparison {
  const zero: ReturnSnapshot = { avgBuyPrice: 0, avgSellPrice: 0, shares: 0, proceeds: 0, profitUsd: 0, profitPct: 0 };
  return {
    lumpSum: zero,
    randomEnsemble: zero,
    intervalScale: zero,
    strategyVsLumpPct: result.comparison.smartVsLumpPct,
    strategyVsRandomPct: result.comparison.smartVsRandomPct,
    strategyVsIntervalPct: result.comparison.smartVsIntervalPct,
  };
}

function buildReturnComparison(
  investedAmount: number,
  strategyProfitPct: number,
  scaleIn: DirectionalBacktestResult,
  scaleOut: DirectionalBacktestResult
): ReturnComparison {
  const lumpSum = computeReturnSnapshot(
    investedAmount,
    scaleIn.comparison.lumpSum,
    scaleOut.comparison.lumpSum
  );
  const randomEnsemble = computeReturnSnapshot(
    investedAmount,
    scaleIn.comparison.randomScale,
    scaleOut.comparison.randomScale
  );
  const intervalScale = computeReturnSnapshot(
    investedAmount,
    scaleIn.comparison.intervalScale,
    scaleOut.comparison.intervalScale
  );

  return {
    lumpSum,
    randomEnsemble,
    intervalScale,
    strategyVsLumpPct: strategyProfitPct - lumpSum.profitPct,
    strategyVsRandomPct: strategyProfitPct - randomEnsemble.profitPct,
    strategyVsIntervalPct: strategyProfitPct - intervalScale.profitPct,
  };
}

interface TaxConfig {
  accountType: AccountType;
  washSaleWindowDays: number;
  applyWashSaleRule: boolean;
}

interface TaxComputationResult {
  summary: TaxImpactSummary;
  tradeTaxByIndex: Array<TradeTaxSummary | undefined>;
}

interface BuyLot {
  date: string;
  dateTs: number;
  basisPerShare: number;
  remaining: number;
  poolIndex: number;
}

interface ReplacementPoolEntry {
  date: string;
  dateTs: number;
  availableShares: number;
}

interface SellExecutionPlan {
  tradeIndex: number;
  date: string;
  dateTs: number;
  sellPrice: number;
  plannedShares: number;
}

function computeTaxImpact(
  scaleInTrades: BacktestTrade[],
  scaleOutTrades: BacktestTrade[],
  sharesBought: number,
  cfg: TaxConfig
): TaxComputationResult {
  const accountType = cfg.accountType;
  const washSaleWindowDays = normalizeWashSaleWindow(cfg.washSaleWindowDays);
  const washWindowMs = washSaleWindowDays * DAY_MS;
  const washRuleEligibleAsset = cfg.applyWashSaleRule;
  const washRuleApplied = accountType === "taxable" && washRuleEligibleAsset;
  const tradeTaxByIndex: Array<TradeTaxSummary | undefined> = Array.from({
    length: scaleOutTrades.length,
  });

  const zeroSummary: TaxImpactSummary = {
    accountType,
    washSaleWindowDays,
    washRuleEligibleAsset,
    washRuleApplied,
    grossRealizedPnL: 0,
    disallowedLossDeferred: 0,
    washAdjustedRealizedPnL: 0,
    washSaleEventCount: 0,
    washSaleEvents: [],
  };

  if (scaleInTrades.length === 0 || scaleOutTrades.length === 0 || sharesBought <= 0) {
    return { summary: zeroSummary, tradeTaxByIndex };
  }

  const replacementPool: ReplacementPoolEntry[] = scaleInTrades.map((trade) => ({
    date: trade.date,
    dateTs: toDateTs(trade.date),
    availableShares: Math.max(trade.shares, 0),
  }));

  const lots: BuyLot[] = scaleInTrades
    .map((trade, idx) => ({
      date: trade.date,
      dateTs: toDateTs(trade.date),
      basisPerShare: Math.max(trade.price, 0),
      remaining: Math.max(trade.shares, 0),
      poolIndex: idx,
    }))
    .sort((a, b) => a.dateTs - b.dateTs);

  const salePlans: SellExecutionPlan[] = planScaleOutShareExecutions(
    scaleOutTrades,
    sharesBought
  )
    .map((plannedShares, tradeIndex) => ({
      tradeIndex,
      date: scaleOutTrades[tradeIndex].date,
      dateTs: toDateTs(scaleOutTrades[tradeIndex].date),
      sellPrice: Math.max(scaleOutTrades[tradeIndex].price, 0),
      plannedShares,
    }))
    .sort((a, b) => {
      if (a.dateTs === b.dateTs) return a.tradeIndex - b.tradeIndex;
      return a.dateTs - b.dateTs;
    });

  const washSaleEvents: WashSaleEvent[] = [];
  let grossRealizedPnL = 0;
  let disallowedLossDeferred = 0;
  let carryForwardShares = 0;

  for (const sale of salePlans) {
    const effectivePlannedShares = Math.max(sale.plannedShares + carryForwardShares, 0);
    let sharesToSell = effectivePlannedShares;
    let executedSellShares = 0;
    let totalCost = 0;

    while (sharesToSell > 1e-9) {
      const lot = lots.find((candidate) => candidate.remaining > 1e-9 && candidate.dateTs <= sale.dateTs);
      if (!lot) break;

      const qty = Math.min(lot.remaining, sharesToSell);
      lot.remaining -= qty;
      sharesToSell -= qty;
      executedSellShares += qty;
      totalCost += qty * lot.basisPerShare;
      replacementPool[lot.poolIndex].availableShares = Math.max(
        0,
        replacementPool[lot.poolIndex].availableShares - qty
      );
    }

    carryForwardShares = Math.max(sharesToSell, 0);

    const realizedPnL =
      executedSellShares > 0 ? executedSellShares * sale.sellPrice - totalCost : 0;
    const avgCostBasis = executedSellShares > 0 ? totalCost / executedSellShares : 0;

    let replacementShares = 0;
    let disallowedLoss = 0;
    const lossPerShare = Math.max(avgCostBasis - sale.sellPrice, 0);

    if (washRuleApplied && executedSellShares > 0 && lossPerShare > 0) {
      replacementShares = consumeReplacementShares(
        replacementPool,
        sale.dateTs,
        washWindowMs,
        executedSellShares
      );
      disallowedLoss = replacementShares * lossPerShare;

      if (disallowedLoss > 0) {
        washSaleEvents.push({
          saleDate: sale.date,
          lossPerShare,
          lossShares: executedSellShares,
          replacementShares,
          disallowedLoss,
        });
      }
    }

    grossRealizedPnL += realizedPnL;
    disallowedLossDeferred += disallowedLoss;

    tradeTaxByIndex[sale.tradeIndex] = {
      plannedSellShares: effectivePlannedShares,
      executedSellShares,
      avgCostBasis,
      realizedPnL,
      disallowedLoss,
      replacementShares,
      washAdjustedPnL: realizedPnL + disallowedLoss,
      washSaleTriggered: disallowedLoss > 0,
    };
  }

  return {
    summary: {
      accountType,
      washSaleWindowDays,
      washRuleEligibleAsset,
      washRuleApplied,
      grossRealizedPnL,
      disallowedLossDeferred,
      washAdjustedRealizedPnL: grossRealizedPnL + disallowedLossDeferred,
      washSaleEventCount: washSaleEvents.length,
      washSaleEvents,
    },
    tradeTaxByIndex,
  };
}

function planScaleOutShareExecutions(
  scaleOutTrades: BacktestTrade[],
  totalShares: number
): number[] {
  if (scaleOutTrades.length === 0 || totalShares <= 0) return [];

  const weights = scaleOutTrades.map((trade) =>
    Number.isFinite(trade.amountUsd) && trade.amountUsd > 0 ? trade.amountUsd : 0
  );
  let totalWeight = weights.reduce((sum, w) => sum + w, 0);

  if (totalWeight <= 0) {
    totalWeight = scaleOutTrades.length;
    for (let i = 0; i < weights.length; i++) weights[i] = 1;
  }

  let remaining = totalShares;
  return weights.map((weight, idx) => {
    if (idx === weights.length - 1) return Math.max(remaining, 0);
    const planned = (totalShares * weight) / totalWeight;
    remaining -= planned;
    return Math.max(planned, 0);
  });
}

function consumeReplacementShares(
  replacementPool: ReplacementPoolEntry[],
  saleTs: number,
  washWindowMs: number,
  maxShares: number
): number {
  if (maxShares <= 0 || washWindowMs <= 0) return 0;

  const candidates = replacementPool
    .map((entry, idx) => ({ ...entry, idx }))
    .filter(
      (entry) =>
        entry.availableShares > 1e-9 &&
        Math.abs(entry.dateTs - saleTs) <= washWindowMs
    )
    .sort((a, b) => {
      if (a.dateTs === b.dateTs) return a.idx - b.idx;
      return a.dateTs - b.dateTs;
    });

  let remaining = maxShares;
  let used = 0;
  for (const candidate of candidates) {
    if (remaining <= 1e-9) break;
    const take = Math.min(candidate.availableShares, remaining);
    replacementPool[candidate.idx].availableShares -= take;
    remaining -= take;
    used += take;
  }
  return used;
}

function computeReturnSnapshot(
  investedAmount: number,
  avgBuyPrice: number,
  avgSellPrice: number
): ReturnSnapshot {
  if (investedAmount <= 0 || avgBuyPrice <= 0 || avgSellPrice <= 0) {
    return {
      avgBuyPrice,
      avgSellPrice,
      shares: 0,
      proceeds: 0,
      profitUsd: 0,
      profitPct: 0,
    };
  }

  const shares = investedAmount / avgBuyPrice;
  const proceeds = shares * avgSellPrice;
  const profitUsd = proceeds - investedAmount;
  const profitPct = (profitUsd / investedAmount) * 100;

  return {
    avgBuyPrice,
    avgSellPrice,
    shares,
    proceeds,
    profitUsd,
    profitPct,
  };
}

function computeBenchmarkPerformance(
  bars: Bar[],
  symbol: string,
  startDate: string,
  endDate: string,
  startingCapital: number
): BenchmarkPerformance | null {
  if (bars.length === 0 || startingCapital <= 0) return null;

  const startTs = new Date(startDate).getTime();
  const endTs = new Date(endDate).getTime();
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) return null;

  const windowBars = bars.filter((b) => {
    const t = new Date(b.t).getTime();
    return t >= startTs && t < endTs && b.c > 0;
  });
  if (windowBars.length < 2) return null;

  const startPrice = windowBars[0].c;
  const endPrice = windowBars[windowBars.length - 1].c;
  if (startPrice <= 0 || endPrice <= 0) return null;

  const shares = startingCapital / startPrice;
  const finalValue = shares * endPrice;
  const profitUsd = finalValue - startingCapital;
  const profitPct = (profitUsd / startingCapital) * 100;

  return {
    symbol,
    startDate,
    endDate,
    startPrice,
    endPrice,
    finalValue,
    profitUsd,
    profitPct,
  };
}

function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map((v) => Number(v));
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().split("T")[0];
}

function normalizeIsoDate(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ts = new Date(trimmed).getTime();
  if (!Number.isFinite(ts)) return null;
  const [y, m, d] = trimmed.split("-");
  if (!y || !m || !d) return null;
  return `${y.padStart(4, "0")}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function toDateTs(isoDate: string): number {
  const ts = new Date(isoDate).getTime();
  if (!Number.isFinite(ts)) return 0;
  return ts;
}

function normalizeWashSaleWindow(days?: number): number {
  if (days == null || !Number.isFinite(days) || Number.isNaN(days)) return 30;
  return Math.max(1, Math.round(days));
}

function isLikelyCryptoSymbol(symbol: string): boolean {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return false;
  if (SUPPORTED_CRYPTO_BASES.has(normalized)) return true;
  if (normalized.includes("/")) return true;
  return /^[A-Z0-9]{2,10}[-_](USD|USDT|USDC|BTC|ETH|EUR|GBP|JPY)$/.test(normalized);
}

const SUPPORTED_CRYPTO_BASES = new Set([
  "AAVE",
  "ALGO",
  "AVAX",
  "BAT",
  "BCH",
  "BTC",
  "CRV",
  "DOGE",
  "DOT",
  "ETH",
  "GRT",
  "LINK",
  "LTC",
  "MKR",
  "NEAR",
  "PAXG",
  "SHIB",
  "SOL",
  "SUSHI",
  "TRX",
  "UNI",
  "USDC",
  "USDT",
  "WBTC",
  "XTZ",
  "YFI",
]);

function deriveTrancheCount(
  windowDays: number,
  cadenceDays: number,
  maxBars: number
): number {
  const cadence = Math.max(1, cadenceDays);
  const unclamped = Math.round(windowDays / cadence);
  const target = Math.max(1, unclamped);
  return Math.max(1, Math.min(target, maxBars));
}

function normalizeFriction(
  friction: ExecutionFrictionConfig = { slippageBps: 0, spreadBps: 0, feeBps: 0 }
): ExecutionFrictionConfig {
  return {
    slippageBps: toFiniteNonNegative(friction.slippageBps),
    spreadBps: toFiniteNonNegative(friction.spreadBps),
    feeBps: toFiniteNonNegative(friction.feeBps),
  };
}

function applyExecutionPrice(
  midPrice: number,
  direction: Direction,
  friction: ExecutionFrictionConfig
): number {
  if (midPrice <= 0) return 0;
  const totalBps = friction.slippageBps + friction.feeBps + friction.spreadBps / 2;
  const impact = totalBps / 10_000;
  if (direction === "scale_out") {
    return Math.max(midPrice * (1 - impact), 0);
  }
  return midPrice * (1 + impact);
}

function summarizeMetric(values: number[]): MetricDistribution {
  if (values.length === 0) {
    return { mean: 0, median: 0, stdev: 0, min: 0, max: 0, winRatePct: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const median =
    n % 2 === 0
      ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
      : sorted[(n - 1) / 2];
  const winCount = values.filter((v) => v > 0).length;

  return {
    mean,
    median,
    stdev: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1],
    winRatePct: (winCount / n) * 100,
  };
}

function toFiniteNonNegative(v: number): number {
  if (!Number.isFinite(v) || Number.isNaN(v)) return 0;
  return Math.max(v, 0);
}
