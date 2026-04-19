# Smart Scale Roadmap

## Product Direction
Build a strategy research platform that:
1. Runs robust walk-forward backtests for smart scale-in and smart scale-out.
2. Manages capital and positions from a starting lump sum.
3. Produces explainable recommendations with clear risk controls.

## Current Status
1. Smart scale-in and smart scale-out backtesting is implemented.
2. Walk-forward multi-run testing is implemented with per-run table rows.
3. Random baseline is now a random-ensemble average.
4. Tranche count is derived from cadence and window duration.
5. Scanner and recommendation assistant are intentionally deferred.

## Phase 1: Backtest Quality (Current Priority)
1. Add transaction costs model (fees, slippage, spread).
2. Add fill/market assumptions and configurable execution constraints.
3. Add walk-forward aggregate stats (mean, median, standard deviation, hit rate).
4. Add parameter sweep tooling for cadence, periods, aggressiveness, and signals.
5. Add robustness checks for different regimes and start-date sensitivity.

## Phase 2: Capital Management Framework
1. Add portfolio state with starting cash, available cash, and reserved cash.
2. Add positions model with symbol, shares, cost basis, and realized/unrealized PnL.
3. Add allocation rules for max per-position allocation, max daily deployment, and max concurrent active scale plans.
4. Add validation rules so scale-out cannot exceed shares held and new plans must fit available capital limits.
5. Add UI panel to view and edit capital, positions, and guardrails.

## Phase 3: Optimization Workflow
1. Add objective definitions (cost basis improvement, drawdown-adjusted return, consistency).
2. Add repeatable experiment tracking for parameter sets and outputs.
3. Add ranked configuration comparison with out-of-sample emphasis.
4. Add model/card output for best settings by market regime.

## Phase 4: Recommendation Assistant (Deferred)
1. Add symbol universe selection and candidate ranking.
2. Add daily news/event ingestion with source attribution.
3. Add chat assistant that explains recommendations and risk tradeoffs.
4. Keep human approval in loop for any proposed actions.

## Immediate Next Tasks
1. Implement Phase 1.1 and Phase 1.3 (cost model + walk-forward aggregate stats).
2. Scaffold Phase 2 data structures in store and domain types.
3. Add portfolio/capital UI shell with placeholder data wiring.
