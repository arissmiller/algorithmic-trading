import { useCallback, useEffect, useMemo, useState } from "react";
import PortfolioVsSp500Page from "./PortfolioVsSp500Page";

type LivePortfolioHoldingSnapshot = {
  symbol: string;
  targetPct: number;
};

type LivePortfolioSnapshot = {
  updatedAt: string;
  holdings: LivePortfolioHoldingSnapshot[];
};

export default function LivePortfolioBacktestPage({ apiPrefix }: { apiPrefix: string }) {
  const [snapshot, setSnapshot] = useState<LivePortfolioSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadLivePortfolio = useCallback(async (silent: boolean) => {
    if (!silent) {
      setLoading(true);
    }
    try {
      const response = await fetch(`${apiPrefix}/bot/portfolio`);
      const body = (await response.json().catch(() => ({}))) as Partial<LivePortfolioSnapshot> & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      if (!Array.isArray(body.holdings) || typeof body.updatedAt !== "string") {
        throw new Error("Invalid live portfolio payload.");
      }
      setSnapshot({
        updatedAt: body.updatedAt,
        holdings: body.holdings
          .map((holding) => ({
            symbol: typeof holding.symbol === "string" ? holding.symbol.trim().toUpperCase() : "",
            targetPct:
              typeof holding.targetPct === "number" && Number.isFinite(holding.targetPct)
                ? holding.targetPct
                : 0,
          }))
          .filter((holding) => holding.symbol && holding.targetPct > 0),
      });
      setError(null);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : "Failed to load live portfolio.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    void loadLivePortfolio(false);
    const timer = setInterval(() => {
      void loadLivePortfolio(true);
    }, 30_000);
    return () => clearInterval(timer);
  }, [loadLivePortfolio]);

  const fixedAllocationsText = useMemo(() => {
    if (!snapshot) return "";
    return snapshot.holdings.map((holding) => `${holding.symbol}: ${holding.targetPct}`).join("\n");
  }, [snapshot]);

  const sourceLabel = useMemo(() => {
    if (!snapshot) return "Live portfolio allocations unavailable.";
    const base = `Synced from backend live portfolio (${new Date(snapshot.updatedAt).toLocaleString()}).`;
    if (!error) return base;
    return `${base} Last refresh error: ${error}`;
  }, [snapshot, error]);

  if (loading && !snapshot) {
    return (
      <div className="h-full overflow-auto p-4">
        <div className="rounded border border-border bg-surface-1 px-4 py-5 text-xs text-text-secondary">
          Loading live portfolio allocations...
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="h-full overflow-auto p-4">
        <div className="mb-3 rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          {error ?? "Could not load live portfolio allocations."}
        </div>
        <button
          type="button"
          onClick={() => void loadLivePortfolio(false)}
          className="rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!fixedAllocationsText.trim()) {
    return (
      <div className="h-full overflow-auto p-4">
        <div className="rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          Live portfolio has no positive target allocations to backtest.
        </div>
      </div>
    );
  }

  return (
    <PortfolioVsSp500Page
      apiPrefix={apiPrefix}
      title="Live Portfolio Backtest"
      description="Backtest the backend live-portfolio allocations against selected benchmark indexes."
      fixedAllocationsText={fixedAllocationsText}
      fixedAllocationsSourceLabel={sourceLabel}
    />
  );
}
