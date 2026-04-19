# Data Service

This folder is the backend service boundary for market data.

## Purpose

Expose a stable contract to the frontend while isolating provider details.

- Frontend contract: `/api/health`, `/api/bars?symbol=...&range=...`
- Provider logic: Alpaca (primary), Yahoo/Twelve Data fallback, normalization, and error mapping

## Runtime entrypoints

- Local dev proxy: `server.ts`
- Serverless (Vercel): `api/health.ts`, `api/bars.ts`

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
	- Optional but recommended.
	- When set, Alpaca becomes the primary data provider.
- `ALPACA_FEED`:
	- Data feed for Alpaca stock bars.
	- Default: `iex`
- `ALPACA_DATA_BASE_URL`:
	- Optional override for Alpaca market data base URL.
	- Default: `https://data.alpaca.markets/v2`
- `ALPACA_REQUEST_TIMEOUT_MS`:
	- Timeout per Alpaca request.
	- Default: `10000`
- `TWELVEDATA_API_KEY`:
	- Optional fallback provider key when Yahoo is unavailable.
	- Default: `demo` (recommended to replace with your free Twelve Data key for better reliability)
- `TWELVEDATA_BASE_URL`:
	- Optional override for Twelve Data API base URL.
	- Default: `https://api.twelvedata.com`
- `YAHOO_REQUEST_TIMEOUT_MS`:
	- Timeout per Yahoo upstream request.
	- Default: `10000`
- `TWELVEDATA_REQUEST_TIMEOUT_MS`:
	- Timeout for Twelve Data fallback request.
	- Default: `10000`

Notes:

- CORS controls browser access, not true authentication. Non-browser clients can still call your API directly.
- Shared-secret auth only stays secret if your frontend calls this API from server-side code.
- If your frontend is fully static/browser-only, no client-side secret is truly private.
- Provider order is Alpaca (when APCA keys are set) -> Yahoo -> Twelve Data.
- For fallback requests, `^GSPC` is mapped to `SPY` when querying Twelve Data.

Example frontend request (server-side runtime):

```ts
await fetch(`${process.env.DATA_SERVICE_URL}/api/bars?symbol=AAPL&range=2y`, {
  headers: {
    Authorization: `Bearer ${process.env.FRONTEND_SHARED_SECRET}`,
  },
});
```
