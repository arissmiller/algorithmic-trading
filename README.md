# Algorithmic Trading Monorepo

This repository is a small monorepo for a static frontend plus two backend services:

- `frontend/`: React + Vite UI for backtests, strategy experiments, and live portfolio pages
- `data-service/`: market-data and trading-oriented backend used by the frontend
- `dispatch-service/`: signal delivery backend for notifications and user dispatch preferences

If you are reading the code for the first time, start by treating each folder above as a service boundary. The frontend owns user-facing workflows. `data-service` owns market data, portfolio state, and bot/watchlist APIs. `dispatch-service` owns notification fan-out and delivery preferences.

## How The Pieces Fit

Typical request flow:

1. The browser loads the static app from `frontend/`.
2. Frontend route code calls `data-service` through `VITE_API_BASE_URL`.
3. `data-service` serves bars, portfolio snapshots, and bot/watchlist routes.
4. When watchlist signals should be forwarded, `data-service` optionally posts them to `dispatch-service` through `SIGNAL_DISPATCH_URL`.
5. `dispatch-service` resolves per-user delivery settings and sends or logs the resulting notifications.

That split lets the UI stay deployable as a static site while backend behavior evolves independently.

## Repo Layout

```text
.
├── frontend/          React application
├── data-service/      Market data + bot/watchlist backend
├── dispatch-service/  Signal delivery backend
└── scripts/           Repo-level helper scripts
```

## Where To Start Reading

- Frontend entry: `frontend/src/main.tsx`
- Frontend routes: `frontend/src/app/AppRoutes.tsx`
- Shared backtesting workspace: `frontend/src/features/backtesting/BacktestingWorkspace.tsx`
- Data-service entry: `data-service/server.ts`
- Data-service route handlers: `data-service/routes/barsRoute.ts`, `data-service/routes/botRoutes.ts`
- Dispatch-service entry: `dispatch-service/server.ts`
- Dispatch-service routing and delivery orchestration: `dispatch-service/src/dispatcher.ts`, `dispatch-service/src/delivery.ts`

If you want the fastest architectural orientation, read those files in that order.

## Local Development

Install root dependencies once:

```bash
npm install
```

Common commands from the repo root:

- `npm run dev`: run `data-service` and `frontend` together
- `npm run dev:frontend`: run only the frontend
- `npm run dev:api`: run only `data-service`
- `npm run dev:dispatch`: run only `dispatch-service`
- `npm run build`: build the frontend
- `npm run build:api`: typecheck/build `data-service`
- `npm run build:dispatch`: typecheck/build `dispatch-service`
- `npm run build:frontend`: typecheck/build the frontend

The frontend expects a reachable backend URL via `VITE_API_BASE_URL`. The two backend services each document their own environment variables in their service README files.

## Service Docs

- [frontend/README.md](frontend/README.md)
- [data-service/README.md](data-service/README.md)
- [dispatch-service/README.md](dispatch-service/README.md)

## Reader Notes

- The frontend is route-driven. New user-facing experiences usually begin in `frontend/src/app/AppRoutes.tsx`.
- The backtesting UI has been split into feature folders under `frontend/src/features/` rather than staying in one page component.
- `data-service` is intentionally a plain Node HTTP service instead of an Express app, so route flow is easiest to follow directly from `server.ts`.
- `dispatch-service` is also a plain Node HTTP service and persists lightweight state to JSON files by default.
