import http from "node:http";
import {
  startBot,
  stopBot,
  removeBot,
  getBotList,
  BotStartRequest,
} from "../botEngine.ts";
import {
  getRecentWatchlistSignals,
  getPublicWatchlistUsers,
  getUserWatchlists,
  getWatchlistMonitorStatus,
  removeUserWatchlist,
  replaceAllUserWatchlists,
  runWatchlistScanNow,
  UserWatchlist,
  upsertUserWatchlist,
  UserWatchlistInput,
} from "../watchlistExecution.ts";
import {
  getBackendManagedPaperBotList,
  getBackendManagedPaperBotStatus,
} from "../liveCryptoBot.ts";
import {
  getLiveSignals,
  getLiveSignalsMonitorStatus,
} from "../liveSignalsMonitor.ts";
import {
  getLivePortfolioSnapshot,
  updateLivePortfolioConfig,
} from "../livePortfolio.ts";
import { UserApiConnectionStore, UserApiConnectionInput } from "../userApiConnections.ts";
import { BOT_TUNING, BOT_TUNING_PROFILES, BotTuningProfileKey } from "../botTuning.ts";
import { fetchAlpacaAccountSnapshot } from "../core.ts";
import {
  ENABLE_BOT_ENGINE,
  DEFAULT_OPERATOR_USER_ID,
  ENABLE_BACKEND_PAPER_CRYPTO_RUNNER,
  ENABLE_LIVE_SIGNALS_MONITOR,
} from "../config.ts";
import { readJsonBody } from "../httpUtils.ts";

// ---------------------------------------------------------------------------
// Main dispatcher — called for all /api/bot/* and /api/community/* paths
// ---------------------------------------------------------------------------

export async function handleBotRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  apiConnectionStore: UserApiConnectionStore
): Promise<void> {
  // Community routes (no bot-engine gate)
  if (url.pathname === "/api/community/watchlists" && req.method === "GET") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.writeHead(200);
    res.end(JSON.stringify({ users: getPublicWatchlistUsers() }));
    return;
  }

  // All remaining paths live under /api/bot/
  if (!url.pathname.startsWith("/api/bot/")) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (url.pathname === "/api/bot/strategy-profiles" && req.method === "GET") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        defaults: BOT_TUNING.defaults,
        cadence: BOT_TUNING.cadence,
        risk: BOT_TUNING.risk,
        profiles: BOT_TUNING_PROFILES,
      })
    );
    return;
  }

  if (url.pathname === "/api/bot/portfolio" && req.method === "GET") {
    const portfolioKey = url.searchParams.get("portfolio") ?? undefined;
    try {
      const snapshot = await getLivePortfolioSnapshot(portfolioKey);
      res.writeHead(200);
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (url.pathname === "/api/bot/portfolio" && req.method === "PUT") {
    const portfolioKey = url.searchParams.get("portfolio") ?? undefined;
    try {
      const body = await readJsonBody(req);
      const config = await updateLivePortfolioConfig(body, portfolioKey);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, config }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Live strategy signals (read-only)
  // -------------------------------------------------------------------------

  if (url.pathname === "/api/bot/live-signals/status" && req.method === "GET") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        enabled: ENABLE_LIVE_SIGNALS_MONITOR,
        monitor: getLiveSignalsMonitorStatus(),
      })
    );
    return;
  }

  if (url.pathname === "/api/bot/live-signals" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "200");
    const safeLimit = Math.max(1, Math.min(5_000, Math.round(limit) || 200));
    const profileParam = url.searchParams.get("profile");
    const timeframeParam = url.searchParams.get("timeframe");
    const actionParam = url.searchParams.get("action");

    const profile =
      typeof profileParam === "string" && profileParam in BOT_TUNING_PROFILES
        ? (profileParam as BotTuningProfileKey)
        : null;
    const timeframe =
      timeframeParam === "1Hour" || timeframeParam === "1Day" ? timeframeParam : null;
    const action = actionParam === "buy" || actionParam === "sell" || actionParam === "hold"
      ? actionParam
      : null;

    const signals = getLiveSignals({
      limit: safeLimit,
      symbol: url.searchParams.get("symbol"),
      profile,
      timeframe,
      action,
    });

    res.writeHead(200);
    res.end(
      JSON.stringify({
        enabled: ENABLE_LIVE_SIGNALS_MONITOR,
        monitor: getLiveSignalsMonitorStatus(),
        signals,
      })
    );
    return;
  }

  // -------------------------------------------------------------------------
  // Backend paper runner observability (read-only)
  // -------------------------------------------------------------------------

  if (url.pathname === "/api/bot/paper-runner" && req.method === "GET") {
    const bots = getBackendManagedPaperBotList();
    res.writeHead(200);
    res.end(
      JSON.stringify({
        enabled: ENABLE_BACKEND_PAPER_CRYPTO_RUNNER,
        botCount: bots.length,
        bots,
      })
    );
    return;
  }

  const paperRunnerMatch = url.pathname.match(/^\/api\/bot\/paper-runner\/([^/]+)$/);
  if (paperRunnerMatch && req.method === "GET") {
    const id = decodeURIComponent(paperRunnerMatch[1]);
    const bot = getBackendManagedPaperBotStatus(id);
    if (!bot) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Bot not found" }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ enabled: ENABLE_BACKEND_PAPER_CRYPTO_RUNNER, bot }));
    return;
  }

  // -------------------------------------------------------------------------
  // Bot-engine routes (gated by ENABLE_BOT_ENGINE)
  // -------------------------------------------------------------------------

  if (url.pathname === "/api/bot/list" && req.method === "GET") {
    if (!ENABLE_BOT_ENGINE) return sendBotEngineDisabled(res);
    res.writeHead(200);
    res.end(JSON.stringify(getBotList()));
    return;
  }

  if (url.pathname === "/api/bot/start" && req.method === "POST") {
    if (!ENABLE_BOT_ENGINE) return sendBotEngineDisabled(res);
    try {
      const body = await readJsonBody(req);
      const configs = buildBotStartConfigs(body);
      if (configs.length === 0) throw new Error("Provide at least one valid symbol.");
      const ids = configs.map((cfg) => startBot(cfg));
      res.writeHead(200);
      res.end(JSON.stringify({ id: ids[0] ?? null, ids, count: ids.length }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  const stopMatch = url.pathname.match(/^\/api\/bot\/stop\/([^/]+)$/);
  if (stopMatch && req.method === "POST") {
    if (!ENABLE_BOT_ENGINE) return sendBotEngineDisabled(res);
    stopBot(stopMatch[1]);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/bot\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    if (!ENABLE_BOT_ENGINE) return sendBotEngineDisabled(res);
    removeBot(deleteMatch[1]);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // -------------------------------------------------------------------------
  // Watchlist routes (always available — no bot-engine gate)
  // -------------------------------------------------------------------------

  if (url.pathname === "/api/bot/watchlists" && req.method === "GET") {
    const watchlists = getUserWatchlists();
    const monitor = buildMonitorPayload(watchlists);
    res.writeHead(200);
    res.end(JSON.stringify({ watchlists, monitor }));
    return;
  }

  if (url.pathname === "/api/bot/watchlists" && req.method === "PUT") {
    try {
      const body = await readJsonBody(req);
      const payload = body as { watchlists?: UserWatchlistInput[] };
      const watchlists = replaceAllUserWatchlists(payload.watchlists ?? []);
      res.writeHead(200);
      res.end(JSON.stringify({ watchlists }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  const watchlistUserMatch = url.pathname.match(/^\/api\/bot\/watchlists\/([^/]+)$/);

  if (watchlistUserMatch && req.method === "PUT") {
    const routeUserId = decodeURIComponent(watchlistUserMatch[1]);
    try {
      const body = await readJsonBody(req);
      const payload = body as Omit<UserWatchlistInput, "userId">;
      const watchlist = upsertUserWatchlist({
        userId: routeUserId,
        name: typeof payload.name === "string" ? payload.name : undefined,
        displayName:
          typeof payload.displayName === "string" ? payload.displayName : undefined,
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
      res.writeHead(400);
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (watchlistUserMatch && req.method === "DELETE") {
    const routeUserId = decodeURIComponent(watchlistUserMatch[1]);
    const removed = removeUserWatchlist(routeUserId);
    res.writeHead(removed ? 200 : 404);
    res.end(JSON.stringify({ ok: removed }));
    return;
  }

  if (url.pathname === "/api/bot/watchlists/scan" && req.method === "POST") {
    try {
      const timeframeParam = url.searchParams.get("timeframe");
      const timeframe =
        timeframeParam === "1Hour" || timeframeParam === "1Day" ? timeframeParam : undefined;
      await runWatchlistScanNow(timeframe);
      const watchlists = getUserWatchlists();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, monitor: buildMonitorPayload(watchlists) }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (url.pathname === "/api/bot/watchlist-signals" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const safeLimit = Math.max(1, Math.min(1_000, Math.round(limit) || 100));
    res.writeHead(200);
    res.end(JSON.stringify({ signals: getRecentWatchlistSignals(safeLimit) }));
    return;
  }

  // -------------------------------------------------------------------------
  // API connection routes (gated by ENABLE_BOT_ENGINE)
  // -------------------------------------------------------------------------

  const isApiConnRoute =
    url.pathname === "/api/bot/api-connection" ||
    url.pathname === "/api/bot/api-connection/test";

  if (isApiConnRoute) {
    if (!ENABLE_BOT_ENGINE) return sendBotEngineDisabled(res);

    if (url.pathname === "/api/bot/api-connection" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ connection: apiConnectionStore.get(DEFAULT_OPERATOR_USER_ID) }));
      return;
    }

    if (url.pathname === "/api/bot/api-connection" && req.method === "PUT") {
      const body = (await readJsonBody(req)) as UserApiConnectionInput;
      const connection = apiConnectionStore.upsert(DEFAULT_OPERATOR_USER_ID, body);
      res.writeHead(200);
      res.end(JSON.stringify({ connection }));
      return;
    }

    if (url.pathname === "/api/bot/api-connection" && req.method === "DELETE") {
      const removed = apiConnectionStore.remove(DEFAULT_OPERATOR_USER_ID);
      res.writeHead(removed ? 200 : 404);
      res.end(JSON.stringify({ ok: removed }));
      return;
    }

    if (url.pathname === "/api/bot/api-connection/test" && req.method === "POST") {
      const body = (await readJsonBody(req)) as {
        alpacaKeyId?: string;
        alpacaSecretKey?: string;
        paper?: boolean;
      };
      const bodyKeyId = (body.alpacaKeyId ?? "").trim();
      const bodySecretKey = (body.alpacaSecretKey ?? "").trim();
      let creds: { keyId: string; secretKey: string; paper: boolean };
      if (bodyKeyId && bodySecretKey) {
        creds = { keyId: bodyKeyId, secretKey: bodySecretKey, paper: body.paper !== false };
      } else {
        const stored = apiConnectionStore.getSecret(DEFAULT_OPERATOR_USER_ID);
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
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}

// ---------------------------------------------------------------------------
// Bot start request parsing
// ---------------------------------------------------------------------------

export function buildBotStartConfigs(body: unknown): BotStartRequest[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object.");
  }

  const payload = body as Record<string, unknown>;
  const symbols = parseBotSymbols(payload.symbol, payload.symbols);
  if (symbols.length === 0) {
    throw new Error("Provide at least one symbol via symbol or symbols.");
  }

  const profile = resolveBotProfile(payload.profile);
  const profileDefaults = BOT_TUNING_PROFILES[profile];
  const startDate = parseOptionalIsoDate(payload.startDate, "startDate");
  const durationDays = parseOptionalPositiveInt(payload.durationDays, "durationDays");
  const allocationMode = parseOptionalAllocationMode(payload.allocationMode);
  const allocationFixed = parseOptionalNonNegativeNumber(
    payload.allocationFixed,
    "allocationFixed"
  );
  const allocationPct = parseOptionalPercentage(payload.allocationPct, "allocationPct");
  const label = parseOptionalLabel(payload.label);

  return symbols.map((symbol) => ({
    label:
      symbols.length > 1
        ? `${label || profileDefaults.label} (${symbol})`
        : label || profileDefaults.label,
    symbol,
    profile,
    startDate: startDate ?? undefined,
    durationDays: durationDays ?? profileDefaults.durationDays,
    allocationMode: allocationMode ?? "pct_of_cash",
    allocationFixed: allocationFixed ?? 0,
    allocationPct: allocationPct ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function sendBotEngineDisabled(res: http.ServerResponse): void {
  res.writeHead(404);
  res.end(
    JSON.stringify({
      error: "Bot engine is disabled. Set ENABLE_BOT_ENGINE=true to enable these routes.",
    })
  );
}

function buildMonitorPayload(watchlists: UserWatchlist[]) {
  const base = getWatchlistMonitorStatus();
  const watchedSymbolCount = countWatchedSymbols(watchlists);
  return {
    ...base,
    watchlistCount: watchlists.length,
    watchedSymbolCount,
    signalCount: getRecentWatchlistSignals(1_000).length,
  };
}

function countWatchedSymbols(watchlists: UserWatchlist[]): number {
  const symbols = new Set<string>();
  for (const watchlist of watchlists) {
    if (!watchlist.enabled) continue;
    for (const symbol of watchlist.symbols) symbols.add(symbol);
  }
  return symbols.size;
}

function resolveBotProfile(profile: unknown): BotTuningProfileKey {
  if (profile == null || profile === "") return BOT_TUNING.defaults.profile;
  if (typeof profile !== "string") throw new Error("profile must be a string.");
  const normalized = profile.trim();
  if (!normalized) return BOT_TUNING.defaults.profile;
  if (normalized in BOT_TUNING_PROFILES) return normalized as BotTuningProfileKey;
  const supported = Object.keys(BOT_TUNING_PROFILES).join(", ");
  throw new Error(`Unknown profile "${normalized}". Supported profiles: ${supported}`);
}

function parseBotSymbols(symbol: unknown, symbols: unknown): string[] {
  const out = new Set<string>();

  if (typeof symbol === "string") {
    const n = normalizeBotSymbol(symbol);
    if (n) out.add(n);
  } else if (symbol != null) {
    throw new Error("symbol must be a string.");
  }

  if (Array.isArray(symbols)) {
    for (const value of symbols) {
      if (typeof value !== "string") throw new Error("symbols must be an array of strings.");
      const n = normalizeBotSymbol(value);
      if (n) out.add(n);
    }
  } else if (typeof symbols === "string") {
    for (const chunk of symbols.split(/[\n,\s]+/)) {
      const n = normalizeBotSymbol(chunk);
      if (n) out.add(n);
    }
  } else if (symbols != null) {
    throw new Error("symbols must be either a string or array of strings.");
  }

  return Array.from(out);
}

function normalizeBotSymbol(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return "";
  if (!/^[A-Z0-9./_-]+$/.test(normalized)) throw new Error(`Invalid symbol "${value}".`);
  return normalized;
}

function parseOptionalIsoDate(value: unknown, fieldName: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${fieldName} must be a YYYY-MM-DD string.`);
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed))
    throw new Error(`${fieldName} must use YYYY-MM-DD format.`);
  const timestamp = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) throw new Error(`${fieldName} is not a valid calendar date.`);
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseOptionalPositiveInt(value: unknown, fieldName: string): number | null {
  if (value == null || value === "") return null;
  const parsed = parseOptionalNumber(value, fieldName);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${fieldName} must be a positive integer.`);
  return parsed;
}

function parseOptionalAllocationMode(
  value: unknown
): BotStartRequest["allocationMode"] | null {
  if (value == null || value === "") return null;
  if (value === "fixed_usd" || value === "pct_of_cash") return value;
  throw new Error('allocationMode must be "fixed_usd" or "pct_of_cash".');
}

function parseOptionalNonNegativeNumber(value: unknown, fieldName: string): number | null {
  if (value == null || value === "") return null;
  const parsed = parseOptionalNumber(value, fieldName);
  if (parsed < 0) throw new Error(`${fieldName} must be >= 0.`);
  return parsed;
}

function parseOptionalPercentage(value: unknown, fieldName: string): number | null {
  if (value == null || value === "") return null;
  const parsed = parseOptionalNumber(value, fieldName);
  if (parsed < 0 || parsed > 100) throw new Error(`${fieldName} must be between 0 and 100.`);
  return parsed;
}

function parseOptionalLabel(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new Error("label must be a string.");
  const label = value.trim();
  if (label.length > 120) throw new Error("label must be 120 characters or fewer.");
  return label;
}

function parseOptionalNumber(value: unknown, fieldName: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${fieldName} must be a finite number.`);
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${fieldName} must not be empty.`);
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) throw new Error(`${fieldName} must be a finite number.`);
    return parsed;
  }
  throw new Error(`${fieldName} must be a number.`);
}
