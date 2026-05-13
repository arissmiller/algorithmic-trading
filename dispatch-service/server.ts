import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  DispatchDelivery,
  readSmtpConfigFromEnv,
  readTelegramConfigFromEnv,
  readTwilioConfigFromEnv,
} from "./src/delivery";
import { normalizeDispatchableTradingSignal, SignalDispatcher } from "./src/dispatcher";
import { DispatchProfileStore } from "./src/profileStore";
import { TradingConnectionStore, UserTradingConnectionInput } from "./src/tradingConnections";
import { UserDispatchProfileInput } from "./src/types";

const PORT = Number(process.env.PORT ?? 3003);
const ALLOWED_ORIGINS = parseCsvEnv("ALLOWED_ORIGINS");
const REQUIRE_ORIGIN_HEADER = parseBooleanEnv(
  "REQUIRE_ORIGIN_HEADER",
  false
);
const DISPATCH_AUTH_HEADER = (process.env.DISPATCH_AUTH_HEADER ?? "x-dispatch-token")
  .trim()
  .toLowerCase();
const DISPATCH_AUTH_TOKEN = (process.env.DISPATCH_AUTH_TOKEN ?? "").trim();
const EVENT_HISTORY_LIMIT = parsePositiveInt(process.env.DISPATCH_EVENT_HISTORY_LIMIT, 500);
const STATE_FILE =
  process.env.DISPATCH_STATE_FILE ??
  new URL("./dispatch-state.json", import.meta.url).pathname;
const TRADING_STATE_FILE =
  process.env.DISPATCH_TRADING_STATE_FILE ??
  new URL("./dispatch-trading-state.json", import.meta.url).pathname;

const EMAIL_LOG_ONLY_MODE = parseBooleanEnv(
  "DISPATCH_EMAIL_LOG_ONLY_MODE",
  process.env.NODE_ENV !== "production"
);
const SMS_LOG_ONLY_MODE = parseBooleanEnv(
  "DISPATCH_SMS_LOG_ONLY_MODE",
  process.env.NODE_ENV !== "production"
);
const TELEGRAM_LOG_ONLY_MODE = parseBooleanEnv(
  "DISPATCH_TELEGRAM_LOG_ONLY_MODE",
  process.env.NODE_ENV !== "production"
);

const profileStore = new DispatchProfileStore(STATE_FILE);
const tradingStore = new TradingConnectionStore(TRADING_STATE_FILE);
const delivery = new DispatchDelivery({
  smtpConfig: readSmtpConfigFromEnv(),
  twilioConfig: readTwilioConfigFromEnv(),
  telegramConfig: readTelegramConfigFromEnv(),
  emailLogOnlyMode: EMAIL_LOG_ONLY_MODE,
  smsLogOnlyMode: SMS_LOG_ONLY_MODE,
  telegramLogOnlyMode: TELEGRAM_LOG_ONLY_MODE,
});
const dispatcher = new SignalDispatcher({
  profileStore,
  tradingStore,
  delivery,
  eventHistoryLimit: EVENT_HISTORY_LIMIT,
});

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Content-Type, Authorization, ${DISPATCH_AUTH_HEADER}`
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const reqOrigin = firstHeaderValue(req.headers.origin);
  const allowedOrigin = resolveAllowedOrigin(reqOrigin);

  if (REQUIRE_ORIGIN_HEADER && url.pathname !== "/api/health" && !reqOrigin) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "Missing origin" }));
    return;
  }

  if (reqOrigin && !allowedOrigin) {
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

  try {
    if (url.pathname === "/api/health" && req.method === "GET") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          profiles: profileStore.list().length,
          tradingConnections: tradingStore.list().length,
          events: dispatcher.getEventCount(),
        })
      );
      return;
    }

    if (!url.pathname.startsWith("/api/dispatch/")) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (!hasValidDispatchAuth(req)) {
      throw new HttpError(401, "Unauthorized caller");
    }

    if (url.pathname === "/api/dispatch/users" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ profiles: profileStore.list() }));
      return;
    }

    const userRouteMatch = url.pathname.match(/^\/api\/dispatch\/users\/([^/]+)$/);
    if (userRouteMatch && req.method === "GET") {
      const userId = decodeURIComponent(userRouteMatch[1]);
      const profile = profileStore.get(userId);
      if (!profile) {
        throw new HttpError(404, "Profile not found");
      }

      res.writeHead(200);
      res.end(JSON.stringify({ profile }));
      return;
    }

    if (userRouteMatch && req.method === "PUT") {
      const userId = decodeURIComponent(userRouteMatch[1]);
      const body = (await readJsonBody(req)) as UserDispatchProfileInput;
      const profile = profileStore.upsert(userId, body);
      res.writeHead(200);
      res.end(JSON.stringify({ profile }));
      return;
    }

    if (userRouteMatch && req.method === "DELETE") {
      const userId = decodeURIComponent(userRouteMatch[1]);
      const removed = profileStore.remove(userId);
      res.writeHead(removed ? 200 : 404);
      res.end(JSON.stringify({ ok: removed }));
      return;
    }

    if (url.pathname === "/api/dispatch/trading-connections" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ connections: tradingStore.list() }));
      return;
    }

    const tradingRouteMatch = url.pathname.match(/^\/api\/dispatch\/users\/([^/]+)\/trading-connection$/);
    if (tradingRouteMatch && req.method === "GET") {
      const userId = decodeURIComponent(tradingRouteMatch[1]);
      const connection = tradingStore.get(userId);
      if (!connection) {
        throw new HttpError(404, "Trading connection not found");
      }
      res.writeHead(200);
      res.end(JSON.stringify({ connection }));
      return;
    }

    if (tradingRouteMatch && req.method === "PUT") {
      const userId = decodeURIComponent(tradingRouteMatch[1]);
      const body = (await readJsonBody(req)) as UserTradingConnectionInput;
      const connection = tradingStore.upsert(userId, body);
      res.writeHead(200);
      res.end(JSON.stringify({ connection }));
      return;
    }

    if (tradingRouteMatch && req.method === "DELETE") {
      const userId = decodeURIComponent(tradingRouteMatch[1]);
      const removed = tradingStore.remove(userId);
      res.writeHead(removed ? 200 : 404);
      res.end(JSON.stringify({ ok: removed }));
      return;
    }

    if (url.pathname === "/api/dispatch/signal" && req.method === "POST") {
      const body = await readJsonBody(req);
      const signal = normalizeDispatchableTradingSignal(body);
      const result = await dispatcher.dispatchSignal(signal);
      const statusCode = result.status === "failed" ? 502 : 200;
      res.writeHead(statusCode);
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === "/api/dispatch/events" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const events = dispatcher.getEventHistory(limit);
      res.writeHead(200);
      res.end(JSON.stringify({ events }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    if (err instanceof HttpError) {
      res.writeHead(err.status);
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    if (err instanceof SyntaxError) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    const status = isLikelyValidationError(err) ? 400 : 500;
    res.writeHead(status);
    res.end(JSON.stringify({ error: message }));
  }
});

async function start(): Promise<void> {
  await Promise.all([profileStore.load(), tradingStore.load()]);
  server.listen(PORT, () => {
    console.log(`Dispatch service listening on http://localhost:${PORT}`);
  });
}

void start().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Dispatch service failed to start: ${message}`);
  process.exit(1);
});

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseCsvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.round(value);
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === "string" ? value : null;
}

function resolveAllowedOrigin(reqOrigin: string | null): string | null {
  if (!reqOrigin) return null;
  if (ALLOWED_ORIGINS.length === 0) return reqOrigin;
  return ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : null;
}

function hasValidDispatchAuth(req: http.IncomingMessage): boolean {
  if (!DISPATCH_AUTH_TOKEN) {
    return true;
  }

  const headerToken = firstHeaderValue(req.headers[DISPATCH_AUTH_HEADER]);
  const authHeader = firstHeaderValue(req.headers.authorization);
  const bearerToken =
    authHeader && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;

  if (!headerToken && !bearerToken) {
    return false;
  }

  return secureTokenEquals(headerToken, DISPATCH_AUTH_TOKEN) ||
    secureTokenEquals(bearerToken, DISPATCH_AUTH_TOKEN);
}

function secureTokenEquals(candidate: string | null, expected: string): boolean {
  if (!candidate) return false;

  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

function isLikelyValidationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const text = err.message.toLowerCase();
  return ["must", "required", "invalid", "too long", "not configured"].some((needle) =>
    text.includes(needle)
  );
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new HttpError(413, "Body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}
