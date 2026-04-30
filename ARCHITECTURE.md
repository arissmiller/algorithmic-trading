# Architecture

## Frontend

- Location: `frontend/`
- Hosting target: GitHub Pages
- Calls backend services through environment-configured base URLs
  - Data service: `VITE_API_BASE_URL`
  - Auth service: `VITE_AUTH_API_BASE_URL`

## Data Service

- Location: `data-service/`
- Core logic: `data-service/core.ts`
- Local dev runtime: `data-service/server.ts`
- Hosted runtime (Vercel serverless): `data-service/api/health.ts`, `data-service/api/bars.ts`
- Bot runtime: `data-service/bot.ts`
- Multi-user watchlist signal execution: `data-service/watchlistExecution.ts`
- Dispatch client abstraction: `data-service/signalDispatch.ts`

## Auth Service

- Location: `auth-service/`
- Local/hosted runtime: `auth-service/server.ts`
- Core auth logic: `auth-service/src/authCore.ts`
- Persistence (v1): `auth-service/auth-state.json` file

## Dispatch Service

- Location: `dispatch-service/`
- Local/hosted runtime: `dispatch-service/server.ts`
- Channel routing core: `dispatch-service/src/dispatcher.ts`
- User profile persistence: `dispatch-service/src/profileStore.ts`

## API contracts

Data service:
- `GET /api/health`
- `GET /api/bars?symbol=<ticker>&range=<1y|2y|5y|max>`
- `GET /api/alpaca/account`
- `GET /api/bot/list`
- `POST /api/bot/start`
- `POST /api/bot/stop/:id`
- `DELETE /api/bot/:id`
- `GET /api/bot/watchlists`
- `PUT /api/bot/watchlists`
- `PUT /api/bot/watchlists/:userId`
- `DELETE /api/bot/watchlists/:userId`
- `POST /api/bot/watchlists/scan`
- `GET /api/bot/watchlist-signals`

Watchlist auth model:
- Shared-secret callers are treated as admin and can access all watchlists/signals.
- Bearer callers are validated via auth-service and scoped to their own user IDs.

Auth service:
- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/verify-email`
- `GET /api/auth/verify-email?token=...`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`

Dispatch service:
- `GET /api/health`
- `GET /api/dispatch/users`
- `GET /api/dispatch/users/:userId`
- `PUT /api/dispatch/users/:userId`
- `DELETE /api/dispatch/users/:userId`
- `POST /api/dispatch/signal`
- `GET /api/dispatch/events?limit=100`

The frontend depends on these service contracts, not direct provider APIs.
