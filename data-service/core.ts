const RANGE_MAP: Record<string, string> = {
  "1y": "1y",
  "2y": "2y",
  "5y": "5y",
  max: "max",
};
const YAHOO_CHART_HOSTS = [
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
] as const;
const ALPACA_DATA_BASE_URL =
  process.env.ALPACA_DATA_BASE_URL ?? "https://data.alpaca.markets/v2";
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
const YAHOO_REQUEST_TIMEOUT_MS = Number(
  process.env.YAHOO_REQUEST_TIMEOUT_MS ?? 10_000
);
const TWELVEDATA_REQUEST_TIMEOUT_MS = Number(
  process.env.TWELVEDATA_REQUEST_TIMEOUT_MS ?? 10_000
);
const TWELVEDATA_API_KEY = (process.env.TWELVEDATA_API_KEY ?? "demo").trim();
const TWELVEDATA_BASE_URL =
  process.env.TWELVEDATA_BASE_URL ?? "https://api.twelvedata.com";

export class ApiHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function fetchYahooBars(input: {
  symbol: string;
  range: string | null;
}): Promise<{ symbol: string; bars: ApiBar[] }> {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) {
    throw new ApiHttpError(400, "Missing symbol");
  }

  const range = RANGE_MAP[input.range ?? "2y"] ?? "2y";

  if (hasAlpacaCredentials()) {
    try {
      return await fetchFromAlpaca(symbol, range);
    } catch (err) {
      if (!shouldFallbackFromAlpaca(err)) {
        throw err;
      }
    }
  }

  try {
    return await fetchFromYahoo(symbol, range);
  } catch (err) {
    if (!shouldFallbackToTwelveData(err)) {
      throw err;
    }

    return fetchFromTwelveData(symbol, range);
  }
}

async function fetchFromYahoo(
  symbol: string,
  range: string
): Promise<{ symbol: string; bars: ApiBar[] }> {
  let lastErr: unknown = null;
  for (const host of YAHOO_CHART_HOSTS) {
    const yfUrl =
      `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=1d&range=${range}&includeAdjustedClose=true`;

    try {
      const yfRes = await fetchWithTimeout(yfUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
        },
      }, YAHOO_REQUEST_TIMEOUT_MS);

      if (!yfRes.ok) {
        const msg = `Yahoo Finance returned ${yfRes.status}`;
        const err = new ApiHttpError(502, msg);
        (err as any).upstreamStatus = yfRes.status;
        throw err;
      }

      const json = (await yfRes.json()) as YFChartResponse;
      const result = json.chart?.result?.[0];
      if (!result) {
        const errMsg = json.chart?.error?.description ?? "No data returned";
        throw new ApiHttpError(404, errMsg);
      }

      const timestamps = result.timestamp ?? [];
      const quote = result.indicators.quote[0];
      const adjClose = result.indicators.adjclose?.[0]?.adjclose ?? [];

      const bars = timestamps
        .map((ts, i) => ({
          t: new Date(ts * 1000).toISOString(),
          o: quote.open[i],
          h: quote.high[i],
          l: quote.low[i],
          c: adjClose[i] ?? quote.close[i],
          v: quote.volume[i] ?? 0,
        }))
        .filter((bar) => bar.o != null && bar.c != null)
        .map((bar) => ({
          t: bar.t,
          o: round(bar.o!),
          h: round(bar.h!),
          l: round(bar.l!),
          c: round(bar.c!),
          v: bar.v,
        }));

      return { symbol, bars };
    } catch (err) {
      lastErr = err;
      if (!isRetryableYahooFailure(err)) {
        throw err;
      }
    }
  }

  if (lastErr instanceof ApiHttpError) {
    throw lastErr;
  }
  if (lastErr instanceof Error) {
    throw new ApiHttpError(502, `Yahoo Finance unavailable: ${lastErr.message}`);
  }
  throw new ApiHttpError(502, "Yahoo Finance unavailable");
}

async function fetchFromAlpaca(
  symbol: string,
  range: string
): Promise<{ symbol: string; bars: ApiBar[] }> {
  const requestSymbol = resolveAlpacaSymbol(symbol);
  const window = getTimeWindow(range);
  let pageToken: string | null = null;
  const allBars: AlpacaBar[] = [];

  do {
    const params = new URLSearchParams({
      timeframe: "1Day",
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

async function fetchFromTwelveData(
  symbol: string,
  range: string
): Promise<{ symbol: string; bars: ApiBar[] }> {
  const requestSymbol = resolveTwelveDataSymbol(symbol);
  const tdUrl =
    `${TWELVEDATA_BASE_URL}/time_series?symbol=${encodeURIComponent(requestSymbol)}` +
    `&interval=1day&outputsize=5000&apikey=${encodeURIComponent(TWELVEDATA_API_KEY)}`;

  const tdRes = await fetchWithTimeout(tdUrl, {
    headers: {
      Accept: "application/json",
    },
  }, TWELVEDATA_REQUEST_TIMEOUT_MS);

  if (!tdRes.ok) {
    throw new ApiHttpError(502, `Twelve Data returned ${tdRes.status}`);
  }

  const json = (await tdRes.json()) as TwelveDataTimeSeriesResponse;
  if (json.status === "error") {
    const msg = json.message ?? "Twelve Data error";
    // Map common auth/plan issues to upstream unavailable for callers.
    if (json.code === 401 || json.code === 403 || json.code === 429) {
      throw new ApiHttpError(502, `Twelve Data unavailable: ${msg}`);
    }
    throw new ApiHttpError(404, msg);
  }

  if (!Array.isArray(json.values) || json.values.length === 0) {
    throw new ApiHttpError(404, "No data returned");
  }

  const cutoff = getCutoffDate(range);
  const bars = json.values
    .map((row) => {
      const iso = new Date(`${row.datetime}T00:00:00Z`).toISOString();
      return {
        t: iso,
        o: Number(row.open),
        h: Number(row.high),
        l: Number(row.low),
        c: Number(row.close),
        v: Number(row.volume),
      };
    })
    .filter((bar) => Number.isFinite(bar.o) && Number.isFinite(bar.c))
    .filter((bar) => !cutoff || new Date(bar.t).getTime() >= cutoff.getTime())
    .sort((a, b) => a.t.localeCompare(b.t))
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

function resolveTwelveDataSymbol(symbol: string): string {
  // Twelve Data demo key commonly rejects ^GSPC. SPY is a practical proxy.
  if (symbol === "^GSPC") {
    return "SPY";
  }
  return symbol;
}

function resolveAlpacaSymbol(symbol: string): string {
  // Alpaca stock bars do not provide index symbols directly.
  if (symbol === "^GSPC") {
    return "SPY";
  }
  return symbol;
}

function hasAlpacaCredentials(): boolean {
  return Boolean(ALPACA_API_KEY_ID && ALPACA_API_SECRET_KEY);
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

function shouldFallbackFromAlpaca(err: unknown): boolean {
  if (!(err instanceof ApiHttpError)) {
    return true;
  }
  return err.status === 429 || err.status >= 500;
}

function getTimeWindow(range: string): { start: string; end: string } {
  const now = new Date();
  const start = getCutoffDate(range) ?? new Date(Date.UTC(2000, 0, 1));
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

function shouldFallbackToTwelveData(err: unknown): boolean {
  if (!(err instanceof ApiHttpError)) {
    return true;
  }
  return err.status >= 500 || err.status === 429;
}

function isRetryableYahooFailure(err: unknown): boolean {
  if (!(err instanceof ApiHttpError)) {
    return true;
  }
  const upstreamStatus = Number((err as any).upstreamStatus ?? 0);
  return [408, 425, 429, 500, 502, 503, 504].includes(upstreamStatus);
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

interface ApiBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

interface YFChartResponse {
  chart: {
    result?: Array<{
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose: (number | null)[] }>;
      };
    }>;
    error?: { description: string };
  };
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[];
  next_page_token?: string | null;
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface TwelveDataTimeSeriesResponse {
  code?: number;
  message?: string;
  status?: string;
  values?: Array<{
    datetime: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }>;
}
