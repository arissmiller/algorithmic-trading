const RANGE_MAP: Record<string, string> = {
  "1y": "1y",
  "2y": "2y",
  "5y": "5y",
  max: "max",
};
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

export class ApiHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function fetchMarketBars(input: {
  symbol: string;
  range: string | null;
  timeframe?: "1Day" | "1Hour";
}): Promise<{ symbol: string; bars: ApiBar[] }> {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) {
    throw new ApiHttpError(400, "Missing symbol");
  }

  const timeframe = input.timeframe ?? "1Day";
  const range = RANGE_MAP[input.range ?? "2y"] ?? "2y";
  if (!hasAlpacaCredentials()) {
    throw new ApiHttpError(
      400,
      "Missing Alpaca API credentials. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY."
    );
  }

  if (isCryptoSymbol(symbol)) {
    return fetchCryptoFromAlpaca(symbol, range, timeframe);
  }

  return fetchFromAlpaca(symbol, range, timeframe);
}

export async function fetchAlpacaAccountSnapshot(): Promise<AlpacaAccountSnapshot> {
  if (!hasAlpacaCredentials()) {
    throw new ApiHttpError(
      400,
      "Missing Alpaca API credentials. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY."
    );
  }

  const [accountResponse, positionsResponse] = await Promise.all([
    fetchWithTimeout(
      `${ALPACA_TRADING_BASE_URL}/account`,
      {
        headers: {
          Accept: "application/json",
          "APCA-API-KEY-ID": ALPACA_API_KEY_ID,
          "APCA-API-SECRET-KEY": ALPACA_API_SECRET_KEY,
        },
      },
      ALPACA_REQUEST_TIMEOUT_MS
    ),
    fetchWithTimeout(
      `${ALPACA_TRADING_BASE_URL}/positions`,
      {
        headers: {
          Accept: "application/json",
          "APCA-API-KEY-ID": ALPACA_API_KEY_ID,
          "APCA-API-SECRET-KEY": ALPACA_API_SECRET_KEY,
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
  timeframe: "1Day" | "1Hour" = "1Day"
): Promise<{ symbol: string; bars: ApiBar[] }> {
  const requestSymbol = resolveAlpacaSymbol(symbol);
  const window = getTimeWindow(range, timeframe);
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

  if (bars.length === 0) {
    throw new ApiHttpError(404, "No data returned");
  }

  return { symbol, bars };
}

async function fetchCryptoFromAlpaca(
  symbol: string,
  range: string,
  timeframe: "1Day" | "1Hour" = "1Day"
): Promise<{ symbol: string; bars: ApiBar[] }> {
  const requestSymbol = normalizeCryptoSymbol(symbol);
  const window = getTimeWindow(range, timeframe);
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

  if (bars.length === 0) {
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
  if (symbol.includes("/")) {
    return true;
  }
  return /[A-Z0-9]+(USD|USDT|USDC)$/.test(symbol);
}

function normalizeCryptoSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase().replace(/[-_]/g, "/");
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

function getTimeWindow(range: string, timeframe: "1Day" | "1Hour" = "1Day"): { start: string; end: string } {
  const now = new Date();
  // For hourly bars, 30 days gives ~720 bars — plenty for all signal warmup periods.
  const start = timeframe === "1Hour"
    ? new Date(now.getTime() - 365 * 86_400_000)
    : (getCutoffDate(range) ?? new Date(Date.UTC(2000, 0, 1)));
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
