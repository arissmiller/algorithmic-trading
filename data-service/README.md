# Data Service

This folder is the backend service boundary for market data and bot execution.

## Purpose

Expose a stable contract to the frontend while isolating provider details.

- Frontend contract:
	- `/api/health`
	- `/api/bars?symbol=...&range=...` (returns `bars` and optional `earningsEvents`)
	- `/api/bars?symbol=...&timeframe=15Min&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` (returns `bars` and optional `earningsEvents`)
	- `/api/alpaca/account` (read-only snapshot)
	- `/api/bot/*` (protected bot + watchlist execution routes)
- Provider logic: Alpaca-only market data + normalization and error mapping

## Runtime entrypoints

- Local dev proxy: `server.ts`
- Serverless (Vercel): `api/health.ts`, `api/bars.ts`, `api/alpaca/account.ts`
- Bot execution engine: `botEngine.ts`
- Watchlist signal engine: `watchlistExecution.ts`
- Dispatch integration layer: `signalDispatch.ts`
- Optional bars cache adapter: `barCache.ts` (PostgreSQL)

All entrypoints use `core.ts` for market/account behavior consistency.

## Bot and Watchlist Routes

Bot engine control-plane routes are disabled by default. Set `ENABLE_BOT_ENGINE=true` to enable:

- `GET /api/bot/list`
- `POST /api/bot/start`
- `POST /api/bot/stop/:id`
- `DELETE /api/bot/:id`

Watchlist routes remain enabled:

- `GET /api/bot/watchlists`
- `PUT /api/bot/watchlists`
- `PUT /api/bot/watchlists/:userId`
- `DELETE /api/bot/watchlists/:userId`
- `POST /api/bot/watchlists/scan?timeframe=1Hour|1Day`
- `GET /api/bot/watchlist-signals?limit=100`
- `GET /api/bot/live-signals`
- `GET /api/bot/live-signals/status`
- `GET /api/bot/portfolio`
- `PUT /api/bot/portfolio`
  - Optional query param: `portfolio=<portfolio-key>`
- `GET /api/bot/paper-runner`
- `GET /api/bot/paper-runner/:id`
- `GET /api/bot/strategy-profiles`

## Bot Campaign Parameters

`POST /api/bot/start` accepts campaign-oriented inputs. The backend expands these into per-symbol bots and applies all strategy tuning from backend modules.

- `profile`:
  - One of:
    - `long_term_scale_in`
    - `short_term_scale_in`
    - `long_term_selloff`
    - `short_term_selloff`
    - `crash_buy_in`
    - `crash_selloff_detected`
- `startDate`:
  - Campaign start date (`YYYY-MM-DD`).
- `durationDays`:
  - Campaign duration; backend derives cadence from this duration.
- `symbol` or `symbols`:
  - Single symbol or list; when `symbols` is provided, one bot is started per symbol.
- `allocationMode`, `allocationPct`, `allocationFixed`:
  - Capital deployment controls.
- Validation:
  - `startDate` must be `YYYY-MM-DD`.
  - `durationDays` must be a positive integer.
  - `allocationPct` must be `0..100`.
  - `allocationFixed` must be `>= 0`.

All signal mixes, thresholds, cadence bounds, and history-based weighting heuristics are backend-owned in:

- `botTuning.ts`
- `botEngine.ts`

Frontend sends only high-level campaign parameters and a profile key.

Current watchlist behavior:

- Operator-managed mode (no external authentication service dependency).
- All callers share the same global watchlists and signal stream.
- API connection settings are stored under one operator identity (`DEFAULT_OPERATOR_USER_ID`, default `operator`).

Live portfolio behavior:

- Portfolio allocations/thresholds are file-backed at `data-service/live-portfolio-state.json` by default.
- Supports multiple named portfolios using `defaultPortfolioKey` + `portfolios[]` in the state file.
- Each portfolio can optionally define a `whitepaper` object (`title`, `url`, `aiGenerated`, optional `disclosure`) for UI linking and AI-origin transparency.
- Each portfolio can optionally define `launchedAt` (any valid date string) to display a stable "Live since ..." day in the live portfolio header.
- Edit that file directly to control target percentages.
- The service auto-reloads file edits on the next portfolio request.

## Why this split helps

- Frontend on GitHub Pages stays static
- Backend can evolve without touching frontend call sites
- Includes optional PostgreSQL bar-cache support for faster repeated backtests

## Railway hardening checklist

Before exposing this service publicly, set these Railway environment variables:

- `ALLOWED_ORIGINS`:
	- Comma-separated frontend origins allowed by CORS.
	- Example: `https://your-app.vercel.app,https://yourdomain.com`
	- Matching is normalized (`https://site.com` and `https://site.com/` are treated the same).
	- Supports optional wildcard subdomains like `https://*.yourdomain.com`.
- `REQUIRE_ORIGIN_HEADER`:
	- Defaults to `true` when `ALLOWED_ORIGINS` is set.
	- When enabled, requests without an `Origin` header are rejected on protected routes.
- `FRONTEND_SHARED_SECRET_HEADER`:
	- Optional custom header name allowed by CORS.
	- Default: `x-frontend-secret`
- `DEFAULT_OPERATOR_USER_ID`:
	- Optional logical user ID used for shared API connection credentials.
	- Default: `operator`
- `ENABLE_BOT_ENGINE`:
	- Set to `true` to enable `/api/bot/list`, `/api/bot/start`, `/api/bot/stop/:id`, and `/api/bot/:id`.
	- Default: `false` (returns 404 for bot engine control-plane routes).
- `ENABLE_LIVE_SIGNALS_MONITOR`:
	- Enables the backend live strategy signal monitor loop.
	- Default: `false`
- `LIVE_SIGNAL_SYMBOLS`:
	- Comma-separated symbols monitored by the live signal engine.
	- Example: `BTC/USD,ETH/USD,SOL/USD`
- `LIVE_SIGNAL_PROFILES`:
	- Optional comma-separated `botTuning` profile keys to monitor.
	- When omitted, all profiles are monitored.
- `LIVE_SIGNAL_HISTORY_LIMIT`:
	- Max in-memory live signal rows retained for `/api/bot/live-signals`.
	- Default: `500`
- `LIVE_PORTFOLIO_ALLOCATIONS`:
	- Optional default target weights for `/api/bot/portfolio` in `SYMBOL:PCT` format.
	- Example: `SPY:50,QQQ:30,TLT:20`
- `LIVE_PORTFOLIO_STATE_FILE`:
	- Optional path override for persisted portfolio allocation state.
	- Default: `<data-service>/live-portfolio-state.json`
- `LIVE_PORTFOLIO_SNAPSHOT_TTL_MS`:
	- Cache TTL (ms) for computed `/api/bot/portfolio` snapshots.
	- Default: `60000`
- `ENABLE_BACKEND_PAPER_CRYPTO_RUNNER`:
	- Enables backend-managed paper trading bot startup at server boot.
	- Default: `false`
- `BACKEND_PAPER_CRYPTO_SYMBOLS`:
	- Comma-separated symbols for backend-managed paper bots.
	- Example: `BTC/USD,ETH/USD`
- `BACKEND_PAPER_CRYPTO_TIMEFRAME`:
	- Polling timeframe for backend paper bots (`1Hour` or `1Day`).
	- Default: `1Hour`
- `BACKEND_PAPER_CRYPTO_ALLOCATION_USD`:
	- Per-order notional (USD) used by backend-managed paper bots.
	- Default: `100`
- `BACKEND_PAPER_CRYPTO_DIRECTION_MODE`:
	- Strategy mode for backend-managed paper bots.
	- Supported: `long_only` (default), `trend_short_selloff` (short selloffs in downtrends, buy entries in uptrends).
	- Default: `long_only`
- `BACKEND_PAPER_CRYPTO_TREND_LOOKBACK_DAYS`:
	- Lookback window used to classify trend regime for `trend_short_selloff`.
	- Default: `10`
- `BACKEND_PAPER_CRYPTO_TREND_BAND_PCT`:
	- Minimum absolute return over the trend lookback window to classify uptrend/downtrend.
	- Example: `0.015` = 1.5% band; inside band is treated as neutral.
	- Default: `0.015`
- `BACKEND_PAPER_CRYPTO_SELLOFF_START_THRESHOLD`:
	- Selloff detection score threshold that activates short-entry conditions in `trend_short_selloff`.
	- Default: `0.70`
- `BACKEND_PAPER_CRYPTO_SELLOFF_END_THRESHOLD`:
	- Selloff detection score threshold that deactivates selloff state and triggers short-cover conditions.
	- Must be lower than start threshold.
	- Default: `0.52`
- `ALLOW_LIVE_CRYPTO_TRADING`:
	- Safety switch required for non-paper live order submission.
	- Default: `false`
- `ORIGIN_EXEMPT_PATHS`:
	- Optional comma-separated route list that should skip origin checks.
	- Default: `/api/health`
	- Backward-compatible alias: `AUTH_EXEMPT_PATHS`
- `RATE_LIMIT_WINDOW_MS`:
	- Rate limit window in milliseconds.
	- Default: `60000`
- `RATE_LIMIT_MAX`:
	- Max requests per IP in the window for mutating routes (`POST`, `PUT`, `DELETE`).
	- Default: `60`
- `RATE_LIMIT_MAX_READ`:
	- Max requests per IP in the window for general read routes (`GET`).
	- Default: `300`
- `RATE_LIMIT_MAX_BARS`:
	- Max requests per IP in the window for `/api/bars` reads.
	- Default: `600`
- `RATE_LIMIT_MAX_BOT_READ`:
	- Max requests per IP in the window for hot-read bot/community routes:
	  `/api/bot/portfolio`, `/api/bot/live-signals`, `/api/bot/live-signals/status`,
	  and `/api/community/watchlists`.
	- Default: `600`
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
- `ALPHA_VANTAGE_API_KEY`:
	- Optional fallback API key used to enrich `/api/bars` responses with stock earnings events
	  when SEC-backed persistence is not configured.
- `ALPHA_VANTAGE_EARNINGS_URL`:
	- Optional override for the Alpha Vantage fallback earnings endpoint base URL.
	- Default: `https://www.alphavantage.co/query`
- `EARNINGS_CACHE_TTL_MS`:
	- Optional in-memory cache TTL (milliseconds) for Alpha Vantage fallback earnings lookups.
	- Default: `21600000` (6 hours)
- `SEC_EDGAR_USER_AGENT`:
	- Required for SEC data API access. Must identify your app and contact.
	- Example: `SmartScale/1.0 admin@yourdomain.com`
- `SEC_EARNINGS_DATABASE_URL`:
	- PostgreSQL connection string for persistent SEC earnings storage.
	- If unset, falls back to `BACKTEST_CACHE_DATABASE_URL`.
- `SEC_EARNINGS_TABLE`:
	- Optional table name for persisted SEC earnings events.
	- Default: `backtest_sec_earnings_cache`
- `SEC_EARNINGS_TTL_MS`:
	- How long SEC earnings data remains fresh before being reloaded.
	- Default: `86400000` (24 hours)
- `SEC_EARNINGS_RETRY_TTL_MS`:
	- Backoff window after SEC fetch failures before retrying stale symbols.
	- Default: `3600000` (1 hour)
- `SEC_EARNINGS_SYNC_ENABLED`:
	- Enables background stale-symbol refresh loop in `server.ts`.
	- Default: `true`
- `SEC_EARNINGS_SYNC_INTERVAL_MS`:
	- Background refresh cadence for stale tracked symbols.
	- Default: `21600000` (6 hours)
- `SEC_EARNINGS_SYNC_BATCH_SIZE`:
	- Max stale symbols refreshed per sync tick.
	- Default: `25`
- `SEC_TICKER_MAP_TTL_MS`:
	- Cache TTL for SEC ticker→CIK lookup map.
	- Default: `86400000` (24 hours)
- `SEC_REQUEST_TIMEOUT_MS`:
	- Timeout for SEC API requests.
	- Default: `12000`
- `SEC_REQUEST_SPACING_MS`:
	- Minimum delay between SEC requests to stay within fair-access guidance.
	- Default: `160`
- `SEC_TICKERS_URL`:
	- Optional override for SEC ticker/CIK mapping URL.
	- Default: `https://www.sec.gov/files/company_tickers.json`
- `SEC_DATA_BASE_URL`:
	- Optional override for SEC JSON API base URL.
	- Default: `https://data.sec.gov`
- `BACKTEST_CACHE_DATABASE_URL`:
	- Optional PostgreSQL connection string for persistent Alpaca bar caching used by `/api/bars`.
	- Recommended: point this at a second Railway Postgres instance dedicated to market-data cache.
	- If unset, `/api/bars` still uses in-memory cache per service instance (non-persistent); Postgres adds persistence across restarts/instances.
- `BACKTEST_CACHE_TABLE`:
	- Optional table name for bar cache records.
	- Default: `backtest_bars_cache`
- `BAR_CACHE_TTL_1_DAY_MS`:
	- Optional cache TTL for daily (`1Day`) bars.
	- Default: `21600000` (6 hours)
- `BAR_CACHE_TTL_1_HOUR_MS`:
	- Optional cache TTL for hourly (`1Hour`) bars.
	- Default: `1800000` (30 minutes)
- `BAR_CACHE_TTL_15_MIN_MS`:
	- Optional cache TTL for 15-minute (`15Min`) day-sliced bars.
	- Default: `86400000` (24 hours)
- `BAR_CACHE_TTL_5_MIN_MS`:
	- Optional cache TTL for 5-minute (`5Min`) day-sliced bars.
	- Default: `43200000` (12 hours)
- `MARKET_DATA_MAX_CONCURRENT_REQUESTS`:
	- Max concurrent outbound upstream market-data/account requests per service instance.
	- Default: `4`
- `MARKET_DATA_MIN_INTERVAL_MS`:
	- Minimum spacing between outbound upstream request starts (milliseconds), used to smooth bursts.
	- Default: `120`
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
- `^GSPC` requests are mapped to `SPY` for Alpaca bars.
- For stock symbols, `/api/bars` includes historical earnings markers (`earningsEvents`) from
  persistent SEC EDGAR data when `SEC_EDGAR_USER_AGENT` and a Postgres URL are configured.
- The SEC earnings table is automatically updated on-demand when symbols are requested, and stale
  tracked symbols are refreshed in the background by the `server.ts` sync loop.
- If SEC-backed persistence is unavailable, Alpha Vantage can still provide fallback earnings data.
- `15Min` requests are intended for intraday/day-trading backtests and require `startDate` + `endDate`.
- `15Min` bars are fetched and cached per day (`symbol + YYYY-MM-DD + timeframe`) so repeated tests on the same stocks are much faster.
- `/api/bars` also uses in-flight request deduplication and outbound request pacing to reduce duplicate upstream calls during concurrent loads.
- `/api/bars` and read-only `/api/bot/*` endpoints set short `Cache-Control` headers so browsers/CDNs can absorb polling traffic.
- `/api/alpaca/*` endpoints remain read-only by design.
- `/api/bot/*` endpoints are operator control-plane routes and can place Alpaca orders for running bots.

Example frontend request (server-side runtime):

```ts
await fetch(`${process.env.DATA_SERVICE_URL}/api/bars?symbol=AAPL&range=2y`);
```
