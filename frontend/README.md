# Frontend

This folder contains the React + Vite application for the repo.

The frontend is intentionally thin on backend business logic. It owns route structure, UI state, chart/table presentation, and backtest orchestration, while `data-service` owns data access and strategy-supporting backend APIs.

## Start Here In The Code

- `src/main.tsx`: React bootstrap and `HashRouter` setup
- `src/app/AppRoutes.tsx`: top-level route map and lazy-loaded page boundaries
- `src/app/navigation.ts`: canonical navigation groups and path constants
- `src/App.tsx`: shared app shell
- `src/features/backtesting/BacktestingWorkspace.tsx`: main stocks/crypto backtesting workspace shell
- `src/lib/apiFetch.ts`: backend request wrapper using `VITE_API_BASE_URL`

If you want to understand the app structure quickly, read those files in that order.

## What Lives Where

- `src/app/`: app shell, route definitions, app-wide constants/navigation
- `src/components/`: page components and reusable UI pieces
- `src/features/backtesting/`: shared backtesting workspace state and orchestration
- `src/features/portfolioBacktest/`: portfolio-backtest-specific helpers and UI
- `src/lib/`: lower-level client helpers, backtest engines, and shared utilities

## Route Shape

`AppRoutes.tsx` is the fastest way to see what the product currently exposes:

- Stock and crypto backtesting workspaces
- Focused crypto strategy pages
- Weighted portfolio comparison page
- Live portfolio pages
- Live portfolio backtest pages

Most new user-facing work should start by deciding whether it belongs in the shared backtesting workspace or in a dedicated page component.

## Backend Integration

The frontend talks to the backend through `VITE_API_BASE_URL`.

- `src/lib/apiFetch.ts` and app constants normalize the base URL
- Route/page components call backend APIs rather than embedding provider logic locally
- The router uses `HashRouter`, which matches the static-hosting deployment model

## Local Dev

From the repo root:

1. `npm install`
2. `npm run dev:frontend`

From inside `frontend/`:

1. `npm install`
2. `npm run dev`

Default Vite dev server: `http://127.0.0.1:5173`

Build:

- `npm --prefix frontend run build`

## Reader Notes

- The frontend has both page-level components and strategy logic under `src/lib/`; when investigating correctness, check both the page wiring and the underlying backtest engine.
- Shared backtesting flows have been moving into `src/features/backtesting/` so route-level pages stay smaller and easier to reason about.
- Because the app is static-hosted, backend URL and origin behavior matter more than server-side rendering concerns.
