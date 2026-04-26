# Strategy Brainstorm and Execution Plan

## Why this document exists
This captures the current strategy brainstorming so we can keep momentum and execute in phases without losing context.

## Goal
Build a strategy research workflow that can progress from:
1. Single-strategy backtests.
2. Multi-strategy comparisons.
3. Meta-strategy routing.
4. News-aware regime decisions.
5. Portfolio-level capital allocation.

## Current strategy (baseline)
The app currently runs a signal-weighted DCA strategy that combines:
1. Price vs SMA.
2. RSI.
3. Bollinger Bands.
4. Optional Volume and Momentum signals.

Useful properties today:
1. Explainable per-trade signal rationale.
2. Comparison versus lump sum, random ensemble, and interval scale baselines.
3. Walk-forward utility functions already present in the backtest engine.

Known limitations to address:
1. Segment-best trade selection can be optimistic if used as live decision logic.
2. Default cost/friction assumptions are minimal and can overstate edge.
3. Strategy development is still one-config-at-a-time in the UI.

## Priority now: multi-strategy backtesting
We will start by enabling side-by-side backtests of multiple strategy configurations over the same market window.

### Phase 1 deliverable
1. Define a strategy set and run each strategy on identical data windows.
2. Display ranked comparison metrics in one table.
3. Preserve drill-down into per-strategy trade logs and rationale.
4. Support walk-forward summary per strategy (mean, median, stdev, win rate).
5. Export comparison outputs for experiment tracking.

### Proposed implementation shape
1. Add reusable strategy config entities in `frontend/src/lib/backtest.ts`.
2. Add a `runMultiStrategyBacktest(...)` helper that loops over `runBacktest(...)` with shared market data.
3. Add a multi-strategy comparison panel in the Backtesting page.
4. Add a small preset library in strategy UI so we can run curated variants quickly.
5. Add an objective/ranking selector, for example:
   - highest `strategyVsRandomPct`
   - highest walk-forward median
   - best risk-adjusted score

### Candidate starter strategies
1. Mean reversion core: Price vs SMA + RSI + Bollinger.
2. Capitulation variant: add Volume with higher weight.
3. Pullback trend hybrid: SMA + Momentum + lighter RSI.
4. Defensive variant: lower aggressiveness, wider cadence, tighter capital deployment.

### Tuning playbook by market situation
1. Trending up:
   - Use `Trend Pullback Hybrid`.
   - Start range: cadence `5-8`, aggressiveness `0.30-0.50`.
   - Tilt weights toward Price vs SMA and Momentum.
2. Sideways/range:
   - Use `Mean Reversion (Balanced)`.
   - Start range: cadence `2-4`, aggressiveness `0.60-0.85`.
   - Tilt weights toward RSI and Bollinger.
3. Panic/high volatility:
   - Use `Capitulation Hunter`.
   - Start range: cadence `1-3`, aggressiveness `0.65-0.90`.
   - Increase Volume and short-lookback Momentum influence.
4. Risk-off/uncertain macro:
   - Use `Defensive Risk-Off`.
   - Start range: cadence `5-10`, aggressiveness `0.20-0.40`.
   - Widen windows, reduce indicator sensitivity, keep position changes slower.

## Next phase: meta-strategy controller
After multi-strategy comparison is stable, add a controller that chooses which base strategy to run by regime.

Detailed design spec: see `META_STRATEGY.md`.

Portfolio capital allocator design spec: see `PORTFOLIO_ALLOCATOR.md`.

Core requirements:
1. Regime detector uses trailing-only features.
2. Strategy selection is timestamp-safe (no look-ahead).
3. Switching costs are modeled.
4. Attribution logs show regime, selected strategy, and reason.

Backtest guardrails:
1. Rolling walk-forward evaluation only.
2. No in-period selection leakage.
3. Compare against static strategy baselines and include ablations.

## Future phase: news-aware signal layer
Use news as a separate feature layer that modifies confidence, aggressiveness, or strategy routing.

Core requirements:
1. Timestamped ingestion and publish-lag handling.
2. Per-symbol daily features (sentiment, relevance, novelty, event type, uncertainty).
3. Strict attribution from headlines to decisions in the audit log.

## Execution order
1. Multi-strategy backtest engine and comparison UI.
2. Walk-forward robustness dashboard for strategy sets.
3. Meta-strategy router with regime detection.
4. News features and attribution wiring.

## Definition of done for the current milestone
1. A single click can run multiple strategy configs on one symbol/date window.
2. Results are ranked and filterable in one place.
3. Per-strategy trade rationale is still fully visible.
4. Walk-forward stats are shown per strategy.
5. Results can be exported for record keeping.
