# Architecture

## Frontend

- Location: `frontend/`
- Hosting target: GitHub Pages
- Calls the data service through `VITE_API_BASE_URL` (see `frontend/src/App.tsx`)

## Data Service

- Location: `data-service/`
- Core logic: `data-service/core.ts`
- Local dev runtime: `data-service/server.ts`
- Hosted runtime (Vercel serverless): `data-service/api/health.ts`, `data-service/api/bars.ts`

## API contract

- `GET /api/health`
- `GET /api/bars?symbol=<ticker>&range=<1y|2y|5y|max>`

The frontend only depends on this contract, not on Alpaca directly.
