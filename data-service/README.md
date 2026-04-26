# Data Service

This folder is the backend service boundary for market data.

## Purpose

Expose a stable contract to the frontend while isolating provider details.

- Frontend contract:
	- `/api/health`
	- `/api/bars?symbol=...&range=...`
	- `/api/alpaca/account` (read-only snapshot; no trading/order routes exposed)
- Provider logic: Alpaca-only market data + normalization and error mapping

## Runtime entrypoints

- Local dev proxy: `server.ts`
- Serverless (Vercel): `api/health.ts`, `api/bars.ts`, `api/alpaca/account.ts`

Both entrypoints use `core.ts` so behavior stays consistent.

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

Notes:

- CORS controls browser access, not true authentication. Non-browser clients can still call your API directly.
- Shared-secret auth only stays secret if your frontend calls this API from server-side code.
- If your frontend is fully static/browser-only, no client-side secret is truly private.
- `^GSPC` requests are mapped to `SPY` for Alpaca bars.
- No account mutation or order placement API is exposed by this service. It is read-only by design.

Example frontend request (server-side runtime):

```ts
await fetch(`${process.env.DATA_SERVICE_URL}/api/bars?symbol=AAPL&range=2y`, {
  headers: {
    Authorization: `Bearer ${process.env.FRONTEND_SHARED_SECRET}`,
  },
});
```
