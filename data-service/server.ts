import http from "node:http";
import { loadPersistedState } from "./botEngine.ts";
import { loadPersistedWatchlists, startWatchlistExecution } from "./watchlistExecution.ts";
import {
  startBackendManagedPaperBots,
} from "./liveCryptoBot.ts";
import { startLiveSignalsMonitor } from "./liveSignalsMonitor.ts";
import { UserApiConnectionStore } from "./userApiConnections.ts";
import { handleBotRoutes } from "./routes/botRoutes.ts";
import { handleBarsRoute } from "./routes/barsRoute.ts";
import { firstHeaderValue } from "./httpUtils.ts";
import { loadLivePortfolioState } from "./livePortfolio.ts";
import {
  PORT,
  API_CONNECTION_STATE_FILE,
  ALLOWED_ORIGINS,
  FRONTEND_SHARED_SECRET_HEADER,
  ORIGIN_EXEMPT_PATHS,
  REQUIRE_ORIGIN_HEADER,
  ENABLE_BOT_ENGINE,
  ENABLE_BACKEND_PAPER_CRYPTO_RUNNER,
  BACKEND_PAPER_CRYPTO_SYMBOLS,
  BACKEND_PAPER_CRYPTO_TIMEFRAME,
  BACKEND_PAPER_CRYPTO_ALLOCATION_USD,
  BACKEND_PAPER_CRYPTO_DIRECTION_MODE,
  BACKEND_PAPER_CRYPTO_TREND_LOOKBACK_DAYS,
  BACKEND_PAPER_CRYPTO_TREND_BAND_PCT,
  BACKEND_PAPER_CRYPTO_SELLOFF_START_THRESHOLD,
  BACKEND_PAPER_CRYPTO_SELLOFF_END_THRESHOLD,
  ENABLE_LIVE_SIGNALS_MONITOR,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
} from "./config.ts";
import { startSecEarningsSyncLoop } from "./secEarningsStore.ts";

type RateLimitBucket = { count: number; resetAtMs: number };
type ParsedOrigin = {
  protocol: "http:" | "https:";
  hostname: string;
  port: string;
  canonical: string;
};
type AllowedOriginRule =
  | { kind: "any" }
  | { kind: "exact"; canonical: string }
  | {
      kind: "wildcard_subdomain";
      protocol: "http:" | "https:";
      baseHostname: string;
      port: string | null;
    };
const rateLimitBuckets = new Map<string, RateLimitBucket>();
const ALLOWED_ORIGIN_RULES = ALLOWED_ORIGINS
  .map(parseAllowedOriginRule)
  .filter((rule): rule is AllowedOriginRule => rule !== null);

const apiConnectionStore = new UserApiConnectionStore(API_CONNECTION_STATE_FILE);

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Content-Type, Authorization, ${FRONTEND_SHARED_SECRET_HEADER}`
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const isOriginExemptPath = ORIGIN_EXEMPT_PATHS.has(url.pathname);
  const reqOrigin = firstHeaderValue(req.headers.origin);
  const allowedOrigin = resolveAllowedOrigin(reqOrigin);

  if (!isOriginExemptPath && REQUIRE_ORIGIN_HEADER && !reqOrigin) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "Missing origin" }));
    return;
  }

  if (!isOriginExemptPath && reqOrigin && !allowedOrigin) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "Origin not allowed" }));
    return;
  }

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  } else if (isOriginExemptPath) {
    // Keep health and other explicitly-exempt routes readable across origins so
    // status checks do not fail hard while protected routes remain allowlisted.
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const isBotPath =
    url.pathname.startsWith("/api/bot/") ||
    url.pathname === "/api/community/watchlists";

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
    res.end(JSON.stringify({ ok: true, auth: { enabled: false } }));
    return;
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    res.writeHead(429);
    res.end(JSON.stringify({ error: "Too many requests" }));
    return;
  }

  if (isBotPath) {
    await handleBotRoutes(req, res, url, apiConnectionStore);
    return;
  }

  await handleBarsRoute(req, res, url, apiConnectionStore);
});

server.listen(PORT, () => {
  console.log(`Alpaca data proxy → http://localhost:${PORT}`);
  console.log("[access] Operator-managed mode enabled (no per-user auth)");
  if (ENABLE_BOT_ENGINE) {
    void loadPersistedState();
  } else {
    console.log("[bot-engine] disabled (set ENABLE_BOT_ENGINE=true to enable)");
  }
  if (ENABLE_BACKEND_PAPER_CRYPTO_RUNNER) {
    void initializeBackendPaperRunner();
  } else {
    console.log(
      "[backend-paper-runner] disabled (set ENABLE_BACKEND_PAPER_CRYPTO_RUNNER=true to enable)"
    );
  }
  if (ENABLE_LIVE_SIGNALS_MONITOR) {
    startLiveSignalsMonitor();
  } else {
    console.log(
      "[live-signals] disabled (set ENABLE_LIVE_SIGNALS_MONITOR=true to enable)"
    );
  }
  void initializeWatchlistExecution();
  void apiConnectionStore.load();
  void loadLivePortfolioState();
  startSecEarningsSyncLoop();
});

async function initializeWatchlistExecution(): Promise<void> {
  await loadPersistedWatchlists();
  startWatchlistExecution();
}

async function initializeBackendPaperRunner(): Promise<void> {
  const symbols = BACKEND_PAPER_CRYPTO_SYMBOLS
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0) {
    console.log(
      "[backend-paper-runner] enabled but no symbols configured (set BACKEND_PAPER_CRYPTO_SYMBOLS)"
    );
    return;
  }

  const ids = startBackendManagedPaperBots(
    symbols.map((symbol) => ({
      symbol,
      timeframe: BACKEND_PAPER_CRYPTO_TIMEFRAME,
      allocationUsd: BACKEND_PAPER_CRYPTO_ALLOCATION_USD,
      directionMode: BACKEND_PAPER_CRYPTO_DIRECTION_MODE,
      trendLookbackDays: BACKEND_PAPER_CRYPTO_TREND_LOOKBACK_DAYS,
      trendBandPct: BACKEND_PAPER_CRYPTO_TREND_BAND_PCT,
      selloffStartThreshold: BACKEND_PAPER_CRYPTO_SELLOFF_START_THRESHOLD,
      selloffEndThreshold: BACKEND_PAPER_CRYPTO_SELLOFF_END_THRESHOLD,
    }))
  );

  console.log(
    `[backend-paper-runner] started ${ids.length} bot(s) for ${symbols.join(", ")} ` +
      `(mode=${BACKEND_PAPER_CRYPTO_DIRECTION_MODE}, timeframe=${BACKEND_PAPER_CRYPTO_TIMEFRAME})`
  );
}

function resolveAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const parsedOrigin = parseHttpOrigin(origin);
  if (!parsedOrigin) return null;

  if (ALLOWED_ORIGIN_RULES.length === 0) {
    return parsedOrigin.canonical;
  }

  for (const rule of ALLOWED_ORIGIN_RULES) {
    if (matchesAllowedOriginRule(parsedOrigin, rule)) {
      return parsedOrigin.canonical;
    }
  }

  return null;
}

function parseAllowedOriginRule(value: string): AllowedOriginRule | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return { kind: "any" };

  const wildcardRule = parseWildcardSubdomainRule(trimmed);
  if (wildcardRule) return wildcardRule;

  const parsedExact = parseHttpOrigin(trimmed);
  if (!parsedExact) return null;
  return { kind: "exact", canonical: parsedExact.canonical };
}

function parseWildcardSubdomainRule(value: string): AllowedOriginRule | null {
  const match = value.match(
    /^(https?):\/\/\*\.([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?\/?$/i
  );
  if (!match) return null;

  const protocol = `${match[1].toLowerCase()}:` as "http:" | "https:";
  const baseHostname = match[2].toLowerCase().replace(/\.+$/, "");
  if (!baseHostname) return null;

  const hasPort = typeof match[3] === "string" && match[3].length > 0;
  const normalizedPort = hasPort ? normalizePort(protocol, match[3]) : null;
  if (hasPort && normalizedPort === null) return null;

  return {
    kind: "wildcard_subdomain",
    protocol,
    baseHostname,
    port: normalizedPort,
  };
}

function matchesAllowedOriginRule(
  origin: ParsedOrigin,
  rule: AllowedOriginRule
): boolean {
  if (rule.kind === "any") return true;

  if (rule.kind === "exact") {
    return origin.canonical === rule.canonical;
  }

  if (origin.protocol !== rule.protocol) {
    return false;
  }

  if (rule.port !== null && origin.port !== rule.port) {
    return false;
  }

  if (origin.hostname === rule.baseHostname) {
    return false;
  }

  return origin.hostname.endsWith(`.${rule.baseHostname}`);
}

function parseHttpOrigin(value: string): ParsedOrigin | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    const protocol = url.protocol as "http:" | "https:";
    const hostname = url.hostname.toLowerCase();
    const port = normalizePort(protocol, url.port);
    if (port === null) return null;

    const canonical = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    return { protocol, hostname, port, canonical };
  } catch {
    return null;
  }
}

function normalizePort(
  protocol: "http:" | "https:",
  rawPort: string
): string | null {
  if (!rawPort) return "";
  if (!/^[0-9]{1,5}$/.test(rawPort)) return null;
  const asNumber = Number(rawPort);
  if (!Number.isFinite(asNumber) || asNumber <= 0 || asNumber > 65_535) {
    return null;
  }
  if ((protocol === "https:" && asNumber === 443) || (protocol === "http:" && asNumber === 80)) {
    return "";
  }
  return String(asNumber);
}

function getClientIp(req: http.IncomingMessage): string {
  const fwd = firstHeaderValue(req.headers["x-forwarded-for"]);
  if (fwd) return fwd.split(",")[0]?.trim() || "unknown";
  return req.socket.remoteAddress ?? "unknown";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const existing = rateLimitBuckets.get(ip);
  if (!existing || now > existing.resetAtMs) {
    rateLimitBuckets.set(ip, { count: 1, resetAtMs: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  existing.count += 1;
  return existing.count > RATE_LIMIT_MAX;
}
