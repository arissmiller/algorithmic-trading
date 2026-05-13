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

export const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);

export const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);

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
