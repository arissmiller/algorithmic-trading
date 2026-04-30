# Data Service

This folder is the backend service boundary for market data and bot execution.

## Purpose

Expose a stable contract to the frontend while isolating provider details.

- Frontend contract:
	- `/api/health`
	- `/api/bars?symbol=...&range=...`
	- `/api/alpaca/account` (read-only snapshot)
	- `/api/bot/*` (protected bot + watchlist execution routes)
- Provider logic: Alpaca-only market data + normalization and error mapping

## Runtime entrypoints

- Local dev proxy: `server.ts`
- Serverless (Vercel): `api/health.ts`, `api/bars.ts`, `api/alpaca/account.ts`
- Bot execution engine: `bot.ts`
- Multi-user watchlist signal engine: `watchlistExecution.ts`
- Dispatch integration layer: `signalDispatch.ts`

All entrypoints use `core.ts` for market/account behavior consistency.

## Bot and Watchlist Routes (protected)

- `GET /api/bot/list`
- `POST /api/bot/start`
- `POST /api/bot/stop/:id`
- `DELETE /api/bot/:id`
- `GET /api/bot/watchlists`
- `PUT /api/bot/watchlists`
- `PUT /api/bot/watchlists/:userId`
- `DELETE /api/bot/watchlists/:userId`
- `POST /api/bot/watchlists/scan?timeframe=1Hour|1Day`
- `GET /api/bot/watchlist-signals?limit=100`

Watchlist endpoint auth behavior:

- Shared-secret caller (`FRONTEND_SHARED_SECRET`) is treated as admin and can access all watchlists/signals.
- Bearer auth caller is validated against the auth service (`GET /api/auth/me`) and is scoped to its own user ID (`userId` or `${userId}:...`).
- `PUT /api/bot/watchlists` (bulk replace) is admin-only.

## Why this split helps

- Frontend on GitHub Pages stays static
- Backend can evolve without touching frontend call sites
- Easier to add caching/rate-limit handling later

## Railway hardening checklist

Before exposing this service publicly, set these Railway environment variables:

- `ALLOWED_ORIGINS`:
	- Comma-separated frontend origins allowed by CORS.
	- Example: `https://your-app.vercel.app,https://yourdomain.com`
- `REQUIRE_ORIGIN_HEADER`:
	- Defaults to `true` when `ALLOWED_ORIGINS` is set.
	- When enabled, requests without an `Origin` header are rejected on protected routes.
- `FRONTEND_SHARED_SECRET`:
	- Optional but recommended for stronger protection.
	- If set, protected routes require either `Authorization: Bearer <secret>` or `x-frontend-secret: <secret>`.
- `AUTH_API_BASE_URL`:
	- Base URL for the auth service used to validate bearer sessions for watchlist routes.
	- Example: `https://auth-service.up.railway.app`
	- In pure local non-Railway development, defaults to `http://127.0.0.1:3002` when unset.
	- When running with Railway environment variables, this must be set explicitly to the auth-service public URL.
- `AUTH_API_TIMEOUT_MS`:
	- Timeout in milliseconds for auth session validation calls.
	- Default: `5000`
- `FRONTEND_SHARED_SECRET_HEADER`:
	- Optional custom header name for the shared secret.
	- Default: `x-frontend-secret`
- `AUTH_EXEMPT_PATHS`:
	- Optional comma-separated route list that should skip auth/origin checks.
	- Default: `/api/health`
- `RATE_LIMIT_WINDOW_MS`:
	- Rate limit window in milliseconds.
	- Default: `60000`
- `RATE_LIMIT_MAX`:
	- Max requests per IP in the window.
	- Default: `60`
- `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY`:
	- Required for market bars and account snapshots.
	- If missing, `/api/bars` and `/api/alpaca/account` return a credential error.
- `ALPACA_FEED`:
	- Data feed for Alpaca stock bars.
	- Default: `iex`
- `ALPACA_DATA_BASE_URL`:
	- Optional override for Alpaca market data base URL.
	- Default: `https://data.alpaca.markets/v2`
- `ALPACA_TRADING_BASE_URL`:
	- Optional override for Alpaca trading/account base URL.
	- Used by `/api/alpaca/account`.
	- Default: `https://paper-api.alpaca.markets/v2`
- `APCA_API_BASE_URL`:
	- Optional Alpaca base URL alias for trading/account requests.
	- If set without `/v2`, the service appends `/v2`.
- `ALPACA_REQUEST_TIMEOUT_MS`:
	- Timeout per Alpaca request.
	- Default: `10000`
- `SIGNAL_DISPATCH_URL`:
	- Optional HTTP endpoint to receive generated watchlist signals.
	- Example: `https://dispatch-service.up.railway.app/api/dispatch/signal`
	- If unset, signals are still generated and stored, but dispatch is marked as skipped.
- `SIGNAL_DISPATCH_TIMEOUT_MS`:
	- Timeout in milliseconds for dispatch HTTP requests.
	- Default: `5000`
- `SIGNAL_DISPATCH_AUTH_HEADER`:
	- Optional auth header name used when sending to dispatch service.
	- Default: `x-dispatch-token`
- `SIGNAL_DISPATCH_AUTH_TOKEN`:
	- Optional auth token value sent to the dispatch service.
- `WATCHLIST_SIGNAL_HISTORY_LIMIT`:
	- Max in-memory watchlist signal events retained for `/api/bot/watchlist-signals`.
	- Default: `500`

Notes:

- CORS controls browser access, not true authentication. Non-browser clients can still call your API directly.
- Shared-secret auth only stays secret if your frontend calls this API from server-side code.
- If your frontend is fully static/browser-only, no client-side secret is truly private.
- `^GSPC` requests are mapped to `SPY` for Alpaca bars.
- `/api/alpaca/*` endpoints remain read-only by design.
- `/api/bot/*` endpoints are protected control-plane routes and can place Alpaca orders for running bots.

Example frontend request (server-side runtime):

```ts
await fetch(`${process.env.DATA_SERVICE_URL}/api/bars?symbol=AAPL&range=2y`, {
  headers: {
    Authorization: `Bearer ${process.env.FRONTEND_SHARED_SECRET}`,
  },
});
```
