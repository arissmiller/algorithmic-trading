const RAW_API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");

const BLOCKED_MARKET_DATA_HOST_SUFFIXES = [
  "alpaca.markets",
  "polygon.io",
  "finnhub.io",
  "yahoo.com",
  "yahooapis.com",
  "twelvedata.com",
  "alphavantage.co",
  "iexcloud.io",
  "tiingo.com",
  "stooq.com",
];

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  assertApiRequestAllowed(input);
  return fetch(input, init);
}

function assertApiRequestAllowed(input: string): void {
  const resolvedUrl = resolveRequestUrl(input);
  if (!isAllowedApiPath(resolvedUrl.pathname)) {
    throw new Error(
      `Blocked non-API frontend request: ${resolvedUrl.toString()}. ` +
        "Frontend market data calls must go through /api/* backend routes."
    );
  }

  if (!isAllowedApiOrigin(resolvedUrl.origin)) {
    throw new Error(
      `Blocked cross-origin API request: ${resolvedUrl.toString()}. ` +
        "Frontend API calls must target the configured backend origin."
    );
  }

  const hostname = resolvedUrl.hostname.toLowerCase();
  for (const blockedSuffix of BLOCKED_MARKET_DATA_HOST_SUFFIXES) {
    if (hostname === blockedSuffix || hostname.endsWith(`.${blockedSuffix}`)) {
      throw new Error(
        `Blocked direct market-data vendor request from frontend: ${resolvedUrl.toString()}`
      );
    }
  }
}

function resolveRequestUrl(input: string): URL {
  try {
    return new URL(input);
  } catch {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "http://localhost";
    return new URL(input, origin);
  }
}

function isAllowedApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isAllowedApiOrigin(origin: string): boolean {
  const allowedOrigins = new Set<string>();
  if (typeof window !== "undefined" && window.location?.origin) {
    allowedOrigins.add(window.location.origin);
  }
  if (RAW_API_BASE_URL) {
    try {
      allowedOrigins.add(new URL(RAW_API_BASE_URL).origin);
    } catch {
      // Invalid env value should not explode module init. Guard below will fail requests anyway.
    }
  }

  // In non-browser build/runtime contexts, allow current request origin by default.
  if (allowedOrigins.size === 0) {
    return true;
  }

  return allowedOrigins.has(origin);
}
