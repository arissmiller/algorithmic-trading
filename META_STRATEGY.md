# Meta Strategy Design (Implementation Spec)

## Purpose
Define how Smart Scale chooses which base strategy to run in each market regime, while keeping backtests leakage-safe and explainable.

## Related Specs
1. `STRATEGY_BRAINSTORM.md` for high-level planning context.
2. `PORTFOLIO_ALLOCATOR.md` for portfolio-level asset selection and capital sizing.

## Scope
This spec covers:
1. Regime detection.
2. Strategy routing and blending.
3. Risk overlays.
4. Backtest methodology.
5. Decision and attribution logging.

This spec does not yet cover:
1. LLM/news scoring internals.
2. Live order management.

## Base Strategy Inputs
The meta strategy routes among existing preset families:
1. `mean_reversion_balanced`
2. `capitulation_hunter`
3. `trend_pullback_hybrid`
4. `defensive_risk_off`

Each base strategy must produce, at each decision step:
1. `targetExposure` in `[0, 1]`.
2. `confidence` in `[0, 1]`.
3. `rationale` text.

## Regime Model (V1)
Regimes are computed from trailing-only features:
1. `trend_strength`: slope and distance vs moving averages.
2. `realized_volatility`: rolling standard deviation of returns.
3. `drawdown_pressure`: distance from trailing high.
4. `breadth_proxy` (optional V2): market-level participation proxy.

V1 regime labels:
1. `trend_up`
2. `range`
3. `panic_high_vol`
4. `risk_off_uncertain`

### Suggested threshold style
Use quantile-based thresholds learned on training folds, not fixed global constants, so behavior remains stable across symbols.

## Routing Policy
At every decision timestamp `t`, using data up to `t-1`:
1. Detect regime.
2. Compute per-strategy routing weights.
3. Blend strategy targets.
4. Apply risk overlays.
5. Emit a final target.

### V1 Routing (rule-based)
Deterministic mapping from regime to strategy weights:
1. `trend_up`: overweight `trend_pullback_hybrid`.
2. `range`: overweight `mean_reversion_balanced`.
3. `panic_high_vol`: overweight `capitulation_hunter`.
4. `risk_off_uncertain`: overweight `defensive_risk_off`.

Weights should sum to 1.0 and allow partial blending to reduce regime flip churn.

### V2 Routing (performance-aware)
Adjust base regime weights by recent out-of-sample strategy health:
1. Rolling hit rate.
2. Rolling strategy vs random edge.
3. Drawdown penalty.

## Risk Overlay Layer
Applied after routing and before execution:
1. Max exposure cap.
2. Max daily turnover cap.
3. Drawdown throttle (reduce exposure under deep drawdown).
4. Cooldown after high-volatility loss clusters.

## Backtest Methodology (Critical)
Use a two-layer, leakage-safe simulation:

1. Outer loop: rolling walk-forward splits.
2. Train phase per split:
   - Fit regime thresholds.
   - Fit or calibrate routing parameters.
3. Test phase per split:
   - For each bar, compute regime and route using only past data.
   - Apply execution assumptions and switching costs.
4. Aggregate all out-of-sample periods.

### Leakage guardrails
1. No in-period re-optimization.
2. No future bars when labeling regime at `t`.
3. No selecting "best strategy for this period" using that period's outcomes.

## Execution Assumptions
Meta backtests must include:
1. Slippage and fee model.
2. Strategy-switch penalty or turnover cost.
3. Decision latency assumption (signal at close, execute next bar/open).

## Evaluation Metrics
Primary:
1. OOS return.
2. Max drawdown.
3. Strategy vs baseline edge (`vs_random`, `vs_lump`, `vs_interval`).
4. Stability across folds (median, stdev).

Secondary:
1. Regime classification stability.
2. Strategy switch frequency.
3. Turnover and cost drag.

## Decision and Attribution Log Schema
Each decision record should capture:
1. Timestamp.
2. Detected regime and confidence.
3. Routing weights by strategy.
4. Selected/blended strategy target.
5. Risk overlay adjustments.
6. Final action and executed trade.
7. Realized follow-up outcome (for analytics only).

Example shape:

```json
{
  "ts": "2026-04-20T00:00:00Z",
  "regime": "range",
  "regime_confidence": 0.72,
  "weights": {
    "mean_reversion_balanced": 0.65,
    "trend_pullback_hybrid": 0.20,
    "capitulation_hunter": 0.10,
    "defensive_risk_off": 0.05
  },
  "risk_overlay": {
    "max_exposure_cap": 0.8,
    "drawdown_throttle": 0.9
  },
  "target_exposure_pre_overlay": 0.62,
  "target_exposure_final": 0.56,
  "rationale": "Range regime with elevated confidence; drawdown throttle applied."
}
```

## Phased Build Plan
### V1 (fastest path)
1. Rule-based regime detector.
2. Rule-based strategy router.
3. Leakage-safe walk-forward simulation.
4. Basic attribution logs.

### V2
1. Performance-aware routing adjustments.
2. Regime hysteresis and switch smoothing.
3. Enhanced risk overlays.

### V3
1. News-aware regime modifiers.
2. LLM-assisted reasoning layer with strict query budget and audit trail.

## Integration Notes (Current Codebase)
Target files:
1. `frontend/src/lib/backtest.ts`: add `runMetaBacktest(...)` and walk-forward aggregation.
2. `frontend/src/lib/signals.ts`: keep signal outputs reusable per strategy.
3. `frontend/src/components/*`: add meta backtest configuration and result views.
4. `frontend/src/components/AIControlCenter.tsx`: extend decision logs with regime and routing fields.
