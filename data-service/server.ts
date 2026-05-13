import http from "node:http";
import { loadPersistedState } from "./botEngine.ts";
import { loadPersistedWatchlists, startWatchlistExecution } from "./watchlistExecution.ts";
import { UserApiConnectionStore } from "./userApiConnections.ts";
import { handleBotRoutes } from "./routes/botRoutes.ts";
import { handleBarsRoute } from "./routes/barsRoute.ts";
import { firstHeaderValue } from "./httpUtils.ts";
import {
  PORT,
  API_CONNECTION_STATE_FILE,
  ALLOWED_ORIGINS,
  FRONTEND_SHARED_SECRET_HEADER,
  ORIGIN_EXEMPT_PATHS,
  REQUIRE_ORIGIN_HEADER,
  ENABLE_BOT_ENGINE,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
} from "./config.ts";

type RateLimitBucket = { count: number; resetAtMs: number };
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

  if (isBotPath) {
    await handleBotRoutes(req, res, url, apiConnectionStore);
    return;
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    res.writeHead(429);
    res.end(JSON.stringify({ error: "Too many requests" }));
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
  void initializeWatchlistExecution();
  void apiConnectionStore.load();
});

async function initializeWatchlistExecution(): Promise<void> {
  await loadPersistedWatchlists();
  startWatchlistExecution();
}

function resolveAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.length === 0) return origin;
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
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
