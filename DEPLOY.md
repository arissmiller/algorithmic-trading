# Deploy

## Railway (Frontend + Data Service)

Both services are deployed to Railway. The frontend is a static Vite build served via `vite preview`, and the data-service is a long-running Node.js server that hosts the Alpaca proxy and paper trading bots.

### One-time setup

1. Create a [Railway](https://railway.app) account and a new project.
2. Inside the project, create two services:
   - **frontend** — set the root directory to `frontend/`
   - **data-service** — set the root directory to `data-service/`
3. In Railway project settings, generate a **project token** (Settings → Tokens).
4. In GitHub repository settings → Secrets and variables → Actions → Secrets, add:
   - `RAILWAY_TOKEN` — the project token from step 3

### Environment variables

Set these in the Railway dashboard for each service:

**frontend** service:
| Variable | Value |
|---|---|
| `VITE_API_BASE_URL` | URL of your deployed data-service (e.g. `https://data-service.up.railway.app`) |

**data-service** service:
| Variable | Value |
|---|---|
| `APCA_API_KEY_ID` | Alpaca paper trading API key |
| `APCA_API_SECRET_KEY` | Alpaca paper trading secret |
| `ALPACA_TRADING_BASE_URL` | `https://paper-api.alpaca.markets/v2` |
| `ALLOWED_ORIGINS` | URL of your deployed frontend (e.g. `https://frontend.up.railway.app`) |
| `FRONTEND_SHARED_SECRET` | Shared secret for frontend → data-service auth (optional but recommended) |

### Deploy

Push to `main` — the workflow `.github/workflows/deploy-railway.yml` deploys both services in parallel.

You can also trigger a manual deploy from the Actions tab.

### Service names

The workflow uses `railway up --service frontend` and `railway up --service data-service`. If you named your Railway services differently, update the `--service` flags in `.github/workflows/deploy-railway.yml`.

### Bot state persistence

Railway has an ephemeral filesystem — `bot-state.json` is lost on each redeploy. Running bots will need to be restarted after a deploy. For durable state, consider adding a Railway PostgreSQL or Redis service in the future.

---

## Local Dev

From repo root:

1. `npm install`
2. `npm run dev`

That runs:

- `data-service` on `http://127.0.0.1:3001`
- `frontend` on `http://127.0.0.1:1420` (with `/api` proxy to data-service)
