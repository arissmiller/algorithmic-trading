# Data Service

This folder is the backend service boundary for market data.

## Purpose

Expose a stable contract to the frontend while isolating provider details.

- Frontend contract: `/api/health`, `/api/bars?symbol=...&range=...`
- Provider logic: Yahoo Finance fetch, normalization, and error mapping

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

Notes:

- CORS controls browser access, not true authentication. Non-browser clients can still call your API directly.
- Shared-secret auth only stays secret if your frontend calls this API from server-side code.
- If your frontend is fully static/browser-only, no client-side secret is truly private.

Example frontend request (server-side runtime):

```ts
await fetch(`${process.env.DATA_SERVICE_URL}/api/bars?symbol=AAPL&range=2y`, {
  headers: {
    Authorization: `Bearer ${process.env.FRONTEND_SHARED_SECRET}`,
  },
});
```
