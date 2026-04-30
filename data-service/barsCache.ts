/**
 * SQLite-backed cache for Alpaca market bars used in backtesting.
 *
 * Avoids redundant downstream Alpaca API calls for the same
 * (symbol, timeframe, range) combination within the configured TTL.
 *
 * Environment variables:
 *   BARS_CACHE_FILE   – path to the SQLite database file
 *                       (default: bars-cache.db next to this module)
 *   BARS_CACHE_TTL_MS – how long a cached entry stays fresh in milliseconds
 *                       (default: 86400000 = 24 hours)
 */
import Database from "better-sqlite3";

const BARS_CACHE_FILE =
  (process.env.BARS_CACHE_FILE ?? "").trim() ||
  new URL("./bars-cache.db", import.meta.url).pathname;

const BARS_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.BARS_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000;
})();

export interface CachedBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

interface CacheRow {
  bars: string;
  fetched_at: number;
}

export class BarsCache {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bars_cache (
        symbol     TEXT    NOT NULL,
        timeframe  TEXT    NOT NULL,
        range      TEXT    NOT NULL,
        fetched_at INTEGER NOT NULL,
        bars       TEXT    NOT NULL,
        PRIMARY KEY (symbol, timeframe, range)
      );
      CREATE INDEX IF NOT EXISTS bars_cache_fetched_at
        ON bars_cache (fetched_at);
    `);
  }

  /**
   * Returns cached bars if they exist and are within the TTL, otherwise null.
   */
  get(symbol: string, timeframe: string, range: string): CachedBar[] | null {
    const row = this.db
      .prepare<[string, string, string], CacheRow>(
        "SELECT bars, fetched_at FROM bars_cache WHERE symbol = ? AND timeframe = ? AND range = ?"
      )
      .get(symbol, timeframe, range);

    if (!row) {
      return null;
    }

    if (Date.now() - row.fetched_at > BARS_CACHE_TTL_MS) {
      return null;
    }

    try {
      return JSON.parse(row.bars) as CachedBar[];
    } catch {
      return null;
    }
  }

  /**
   * Stores bars in the cache, replacing any existing entry for the same key.
   */
  set(symbol: string, timeframe: string, range: string, bars: CachedBar[]): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO bars_cache (symbol, timeframe, range, fetched_at, bars)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(symbol, timeframe, range, Date.now(), JSON.stringify(bars));
  }

  /**
   * Removes all cache entries older than the current TTL.
   */
  evictStale(): number {
    const cutoff = Date.now() - BARS_CACHE_TTL_MS;
    const result = this.db
      .prepare("DELETE FROM bars_cache WHERE fetched_at < ?")
      .run(cutoff);
    return result.changes;
  }

  /**
   * Returns the number of entries currently in the cache.
   */
  size(): number {
    const row = this.db
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM bars_cache")
      .get();
    return row?.count ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

let _instance: BarsCache | null = null;

/**
 * Returns the shared BarsCache singleton, creating it on first call.
 */
export function getBarsCache(): BarsCache {
  if (!_instance) {
    _instance = new BarsCache(BARS_CACHE_FILE);
  }
  return _instance;
}
