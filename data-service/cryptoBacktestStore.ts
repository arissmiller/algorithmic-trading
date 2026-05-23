import { Pool } from "pg";

export interface StoredCryptoBacktestBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

export interface CryptoUniverseMember {
  rank: number;
  symbol: string;
  sourceSymbol: string;
  quoteVolumeUsd: number;
}

const STORE_DATABASE_URL = trimToNull(
  process.env.BACKTEST_CACHE_DATABASE_URL ??
    process.env.BAR_CACHE_DATABASE_URL ??
    process.env.BARS_CACHE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    process.env.DATABASE_PRIVATE_URL ??
    process.env.POSTGRES_URL ??
    process.env.POSTGRESQL_URL
);
const STORE_TABLE_NAME = sanitizeSqlIdentifier(
  trimToNull(process.env.BACKTEST_CRYPTO_HOURLY_TABLE) ?? "backtest_crypto_hourly_bars"
);
const UNIVERSE_TABLE_NAME = sanitizeSqlIdentifier(
  trimToNull(process.env.BACKTEST_CRYPTO_UNIVERSE_TABLE) ?? "backtest_crypto_universe"
);

const DAY_MS = 86_400_000;

let pool: Pool | null = null;
let setupPromise: Promise<void> | null = null;
let setupFailed = false;
let setupFailureReason = "";

export async function getStoredCryptoBacktestBars(input: {
  symbol: string;
  range: string;
  timeframe: "1Hour" | "1Day" | "15Min";
}): Promise<{ symbol: string; bars: StoredCryptoBacktestBar[] } | null> {
  if (input.timeframe !== "1Hour") {
    return null;
  }

  const cachePool = await getReadyPool();
  if (!cachePool) {
    return null;
  }

  const canonicalSymbol = canonicalizeBacktestCryptoSymbol(input.symbol);
  const cutoff = cutoffIsoForRange(input.range);
  const nowIso = new Date().toISOString();

  try {
    const result = cutoff
      ? await cachePool.query(
          `
            select t, o, h, l, c, v
            from ${STORE_TABLE_NAME}
            where symbol = $1
              and t >= $2::timestamptz
              and t < $3::timestamptz
            order by t asc
          `,
          [canonicalSymbol, cutoff, nowIso]
        )
      : await cachePool.query(
          `
            select t, o, h, l, c, v
            from ${STORE_TABLE_NAME}
            where symbol = $1
              and t < $2::timestamptz
            order by t asc
          `,
          [canonicalSymbol, nowIso]
        );

    if (result.rowCount === 0) {
      return null;
    }

    const bars: StoredCryptoBacktestBar[] = [];
    for (const row of result.rows) {
      const bar = toStoredBar(row);
      if (bar) {
        bars.push(bar);
      }
    }

    if (bars.length === 0) {
      return null;
    }

    return { symbol: canonicalSymbol, bars };
  } catch (err) {
    warnStoreIssue("read failed", err);
    return null;
  }
}

export async function upsertStoredCryptoBacktestBars(input: {
  symbol: string;
  source: string;
  bars: StoredCryptoBacktestBar[];
}): Promise<void> {
  if (input.bars.length === 0) {
    return;
  }

  const cachePool = await getReadyPool();
  if (!cachePool) {
    return;
  }

  const canonicalSymbol = canonicalizeBacktestCryptoSymbol(input.symbol);
  const source = input.source.trim() || "unknown";
  const payload = JSON.stringify(
    input.bars
      .filter(isStoredBar)
      .sort((a, b) => a.t.localeCompare(b.t))
  );

  if (!payload || payload === "[]") {
    return;
  }

  try {
    await cachePool.query(
      `
        insert into ${STORE_TABLE_NAME} (symbol, t, o, h, l, c, v, source, fetched_at)
        select
          $1::text as symbol,
          x.t::timestamptz as t,
          x.o::double precision as o,
          x.h::double precision as h,
          x.l::double precision as l,
          x.c::double precision as c,
          x.v::double precision as v,
          $3::text as source,
          now() as fetched_at
        from jsonb_to_recordset($2::jsonb) as x(
          t text,
          o double precision,
          h double precision,
          l double precision,
          c double precision,
          v double precision
        )
        on conflict (symbol, t)
        do update set
          o = excluded.o,
          h = excluded.h,
          l = excluded.l,
          c = excluded.c,
          v = excluded.v,
          source = excluded.source,
          fetched_at = now()
      `,
      [canonicalSymbol, payload, source]
    );
  } catch (err) {
    warnStoreIssue("upsert failed", err);
  }
}

export async function replaceCryptoUniverse(input: {
  source: string;
  members: CryptoUniverseMember[];
}): Promise<void> {
  const cachePool = await getReadyPool();
  if (!cachePool) {
    return;
  }

  const source = input.source.trim() || "unknown";
  const members = input.members
    .map((member) => ({
      rank: Math.max(1, Math.floor(member.rank)),
      symbol: canonicalizeBacktestCryptoSymbol(member.symbol),
      sourceSymbol: member.sourceSymbol.trim().toUpperCase(),
      quoteVolumeUsd: Number(member.quoteVolumeUsd),
    }))
    .filter((member) => Number.isFinite(member.quoteVolumeUsd) && member.quoteVolumeUsd > 0)
    .sort((a, b) => a.rank - b.rank);

  try {
    await cachePool.query("begin");
    await cachePool.query(
      `delete from ${UNIVERSE_TABLE_NAME} where source = $1`,
      [source]
    );
    if (members.length > 0) {
      const payload = JSON.stringify(members);
      await cachePool.query(
        `
          insert into ${UNIVERSE_TABLE_NAME} (
            source,
            rank,
            symbol,
            source_symbol,
            quote_volume_usd,
            collected_at
          )
          select
            $1::text as source,
            x.rank::integer as rank,
            x.symbol::text as symbol,
            x.sourceSymbol::text as source_symbol,
            x.quoteVolumeUsd::double precision as quote_volume_usd,
            now() as collected_at
          from jsonb_to_recordset($2::jsonb) as x(
            rank integer,
            symbol text,
            sourceSymbol text,
            quoteVolumeUsd double precision
          )
          on conflict (source, rank)
          do update set
            symbol = excluded.symbol,
            source_symbol = excluded.source_symbol,
            quote_volume_usd = excluded.quote_volume_usd,
            collected_at = now()
        `,
        [source, payload]
      );
    }
    await cachePool.query("commit");
  } catch (err) {
    await cachePool.query("rollback").catch(() => undefined);
    warnStoreIssue("replace universe failed", err);
  }
}

async function getReadyPool(): Promise<Pool | null> {
  if (!STORE_DATABASE_URL) {
    return null;
  }

  if (!pool) {
    pool = new Pool({ connectionString: STORE_DATABASE_URL });
    pool.on("error", (err) => {
      warnStoreIssue("postgres pool error", err);
    });
  }

  if (setupFailed) {
    return null;
  }

  if (!setupPromise) {
    setupPromise = setupStoreTables(pool).catch((err) => {
      setupFailed = true;
      setupFailureReason = err instanceof Error ? err.message : String(err);
      warnStoreIssue("setup failed", err);
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

async function setupStoreTables(cachePool: Pool): Promise<void> {
  await cachePool.query(`
    create table if not exists ${STORE_TABLE_NAME} (
      symbol text not null,
      t timestamptz not null,
      o double precision not null,
      h double precision not null,
      l double precision not null,
      c double precision not null,
      v double precision null,
      source text not null,
      fetched_at timestamptz not null,
      primary key (symbol, t)
    );
  `);
  await cachePool.query(
    `create index if not exists idx_${STORE_TABLE_NAME}_symbol_t on ${STORE_TABLE_NAME}(symbol, t);`
  );

  await cachePool.query(`
    create table if not exists ${UNIVERSE_TABLE_NAME} (
      source text not null,
      rank integer not null,
      symbol text not null,
      source_symbol text not null,
      quote_volume_usd double precision not null,
      collected_at timestamptz not null,
      primary key (source, rank)
    );
  `);
}

function toStoredBar(row: Record<string, unknown>): StoredCryptoBacktestBar | null {
  const tRaw = row.t;
  const ts = tRaw instanceof Date ? tRaw.getTime() : Date.parse(String(tRaw ?? ""));
  const o = Number(row.o);
  const h = Number(row.h);
  const l = Number(row.l);
  const c = Number(row.c);
  const vRaw = row.v;
  const v = vRaw === null || vRaw === undefined ? null : Number(vRaw);
  if (!Number.isFinite(ts)) return null;
  if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
    return null;
  }
  if (v !== null && !Number.isFinite(v)) return null;
  return {
    t: new Date(ts).toISOString(),
    o,
    h,
    l,
    c,
    v,
  };
}

function isStoredBar(value: StoredCryptoBacktestBar): boolean {
  return (
    typeof value.t === "string" &&
    Number.isFinite(value.o) &&
    Number.isFinite(value.h) &&
    Number.isFinite(value.l) &&
    Number.isFinite(value.c) &&
    (value.v === null || Number.isFinite(value.v))
  );
}

function canonicalizeBacktestCryptoSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase().replace(/[-_]/g, "/");
  const [base] = upper.split("/");
  const normalizedBase = base.replace(/[^A-Z0-9]/g, "");
  return `${normalizedBase}/USD`;
}

function cutoffIsoForRange(range: string): string | null {
  if (range === "max") {
    return null;
  }
  const yearsBack = Number(range.replace("y", ""));
  if (!Number.isFinite(yearsBack) || yearsBack <= 0) {
    return null;
  }
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear() - yearsBack, now.getUTCMonth(), now.getUTCDate())
  );
  return start.toISOString();
}

function trimToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sanitizeSqlIdentifier(identifier: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)
    ? identifier
    : "backtest_crypto_hourly_bars";
}

function warnStoreIssue(message: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  if (setupFailureReason) {
    console.warn(`[crypto-backtest-store] ${message}: ${detail}. setup_failure=${setupFailureReason}`);
    return;
  }
  console.warn(`[crypto-backtest-store] ${message}: ${detail}`);
}

export function deriveStartIsoForYears(yearsBack: number): string {
  const now = Date.now();
  const years = Math.max(1, Math.floor(yearsBack));
  const startMs = now - years * 365 * DAY_MS;
  return new Date(startMs).toISOString();
}
