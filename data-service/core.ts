import { getCachedBars, upsertCachedBars } from "./barCache";
import {
  getStoredCryptoBacktestBars,
  upsertStoredCryptoBacktestBars,
} from "./cryptoBacktestStore.ts";
import {
  getSecEarningsEventsForWindow,
} from "./secEarningsStore.ts";
import type { EarningsEvent } from "./earningsTypes.ts";

const RANGE_MAP: Record<string, string> = {
  "1y": "1y",
  "2y": "2y",
  "5y": "5y",
  max: "max",
};
const INTRADAY_DAY_CACHE_PREFIX = "day:";
const DAY_MS = 86_400_000;
const ALPACA_DATA_BASE_URL =
  process.env.ALPACA_DATA_BASE_URL ?? "https://data.alpaca.markets/v2";
const ALPACA_CRYPTO_DATA_BASE_URL = normalizeBaseUrl(
  process.env.ALPACA_CRYPTO_DATA_BASE_URL ??
    "https://data.alpaca.markets/v1beta3/crypto/us"
);
const ALPACA_TRADING_BASE_URL = normalizeAlpacaTradingBaseUrl(
  process.env.ALPACA_TRADING_BASE_URL ??
    process.env.APCA_API_BASE_URL ??
    "https://paper-api.alpaca.markets/v2"
);
const ALPACA_API_KEY_ID = (
  process.env.APCA_API_KEY_ID ?? process.env.ALPACA_API_KEY_ID ?? ""
).trim();
const ALPACA_API_SECRET_KEY = (
  process.env.APCA_API_SECRET_KEY ?? process.env.ALPACA_API_SECRET_KEY ?? ""
).trim();
const ALPACA_FEED = (process.env.ALPACA_FEED ?? "iex").trim() || "iex";
const ALPACA_REQUEST_TIMEOUT_MS = Number(
  process.env.ALPACA_REQUEST_TIMEOUT_MS ?? 10_000
);
const ALPHA_VANTAGE_EARNINGS_URL =
  process.env.ALPHA_VANTAGE_EARNINGS_URL?.trim() ||
  "https://www.alphavantage.co/query";
const ALPHA_VANTAGE_API_KEY = (process.env.ALPHA_VANTAGE_API_KEY ?? "").trim();
const EARNINGS_CACHE_TTL_MS = normalizePositiveInt(
  process.env.EARNINGS_CACHE_TTL_MS,
  6 * 60 * 60 * 1000
);
const earningsEventsCache = new Map<string, CachedEarningsEvents>();

export class ApiHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type MarketTimeframe = "1Day" | "1Hour" | "15Min" | "5Min";

export async function fetchMarketBars(input: {
  symbol: string;
  range: string | null;
  timeframe?: MarketTimeframe;
  startDate?: string | null;
  endDate?: string | null;
  preferStoredHourlyCryptoBars?: boolean;
}): Promise<{ symbol: string; bars: ApiBar[]; earningsEvents: EarningsEvent[] }> {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) {
    throw new ApiHttpError(400, "Missing symbol");
  }

  const timeframe = input.timeframe ?? "1Day";
  const cacheSymbol = isCryptoSymbol(symbol) ? normalizeCryptoSymbol(symbol) : symbol;

  // Prefer locally stored hourly crypto bars for backtests to avoid Alpaca rate-limit churn.
  const preferStoredHourlyCryptoBars = input.preferStoredHourlyCryptoBars !== false;
  if (preferStoredHourlyCryptoBars && timeframe === "1Hour" && isCryptoSymbol(symbol)) {
    const stored = await getStoredCryptoBacktestBars({
      symbol: cacheSymbol,
      range: input.range ?? "2y",
      timeframe,
    });
    if (stored) {
      return {
        symbol: stored.symbol,
        bars: stored.bars.map((bar) => ({
          t: bar.t,
          o: bar.o,
          h: bar.h,
          l: bar.l,
          c: bar.c,
          v: bar.v,
        })),
        earningsEvents: [],
      };
    }
  }

  if (timeframe === "15Min" || timeframe === "5Min") {
    const dayWindow = normalizeDayWindow(input.startDate, input.endDate, timeframe);
    const dayKeys = enumerateDayKeys(dayWindow.startDate, dayWindow.endDate);
    if (dayKeys.length === 0) {
      throw new ApiHttpError(400, `No days selected for ${timeframe} request`);
    }

    if (!hasAlpacaCredentials()) {
      throw new ApiHttpError(
        400,
        "Missing Alpaca API credentials. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY."
      );
    }

    const allBars: ApiBar[] = [];
    let responseSymbol = cacheSymbol;

    for (const dayKey of dayKeys) {
      const dayCacheRange = `${INTRADAY_DAY_CACHE_PREFIX}${dayKey}`;
      const cachedDay = await getCachedBars({
        symbol: cacheSymbol,
        range: dayCacheRange,
        timeframe,
      });
      if (cachedDay) {
        allBars.push(...cachedDay.bars);
        continue;
      }

      const dayWindowUtc = dayKeyToUtcWindow(dayKey);
      const freshDay = isCryptoSymbol(symbol)
        ? await fetchCryptoFromAlpaca(symbol, "2y", timeframe, {
            window: dayWindowUtc,
            allowEmpty: true,
          })
        : await fetchFromAlpaca(symbol, "2y", timeframe, {
            window: dayWindowUtc,
            allowEmpty: true,
          });
      responseSymbol = freshDay.symbol;

      await upsertCachedBars({
        symbol: cacheSymbol,
        range: dayCacheRange,
        timeframe,
        bars: freshDay.bars,
      });

      allBars.push(...freshDay.bars);
    }

    const dedupedBars = dedupeAndSortBars(allBars);
    if (dedupedBars.length === 0) {
      throw new ApiHttpError(404, "No data returned");
    }

    const earningsEvents = await loadEarningsEventsForBars(symbol, dedupedBars);
    return { symbol: responseSymbol, bars: dedupedBars, earningsEvents };
  }

  const range = RANGE_MAP[input.range ?? "2y"] ?? "2y";

  const cached = await getCachedBars({
    symbol: cacheSymbol,
    range,
    timeframe,
  });
  if (cached) {
    const earningsEvents = await loadEarningsEventsForBars(symbol, cached.bars);
    return {
      symbol: cached.symbol,
      bars: cached.bars,
      earningsEvents,
    };
  }

  if (!hasAlpacaCredentials()) {
    throw new ApiHttpError(
      400,
      "Missing Alpaca API credentials. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY."
    );
  }

  const fresh = isCryptoSymbol(symbol)
    ? await fetchCryptoFromAlpaca(symbol, range, timeframe)
    : await fetchFromAlpaca(symbol, range, timeframe);

  await upsertCachedBars({
    symbol: fresh.symbol,
    range,
    timeframe,
    bars: fresh.bars,
  });

  if (timeframe === "1Hour" && isCryptoSymbol(symbol)) {
    await upsertStoredCryptoBacktestBars({
      symbol: fresh.symbol,
      source: "alpaca",
      bars: fresh.bars.map((bar) => ({
        t: bar.t,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        v: bar.v,
      })),
    });
  }

  const earningsEvents = await loadEarningsEventsForBars(symbol, fresh.bars);
  return { ...fresh, earningsEvents };
}

export async function fetchAlpacaAccountSnapshot(
  credentials?: { keyId: string; secretKey: string; paper: boolean }
): Promise<AlpacaAccountSnapshot> {
  const keyId = credentials?.keyId ?? ALPACA_API_KEY_ID;
  const secretKey = credentials?.secretKey ?? ALPACA_API_SECRET_KEY;
  const tradingBaseUrl = credentials
    ? normalizeAlpacaTradingBaseUrl(
        credentials.paper
          ? "https://paper-api.alpaca.markets/v2"
          : "https://api.alpaca.markets/v2"
      )
    : ALPACA_TRADING_BASE_URL;

  if (!keyId || !secretKey) {
    throw new ApiHttpError(
      400,
      "Missing Alpaca API credentials. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY."
    );
  }

  const [accountResponse, positionsResponse] = await Promise.all([
    fetchWithTimeout(
      `${tradingBaseUrl}/account`,
      {
        headers: {
          Accept: "application/json",
          "APCA-API-KEY-ID": keyId,
          "APCA-API-SECRET-KEY": secretKey,
        },
      },
      ALPACA_REQUEST_TIMEOUT_MS
    ),
    fetchWithTimeout(
      `${tradingBaseUrl}/positions`,
      {
        headers: {
          Accept: "application/json",
          "APCA-API-KEY-ID": keyId,
          "APCA-API-SECRET-KEY": secretKey,
        },
      },
      ALPACA_REQUEST_TIMEOUT_MS
    ),
  ]);

  if (!accountResponse.ok) {
    await throwAlpacaTradingError(accountResponse, "account");
  }
  if (!positionsResponse.ok) {
    await throwAlpacaTradingError(positionsResponse, "positions");
  }

  const accountPayload = (await accountResponse.json()) as AlpacaAccountResponse;
  const positionsPayload = (await positionsResponse.json()) as AlpacaPositionResponse[];
  const positions = Array.isArray(positionsPayload) ? positionsPayload : [];

  return {
    account: {
      status: typeof accountPayload.status === "string" ? accountPayload.status : "unknown",
      equity: numberOrZero(accountPayload.equity),
      cash: numberOrZero(accountPayload.cash),
      buyingPower: numberOrZero(accountPayload.buying_power),
      portfolioValue: numberOrZero(accountPayload.portfolio_value),
      longMarketValue: numberOrZero(accountPayload.long_market_value),
      shortMarketValue: numberOrZero(accountPayload.short_market_value),
    },
    positions: positions
      .map((position) => {
        const side: "short" | "long" = position.side === "short" ? "short" : "long";
        return {
          symbol: typeof position.symbol === "string" ? position.symbol : "",
          qty: numberOrZero(position.qty),
          side,
          avgEntryPrice: numberOrZero(position.avg_entry_price),
          currentPrice: numberOrNull(position.current_price),
          marketValue: numberOrZero(position.market_value),
          costBasis: numberOrZero(position.cost_basis),
          unrealizedPl: numberOrZero(position.unrealized_pl),
          unrealizedPlpc: numberOrNull(position.unrealized_plpc),
          changeToday: numberOrNull(position.change_today),
        };
      })
      .filter((position) => position.symbol.length > 0)
      .sort((a, b) => b.marketValue - a.marketValue),
    updatedAt: new Date().toISOString(),
  };
}

async function fetchFromAlpaca(
  symbol: string,
  range: string,
  timeframe: MarketTimeframe = "1Day",
  options?: {
    window?: { start: string; end: string };
    allowEmpty?: boolean;
  }
): Promise<{ symbol: string; bars: ApiBar[] }> {
  const requestSymbol = resolveAlpacaSymbol(symbol);
  const window = options?.window ?? getTimeWindow(range, timeframe);
  let pageToken: string | null = null;
  const allBars: AlpacaBar[] = [];

  do {
    const params = new URLSearchParams({
      timeframe,
      start: window.start,
      end: window.end,
      adjustment: "all",
      feed: ALPACA_FEED,
      sort: "asc",
      limit: "10000",
    });
    if (pageToken) {
      params.set("page_token", pageToken);
    }

    const url =
      `${ALPACA_DATA_BASE_URL}/stocks/${encodeURIComponent(requestSymbol)}/bars` +
      `?${params.toString()}`;
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: "application/json",
          "APCA-API-KEY-ID": ALPACA_API_KEY_ID,
          "APCA-API-SECRET-KEY": ALPACA_API_SECRET_KEY,
        },
      },
      ALPACA_REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      const details = await readErrorText(response);
      if (response.status === 401 || response.status === 403) {
        throw new ApiHttpError(
          502,
          `Alpaca authentication failed. Check APCA keys. ${details}`.trim()
        );
      }
      if (response.status === 404 || response.status === 422) {
        throw new ApiHttpError(404, `Symbol not found: ${symbol}`);
      }
      if (response.status === 429) {
        throw new ApiHttpError(502, "Alpaca rate limit reached");
      }
      throw new ApiHttpError(
        502,
        `Alpaca returned ${response.status}${details ? `: ${details}` : ""}`
      );
    }

    const payload = (await response.json()) as AlpacaBarsResponse;
    if (Array.isArray(payload.bars)) {
      allBars.push(...payload.bars);
    }
    pageToken =
      typeof payload.next_page_token === "string"
        ? payload.next_page_token
        : null;
  } while (pageToken);

  const bars = allBars
    .map((bar) => ({
      t: new Date(bar.t).toISOString(),
      o: Number(bar.o),
      h: Number(bar.h),
      l: Number(bar.l),
      c: Number(bar.c),
      v: Number(bar.v),
    }))
    .filter((bar) => Number.isFinite(bar.o) && Number.isFinite(bar.c))
    .map((bar) => ({
      t: bar.t,
      o: round(bar.o),
      h: round(bar.h),
      l: round(bar.l),
      c: round(bar.c),
      v: Number.isFinite(bar.v) ? bar.v : null,
    }));

  if (bars.length === 0 && !options?.allowEmpty) {
    throw new ApiHttpError(404, "No data returned");
  }

  return { symbol, bars };
}

async function fetchCryptoFromAlpaca(
  symbol: string,
  range: string,
  timeframe: MarketTimeframe = "1Day",
  options?: {
    window?: { start: string; end: string };
    allowEmpty?: boolean;
  }
): Promise<{ symbol: string; bars: ApiBar[] }> {
  const requestSymbol = normalizeCryptoSymbol(symbol);
  const window = options?.window ?? getTimeWindow(range, timeframe);
  let pageToken: string | null = null;
  const allBars: AlpacaBar[] = [];

  do {
    const params = new URLSearchParams({
      timeframe,
      symbols: requestSymbol,
      start: window.start,
      end: window.end,
      sort: "asc",
      limit: "10000",
    });
    if (pageToken) {
      params.set("page_token", pageToken);
    }

    const url = `${ALPACA_CRYPTO_DATA_BASE_URL}/bars?${params.toString()}`;
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: "application/json",
          "APCA-API-KEY-ID": ALPACA_API_KEY_ID,
          "APCA-API-SECRET-KEY": ALPACA_API_SECRET_KEY,
        },
      },
      ALPACA_REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      const details = await readErrorText(response);
      if (response.status === 401 || response.status === 403) {
        throw new ApiHttpError(
          502,
          `Alpaca authentication failed. Check APCA keys. ${details}`.trim()
        );
      }
      if (response.status === 404 || response.status === 422) {
        throw new ApiHttpError(404, `Symbol not found: ${symbol}`);
      }
      if (response.status === 429) {
        throw new ApiHttpError(502, "Alpaca rate limit reached");
      }
      throw new ApiHttpError(
        502,
        `Alpaca returned ${response.status}${details ? `: ${details}` : ""}`
      );
    }

    const payload = (await response.json()) as AlpacaCryptoBarsResponse;
    allBars.push(...extractCryptoBars(payload.bars, requestSymbol));
    pageToken =
      typeof payload.next_page_token === "string"
        ? payload.next_page_token
        : null;
  } while (pageToken);

  const bars = allBars
    .map((bar) => ({
      t: new Date(bar.t).toISOString(),
      o: Number(bar.o),
      h: Number(bar.h),
      l: Number(bar.l),
      c: Number(bar.c),
      v: Number(bar.v),
    }))
    .filter((bar) => Number.isFinite(bar.o) && Number.isFinite(bar.c))
    .map((bar) => ({
      t: bar.t,
      o: round(bar.o),
      h: round(bar.h),
      l: round(bar.l),
      c: round(bar.c),
      v: Number.isFinite(bar.v) ? bar.v : null,
    }));

  if (bars.length === 0 && !options?.allowEmpty) {
    throw new ApiHttpError(404, "No data returned");
  }

  return { symbol: requestSymbol, bars };
}

function resolveAlpacaSymbol(symbol: string): string {
  // Alpaca stock bars do not provide index symbols directly.
  if (symbol === "^GSPC") {
    return "SPY";
  }
  return symbol;
}

function isCryptoSymbol(symbol: string): boolean {
  const upper = symbol.trim().toUpperCase();
  if (SUPPORTED_CRYPTO_BASES.has(upper)) {
    return true;
  }
  if (symbol.includes("/")) {
    return true;
  }
  return /[A-Z0-9]+(USD|USDT|USDC)$/.test(symbol);
}

function normalizeCryptoSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase().replace(/[-_]/g, "/");
  if (SUPPORTED_CRYPTO_BASES.has(upper)) {
    return `${upper}/USD`;
  }
  const [base, quote, ...rest] = upper.split("/");
  if (base && quote && rest.length === 0) {
    return `${base}/${quote}`;
  }

  const compact = upper.replace(/[^A-Z0-9]/g, "");
  const quoteCandidates = ["USDT", "USDC", "USD"];
  for (const quoteSuffix of quoteCandidates) {
    if (
      compact.endsWith(quoteSuffix) &&
      compact.length > quoteSuffix.length
    ) {
      return `${compact.slice(0, -quoteSuffix.length)}/${quoteSuffix}`;
    }
  }
  return upper;
}

const SUPPORTED_CRYPTO_BASES = new Set([
  "AAVE",
  "ALGO",
  "AVAX",
  "BAT",
  "BCH",
  "BTC",
  "CRV",
  "DOGE",
  "DOT",
  "ETH",
  "GRT",
  "LINK",
  "LTC",
  "MKR",
  "NEAR",
  "PAXG",
  "SHIB",
  "SOL",
  "SUSHI",
  "TRX",
  "UNI",
  "USDC",
  "USDT",
  "WBTC",
  "XTZ",
  "YFI",
]);

function extractCryptoBars(
  barsBySymbol: unknown,
  requestSymbol: string
): AlpacaBar[] {
  if (Array.isArray(barsBySymbol)) {
    return barsBySymbol as AlpacaBar[];
  }
  if (!barsBySymbol || typeof barsBySymbol !== "object") {
    return [];
  }

  const symbolMap = barsBySymbol as Record<string, unknown>;
  const direct = symbolMap[requestSymbol];
  if (Array.isArray(direct)) {
    return direct as AlpacaBar[];
  }

  const normalizedNoSlash = requestSymbol.replace("/", "");
  const alt = symbolMap[normalizedNoSlash];
  if (Array.isArray(alt)) {
    return alt as AlpacaBar[];
  }

  for (const value of Object.values(symbolMap)) {
    if (Array.isArray(value)) {
      return value as AlpacaBar[];
    }
  }
  return [];
}

function hasAlpacaCredentials(): boolean {
  return Boolean(ALPACA_API_KEY_ID && ALPACA_API_SECRET_KEY);
}

function normalizeAlpacaTradingBaseUrl(raw: string): string {
  const cleaned = raw.trim().replace(/\/+$/, "");
  if (!cleaned) {
    return "https://paper-api.alpaca.markets/v2";
  }
  if (cleaned.endsWith("/v2")) {
    return cleaned;
  }
  return `${cleaned}/v2`;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

async function readErrorText(response: Response): Promise<string> {
  try {
    const raw = (await response.text()).trim();
    if (!raw) {
      return "";
    }
    return raw.length > 220 ? `${raw.slice(0, 220)}...` : raw;
  } catch {
    return "";
  }
}

async function throwAlpacaTradingError(
  response: Response,
  target: "account" | "positions"
): Promise<never> {
  const details = await readErrorText(response);
  if (response.status === 401 || response.status === 403) {
    throw new ApiHttpError(
      502,
      `Alpaca authentication failed for ${target}. Check APCA keys. ${details}`.trim()
    );
  }
  if (response.status === 429) {
    throw new ApiHttpError(502, "Alpaca rate limit reached");
  }
  throw new ApiHttpError(
    502,
    `Alpaca ${target} returned ${response.status}${details ? `: ${details}` : ""}`
  );
}

async function loadEarningsEventsForBars(
  symbol: string,
  bars: ApiBar[]
): Promise<EarningsEvent[]> {
  if (
    bars.length === 0 ||
    isCryptoSymbol(symbol) ||
    symbol.startsWith("^")
  ) {
    return [];
  }

  const startDate = isoDayFromTimestamp(bars[0]?.t ?? "");
  const endDate = isoDayFromTimestamp(bars[bars.length - 1]?.t ?? "");
  if (!startDate || !endDate || endDate < startDate) {
    return [];
  }

  const persistedSecEvents = await getSecEarningsEventsForWindow({
    symbol,
    startDate,
    endDate,
  });
  if (persistedSecEvents !== null) {
    return persistedSecEvents;
  }

  if (!ALPHA_VANTAGE_API_KEY) {
    return [];
  }

  const allEvents = await fetchEarningsHistory(symbol);
  return allEvents.filter((event) => event.date >= startDate && event.date <= endDate);
}

async function fetchEarningsHistory(symbol: string): Promise<EarningsEvent[]> {
  const cacheKey = normalizeSymbol(symbol);
  const nowMs = Date.now();
  const cached = earningsEventsCache.get(cacheKey);
  if (cached && nowMs - cached.cachedAtMs < EARNINGS_CACHE_TTL_MS) {
    return cached.events;
  }

  const params = new URLSearchParams({
    function: "EARNINGS",
    symbol: cacheKey,
    apikey: ALPHA_VANTAGE_API_KEY,
  });
  const url = `${ALPHA_VANTAGE_EARNINGS_URL}?${params.toString()}`;

  try {
    const response = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 10_000);
    if (!response.ok) {
      earningsEventsCache.set(cacheKey, { cachedAtMs: nowMs, events: [] });
      return [];
    }

    const payload = (await response.json()) as AlphaVantageEarningsResponse;
    if (!payload || typeof payload !== "object") {
      earningsEventsCache.set(cacheKey, { cachedAtMs: nowMs, events: [] });
      return [];
    }

    const warning =
      trimToNull(payload.Note) ??
      trimToNull(payload.Information) ??
      trimToNull(payload["Error Message"]);
    if (warning) {
      earningsEventsCache.set(cacheKey, { cachedAtMs: nowMs, events: [] });
      return [];
    }

    const events = Array.isArray(payload.quarterlyEarnings)
      ? normalizeEarningsEvents(payload.quarterlyEarnings)
      : [];

    earningsEventsCache.set(cacheKey, { cachedAtMs: nowMs, events });
    return events;
  } catch {
    earningsEventsCache.set(cacheKey, { cachedAtMs: nowMs, events: [] });
    return [];
  }
}

function normalizeEarningsEvents(rows: AlphaVantageQuarterlyEarnings[]): EarningsEvent[] {
  const dedupedByDate = new Map<string, EarningsEvent>();

  for (const row of rows) {
    const date = normalizeIsoDay(trimToNull(row.reportedDate) ?? trimToNull(row.fiscalDateEnding));
    if (!date) continue;

    dedupedByDate.set(date, {
      date,
      fiscalDateEnding: normalizeIsoDay(trimToNull(row.fiscalDateEnding)),
      reportedEps: numberOrNull(row.reportedEPS),
      estimatedEps: numberOrNull(row.estimatedEPS),
      surprise: numberOrNull(row.surprise),
      surprisePercentage: numberOrNull(row.surprisePercentage),
    });
  }

  return Array.from(dedupedByDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function getTimeWindow(
  range: string,
  timeframe: MarketTimeframe = "1Day"
): { start: string; end: string } {
  const now = new Date();
  // Intraday bars are fetched with explicit day windows in fetchMarketBars().
  // Keep a small fallback here for non-windowed requests.
  const start =
    timeframe === "15Min" || timeframe === "5Min"
      ? new Date(now.getTime() - 45 * DAY_MS)
      : getCutoffDate(range) ?? new Date(Date.UTC(2000, 0, 1));
  return {
    start: start.toISOString(),
    end: now.toISOString(),
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiHttpError(502, `Upstream request failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }
}

function getCutoffDate(range: string): Date | null {
  if (range === "max") {
    return null;
  }
  const yearsBack = Number(range.replace("y", ""));
  if (!Number.isFinite(yearsBack) || yearsBack <= 0) {
    return null;
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - yearsBack, now.getUTCMonth(), now.getUTCDate()));
}

function normalizeDayWindow(
  startDateRaw: string | null | undefined,
  endDateRaw: string | null | undefined,
  timeframe: "15Min" | "5Min"
): { startDate: string; endDate: string } {
  const startDate = normalizeIsoDay(startDateRaw);
  const endDate = normalizeIsoDay(endDateRaw);

  if (!startDate || !endDate) {
    throw new ApiHttpError(
      400,
      `${timeframe} requests require startDate and endDate query params in YYYY-MM-DD format`
    );
  }

  if (endDate < startDate) {
    throw new ApiHttpError(400, "endDate must be on or after startDate");
  }

  const dayCount = enumerateDayKeys(startDate, endDate).length;
  if (dayCount > 120) {
    throw new ApiHttpError(
      400,
      `${timeframe} requests currently support up to 120 days per call`
    );
  }

  return { startDate, endDate };
}

function normalizeIsoDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ts = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  return trimmed;
}

function enumerateDayKeys(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  const endTs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs < startTs) {
    return out;
  }

  for (let ts = startTs; ts <= endTs; ts += DAY_MS) {
    out.push(new Date(ts).toISOString().slice(0, 10));
  }

  return out;
}

function dayKeyToUtcWindow(dayKey: string): { start: string; end: string } {
  const startTs = Date.parse(`${dayKey}T00:00:00Z`);
  const endTs = startTs + DAY_MS;
  return {
    start: new Date(startTs).toISOString(),
    end: new Date(endTs).toISOString(),
  };
}

function dedupeAndSortBars(bars: ApiBar[]): ApiBar[] {
  const byTime = new Map<string, ApiBar>();
  for (const bar of bars) {
    if (!bar || typeof bar.t !== "string") continue;
    byTime.set(bar.t, bar);
  }
  return Array.from(byTime.values()).sort((a, b) => a.t.localeCompare(b.t));
}

function isoDayFromTimestamp(value: string): string | null {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString().slice(0, 10);
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

function normalizePositiveInt(
  value: string | undefined,
  fallbackValue: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return Math.floor(parsed);
}

interface ApiBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[];
  next_page_token?: string | null;
}

interface CachedEarningsEvents {
  cachedAtMs: number;
  events: EarningsEvent[];
}

interface AlphaVantageEarningsResponse {
  quarterlyEarnings?: AlphaVantageQuarterlyEarnings[];
  annualEarnings?: unknown[];
  Note?: string;
  Information?: string;
  "Error Message"?: string;
}

interface AlphaVantageQuarterlyEarnings {
  fiscalDateEnding?: string;
  reportedDate?: string;
  reportedEPS?: string | number;
  estimatedEPS?: string | number;
  surprise?: string | number;
  surprisePercentage?: string | number;
}

interface AlpacaCryptoBarsResponse {
  bars?: Record<string, AlpacaBar[]> | AlpacaBar[];
  next_page_token?: string | null;
}

interface AlpacaAccountSnapshot {
  account: {
    status: string;
    equity: number;
    cash: number;
    buyingPower: number;
    portfolioValue: number;
    longMarketValue: number;
    shortMarketValue: number;
  };
  positions: Array<{
    symbol: string;
    qty: number;
    side: "long" | "short";
    avgEntryPrice: number;
    currentPrice: number | null;
    marketValue: number;
    costBasis: number;
    unrealizedPl: number;
    unrealizedPlpc: number | null;
    changeToday: number | null;
  }>;
  updatedAt: string;
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaAccountResponse {
  id?: string;
  account_number?: string;
  status?: string;
  equity?: string | number;
  cash?: string | number;
  buying_power?: string | number;
  portfolio_value?: string | number;
  long_market_value?: string | number;
  short_market_value?: string | number;
}

interface AlpacaPositionResponse {
  symbol?: string;
  qty?: string | number;
  side?: string;
  avg_entry_price?: string | number;
  current_price?: string | number;
  market_value?: string | number;
  cost_basis?: string | number;
  unrealized_pl?: string | number;
  unrealized_plpc?: string | number;
  change_today?: string | number;
}
