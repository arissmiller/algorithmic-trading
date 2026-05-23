/**
 * Centralised env-var parsing. All runtime configuration is read once here
 * at startup so the rest of the codebase has a single place to look.
 */

export const PORT = Number(process.env.PORT ?? 3001);

export const API_CONNECTION_STATE_FILE =
  process.env.API_CONNECTION_STATE_FILE ??
  new URL("./api-connections.json", import.meta.url).pathname;

export const ALLOWED_ORIGINS = parseCsvEnv("ALLOWED_ORIGINS");

export const FRONTEND_SHARED_SECRET_HEADER = (
  process.env.FRONTEND_SHARED_SECRET_HEADER ?? "x-frontend-secret"
).toLowerCase();

export const DEFAULT_OPERATOR_USER_ID =
  (process.env.DEFAULT_OPERATOR_USER_ID ?? "operator").trim() || "operator";

export const ORIGIN_EXEMPT_PATHS = parseOriginExemptPaths();

export const REQUIRE_ORIGIN_HEADER = parseBooleanEnv(
  "REQUIRE_ORIGIN_HEADER",
  ALLOWED_ORIGINS.length > 0
);

export const ENABLE_BOT_ENGINE = parseBooleanEnv("ENABLE_BOT_ENGINE", false);
export const ENABLE_LIVE_SIGNALS_MONITOR = parseBooleanEnv(
  "ENABLE_LIVE_SIGNALS_MONITOR",
  false
);
export const LIVE_SIGNAL_SYMBOLS = parseCsvEnv("LIVE_SIGNAL_SYMBOLS");
export const LIVE_SIGNAL_PROFILES = parseCsvEnv("LIVE_SIGNAL_PROFILES");
export const LIVE_SIGNAL_HISTORY_LIMIT = Number(process.env.LIVE_SIGNAL_HISTORY_LIMIT ?? 500);
export const ALLOW_LIVE_CRYPTO_TRADING = parseBooleanEnv(
  "ALLOW_LIVE_CRYPTO_TRADING",
  false
);
export const ENABLE_BACKEND_PAPER_CRYPTO_RUNNER = parseBooleanEnv(
  "ENABLE_BACKEND_PAPER_CRYPTO_RUNNER",
  false
);
export const BACKEND_PAPER_CRYPTO_SYMBOLS = parseCsvEnv("BACKEND_PAPER_CRYPTO_SYMBOLS");
export const BACKEND_PAPER_CRYPTO_TIMEFRAME =
  process.env.BACKEND_PAPER_CRYPTO_TIMEFRAME === "1Day" ? "1Day" : "1Hour";
export const BACKEND_PAPER_CRYPTO_ALLOCATION_USD = Number(
  process.env.BACKEND_PAPER_CRYPTO_ALLOCATION_USD ?? 100
);
export const BACKEND_PAPER_CRYPTO_DIRECTION_MODE =
  process.env.BACKEND_PAPER_CRYPTO_DIRECTION_MODE === "trend_short_selloff"
    ? "trend_short_selloff"
    : "long_only";
export const BACKEND_PAPER_CRYPTO_TREND_LOOKBACK_DAYS = Number(
  process.env.BACKEND_PAPER_CRYPTO_TREND_LOOKBACK_DAYS ?? 10
);
export const BACKEND_PAPER_CRYPTO_TREND_BAND_PCT = Number(
  process.env.BACKEND_PAPER_CRYPTO_TREND_BAND_PCT ?? 0.015
);
export const BACKEND_PAPER_CRYPTO_SELLOFF_START_THRESHOLD = Number(
  process.env.BACKEND_PAPER_CRYPTO_SELLOFF_START_THRESHOLD ?? 0.7
);
export const BACKEND_PAPER_CRYPTO_SELLOFF_END_THRESHOLD = Number(
  process.env.BACKEND_PAPER_CRYPTO_SELLOFF_END_THRESHOLD ?? 0.52
);

export const RATE_LIMIT_WINDOW_MS = parsePositiveIntEnv("RATE_LIMIT_WINDOW_MS", 60_000);

export const RATE_LIMIT_MAX = parsePositiveIntEnv("RATE_LIMIT_MAX", 60);
export const RATE_LIMIT_MAX_READ = parsePositiveIntEnv("RATE_LIMIT_MAX_READ", 300);
export const RATE_LIMIT_MAX_BARS = parsePositiveIntEnv("RATE_LIMIT_MAX_BARS", 600);
export const RATE_LIMIT_MAX_BOT_READ = parsePositiveIntEnv("RATE_LIMIT_MAX_BOT_READ", 600);

// ---------------------------------------------------------------------------
// Helpers (exported so tests can use them directly)
// ---------------------------------------------------------------------------

export function parseCsvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parseOriginExemptPaths(): Set<string> {
  const paths = parseCsvEnv("ORIGIN_EXEMPT_PATHS");
  if (paths.length > 0) return new Set(paths);
  // Backwards-compatible alias while older environments migrate.
  const legacyPaths = parseCsvEnv("AUTH_EXEMPT_PATHS");
  if (legacyPaths.length > 0) return new Set(legacyPaths);
  return new Set(["/api/health"]);
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
