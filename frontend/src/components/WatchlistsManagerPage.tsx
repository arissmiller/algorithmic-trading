import { useCallback, useEffect, useState } from "react";
import { formatAuthDependencyError } from "../lib/authErrors";
import type { AuthUser } from "./AuthGate";
import WatchlistPage from "./WatchlistPage";
import type { StrategyPresetKey } from "./StrategyBuilder";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const API_PREFIX = API_BASE_URL ? `${API_BASE_URL}/api` : "/api";
const AUTH_TOKEN_STORAGE_KEY = "smart_scale_auth_token";

type AssetClass = "stocks_etf" | "crypto";

interface UserWatchlist {
  userId: string;
  name: string;
  assetClass: AssetClass;
  symbols: string[];
  enabled: boolean;
  config: { timeframe: "1Day" | "1Hour" };
  createdAt: string;
  updatedAt: string;
}

interface WatchlistMonitorStatus {
  running: boolean;
  watchlistCount: number;
  watchedSymbolCount: number;
  signalCount: number;
  lastRunByTimeframe: Record<"1Day" | "1Hour", string | null>;
  lastError: string | null;
}

type View = "list" | "manage";

const ASSET_CLASS_DEFAULTS: Record<
  AssetClass,
  {
    label: string;
    description: string;
    defaultSymbols: string[];
    defaultTimeframe: "1Day" | "1Hour";
    defaultPresetKey: StrategyPresetKey;
    symbolHint: string;
  }
> = {
  stocks_etf: {
    label: "Stocks/ETF",
    description: "Equity and ETF watchlist — scanned daily for buy/sell signals.",
    defaultSymbols: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"],
    defaultTimeframe: "1Day",
    defaultPresetKey: "mean_reversion_balanced",
    symbolHint: "SPY, QQQ, AAPL, MSFT",
  },
  crypto: {
    label: "Crypto",
    description: "Crypto pair watchlist — scanned hourly for buy/sell signals.",
    defaultSymbols: ["BTC/USD", "ETH/USD", "SOL/USD"],
    defaultTimeframe: "1Hour",
    defaultPresetKey: "hourly_mean_reversion",
    symbolHint: "BTC/USD, ETH/USD, SOL/USD",
  },
};

export default function WatchlistsManagerPage({ authUser }: { authUser: AuthUser }) {
  const [view, setView] = useState<View>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string>("");
  const [selectedAssetClass, setSelectedAssetClass] = useState<AssetClass>("stocks_etf");

  const [watchlists, setWatchlists] = useState<UserWatchlist[]>([]);
  const [monitor, setMonitor] = useState<WatchlistMonitorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createAssetClass, setCreateAssetClass] = useState<AssetClass>("stocks_etf");
  const [createError, setCreateError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch(`${API_PREFIX}/bot/watchlists`, {
        headers: buildAuthHeaders(),
      });
      const body = (await res.json().catch(() => ({}))) as {
        watchlists?: UserWatchlist[];
        monitor?: WatchlistMonitorStatus;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setWatchlists(Array.isArray(body.watchlists) ? body.watchlists : []);
      setMonitor(body.monitor ?? null);
      setError(null);
    } catch (e) {
      setError(
        e instanceof Error
          ? formatAuthDependencyError(e.message)
          : "Failed to load watchlists."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function handleCreate() {
    const trimmedName = createName.trim();
    if (!trimmedName) {
      setCreateError("Watchlist name is required.");
      return;
    }
    const watchlistId = `${authUser.id}:wl-${Date.now().toString(36)}`;
    setSelectedId(watchlistId);
    setSelectedName(trimmedName);
    setSelectedAssetClass(createAssetClass);
    setView("manage");
    setShowCreateForm(false);
    setCreateName("");
    setCreateError(null);
  }

  function handleOpenManage(watchlist: UserWatchlist) {
    setSelectedId(watchlist.userId);
    setSelectedName(watchlist.name);
    setSelectedAssetClass(watchlist.assetClass ?? "stocks_etf");
    setView("manage");
  }

  function handleBack() {
    setView("list");
    setSelectedId(null);
    setLoading(true);
    void loadData();
  }

  async function handleDelete(watchlistId: string) {
    setDeletingId(watchlistId);
    try {
      const res = await fetch(
        `${API_PREFIX}/bot/watchlists/${encodeURIComponent(watchlistId)}`,
        { method: "DELETE", headers: buildAuthHeaders() }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Delete failed (${res.status})`);
      }
      setWatchlists((prev) => prev.filter((w) => w.userId !== watchlistId));
    } catch (e) {
      setError(
        e instanceof Error ? formatAuthDependencyError(e.message) : "Delete failed."
      );
    } finally {
      setDeletingId(null);
    }
  }

  if (view === "manage" && selectedId) {
    const defaults = ASSET_CLASS_DEFAULTS[selectedAssetClass];
    return (
      <WatchlistPage
        title={selectedName}
        description={defaults.description}
        watchlistUserId={selectedId}
        defaultSymbols={defaults.defaultSymbols}
        defaultTimeframe={defaults.defaultTimeframe}
        defaultPresetKey={defaults.defaultPresetKey}
        symbolHint={defaults.symbolHint}
        assetClass={selectedAssetClass}
        displayName={authUser.name}
        onBack={handleBack}
      />
    );
  }

  return (
    <div className="h-full overflow-auto p-4">
      <section className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">Watchlists</h2>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadData()}
            disabled={loading}
            className="rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowCreateForm((v) => !v);
              setCreateError(null);
            }}
            className="rounded border border-buy/40 bg-buy/10 px-3 py-1.5 text-xs text-buy transition-colors hover:bg-buy/20"
          >
            {showCreateForm ? "Cancel" : "New Watchlist"}
          </button>
        </div>
      </section>

      {showCreateForm && (
        <section className="mb-4 rounded border border-border bg-surface-1 p-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
            Create Watchlist
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-40">
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
                Name
              </label>
              <input
                type="text"
                className="w-full rounded border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent/60 focus:outline-none"
                placeholder="e.g. Tech Stocks"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
                Asset Class
              </label>
              <select
                className="rounded border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent/60 focus:outline-none"
                value={createAssetClass}
                onChange={(e) => setCreateAssetClass(e.target.value as AssetClass)}
              >
                <option value="stocks_etf">Stocks / ETF</option>
                <option value="crypto">Crypto</option>
              </select>
            </div>
            <button
              type="button"
              onClick={handleCreate}
              className="rounded border border-buy/40 bg-buy/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-buy hover:bg-buy/20"
            >
              Create
            </button>
          </div>
          {createError && (
            <p className="mt-2 text-[10px] text-sell">{createError}</p>
          )}
        </section>
      )}

      {error && (
        <div className="mb-4 rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          {error}
        </div>
      )}

      {monitor && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MonitorCard
            label="Monitor"
            value={monitor.running ? "Running" : "Stopped"}
            valueClass={monitor.running ? "text-buy" : "text-sell"}
          />
          <MonitorCard label="Watchlists" value={monitor.watchlistCount.toString()} />
          <MonitorCard label="Symbols" value={monitor.watchedSymbolCount.toString()} />
          <MonitorCard label="Signals" value={monitor.signalCount.toString()} />
        </div>
      )}

      {loading && watchlists.length === 0 ? (
        <div className="rounded border border-border bg-surface-1 p-6 text-center text-xs text-text-secondary">
          Loading watchlists...
        </div>
      ) : watchlists.length === 0 ? (
        <div className="rounded border border-border bg-surface-1 p-6 text-center">
          <p className="mb-2 text-xs text-text-secondary">No watchlists yet.</p>
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="rounded border border-buy/40 bg-buy/10 px-3 py-1.5 text-xs text-buy hover:bg-buy/20"
          >
            Create your first watchlist
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {watchlists.map((wl) => (
            <WatchlistCard
              key={wl.userId}
              watchlist={wl}
              deleting={deletingId === wl.userId}
              onManage={() => handleOpenManage(wl)}
              onDelete={() => void handleDelete(wl.userId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WatchlistCard({
  watchlist,
  deleting,
  onManage,
  onDelete,
}: {
  watchlist: UserWatchlist;
  deleting: boolean;
  onManage: () => void;
  onDelete: () => void;
}) {
  const assetLabel = watchlist.assetClass === "crypto" ? "Crypto" : "Stocks/ETF";
  const assetColor =
    watchlist.assetClass === "crypto"
      ? "border-accent/40 bg-accent/10 text-accent"
      : "border-buy/30 bg-buy/10 text-buy";

  const symbolPreview = watchlist.symbols.slice(0, 5).join(", ");
  const extraCount = watchlist.symbols.length > 5 ? watchlist.symbols.length - 5 : 0;

  return (
    <div className="flex flex-col rounded border border-border bg-surface-1 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">{watchlist.name}</p>
          <p className="mt-0.5 text-[10px] text-text-secondary">
            Updated {new Date(watchlist.updatedAt).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${assetColor}`}
          >
            {assetLabel}
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              watchlist.enabled
                ? "border-buy/30 bg-buy/10 text-buy"
                : "border-border bg-surface-2 text-text-secondary"
            }`}
          >
            {watchlist.enabled ? "On" : "Off"}
          </span>
        </div>
      </div>

      <div className="mb-3 flex-1 rounded border border-border/60 bg-surface-0/50 px-2 py-1.5">
        <p className="text-[10px] text-text-secondary">
          {watchlist.symbols.length === 0 ? (
            <span className="italic">No symbols</span>
          ) : (
            <>
              {symbolPreview}
              {extraCount > 0 && (
                <span className="text-text-secondary"> +{extraCount} more</span>
              )}
            </>
          )}
        </p>
        <p className="mt-0.5 text-[10px] text-text-secondary">
          {watchlist.symbols.length} symbol{watchlist.symbols.length === 1 ? "" : "s"} ·{" "}
          {watchlist.config.timeframe}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onManage}
          className="flex-1 rounded border border-accent/40 bg-accent/10 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent hover:bg-accent/20"
        >
          Manage
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="rounded border border-sell/30 bg-sell/10 px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-sell hover:bg-sell/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deleting ? "..." : "Delete"}
        </button>
      </div>
    </div>
  );
}

function MonitorCard({
  label,
  value,
  valueClass = "text-text-primary",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded border border-border bg-surface-1 p-3">
      <p className="mb-1 text-[10px] text-text-secondary">{label}</p>
      <p className={`text-base font-semibold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  );
}

function buildAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  try {
    const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    if (typeof token === "string" && token.trim()) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }
  } catch {
    // ignore
  }
  return headers;
}
