import type { BacktestTrade } from "../../../lib/backtest";
import type {
  CryptoAutotraderTrade,
} from "../../../lib/cryptoAutotraderBacktest";
import type {
  TrendConfidenceRegion,
} from "../../../lib/cryptoTrendConfidenceBacktest";
import type { PerpetualTrade } from "../../../lib/perpetualBacktest";
import type { BacktestChartEventMarker } from "../../../components/BacktestChart";
import type { RunQueueResult } from "../types";
import { trendDirectionCode, trendDirectionColor } from "./trendUtils";

const POSITION_EPSILON = 1e-9;

export type AutotraderRoundTrip = {
  side: "long" | "short";
  entryDate: string;
  exitDate: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryNotionalUsd: number;
  exitNotionalUsd: number;
  pnlUsd: number;
  pnlPct: number;
};

type ShortSaleCoverLeg = {
  date: string;
  qty: number;
  coverPrice: number;
  coverNotionalUsd: number;
  entryBasisUsd: number;
  pnlUsd: number;
  pnlPct: number;
  score: number;
  selloffScore: number;
  trendDirection: "up" | "down" | "neutral";
};

export type ShortSaleGroup = {
  id: string;
  entryDate: string;
  entryQty: number;
  entryPrice: number;
  entryNotionalUsd: number;
  coveredQty: number;
  coveredEntryBasisUsd: number;
  coverNotionalUsd: number;
  remainingQty: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  covers: ShortSaleCoverLeg[];
};

export type SymbolRunGroup = {
  symbol: string;
  runs: RunQueueResult[];
};

export function toPerpetualChartTrades(trades: PerpetualTrade[], side: "buy" | "sell"): BacktestTrade[] {
  return trades
    .filter((trade) => trade.side === side)
    .map((trade) => ({
      date: trade.date,
      price: trade.price,
      amountUsd: trade.notionalUsd,
      shares: trade.qty,
      sharesHeld: trade.positionQtyAfter,
      signalScore: trade.score,
      rationale: `${trade.reason} | score ${trade.score.toFixed(2)}`,
      side,
    }));
}

export function toAutotraderChartTrades(
  trades: CryptoAutotraderTrade[],
  side: "buy" | "sell"
): BacktestTrade[] {
  return trades
    .filter((trade) => trade.side === side)
    .map((trade) => ({
      date: trade.date,
      price: trade.price,
      amountUsd: trade.notionalUsd,
      shares: trade.qty,
      sharesHeld:
        trade.positionSideAfter === "short" ? -trade.positionQtyAfter : trade.positionQtyAfter,
      signalScore: trade.score,
      rationale: `${trade.intent} | trend ${trade.trendDirection} | selloff ${trade.selloffScore.toFixed(2)}`,
      side,
    }));
}

export function toAutotraderRoundTrips(trades: CryptoAutotraderTrade[]): AutotraderRoundTrip[] {
  const out: AutotraderRoundTrip[] = [];
  let longQty = 0;
  let longCostBasisUsd = 0;
  let longEntryDate: string | null = null;
  let shortQty = 0;
  let shortEntryBasisUsd = 0;
  let shortEntryDate: string | null = null;

  for (const trade of trades) {
    if (trade.intent === "open_long") {
      if (longEntryDate == null) longEntryDate = trade.date;
      longQty += trade.qty;
      longCostBasisUsd += trade.notionalUsd;
      continue;
    }

    if (trade.intent === "close_long" && longQty > POSITION_EPSILON) {
      const closeQty = Math.min(trade.qty, longQty);
      if (closeQty > POSITION_EPSILON) {
        const allocatedBasis = longCostBasisUsd * (closeQty / longQty);
        const proceeds = trade.notionalUsd;
        const pnlUsd = proceeds - allocatedBasis;
        out.push({
          side: "long",
          entryDate: longEntryDate ?? trade.date,
          exitDate: trade.date,
          qty: closeQty,
          entryPrice: allocatedBasis / Math.max(closeQty, POSITION_EPSILON),
          exitPrice: proceeds / Math.max(closeQty, POSITION_EPSILON),
          entryNotionalUsd: allocatedBasis,
          exitNotionalUsd: proceeds,
          pnlUsd,
          pnlPct: allocatedBasis > 0 ? (pnlUsd / allocatedBasis) * 100 : 0,
        });
        longQty -= closeQty;
        longCostBasisUsd -= allocatedBasis;
      }
      if (longQty <= POSITION_EPSILON) {
        longQty = 0;
        longCostBasisUsd = 0;
        longEntryDate = null;
      }
      continue;
    }

    if (trade.intent === "open_short") {
      if (shortEntryDate == null) shortEntryDate = trade.date;
      shortQty += trade.qty;
      shortEntryBasisUsd += trade.notionalUsd;
      continue;
    }

    if (trade.intent === "cover_short" && shortQty > POSITION_EPSILON) {
      const coverQty = Math.min(trade.qty, shortQty);
      if (coverQty > POSITION_EPSILON) {
        const allocatedEntryBasis = shortEntryBasisUsd * (coverQty / shortQty);
        const coverCost = trade.notionalUsd;
        const pnlUsd = allocatedEntryBasis - coverCost;
        out.push({
          side: "short",
          entryDate: shortEntryDate ?? trade.date,
          exitDate: trade.date,
          qty: coverQty,
          entryPrice: allocatedEntryBasis / Math.max(coverQty, POSITION_EPSILON),
          exitPrice: coverCost / Math.max(coverQty, POSITION_EPSILON),
          entryNotionalUsd: allocatedEntryBasis,
          exitNotionalUsd: coverCost,
          pnlUsd,
          pnlPct: allocatedEntryBasis > 0 ? (pnlUsd / allocatedEntryBasis) * 100 : 0,
        });
        shortQty -= coverQty;
        shortEntryBasisUsd -= allocatedEntryBasis;
      }
      if (shortQty <= POSITION_EPSILON) {
        shortQty = 0;
        shortEntryBasisUsd = 0;
        shortEntryDate = null;
      }
    }
  }

  return out;
}

export function groupShortSalesByEntry(trades: CryptoAutotraderTrade[]): ShortSaleGroup[] {
  const groups: ShortSaleGroup[] = [];
  const openLots: Array<{
    groupIndex: number;
    remainingQty: number;
    remainingEntryBasisUsd: number;
  }> = [];

  for (const trade of trades) {
    if (trade.intent === "open_short" && trade.qty > POSITION_EPSILON) {
      groups.push({
        id: `short-${groups.length + 1}`,
        entryDate: trade.date,
        entryQty: trade.qty,
        entryPrice: trade.price,
        entryNotionalUsd: trade.notionalUsd,
        coveredQty: 0,
        coveredEntryBasisUsd: 0,
        coverNotionalUsd: 0,
        remainingQty: trade.qty,
        realizedPnlUsd: 0,
        realizedPnlPct: 0,
        covers: [],
      });
      openLots.push({
        groupIndex: groups.length - 1,
        remainingQty: trade.qty,
        remainingEntryBasisUsd: trade.notionalUsd,
      });
      continue;
    }

    if (trade.intent !== "cover_short" || trade.qty <= POSITION_EPSILON) continue;

    let coverQtyRemaining = trade.qty;
    let coverNotionalRemaining = trade.notionalUsd;

    while (coverQtyRemaining > POSITION_EPSILON && openLots.length > 0) {
      const lot = openLots[0];
      const lotQtyBefore = Math.max(lot.remainingQty, POSITION_EPSILON);
      const allocatedQty = Math.min(coverQtyRemaining, lotQtyBefore);
      const allocatedCoverNotional = coverNotionalRemaining * (allocatedQty / coverQtyRemaining);
      const allocatedEntryBasis = lot.remainingEntryBasisUsd * (allocatedQty / lotQtyBefore);

      const group = groups[lot.groupIndex];
      const pnlUsd = allocatedEntryBasis - allocatedCoverNotional;

      group.covers.push({
        date: trade.date,
        qty: allocatedQty,
        coverPrice: allocatedCoverNotional / Math.max(allocatedQty, POSITION_EPSILON),
        coverNotionalUsd: allocatedCoverNotional,
        entryBasisUsd: allocatedEntryBasis,
        pnlUsd,
        pnlPct: allocatedEntryBasis > POSITION_EPSILON ? (pnlUsd / allocatedEntryBasis) * 100 : 0,
        score: trade.score,
        selloffScore: trade.selloffScore,
        trendDirection: trade.trendDirection,
      });
      group.coveredQty += allocatedQty;
      group.coveredEntryBasisUsd += allocatedEntryBasis;
      group.coverNotionalUsd += allocatedCoverNotional;
      group.realizedPnlUsd += pnlUsd;
      group.remainingQty = Math.max(0, group.entryQty - group.coveredQty);
      group.realizedPnlPct =
        group.coveredEntryBasisUsd > POSITION_EPSILON
          ? (group.realizedPnlUsd / group.coveredEntryBasisUsd) * 100
          : 0;

      lot.remainingQty = Math.max(0, lot.remainingQty - allocatedQty);
      lot.remainingEntryBasisUsd = Math.max(0, lot.remainingEntryBasisUsd - allocatedEntryBasis);
      coverNotionalRemaining = Math.max(0, coverNotionalRemaining - allocatedCoverNotional);
      coverQtyRemaining = Math.max(0, coverQtyRemaining - allocatedQty);

      if (lot.remainingQty <= POSITION_EPSILON) {
        openLots.shift();
      }
    }
  }

  return groups;
}

export function toTrendRegionMarkers(regions: TrendConfidenceRegion[]): BacktestChartEventMarker[] {
  return regions.map((region) => ({
    date: region.markerDate,
    position:
      region.direction === "downtrend"
        ? "aboveBar"
        : region.direction === "uptrend"
          ? "belowBar"
          : "inBar",
    shape: "square",
    color: trendDirectionColor(region.direction, region.status),
    size: 0.95,
    text: `${region.id} ${region.status === "forming" ? "~" : ""}${trendDirectionCode(region.direction)} ${Math.round(region.confidence * 100)}%`,
  }));
}

export function groupResultsBySymbol(results: RunQueueResult[]): SymbolRunGroup[] {
  const groupsBySymbol = new Map<string, SymbolRunGroup>();
  const orderedGroups: SymbolRunGroup[] = [];

  for (const result of results) {
    const symbol = result.run.symbol.trim().toUpperCase();
    const existing = groupsBySymbol.get(symbol);
    if (existing) {
      existing.runs.push(result);
      continue;
    }
    const group = { symbol, runs: [result] };
    groupsBySymbol.set(symbol, group);
    orderedGroups.push(group);
  }

  return orderedGroups;
}
