import { useCallback, useEffect, useState } from "react";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const API_PREFIX = API_BASE_URL ? `${API_BASE_URL}/api` : "/api";

type AssetClass = "stocks_etf" | "crypto";

interface PublicWatchlist {
  name: string;
  assetClass: AssetClass;
  symbols: string[];
  symbolCount: number;
  updatedAt: string;
}

interface PublicUser {
  displayName: string;
  watchlists: PublicWatchlist[];
}

export default function CommunityPage() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_PREFIX}/community/watchlists`);
      const body = (await res.json().catch(() => ({}))) as {
        users?: PublicUser[];
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setUsers(Array.isArray(body.users) ? body.users : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load community watchlists.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  return (
    <div className="h-full overflow-auto p-4">
      <section className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-sm font-semibold">Community Watchlists</h2>
          <p className="mt-0.5 text-[11px] text-text-secondary">
            Public watchlists from all users. Display names and watchlists are visible to everyone.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadData()}
          disabled={loading}
          className="ml-auto rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </section>

      {error && (
        <div className="mb-4 rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
          {error}
        </div>
      )}

      {loading && users.length === 0 ? (
        <div className="rounded border border-border bg-surface-1 p-6 text-center text-xs text-text-secondary">
          Loading community watchlists...
        </div>
      ) : users.length === 0 ? (
        <div className="rounded border border-border bg-surface-1 p-6 text-center text-xs text-text-secondary">
          No public watchlists yet. Create a watchlist to appear here.
        </div>
      ) : (
        <div className="space-y-4">
          {users.map((user, i) => (
            <UserCard key={i} user={user} />
          ))}
        </div>
      )}
    </div>
  );
}

function UserCard({ user }: { user: PublicUser }) {
  return (
    <section className="rounded border border-border bg-surface-1">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-full border border-accent/40 bg-accent/10 text-[10px] font-bold uppercase text-accent">
          {user.displayName.charAt(0) || "?"}
        </div>
        <span className="text-sm font-semibold text-text-primary">{user.displayName}</span>
        <span className="ml-auto text-[10px] text-text-secondary">
          {user.watchlists.length} watchlist{user.watchlists.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
        {user.watchlists.map((wl, j) => (
          <WatchlistCard key={j} watchlist={wl} />
        ))}
      </div>
    </section>
  );
}

function WatchlistCard({ watchlist }: { watchlist: PublicWatchlist }) {
  const assetColor =
    watchlist.assetClass === "crypto"
      ? "border-accent/40 bg-accent/10 text-accent"
      : "border-buy/30 bg-buy/10 text-buy";
  const assetLabel = watchlist.assetClass === "crypto" ? "Crypto" : "Stocks/ETF";

  const symbolPreview = watchlist.symbols.slice(0, 5).join(", ");
  const extraCount = watchlist.symbols.length > 5 ? watchlist.symbols.length - 5 : 0;

  return (
    <div className="rounded border border-border bg-surface-0/50 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-xs font-semibold text-text-primary">{watchlist.name}</p>
        <span
          className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${assetColor}`}
        >
          {assetLabel}
        </span>
      </div>
      <p className="text-[10px] text-text-secondary">
        {watchlist.symbolCount === 0 ? (
          <span className="italic">No symbols</span>
        ) : (
          <>
            {symbolPreview}
            {extraCount > 0 && <span> +{extraCount} more</span>}
          </>
        )}
      </p>
      <p className="mt-1 text-[10px] text-text-secondary">
        {watchlist.symbolCount} symbol{watchlist.symbolCount === 1 ? "" : "s"} · Updated{" "}
        {new Date(watchlist.updatedAt).toLocaleDateString()}
      </p>
    </div>
  );
}
