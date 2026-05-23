import { Pool } from "pg";

export interface CachedApiBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

const BAR_CACHE_DATABASE_URL = trimToNull(
  process.env.BACKTEST_CACHE_DATABASE_URL ??
    process.env.BAR_CACHE_DATABASE_URL ??
    process.env.BARS_CACHE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    process.env.DATABASE_PRIVATE_URL ??
    process.env.POSTGRES_URL ??
    process.env.POSTGRESQL_URL
);
const BAR_CACHE_TABLE_NAME = sanitizeSqlIdentifier(
  trimToNull(process.env.BACKTEST_CACHE_TABLE) ?? "backtest_bars_cache"
);
const BAR_CACHE_TTL_1_DAY_MS = parsePositiveIntEnv("BAR_CACHE_TTL_1_DAY_MS", 6 * 60 * 60 * 1000);
const BAR_CACHE_TTL_1_HOUR_MS = parsePositiveIntEnv("BAR_CACHE_TTL_1_HOUR_MS", 30 * 60 * 1000);
const BAR_CACHE_TTL_15_MIN_MS = parsePositiveIntEnv(
  "BAR_CACHE_TTL_15_MIN_MS",
  24 * 60 * 60 * 1000
);
const BAR_CACHE_TTL_5_MIN_MS = parsePositiveIntEnv(
  "BAR_CACHE_TTL_5_MIN_MS",
  12 * 60 * 60 * 1000
);

interface MemoryBarsCacheEntry {
  symbol: string;
  bars: CachedApiBar[];
  cachedAtMs: number;
  expiresAtMs: number;
}

const memoryBarsCache = new Map<string, MemoryBarsCacheEntry>();

let pool: Pool | null = null;
let setupPromise: Promise<void> | null = null;
let setupFailed = false;
let setupFailureReason = "";
let warnedMissingPersistentCacheUrl = false;

export async function getCachedBars(input: {
  symbol: string;
  range: string;
  timeframe: "1Day" | "1Hour" | "15Min" | "5Min";
}): Promise<{ symbol: string; bars: CachedApiBar[] } | null> {
  const memoryCached = getMemoryCachedBars(input);
  if (memoryCached) {
    return memoryCached;
  }

  const cachePool = await getReadyPool();
  if (!cachePool) {
    return null;
  }

  try {
    const result = await cachePool.query(
      `
        select symbol, bars
        from ${BAR_CACHE_TABLE_NAME}
        where symbol = $1
          and range = $2
          and timeframe = $3
          and expires_at > now()
        limit 1
      `,
      [input.symbol, input.range, input.timeframe]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0] as { symbol?: unknown; bars?: unknown };
    if (typeof row.symbol !== "string") {
      return null;
    }

    const bars = parseCachedBars(row.bars);
    if (!bars) {
      return null;
    }

    const ttlMs = resolveTimeframeTtlMs(input.timeframe);
    setMemoryCachedBars({
      symbol: row.symbol,
      range: input.range,
      timeframe: input.timeframe,
      bars,
      ttlMs,
    });
    return {
      symbol: row.symbol,
      bars: cloneBars(bars),
    };
  } catch (err) {
    warnCacheIssue("cache read failed", err);
    return null;
  }
}

export async function upsertCachedBars(input: {
  symbol: string;
  range: string;
  timeframe: "1Day" | "1Hour" | "15Min" | "5Min";
  bars: CachedApiBar[];
}): Promise<void> {
  const ttlMs = resolveTimeframeTtlMs(input.timeframe);
  setMemoryCachedBars({
    symbol: input.symbol,
    range: input.range,
    timeframe: input.timeframe,
    bars: input.bars,
    ttlMs,
  });

  const cachePool = await getReadyPool();
  if (!cachePool) {
    return;
  }

  try {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    await cachePool.query(
      `
        insert into ${BAR_CACHE_TABLE_NAME} (
          symbol,
          range,
          timeframe,
          bars,
          fetched_at,
          expires_at
        )
        values ($1, $2, $3, $4::jsonb, now(), $5)
        on conflict (symbol, range, timeframe)
        do update set
          bars = excluded.bars,
          fetched_at = now(),
          expires_at = excluded.expires_at
      `,
      [input.symbol, input.range, input.timeframe, JSON.stringify(input.bars), expiresAt]
    );
  } catch (err) {
    warnCacheIssue("cache write failed", err);
  }
}

async function getReadyPool(): Promise<Pool | null> {
  if (!BAR_CACHE_DATABASE_URL) {
    if (!warnedMissingPersistentCacheUrl) {
      warnedMissingPersistentCacheUrl = true;
      console.warn(
        "[bar-cache] persistent cache disabled (no cache DB URL env configured); using in-memory cache only"
      );
    }
    return null;
  }

  if (!pool) {
    pool = new Pool({ connectionString: BAR_CACHE_DATABASE_URL });
    pool.on("error", (err) => {
      warnCacheIssue("postgres pool error", err);
    });
  }

  if (setupFailed) {
    return null;
  }

  if (!setupPromise) {
    setupPromise = setupCacheTable(pool).catch((err) => {
      setupFailed = true;
      setupFailureReason = err instanceof Error ? err.message : String(err);
      warnCacheIssue("cache setup failed", err);
      throw err;
    });
  }

  try {
    await setupPromise;
  } catch {
    return null;
  }

  return pool;
}

async function setupCacheTable(cachePool: Pool): Promise<void> {
  await cachePool.query(`
    create table if not exists ${BAR_CACHE_TABLE_NAME} (
      symbol text not null,
      range text not null,
      timeframe text not null,
      bars jsonb not null,
      fetched_at timestamptz not null,
      expires_at timestamptz not null,
      primary key (symbol, range, timeframe)
    );
  `);

  await cachePool.query(
    `create index if not exists idx_${BAR_CACHE_TABLE_NAME}_expires_at on ${BAR_CACHE_TABLE_NAME}(expires_at);`
  );
}

function parseCachedBars(value: unknown): CachedApiBar[] | null {
  const parsed =
    typeof value === "string"
      ? safeJsonParse(value)
      : value;

  if (!Array.isArray(parsed)) {
    return null;
  }

  const bars = parsed.filter(isCachedApiBar) as CachedApiBar[];
  if (bars.length !== parsed.length) {
    return null;
  }

  return bars;
}

function isCachedApiBar(value: unknown): value is CachedApiBar {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.t === "string" &&
    Number.isFinite(Number(candidate.o)) &&
    Number.isFinite(Number(candidate.h)) &&
    Number.isFinite(Number(candidate.l)) &&
    Number.isFinite(Number(candidate.c)) &&
    (candidate.v === null || Number.isFinite(Number(candidate.v)))
  );
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = trimToNull(process.env[name]);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.round(parsed);
}

function resolveTimeframeTtlMs(timeframe: "1Day" | "1Hour" | "15Min" | "5Min"): number {
  return timeframe === "15Min"
    ? BAR_CACHE_TTL_15_MIN_MS
    : timeframe === "5Min"
    ? BAR_CACHE_TTL_5_MIN_MS
    : timeframe === "1Hour"
    ? BAR_CACHE_TTL_1_HOUR_MS
    : BAR_CACHE_TTL_1_DAY_MS;
}

function setMemoryCachedBars(input: {
  symbol: string;
  range: string;
  timeframe: "1Day" | "1Hour" | "15Min" | "5Min";
  bars: CachedApiBar[];
  ttlMs: number;
}): void {
  const cacheKey = buildCacheKey(input.symbol, input.range, input.timeframe);
  const nowMs = Date.now();
  memoryBarsCache.set(cacheKey, {
    symbol: input.symbol,
    bars: cloneBars(input.bars),
    cachedAtMs: nowMs,
    expiresAtMs: nowMs + input.ttlMs,
  });
}

function getMemoryCachedBars(input: {
  symbol: string;
  range: string;
  timeframe: "1Day" | "1Hour" | "15Min" | "5Min";
}): { symbol: string; bars: CachedApiBar[] } | null {
  const cacheKey = buildCacheKey(input.symbol, input.range, input.timeframe);
  const cached = memoryBarsCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAtMs <= Date.now()) {
    memoryBarsCache.delete(cacheKey);
    return null;
  }
  return {
    symbol: cached.symbol,
    bars: cloneBars(cached.bars),
  };
}

export async function getStaleCachedBars(input: {
  symbol: string;
  range: string;
  timeframe: "1Day" | "1Hour" | "15Min" | "5Min";
  maxAgeMs: number;
}): Promise<{ symbol: string; bars: CachedApiBar[]; cachedAtMs: number } | null> {
  const maxAgeMs = Math.max(1, input.maxAgeMs);
  const memoryStale = getMemoryCachedBarsIncludingExpired(input);
  if (memoryStale) {
    const ageMs = Date.now() - memoryStale.cachedAtMs;
    if (ageMs <= maxAgeMs) {
      return memoryStale;
    }
  }

  const cachePool = await getReadyPool();
  if (!cachePool) {
    return null;
  }

  try {
    const result = await cachePool.query(
      `
        select symbol, bars, fetched_at
        from ${BAR_CACHE_TABLE_NAME}
        where symbol = $1
          and range = $2
          and timeframe = $3
        limit 1
      `,
      [input.symbol, input.range, input.timeframe]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0] as {
      symbol?: unknown;
      bars?: unknown;
      fetched_at?: unknown;
    };
    if (typeof row.symbol !== "string") {
      return null;
    }

    const bars = parseCachedBars(row.bars);
    if (!bars) {
      return null;
    }

    const cachedAtMs = toEpochMs(row.fetched_at);
    if (!Number.isFinite(cachedAtMs)) {
      return null;
    }

    const ageMs = Date.now() - cachedAtMs;
    if (ageMs > maxAgeMs) {
      return null;
    }

    return {
      symbol: row.symbol,
      bars: cloneBars(bars),
      cachedAtMs,
    };
  } catch (err) {
    warnCacheIssue("stale fallback read failed", err);
    return null;
  }
}

function buildCacheKey(
  symbol: string,
  range: string,
  timeframe: "1Day" | "1Hour" | "15Min" | "5Min"
): string {
  return `${symbol}::${range}::${timeframe}`;
}

function cloneBars(bars: CachedApiBar[]): CachedApiBar[] {
  return bars.map((bar) => ({ ...bar }));
}

function getMemoryCachedBarsIncludingExpired(input: {
  symbol: string;
  range: string;
  timeframe: "1Day" | "1Hour" | "15Min" | "5Min";
}): { symbol: string; bars: CachedApiBar[]; cachedAtMs: number } | null {
  const cacheKey = buildCacheKey(input.symbol, input.range, input.timeframe);
  const cached = memoryBarsCache.get(cacheKey);
  if (!cached) return null;
  return {
    symbol: cached.symbol,
    bars: cloneBars(cached.bars),
    cachedAtMs: cached.cachedAtMs,
  };
}

function toEpochMs(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function trimToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sanitizeSqlIdentifier(identifier: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)
    ? identifier
    : "backtest_bars_cache";
}

function warnCacheIssue(message: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  if (setupFailureReason) {
    console.warn(`[bar-cache] ${message}: ${detail}. setup_failure=${setupFailureReason}`);
    return;
  }
  console.warn(`[bar-cache] ${message}: ${detail}`);
}
