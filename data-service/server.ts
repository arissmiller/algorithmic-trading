/**
 * Minimal Alpaca data proxy.
 * Runs alongside the Vite dev server. Vite proxies /api/* here.
 *
 * Provides market bars and read-only account snapshots from Alpaca.
 * Start: tsx watch server.ts
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ApiHttpError, fetchAlpacaAccountSnapshot, fetchMarketBars } from "./core";
import { startBot, stopBot, removeBot, getBotList, loadPersistedState, BotConfig } from "./bot";
import {
  getRecentWatchlistSignals,
  getPublicWatchlistUsers,
  getUserWatchlists,
  getWatchlistMonitorStatus,
  loadPersistedWatchlists,
  removeUserWatchlist,
  replaceAllUserWatchlists,
  runWatchlistScanNow,
  runWatchlistScanNowForUser,
  startWatchlistExecution,
  UserWatchlist,
  WatchlistSignalEvent,
  upsertUserWatchlist,
  UserWatchlistInput,
} from "./watchlistExecution";
import { UserApiConnectionStore, UserApiConnectionInput } from "./userApiConnections";

const PORT = Number(process.env.PORT ?? 3001);
const API_CONNECTION_STATE_FILE =
  process.env.API_CONNECTION_STATE_FILE ??
  new URL("./api-connections.json", import.meta.url).pathname;
const ALLOWED_ORIGINS = parseCsvEnv("ALLOWED_ORIGINS");
const FRONTEND_SHARED_SECRET = (process.env.FRONTEND_SHARED_SECRET ?? "").trim();
const FRONTEND_SHARED_SECRET_HEADER = (
  process.env.FRONTEND_SHARED_SECRET_HEADER ?? "x-frontend-secret"
).toLowerCase();
const AUTH_API = resolveAuthApiConfig();
const AUTH_API_PREFIX = AUTH_API.prefix;
const AUTH_API_TIMEOUT_MS = parsePositiveIntEnv("AUTH_API_TIMEOUT_MS", 5_000);
const AUTH_EXEMPT_PATHS = parseAuthExemptPaths();
const REQUIRE_ORIGIN_HEADER = parseBooleanEnv(
  "REQUIRE_ORIGIN_HEADER",
  ALLOWED_ORIGINS.length > 0
);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);

type RateLimitBucket = {
  count: number;
  resetAtMs: number;
};

type WatchlistAccessContext =
  | { mode: "admin"; authUserId: null }
  | { mode: "user"; authUserId: string };

type WatchlistAccessResolution =
  | { ok: true; access: WatchlistAccessContext }
  | { ok: false; status: number; error: string };

type AuthUserLookupResult =
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string };

type AuthApiMode = "configured" | "local-fallback" | "missing";

type AuthApiConfig = {
  prefix: string;
  baseUrl: string | null;
  mode: AuthApiMode;
  warning: string | null;
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();

const apiConnectionStore = new UserApiConnectionStore(API_CONNECTION_STATE_FILE);

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Content-Type, Authorization, ${FRONTEND_SHARED_SECRET_HEADER}`
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const isAuthExemptPath = AUTH_EXEMPT_PATHS.has(url.pathname);

  const reqOrigin = firstHeaderValue(req.headers.origin);
  const allowedOrigin = resolveAllowedOrigin(reqOrigin);

  if (!isAuthExemptPath && REQUIRE_ORIGIN_HEADER && !reqOrigin) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "Missing origin" }));
    return;
  }

  if (!isAuthExemptPath && reqOrigin && !allowedOrigin) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "Origin not allowed" }));
    return;
  }

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const isBotPath = url.pathname.startsWith("/api/bot/");
  const isAllowedMethod =
    req.method === "GET" ||
    (req.method === "POST" && isBotPath) ||
    (req.method === "PUT" && isBotPath) ||
    (req.method === "DELETE" && isBotPath);

  if (!isAllowedMethod) {
    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        ok: true,
        auth: {
          configured: AUTH_API.mode !== "missing",
          mode: AUTH_API.mode,
          baseUrl: AUTH_API.baseUrl,
          timeoutMs: AUTH_API_TIMEOUT_MS,
        },
      })
    );
    return;
  }

  if (isBotPath) {
    const isWatchlistRoute = isWatchlistApiPath(url.pathname);
    const isApiConnRoute = isApiConnectionPath(url.pathname);
    let watchlistAccess: WatchlistAccessContext = { mode: "admin", authUserId: null };
    let apiConnUserId: string | null = null;

    if (!isAuthExemptPath) {
      if (isWatchlistRoute) {
        const resolution = await resolveWatchlistAccess(req);
        if (!resolution.ok) {
          res.writeHead(resolution.status);
          res.end(JSON.stringify({ error: resolution.error }));
          return;
        }
        watchlistAccess = resolution.access;
      } else if (isApiConnRoute) {
        const lookup = await resolveUserBearerAuth(req);
        if (!lookup.ok) {
          res.writeHead(lookup.status);
          res.end(JSON.stringify({ error: lookup.error }));
          return;
        }
        apiConnUserId = lookup.userId;
      } else if (!hasValidFrontendSharedSecret(req)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized caller" }));
        return;
      }
    }

    // GET /api/bot/list
    if (url.pathname === "/api/bot/list" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify(getBotList()));
      return;
    }

    // POST /api/bot/start
    if (url.pathname === "/api/bot/start" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const cfg = body as BotConfig;
        if (!cfg.symbol || !Array.isArray(cfg.signals) || !cfg.timeframe) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid bot config: symbol, timeframe, and signals required" }));
          return;
        }
        const id = startBot(cfg);
        res.writeHead(200);
        res.end(JSON.stringify({ id }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(400);
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    // GET /api/bot/watchlists
    if (url.pathname === "/api/bot/watchlists" && req.method === "GET") {
      const allWatchlists = getUserWatchlists();
      const watchlists =
        watchlistAccess.mode === "admin"
          ? allWatchlists
          : filterWatchlistsForUser(allWatchlists, watchlistAccess.authUserId);

      const baseMonitor = getWatchlistMonitorStatus();
      const monitor =
        watchlistAccess.mode === "admin"
          ? baseMonitor
          : {
              ...baseMonitor,
              watchlistCount: watchlists.length,
              watchedSymbolCount: countWatchedSymbolsForWatchlists(watchlists),
              signalCount: filterSignalsForUser(
                getRecentWatchlistSignals(1_000),
                watchlistAccess.authUserId
              ).length,
            };

      res.writeHead(200);
      res.end(
        JSON.stringify({
          watchlists,
          monitor,
        })
      );
      return;
    }

    // PUT /api/bot/watchlists
    if (url.pathname === "/api/bot/watchlists" && req.method === "PUT") {
      if (watchlistAccess.mode !== "admin") {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "Only admin callers can bulk replace watchlists" }));
        return;
      }

      try {
        const body = await readJsonBody(req);
        const payload = body as { watchlists?: UserWatchlistInput[] };
        const watchlists = replaceAllUserWatchlists(payload.watchlists ?? []);
        res.writeHead(200);
        res.end(JSON.stringify({ watchlists }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(400);
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    // PUT /api/bot/watchlists/:userId
    const watchlistUpsertMatch = url.pathname.match(/^\/api\/bot\/watchlists\/([^/]+)$/);
    if (watchlistUpsertMatch && req.method === "PUT") {
      const routeUserId = decodeURIComponent(watchlistUpsertMatch[1]);
      if (
        watchlistAccess.mode === "user" &&
        !isWatchlistOwnedByUser(routeUserId, watchlistAccess.authUserId)
      ) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "Cannot modify another user's watchlist" }));
        return;
      }

      try {
        const body = await readJsonBody(req);
        const payload = body as Omit<UserWatchlistInput, "userId">;
        const watchlist = upsertUserWatchlist({
          userId: routeUserId,
          name: typeof payload.name === "string" ? payload.name : undefined,
          displayName: typeof payload.displayName === "string" ? payload.displayName : undefined,
          assetClass:
            payload.assetClass === "stocks_etf" || payload.assetClass === "crypto"
              ? payload.assetClass
              : undefined,
          symbols: Array.isArray(payload.symbols) ? payload.symbols : undefined,
          enabled: payload.enabled,
          config: payload.config,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ watchlist }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(400);
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    // DELETE /api/bot/watchlists/:userId
    const watchlistDeleteMatch = url.pathname.match(/^\/api\/bot\/watchlists\/([^/]+)$/);
    if (watchlistDeleteMatch && req.method === "DELETE") {
      const routeUserId = decodeURIComponent(watchlistDeleteMatch[1]);
      if (
        watchlistAccess.mode === "user" &&
        !isWatchlistOwnedByUser(routeUserId, watchlistAccess.authUserId)
      ) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "Cannot delete another user's watchlist" }));
        return;
      }

      const removed = removeUserWatchlist(routeUserId);
      res.writeHead(removed ? 200 : 404);
      res.end(JSON.stringify({ ok: removed }));
      return;
    }

    // POST /api/bot/watchlists/scan
    if (url.pathname === "/api/bot/watchlists/scan" && req.method === "POST") {
      try {
        const timeframeParam = url.searchParams.get("timeframe");
        const timeframe =
          timeframeParam === "1Hour" || timeframeParam === "1Day"
            ? timeframeParam
            : undefined;

        if (watchlistAccess.mode === "admin") {
          await runWatchlistScanNow(timeframe);
        } else {
          await runWatchlistScanNowForUser(watchlistAccess.authUserId, timeframe);
        }

        const baseMonitor = getWatchlistMonitorStatus();
        const monitor =
          watchlistAccess.mode === "admin"
            ? baseMonitor
            : {
                ...baseMonitor,
                watchlistCount: filterWatchlistsForUser(
                  getUserWatchlists(),
                  watchlistAccess.authUserId
                ).length,
                watchedSymbolCount: countWatchedSymbolsForWatchlists(
                  filterWatchlistsForUser(getUserWatchlists(), watchlistAccess.authUserId)
                ),
                signalCount: filterSignalsForUser(
                  getRecentWatchlistSignals(1_000),
                  watchlistAccess.authUserId
                ).length,
              };

        res.writeHead(200);
        res.end(
          JSON.stringify({
            ok: true,
            monitor,
          })
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    // GET /api/bot/watchlist-signals?limit=100
    if (url.pathname === "/api/bot/watchlist-signals" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const safeLimit = normalizeSignalLimit(limit);
      const signals =
        watchlistAccess.mode === "admin"
          ? getRecentWatchlistSignals(safeLimit)
          : filterSignalsForUser(
              getRecentWatchlistSignals(1_000),
              watchlistAccess.authUserId
            ).slice(0, safeLimit);
      res.writeHead(200);
      res.end(JSON.stringify({ signals }));
      return;
    }

    // POST /api/bot/stop/:id
    const stopMatch = url.pathname.match(/^\/api\/bot\/stop\/([^/]+)$/);
    if (stopMatch && req.method === "POST") {
      stopBot(stopMatch[1]);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // DELETE /api/bot/:id
    const deleteMatch = url.pathname.match(/^\/api\/bot\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      removeBot(deleteMatch[1]);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/bot/api-connection
    if (isApiConnRoute && url.pathname === "/api/bot/api-connection" && req.method === "GET") {
      const connection = apiConnectionStore.get(apiConnUserId!);
      res.writeHead(200);
      res.end(JSON.stringify({ connection }));
      return;
    }

    // PUT /api/bot/api-connection
    if (isApiConnRoute && url.pathname === "/api/bot/api-connection" && req.method === "PUT") {
      const body = (await readJsonBody(req)) as UserApiConnectionInput;
      const connection = apiConnectionStore.upsert(apiConnUserId!, body);
      res.writeHead(200);
      res.end(JSON.stringify({ connection }));
      return;
    }

    // DELETE /api/bot/api-connection
    if (isApiConnRoute && url.pathname === "/api/bot/api-connection" && req.method === "DELETE") {
      const removed = apiConnectionStore.remove(apiConnUserId!);
      res.writeHead(removed ? 200 : 404);
      res.end(JSON.stringify({ ok: removed }));
      return;
    }

    // POST /api/bot/api-connection/test
    if (isApiConnRoute && url.pathname === "/api/bot/api-connection/test" && req.method === "POST") {
      const body = (await readJsonBody(req)) as {
        alpacaKeyId?: string;
        alpacaSecretKey?: string;
        paper?: boolean;
      };
      let creds: { keyId: string; secretKey: string; paper: boolean };
      const bodyKeyId = (body.alpacaKeyId ?? "").trim();
      const bodySecretKey = (body.alpacaSecretKey ?? "").trim();
      if (bodyKeyId && bodySecretKey) {
        creds = { keyId: bodyKeyId, secretKey: bodySecretKey, paper: body.paper !== false };
      } else {
        const stored = apiConnectionStore.getSecret(apiConnUserId!);
        if (!stored) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "No credentials provided or stored" }));
          return;
        }
        creds = stored;
      }
      const snapshot = await fetchAlpacaAccountSnapshot(creds);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, account: snapshot.account }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // GET /api/community/watchlists — public, no auth required
  if (url.pathname === "/api/community/watchlists" && req.method === "GET") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.writeHead(200);
    res.end(JSON.stringify({ users: getPublicWatchlistUsers() }));
    return;
  }

  const symbolFromPath = url.pathname.match(/^\/api\/bars\/([^/]+)$/)?.[1];
  const isBarsRequest = url.pathname === "/api/bars" || Boolean(symbolFromPath);
  const isAlpacaPath = url.pathname.startsWith("/api/alpaca/");
  const isAlpacaAccountRequest = url.pathname === "/api/alpaca/account";

  if (isAlpacaPath && !isAlpacaAccountRequest) {
    res.writeHead(403);
    res.end(
      JSON.stringify({
        error: "Trading endpoints are disabled. This service is read-only.",
      })
    );
    return;
  }

  if (!isBarsRequest && !isAlpacaAccountRequest) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (!isAuthExemptPath && !hasValidFrontendSharedSecret(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized caller" }));
    return;
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    res.writeHead(429);
    res.end(JSON.stringify({ error: "Too many requests" }));
    return;
  }

  try {
    if (isAlpacaAccountRequest) {
      let userCredentials: { keyId: string; secretKey: string; paper: boolean } | undefined;
      const bearerToken = parseBearerToken(firstHeaderValue(req.headers.authorization));
      if (bearerToken) {
        const lookup = await fetchAuthUserId(bearerToken);
        if (lookup.ok) {
          const stored = apiConnectionStore.getSecret(lookup.userId);
          if (stored) userCredentials = stored;
        }
      }
      const payload = await fetchAlpacaAccountSnapshot(userCredentials);
      res.writeHead(200);
      res.end(JSON.stringify(payload));
      return;
    }

    const symbol = url.searchParams.get("symbol") ?? symbolFromPath;
    const timeframeParam = url.searchParams.get("timeframe");
    const timeframe = timeframeParam === "1Hour" ? "1Hour" : "1Day";
    const payload = await fetchMarketBars({
      symbol: symbol ?? "",
      range: url.searchParams.get("range"),
      timeframe,
    });

    res.writeHead(200);
    res.end(JSON.stringify(payload));
  } catch (err) {
    if (err instanceof ApiHttpError) {
      res.writeHead(err.status);
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: msg }));
  }
});

server.listen(PORT, () => {
  console.log(`Alpaca data proxy → http://localhost:${PORT}`);
  if (AUTH_API.warning) {
    console.warn(`[auth] ${AUTH_API.warning}`);
  } else if (AUTH_API.baseUrl) {
    console.log(
      `[auth] Bearer-token watchlist and API connection auth enabled via ${AUTH_API.baseUrl}`
    );
  }
  void loadPersistedState();
  void initializeWatchlistExecution();
  void apiConnectionStore.load();
});

async function initializeWatchlistExecution(): Promise<void> {
  await loadPersistedWatchlists();
  startWatchlistExecution();
}

function parseCsvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseAuthExemptPaths(): Set<string> {
  const paths = parseCsvEnv("AUTH_EXEMPT_PATHS");
  if (paths.length === 0) {
    return new Set(["/api/health"]);
  }
  return new Set(paths);
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.round(parsed);
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : null;
  }
  return null;
}

function resolveAllowedOrigin(origin: string | null): string | null {
  if (!origin) {
    return null;
  }

  if (ALLOWED_ORIGINS.length === 0) {
    return origin;
  }

  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function hasValidFrontendSharedSecret(req: http.IncomingMessage): boolean {
  if (!FRONTEND_SHARED_SECRET) {
    return true;
  }

  return hasValidConfiguredFrontendSharedSecret(req);
}

function hasValidConfiguredFrontendSharedSecret(req: http.IncomingMessage): boolean {
  if (!FRONTEND_SHARED_SECRET) {
    return false;
  }

  const customHeader = firstHeaderValue(
    req.headers[FRONTEND_SHARED_SECRET_HEADER]
  );
  if (constantTimeEqual(customHeader, FRONTEND_SHARED_SECRET)) {
    return true;
  }

  const authHeader = firstHeaderValue(req.headers.authorization);
  const bearerToken = parseBearerToken(authHeader);
  return constantTimeEqual(bearerToken, FRONTEND_SHARED_SECRET);
}

function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function constantTimeEqual(a: string | null, b: string): boolean {
  if (!a) {
    return false;
  }

  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return timingSafeEqual(aBuffer, bBuffer);
}

function resolveAuthApiConfig(): AuthApiConfig {
  const configured = (process.env.AUTH_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (configured.length > 0) {
    return {
      prefix: `${configured}/api`,
      baseUrl: configured,
      mode: "configured",
      warning: null,
    };
  }

  if (process.env.NODE_ENV !== "production" && !isRailwayRuntime()) {
    const localBaseUrl = "http://127.0.0.1:3002";
    return {
      prefix: `${localBaseUrl}/api`,
      baseUrl: localBaseUrl,
      mode: "local-fallback",
      warning: null,
    };
  }

  const reason = isRailwayRuntime()
    ? "AUTH_API_BASE_URL is required when data-service runs with Railway environment variables."
    : "AUTH_API_BASE_URL is required in production.";

  return {
    prefix: "",
    baseUrl: null,
    mode: "missing",
    warning: `${reason} Set it to the auth-service public URL, for example https://auth-service-development-<id>.up.railway.app.`,
  };
}

function isRailwayRuntime(): boolean {
  return [
    "RAILWAY_ENVIRONMENT",
    "RAILWAY_ENVIRONMENT_NAME",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_SERVICE_ID",
    "RAILWAY_PUBLIC_DOMAIN",
    "RAILWAY_STATIC_URL",
  ].some((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function isApiConnectionPath(pathname: string): boolean {
  return pathname === "/api/bot/api-connection" || pathname === "/api/bot/api-connection/test";
}

async function resolveUserBearerAuth(req: http.IncomingMessage): Promise<AuthUserLookupResult> {
  const bearerToken = parseBearerToken(firstHeaderValue(req.headers.authorization));
  if (!bearerToken) {
    return { ok: false, status: 401, error: "Missing bearer token" };
  }
  return fetchAuthUserId(bearerToken);
}

function isWatchlistApiPath(pathname: string): boolean {
  return (
    pathname === "/api/bot/watchlists" ||
    pathname.startsWith("/api/bot/watchlists/") ||
    pathname === "/api/bot/watchlist-signals"
  );
}

async function resolveWatchlistAccess(
  req: http.IncomingMessage
): Promise<WatchlistAccessResolution> {
  if (hasValidConfiguredFrontendSharedSecret(req)) {
    return { ok: true, access: { mode: "admin", authUserId: null } };
  }

  const bearerToken = parseBearerToken(firstHeaderValue(req.headers.authorization));
  if (!bearerToken) {
    return { ok: false, status: 401, error: "Missing bearer token" };
  }

  const lookup = await fetchAuthUserId(bearerToken);
  if (!lookup.ok) {
    return lookup;
  }

  return { ok: true, access: { mode: "user", authUserId: lookup.userId } };
}

async function fetchAuthUserId(bearerToken: string): Promise<AuthUserLookupResult> {
  if (!AUTH_API_PREFIX) {
    return {
      ok: false,
      status: 503,
      error:
        AUTH_API.warning ??
        "Auth service is not configured. Set AUTH_API_BASE_URL to the auth-service public URL.",
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AUTH_API_TIMEOUT_MS);

  try {
    const response = await fetch(`${AUTH_API_PREFIX}/auth/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      user?: { id?: string };
    };

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          status: 401,
          error: payload.error ?? "Invalid or expired session",
        };
      }

      return {
        ok: false,
        status: 503,
        error:
          payload.error ??
          `Auth service request failed (${response.status}). Check AUTH_API_BASE_URL and auth-service health.`,
      };
    }

    const userId = typeof payload.user?.id === "string" ? payload.user.id.trim() : "";
    if (!userId) {
      return {
        ok: false,
        status: 503,
        error: "Auth service returned an invalid user session",
      };
    }

    return { ok: true, userId };
  } catch (err) {
    const errorName = err instanceof Error ? err.name : "";
    const isAbort = errorName === "AbortError";
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(
      `[auth] Failed to reach auth service${AUTH_API.baseUrl ? ` at ${AUTH_API.baseUrl}` : ""}: ${errorMessage}`
    );
    return {
      ok: false,
      status: 503,
      error: isAbort
        ? "Auth service request timed out. Check AUTH_API_BASE_URL and auth-service health."
        : "Auth service is unavailable. Check AUTH_API_BASE_URL and auth-service health.",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function isWatchlistOwnedByUser(watchlistUserId: string, authUserId: string): boolean {
  return watchlistUserId === authUserId || watchlistUserId.startsWith(`${authUserId}:`);
}

function filterWatchlistsForUser(
  watchlists: UserWatchlist[],
  authUserId: string
): UserWatchlist[] {
  return watchlists.filter((watchlist) => isWatchlistOwnedByUser(watchlist.userId, authUserId));
}

function filterSignalsForUser(
  signals: WatchlistSignalEvent[],
  authUserId: string
): WatchlistSignalEvent[] {
  return signals.filter((signal) => isWatchlistOwnedByUser(signal.userId, authUserId));
}

function countWatchedSymbolsForWatchlists(watchlists: UserWatchlist[]): number {
  const symbols = new Set<string>();
  for (const watchlist of watchlists) {
    if (!watchlist.enabled) continue;
    for (const symbol of watchlist.symbols) {
      symbols.add(symbol);
    }
  }
  return symbols.size;
}

function normalizeSignalLimit(limit: number): number {
  return Math.max(1, Math.min(1_000, Math.round(limit) || 100));
}

function getClientIp(req: http.IncomingMessage): string {
  const fwd = firstHeaderValue(req.headers["x-forwarded-for"]);
  if (fwd) {
    return fwd.split(",")[0]?.trim() || "unknown";
  }
  return req.socket.remoteAddress ?? "unknown";
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const existing = rateLimitBuckets.get(ip);

  if (!existing || now > existing.resetAtMs) {
    rateLimitBuckets.set(ip, {
      count: 1,
      resetAtMs: now + RATE_LIMIT_WINDOW_MS,
    });
    return false;
  }

  existing.count += 1;
  return existing.count > RATE_LIMIT_MAX;
}
