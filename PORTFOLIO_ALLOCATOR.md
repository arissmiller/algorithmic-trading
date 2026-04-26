# Portfolio Allocator Design (Implementation Spec)

## Purpose
Define how Smart Scale decides:
1. Which assets receive capital.
2. How much capital each asset receives.
3. At what deployment rates and over what time horizons.

This layer sits above base strategy logic and above meta-strategy routing.

## Role in the Stack
Decision hierarchy:
1. **Portfolio allocator**: asset selection, sizing, horizon, and capital budgets.
2. **Meta strategy**: chooses strategy blend per selected asset/regime.
3. **Execution engine**: translates target changes into scheduled trades.

## Scope
This spec covers:
1. Asset universe and candidate ranking.
2. Capital budgeting and sizing.
3. Timeframe assignment and deployment pace.
4. Rebalancing and de-allocation.
5. Portfolio-level risk constraints.
6. Backtest methodology and attribution.

This spec does not yet cover:
1. Broker order routing details.
2. Tax lot optimization.
3. Derivatives/leverage products.

## Inputs
Allocator consumes:
1. Account state: cash, positions, reserved capital, unrealized and realized PnL.
2. Candidate asset features: liquidity, volatility, trend, drawdown, regime score.
3. Meta-strategy outputs per asset: expected edge proxy and confidence.
4. Risk state: portfolio drawdown, concentration, turnover, exposure limits.

## Core Outputs
At each allocation cycle:
1. `targetWeights` per asset.
2. `deploymentPlan` per asset:
   - `scaleInWindowDays`
   - `scaleOutWindowDays`
   - `cadenceDays`
   - `maxDailyCapital`
3. `capitalActions`:
   - increase allocation
   - hold
   - reduce/de-allocate

## Allocation Objectives
Primary:
1. Maximize risk-adjusted portfolio return.
2. Preserve capital under adverse regimes.
3. Maintain allocation stability (avoid over-trading).

Secondary:
1. Keep turnover and cost drag bounded.
2. Maintain diversification and concentration discipline.

## Constraint Set (V1)
Hard constraints:
1. Cash floor: minimum unallocated cash buffer.
2. Max position size: cap per single asset.
3. Max sector/theme concentration.
4. Max daily deployment and withdrawal limits.
5. Scale-out cannot exceed available shares.

Soft constraints:
1. Turnover penalty.
2. Strategy-switch penalty.
3. Horizon-change penalty (discourage rapid timeframe flips).

## Allocation Model (V1 Rule-Based)
At each rebalance timestamp `t`:
1. Score candidates using a weighted composite:
   - edge proxy
   - confidence
   - liquidity quality
   - risk penalty (volatility, drawdown)
2. Filter out ineligible assets:
   - low liquidity
   - excessive volatility relative to profile
   - constraint violations
3. Convert scores to preliminary weights (normalized positive scores).
4. Apply hard caps/floors and renormalize.
5. Emit final target weights and per-asset deployment plans.

## Timeframe and Rate Assignment
Allocator should choose pace per asset, not one-size-fits-all:
1. Higher confidence + lower volatility -> longer horizon, smoother cadence.
2. High-volatility opportunity -> shorter horizon, tighter cadence, capped daily spend.
3. Risk-off portfolio state -> slower deployment and larger cash reserve.

Example policy:
1. `high_confidence_trend`: 120-180d scale-in, cadence 5-8.
2. `range_mean_reversion`: 45-90d scale-in, cadence 2-5.
3. `panic_rebound`: 20-60d scale-in, cadence 1-3, stricter max daily cap.

## Rebalancing and De-Allocation
Rebalance cadence:
1. Daily light-touch checks for risk breaches.
2. Weekly full allocation rebalance.

De-allocation triggers:
1. Edge/confidence deterioration below threshold.
2. Risk breach (position or portfolio drawdown cap).
3. Better opportunity displacement under fixed capital budget.

## Risk Overlay (Portfolio Level)
Applied after preliminary weights:
1. Drawdown throttle: reduce gross allocation when portfolio drawdown deepens.
2. Correlation throttle: reduce similar exposures when concentration rises.
3. Volatility throttle: scale down high-vol assets in unstable regimes.
4. Cash rebuild mode: force incremental de-risking after loss clusters.

## Backtest Methodology (Critical)
Use a three-layer, leakage-safe simulation:
1. Allocator layer (asset/weight/horizon decisions).
2. Meta-strategy layer (strategy selection per asset).
3. Execution layer (fills, costs, schedule realization).

### Protocol
1. Outer walk-forward splits.
2. Train split:
   - calibrate allocator thresholds and weights.
   - calibrate regime and routing params.
3. Test split:
   - run bar-by-bar using only historical data up to `t-1`.
   - apply slippage/fees/switch and turnover costs.
4. Aggregate all out-of-sample test periods.

### Leakage Guardrails
1. No future information in candidate scoring.
2. No in-period optimization for same evaluation window.
3. No choosing winners with forward returns from current period.

## Evaluation Metrics
Portfolio-level:
1. OOS CAGR / total return.
2. Max drawdown and ulcer index.
3. Volatility and downside volatility.
4. Sharpe/Sortino proxies.
5. Turnover and cost drag.

Allocator-specific:
1. Allocation stability (weight churn).
2. Hit rate of top-ranked assets.
3. Capital utilization ratio.
4. Regime-conditioned performance.

## Attribution and Logging Schema
Each allocation decision should log:
1. Timestamp and universe snapshot.
2. Candidate scores and exclusions.
3. Raw and risk-adjusted target weights.
4. Constraint activations.
5. Final deployment plans per asset.
6. Link to meta-strategy decision IDs.

Example shape:

```json
{
  "ts": "2026-04-20T00:00:00Z",
  "portfolio_state": {
    "cash": 41250,
    "equity": 128900,
    "drawdown_pct": -6.2
  },
  "candidates": [
    { "symbol": "NVDA", "score": 0.78, "eligible": true },
    { "symbol": "AAPL", "score": 0.63, "eligible": true },
    { "symbol": "TSLA", "score": 0.41, "eligible": false, "reason": "volatility_cap" }
  ],
  "weights_pre_overlay": { "NVDA": 0.42, "AAPL": 0.33, "MSFT": 0.25 },
  "risk_overlay": { "drawdown_throttle": 0.85, "cash_floor_enforced": true },
  "weights_final": { "NVDA": 0.36, "AAPL": 0.29, "MSFT": 0.22, "CASH": 0.13 },
  "deployment_plan": {
    "NVDA": { "scaleInWindowDays": 60, "cadenceDays": 3, "maxDailyCapital": 2500 },
    "AAPL": { "scaleInWindowDays": 120, "cadenceDays": 6, "maxDailyCapital": 1800 }
  }
}
```

## Phased Build Plan
### V1 (rule-based allocator)
1. Fixed universe input.
2. Rule-based candidate scoring.
3. Constraint-aware weight assignment.
4. Weekly rebalance + daily risk checks.
5. Allocation logs and backtest summary.

### V2 (adaptive allocator)
1. Regime-conditioned scoring weights.
2. Performance-aware budget shifts by strategy family.
3. Correlation-aware concentration controls.

### V3 (research-grade allocator)
1. Optimizer-based allocation (constrained objective).
2. News-aware and LLM-derived feature integration.
3. Multi-horizon portfolio buckets with explicit budget sleeves.

## Integration Notes (Current Codebase)
Likely implementation targets:
1. `frontend/src/lib/backtest.ts`: portfolio-level simulation runner.
2. `frontend/src/store.ts`: portfolio state and allocator config.
3. `frontend/src/components/*`: allocator config + portfolio results UI.
4. `frontend/src/components/AIControlCenter.tsx`: allocation decision audit records.
