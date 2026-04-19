# Signal Breakdown

This document explains how trading signals are calculated, why they are used, and which functions are called.

## Signal Call Chain

1. The backtest calls `runDirectionalBacktest(...)`, which passes selected signals into `generateSchedule(...)`.
   - File: `src/lib/backtest.ts`
2. `generateSchedule(...)` computes a score per bar using `compositeScore(...)`.
   - File: `src/lib/dca.ts`
3. `compositeScore(...)` computes a weighted average across active signals via `buyScore(...)`.
   - File: `src/lib/signals.ts`
4. `buyScore(...)` routes by signal type to:
   - `priceVsSmaScore(...)`
   - `rsiScore(...)`
   - `bollingerScore(...)`
   - `volumeScore(...)`
   - `momentumScore(...)`
   - File: `src/lib/signals.ts`
5. For scale-out, directional score is inverted using `1 - raw`.
   - File: `src/lib/dca.ts`

## How Each Signal Is Calculated

All signal scores are normalized to `[0, 1]` where `1` means stronger buy timing.

### 1. Price vs SMA

- Function: `priceVsSmaScore(...)`
- Math:
  - `deviation = (SMA - price) / SMA`
  - `score = clamp(0.5 + deviation * 5, 0, 1)`
- Intuition:
  - Price below moving average increases score.
  - Price above moving average lowers score.
  - This is a mean-reversion signal.

### 2. RSI

- Functions: `rsi(...)` and `rsiScore(...)`
- Math:
  - RSI computed with Wilder smoothing.
  - `score = 1 - RSI / 100`
- Intuition:
  - Lower RSI (oversold) produces higher buy score.
  - Higher RSI (overbought) produces lower buy score.

### 3. Bollinger Band

- Functions: `bollingerBands(...)` and `bollingerScore(...)`
- Math:
  - `%B = (price - lowerBand) / (upperBand - lowerBand)`
  - `score = clamp(1 - %B, 0, 1)`
- Intuition:
  - Near lower band increases buy score.
  - Near upper band decreases buy score.
  - Another mean-reversion style input.

### 4. Volume

- Function: `volumeScore(...)`
- Math and behavior:
  - Computes relative volume vs recent average.
  - High-volume down day: score increases.
  - High-volume up day: score decreases.
- Intuition:
  - Tries to detect capitulation-like down moves for better entries.

### 5. Momentum

- Function: `momentumScore(...)`
- Math:
  - `momentum = (price - oldPrice) / oldPrice`
  - `score = clamp(0.5 - momentum * 5, 0, 1)`
- Intuition:
  - Recent negative momentum increases buy score.
  - Recent positive momentum lowers buy score.
  - Mean-reversion bias over the momentum window.

## How Scores Become Trades

1. The selected trading window is split into tranche segments.
2. In each segment, the highest-scoring bar is selected.
3. Allocation per tranche is blended:
   - Equal DCA component
   - Signal-weighted component controlled by `aggressiveness`
4. A minimum floor (`20%` of equal-tranche amount) prevents tiny allocations.
5. Final tranche amounts are normalized to exactly match total budget.

All of this happens in `generateSchedule(...)` in `src/lib/dca.ts`.

## Signal Weights

- Signal weights are user-configurable in the strategy UI.
- `compositeScore(...)` computes a weighted average using those values.
- If no signals are active (or total weight is zero), neutral score `0.5` is used.

## Scale-Out Behavior

- The same signal engine is reused for scale-out.
- Directional inversion (`1 - score`) means:
  - Bars considered bad buy points become good sell points.
- This keeps one consistent scoring framework for both directions.

## Default Signal Mix

Current default setup in the UI:

- `Price vs SMA`: `0.4`
- `RSI`: `0.4`
- `Bollinger Band`: `0.2`

Defined in `src/components/StrategyBuilder.tsx`.
