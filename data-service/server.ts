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

const PORT = Number(process.env.PORT ?? 3001);
const ALLOWED_ORIGINS = parseCsvEnv("ALLOWED_ORIGINS");
const FRONTEND_SHARED_SECRET = (process.env.FRONTEND_SHARED_SECRET ?? "").trim();
const FRONTEND_SHARED_SECRET_HEADER = (
  process.env.FRONTEND_SHARED_SECRET_HEADER ?? "x-frontend-secret"
).toLowerCase();
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

const rateLimitBuckets = new Map<string, RateLimitBucket>();

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Content-Type, Authorization, ${FRONTEND_SHARED_SECRET_HEADER}`
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");

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
    (req.method === "DELETE" && isBotPath);

  if (!isAllowedMethod) {
    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (isBotPath) {
    if (!isAuthExemptPath && !hasValidFrontendSharedSecret(req)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized caller" }));
      return;
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

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
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
      const payload = await fetchAlpacaAccountSnapshot();
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
  void loadPersistedState();
});

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
