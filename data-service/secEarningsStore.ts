import { Pool } from "pg";
import type { EarningsEvent } from "./earningsTypes.ts";

const SEC_EARNINGS_DATABASE_URL = trimToNull(
  process.env.SEC_EARNINGS_DATABASE_URL ??
    process.env.BACKTEST_CACHE_DATABASE_URL ??
    process.env.BAR_CACHE_DATABASE_URL ??
    process.env.BARS_CACHE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    process.env.DATABASE_PRIVATE_URL ??
    process.env.POSTGRES_URL ??
    process.env.POSTGRESQL_URL
);
const SEC_EARNINGS_TABLE_NAME = sanitizeSqlIdentifier(
  trimToNull(process.env.SEC_EARNINGS_TABLE) ?? "backtest_sec_earnings_cache"
);
const SEC_EARNINGS_TTL_MS = parsePositiveIntEnv(
  "SEC_EARNINGS_TTL_MS",
  24 * 60 * 60 * 1000
);
const SEC_EARNINGS_RETRY_TTL_MS = parsePositiveIntEnv(
  "SEC_EARNINGS_RETRY_TTL_MS",
  60 * 60 * 1000
);
const SEC_EARNINGS_SYNC_ENABLED = parseBooleanEnv(
  process.env.SEC_EARNINGS_SYNC_ENABLED,
  true
);
const SEC_EARNINGS_SYNC_INTERVAL_MS = parsePositiveIntEnv(
  "SEC_EARNINGS_SYNC_INTERVAL_MS",
  6 * 60 * 60 * 1000
);
const SEC_EARNINGS_SYNC_BATCH_SIZE = parsePositiveIntEnv(
  "SEC_EARNINGS_SYNC_BATCH_SIZE",
  25
);
const SEC_TICKERS_URL =
  trimToNull(process.env.SEC_TICKERS_URL) ??
  "https://www.sec.gov/files/company_tickers.json";
const SEC_DATA_BASE_URL =
  trimToNull(process.env.SEC_DATA_BASE_URL) ??
  "https://data.sec.gov";
const SEC_TICKER_MAP_TTL_MS = parsePositiveIntEnv(
  "SEC_TICKER_MAP_TTL_MS",
  24 * 60 * 60 * 1000
);
const SEC_EDGAR_USER_AGENT = trimToNull(process.env.SEC_EDGAR_USER_AGENT);
const SEC_REQUEST_TIMEOUT_MS = parsePositiveIntEnv(
  "SEC_REQUEST_TIMEOUT_MS",
  12_000
);
const SEC_REQUEST_SPACING_MS = parsePositiveIntEnv(
  "SEC_REQUEST_SPACING_MS",
  160
);

const EPS_TAG_PREFERENCES = [
  "EarningsPerShareDiluted",
  "EarningsPerShareBasicAndDiluted",
  "IncomeLossFromContinuingOperationsPerDilutedShare",
  "EarningsPerShareBasic",
];

type TickerMapCache = {
  loadedAtMs: number;
  map: Map<string, string>;
};

let pool: Pool | null = null;
let setupPromise: Promise<void> | null = null;
let setupFailed = false;
let setupFailureReason = "";
let tickerMapCache: TickerMapCache | null = null;
let warnedMissingConfig = false;
let lastSecRequestAtMs = 0;
let syncLoopStarted = false;

export async function getSecEarningsEventsForWindow(input: {
  symbol: string;
  startDate: string;
  endDate: string;
}): Promise<EarningsEvent[] | null> {
  const symbol = normalizeTicker(input.symbol);
  if (!symbol || symbol.includes("/") || symbol.startsWith("^")) {
    return [];
  }

  if (!isSecSyncConfigured()) {
    return null;
  }

  const cachePool = await getReadyPool();
  if (!cachePool) {
    return null;
  }

  let row = await readRow(cachePool, symbol);
  const isStale = !row || row.expiresAtMs <= Date.now();

  if (isStale) {
    const refreshed = await refreshSymbol(cachePool, symbol, row?.events ?? []);
    if (refreshed) {
      row = await readRow(cachePool, symbol);
    }
  }

  const events = row?.events ?? [];
  return events.filter(
    (event) =>
      event.date >= input.startDate &&
      event.date <= input.endDate
  );
}

export function startSecEarningsSyncLoop(): void {
  if (syncLoopStarted) return;
  syncLoopStarted = true;

  if (!SEC_EARNINGS_SYNC_ENABLED) {
    console.log("[sec-earnings] sync loop disabled (SEC_EARNINGS_SYNC_ENABLED=false)");
    return;
  }

  if (!isSecSyncConfigured()) {
    return;
  }

  const tick = async () => {
    try {
      const summary = await refreshStaleSecEarningsSymbols(SEC_EARNINGS_SYNC_BATCH_SIZE);
      if (!summary) return;
      if (summary.considered > 0) {
        console.log(
          `[sec-earnings] stale refresh: considered=${summary.considered} refreshed=${summary.refreshed} failed=${summary.failed}`
        );
      }
    } catch (err) {
      warnSecIssue("stale refresh tick failed", err);
    }
  };

  void tick();

  const timer = setInterval(() => {
    void tick();
  }, SEC_EARNINGS_SYNC_INTERVAL_MS);
  timer.unref?.();
}

export async function refreshStaleSecEarningsSymbols(
  limit: number
): Promise<{ considered: number; refreshed: number; failed: number } | null> {
  if (!isSecSyncConfigured()) {
    return null;
  }

  const cachePool = await getReadyPool();
  if (!cachePool) {
    return null;
  }

  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await cachePool.query(
    `
      select symbol, events
      from ${SEC_EARNINGS_TABLE_NAME}
      where expires_at <= now()
      order by expires_at asc
      limit $1
    `,
    [safeLimit]
  );

  const rows = result.rows as Array<{ symbol?: unknown; events?: unknown }>;
  let refreshed = 0;
  let failed = 0;

  for (const row of rows) {
    if (typeof row.symbol !== "string") continue;
    const previousEvents = parseStoredEvents(row.events) ?? [];
    const ok = await refreshSymbol(cachePool, row.symbol, previousEvents);
    if (ok) refreshed += 1;
    else failed += 1;
  }

  return { considered: rows.length, refreshed, failed };
}

async function refreshSymbol(
  cachePool: Pool,
  symbol: string,
  previousEvents: EarningsEvent[]
): Promise<boolean> {
  try {
    const fresh = await fetchSecEarningsHistory(symbol);
    if (!fresh) {
      await persistRefreshFailure(cachePool, symbol, previousEvents, "No SEC CIK or facts available");
      return false;
    }

    const expiresAt = new Date(Date.now() + SEC_EARNINGS_TTL_MS).toISOString();
    await cachePool.query(
      `
        insert into ${SEC_EARNINGS_TABLE_NAME} (
          symbol,
          cik,
          events,
          fetched_at,
          expires_at,
          last_error
        )
        values ($1, $2, $3::jsonb, now(), $4, null)
        on conflict (symbol)
        do update set
          cik = excluded.cik,
          events = excluded.events,
          fetched_at = now(),
          expires_at = excluded.expires_at,
          last_error = null
      `,
      [symbol, fresh.cik, JSON.stringify(fresh.events), expiresAt]
    );
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await persistRefreshFailure(cachePool, symbol, previousEvents, detail);
    return false;
  }
}

async function persistRefreshFailure(
  cachePool: Pool,
  symbol: string,
  previousEvents: EarningsEvent[],
  errorMessage: string
): Promise<void> {
  const expiresAt = new Date(Date.now() + SEC_EARNINGS_RETRY_TTL_MS).toISOString();
  await cachePool.query(
    `
      insert into ${SEC_EARNINGS_TABLE_NAME} (
        symbol,
        cik,
        events,
        fetched_at,
        expires_at,
        last_error
      )
      values ($1, null, $2::jsonb, now(), $3, $4)
      on conflict (symbol)
      do update set
        fetched_at = now(),
        expires_at = excluded.expires_at,
        last_error = excluded.last_error
    `,
    [symbol, JSON.stringify(previousEvents), expiresAt, truncateError(errorMessage)]
  );
}

async function readRow(
  cachePool: Pool,
  symbol: string
): Promise<{ events: EarningsEvent[]; expiresAtMs: number } | null> {
  try {
    const result = await cachePool.query(
      `
        select events, expires_at
        from ${SEC_EARNINGS_TABLE_NAME}
        where symbol = $1
        limit 1
      `,
      [symbol]
    );
    if (result.rowCount === 0) return null;

    const row = result.rows[0] as { events?: unknown; expires_at?: unknown };
    const events = parseStoredEvents(row.events);
    if (!events) return null;

    const expiresAtRaw =
      row.expires_at instanceof Date
        ? row.expires_at.getTime()
        : Date.parse(String(row.expires_at ?? ""));
    const expiresAtMs = Number.isFinite(expiresAtRaw) ? expiresAtRaw : 0;

    return { events, expiresAtMs };
  } catch (err) {
    warnSecIssue("cache read failed", err);
    return null;
  }
}

async function fetchSecEarningsHistory(symbol: string): Promise<{
  cik: string;
  events: EarningsEvent[];
} | null> {
  const cik = await resolveCik(symbol);
  if (!cik) return null;

  await enforceSecRequestSpacing();
  const response = await fetchWithTimeout(
    `${SEC_DATA_BASE_URL}/api/xbrl/companyfacts/CIK${cik}.json`,
    {
      headers: secHeaders(),
    },
    SEC_REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    const detail = await readErrorText(response);
    throw new Error(
      `companyfacts ${response.status}${detail ? `: ${detail}` : ""}`
    );
  }

  const payload = (await response.json()) as SecCompanyFactsResponse;
  const events = normalizeCompanyFactsToEvents(payload);
  return { cik, events };
}

function normalizeCompanyFactsToEvents(payload: SecCompanyFactsResponse): EarningsEvent[] {
  const gaapFacts = payload?.facts?.["us-gaap"];
  if (!gaapFacts || typeof gaapFacts !== "object") {
    return [];
  }

  const tagPriority = new Map<string, number>();
  EPS_TAG_PREFERENCES.forEach((tag, idx) => tagPriority.set(tag, idx));

  const candidates: CandidateEarningsEvent[] = [];

  for (const tag of EPS_TAG_PREFERENCES) {
    const concept = gaapFacts[tag];
    if (!concept || typeof concept !== "object") continue;
    const units = concept.units as Record<string, unknown> | undefined;
    if (!units || typeof units !== "object") continue;

    for (const rows of Object.values(units)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const candidate = toCandidateEvent(
          row as SecEpsFactRow,
          tagPriority.get(tag) ?? 999
        );
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }
  }

  if (candidates.length === 0) {
    return [];
  }

  const byEventDate = new Map<string, CandidateEarningsEvent>();
  for (const candidate of candidates) {
    const existing = byEventDate.get(candidate.date);
    if (!existing || candidate.score > existing.score) {
      byEventDate.set(candidate.date, candidate);
    }
  }

  return Array.from(byEventDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((event) => ({
      date: event.date,
      fiscalDateEnding: event.fiscalDateEnding,
      reportedEps: event.reportedEps,
      estimatedEps: null,
      surprise: null,
      surprisePercentage: null,
    }));
}

function toCandidateEvent(
  row: SecEpsFactRow,
  tagPriority: number
): CandidateEarningsEvent | null {
  if (!row || typeof row !== "object") return null;

  const form = trimToNull(row.form)?.toUpperCase();
  if (!form || !ALLOWED_EARNINGS_FORMS.has(form)) {
    return null;
  }

  const filedDate = normalizeIsoDay(trimToNull(row.filed));
  if (!filedDate) return null;

  const fiscalDateEnding = normalizeIsoDay(trimToNull(row.end));
  if (!fiscalDateEnding) return null;

  const reportedEps = numberOrNull(row.val);
  if (reportedEps == null) return null;

  const durationDays = computeDurationDays(
    normalizeIsoDay(trimToNull(row.start)),
    fiscalDateEnding
  );
  if (!isLikelyPointEpsForForm(form, durationDays)) {
    return null;
  }

  const isAmendment = form.endsWith("/A");
  const score = scoreCandidate({
    form,
    tagPriority,
    durationDays,
    isAmendment,
  });

  return {
    date: filedDate,
    fiscalDateEnding,
    reportedEps,
    score,
  };
}

function isLikelyPointEpsForForm(
  form: string,
  durationDays: number | null
): boolean {
  if (form.startsWith("10-Q")) {
    return durationDays == null ? true : durationDays >= 60 && durationDays <= 120;
  }
  if (form.startsWith("10-K") || form.startsWith("20-F") || form.startsWith("40-F")) {
    return durationDays == null ? true : durationDays >= 300 && durationDays <= 430;
  }
  return true;
}

function scoreCandidate(input: {
  form: string;
  tagPriority: number;
  durationDays: number | null;
  isAmendment: boolean;
}): number {
  let score = 0;

  score += (50 - Math.min(49, input.tagPriority * 8));
  if (!input.isAmendment) score += 25;

  if (input.durationDays != null) {
    if (input.form.startsWith("10-Q")) {
      score += 20 - Math.min(20, Math.abs(input.durationDays - 91));
    } else if (input.form.startsWith("10-K")) {
      score += 20 - Math.min(20, Math.abs(input.durationDays - 365) / 2);
    }
  }

  return score;
}

async function resolveCik(symbol: string): Promise<string | null> {
  const map = await loadTickerMap();
  if (!map) return null;

  const raw = normalizeTicker(symbol);
  const variants = [
    raw,
    raw.replace(/\./g, "-"),
    raw.replace(/\//g, "-"),
    raw.replace(/-/g, ""),
    raw.replace(/\./g, ""),
  ];

  for (const variant of variants) {
    const cik = map.get(variant);
    if (cik) return cik;
  }

  return null;
}

async function loadTickerMap(): Promise<Map<string, string> | null> {
  if (!SEC_EDGAR_USER_AGENT) return null;
  const nowMs = Date.now();
  if (
    tickerMapCache &&
    nowMs - tickerMapCache.loadedAtMs < SEC_TICKER_MAP_TTL_MS
  ) {
    return tickerMapCache.map;
  }

  await enforceSecRequestSpacing();
  const response = await fetchWithTimeout(
    SEC_TICKERS_URL,
    { headers: secHeaders() },
    SEC_REQUEST_TIMEOUT_MS
  );
  if (!response.ok) {
    const detail = await readErrorText(response);
    throw new Error(
      `ticker map ${response.status}${detail ? `: ${detail}` : ""}`
    );
  }

  const payload = (await response.json()) as SecTickerMapPayload;
  const map = new Map<string, string>();

  for (const value of Object.values(payload ?? {})) {
    if (!value || typeof value !== "object") continue;
    const ticker = normalizeTicker(String((value as Record<string, unknown>).ticker ?? ""));
    const cikRaw = Number((value as Record<string, unknown>).cik_str);
    if (!ticker || !Number.isFinite(cikRaw) || cikRaw <= 0) continue;
    map.set(ticker, String(Math.trunc(cikRaw)).padStart(10, "0"));
  }

  tickerMapCache = { loadedAtMs: nowMs, map };
  return map;
}

async function enforceSecRequestSpacing(): Promise<void> {
  const elapsed = Date.now() - lastSecRequestAtMs;
  const waitMs = SEC_REQUEST_SPACING_MS - elapsed;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastSecRequestAtMs = Date.now();
}

function secHeaders(): HeadersInit {
  return {
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
    "User-Agent": SEC_EDGAR_USER_AGENT as string,
  };
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function getReadyPool(): Promise<Pool | null> {
  if (!SEC_EARNINGS_DATABASE_URL) {
    return null;
  }

  if (!pool) {
    pool = new Pool({ connectionString: SEC_EARNINGS_DATABASE_URL });
    pool.on("error", (err) => {
      warnSecIssue("postgres pool error", err);
    });
  }

  if (setupFailed) {
    return null;
  }

  if (!setupPromise) {
    setupPromise = setupSecEarningsTable(pool).catch((err) => {
      setupFailed = true;
      setupFailureReason = err instanceof Error ? err.message : String(err);
      warnSecIssue("cache setup failed", err);
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

async function setupSecEarningsTable(cachePool: Pool): Promise<void> {
  await cachePool.query(`
    create table if not exists ${SEC_EARNINGS_TABLE_NAME} (
      symbol text not null,
      cik text null,
      events jsonb not null,
      fetched_at timestamptz not null,
      expires_at timestamptz not null,
      last_error text null,
      primary key (symbol)
    );
  `);

  await cachePool.query(
    `create index if not exists idx_${SEC_EARNINGS_TABLE_NAME}_expires_at on ${SEC_EARNINGS_TABLE_NAME}(expires_at);`
  );
}

function parseStoredEvents(value: unknown): EarningsEvent[] | null {
  const parsed =
    typeof value === "string"
      ? safeJsonParse(value)
      : value;

  if (!Array.isArray(parsed)) {
    return null;
  }

  const events = parsed.filter(isStoredEvent) as EarningsEvent[];
  if (events.length !== parsed.length) {
    return null;
  }

  return events;
}

function isStoredEvent(value: unknown): value is EarningsEvent {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.date === "string" &&
    (row.fiscalDateEnding === null || typeof row.fiscalDateEnding === "string") &&
    (row.reportedEps === null || Number.isFinite(Number(row.reportedEps))) &&
    (row.estimatedEps === null || Number.isFinite(Number(row.estimatedEps))) &&
    (row.surprise === null || Number.isFinite(Number(row.surprise))) &&
    (row.surprisePercentage === null || Number.isFinite(Number(row.surprisePercentage)))
  );
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readErrorText(response: Response): Promise<string> {
  try {
    const raw = (await response.text()).trim();
    if (!raw) return "";
    return raw.length > 260 ? `${raw.slice(0, 260)}...` : raw;
  } catch {
    return "";
  }
}

function computeDurationDays(
  startDay: string | null,
  endDay: string | null
): number | null {
  if (!startDay || !endDay) return null;
  const startTs = Date.parse(`${startDay}T00:00:00Z`);
  const endTs = Date.parse(`${endDay}T00:00:00Z`);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs < startTs) {
    return null;
  }
  return Math.floor((endTs - startTs) / 86_400_000) + 1;
}

function normalizeIsoDay(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ts = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  return trimmed;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTicker(value: string): string {
  return value.trim().toUpperCase();
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = trimToNull(process.env[name]);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseBooleanEnv(
  raw: string | undefined,
  fallback: boolean
): boolean {
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function sanitizeSqlIdentifier(identifier: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)
    ? identifier
    : "backtest_sec_earnings_cache";
}

function truncateError(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "unknown";
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
}

function isSecSyncConfigured(): boolean {
  if (SEC_EDGAR_USER_AGENT && SEC_EARNINGS_DATABASE_URL) {
    return true;
  }
  if (!warnedMissingConfig) {
    warnedMissingConfig = true;
    const reasons: string[] = [];
    if (!SEC_EDGAR_USER_AGENT) reasons.push("SEC_EDGAR_USER_AGENT");
    if (!SEC_EARNINGS_DATABASE_URL) reasons.push("SEC_EARNINGS_DATABASE_URL");
    console.warn(
      `[sec-earnings] disabled until configured (${reasons.join(", ")} missing)`
    );
  }
  return false;
}

function warnSecIssue(message: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  if (setupFailureReason) {
    console.warn(
      `[sec-earnings] ${message}: ${detail}. setup_failure=${setupFailureReason}`
    );
    return;
  }
  console.warn(`[sec-earnings] ${message}: ${detail}`);
}

const ALLOWED_EARNINGS_FORMS = new Set([
  "10-Q",
  "10-Q/A",
  "10-K",
  "10-K/A",
  "20-F",
  "20-F/A",
  "40-F",
  "40-F/A",
]);

interface SecTickerMapPayload {
  [index: string]: {
    cik_str?: number | string;
    ticker?: string;
    title?: string;
  };
}

interface SecCompanyFactsResponse {
  cik?: number;
  entityName?: string;
  facts?: {
    "us-gaap"?: Record<string, { units?: Record<string, unknown> }>;
  };
}

interface SecEpsFactRow {
  start?: string;
  end?: string;
  val?: number | string;
  form?: string;
  filed?: string;
}

interface CandidateEarningsEvent {
  date: string;
  fiscalDateEnding: string | null;
  reportedEps: number;
  score: number;
}
