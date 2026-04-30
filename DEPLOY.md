# Deploy

## Railway Development Environment (Recommended)

Use a dedicated Railway `development` environment for day-to-day work so production is isolated.

### One-time local setup

From repo root:

1. `npm install`
2. `railway login`
3. `railway link`
4. `npm run railway:dev:bootstrap`

What this does:

- Verifies Railway CLI auth and project link
- Creates `development` by duplicating `production` (if needed)
- Links your local directory to `development`
- Checks that `frontend`, `data-service`, `auth-service`, and `dispatch-service` exist in `development`
- Warns when auth-routing variables are missing for Railway-backed local dev

### Daily development flow

1. `npm run railway:status:dev`
2. `npm run dev:railway`

`npm run dev:railway` runs frontend + data-service + auth-service locally via Railway environment variables. Run `npm run dev:dispatch:railway` in a separate terminal when testing dispatch-service locally.

For Railway-backed local dev, set both auth URL variables explicitly:

- `AUTH_API_BASE_URL` on `data-service` to the public auth-service URL
- `VITE_AUTH_API_BASE_URL` on `frontend` to the public auth-service URL

The localhost auth fallback only applies to pure local dev, not `railway run` development.

### Deploy to the dev environment

From repo root:

- `npm run railway:deploy:dev:all` (deploys all 4 services)
- `npm run railway:deploy:dev:frontend`
- `npm run railway:deploy:dev:data`
- `npm run railway:deploy:dev:auth`
- `npm run railway:deploy:dev:dispatch`

The deploy scripts target service-specific folders in this monorepo:

- `frontend/` → `frontend` service
- `data-service/` → `data-service` service
- `auth-service/` → `auth-service` service
- `dispatch-service/` → `dispatch-service` service

### Useful Railway commands

- `npm run railway:whoami`
- `npm run railway:env:dev:link`
- `railway logs --service data-service --environment development`
- `railway logs --service auth-service --environment development`
- `railway logs --service dispatch-service --environment development`

### Troubleshooting

If deploy fails with `service not found` for auth:

1. `railway service list --environment development`
2. If `auth-service` is missing: `railway add --service auth-service`
3. Retry: `npm run railway:deploy:dev:auth` or `npm run railway:deploy:dev:all`

If frontend auth/register calls return `HTTP 500`:

1. Ensure auth-service has a public domain:
   - `railway domain --service auth-service`
2. Ensure frontend points at that public auth URL:
   - `railway variable set --service frontend --environment development VITE_AUTH_API_BASE_URL=https://<your-auth-domain>`
3. Redeploy frontend:
   - `npm run railway:deploy:dev:frontend`

If watchlist or market-data connection pages show `Auth service is unavailable` or `Auth service is not configured`:

1. Confirm the auth-service URL exists in dev:
   - `railway service list --environment development`
2. Set data-service auth validation to that URL:
   - `railway variable set --service data-service --environment development AUTH_API_BASE_URL=https://<your-auth-domain>`
3. Set frontend auth calls to that same URL:
   - `railway variable set --service frontend --environment development VITE_AUTH_API_BASE_URL=https://<your-auth-domain>`
4. Recommended: allow the frontend origin on both APIs:
   - `railway variable set --service data-service --environment development ALLOWED_ORIGINS=https://<your-frontend-domain>`
   - `railway variable set --service auth-service --environment development ALLOWED_ORIGINS=https://<your-frontend-domain>`
5. Redeploy or restart the affected services:
   - `npm run railway:deploy:dev:data`
   - `npm run railway:deploy:dev:auth`
   - `npm run railway:deploy:dev:frontend`

---

## Railway Production (Frontend + Data Service + Auth Service + Dispatch Service)

All services are deployed to Railway.

- `frontend` is a static Vite build served by `vite preview`.
- `data-service` is a long-running Node.js API for market/account/bot data.
- `auth-service` is a long-running Node.js API for account registration/login/sessions.
- `dispatch-service` is a long-running Node.js API for email/SMS routing.

### One-time setup

1. Create a [Railway](https://railway.app) account and a new project.
2. Inside the project, create four services:
   - **frontend** — set root directory to `frontend/`
   - **data-service** — set root directory to `data-service/`
   - **auth-service** — set root directory to `auth-service/`
   - **dispatch-service** — set root directory to `dispatch-service/`
3. In Railway project settings, generate a **project token** (Settings → Tokens).
4. In GitHub repository settings → Secrets and variables → Actions → Secrets, add:
   - `RAILWAY_TOKEN` — the project token from step 3

### Environment variables

Set these in Railway for each service.

**frontend** service:

| Variable | Value |
|---|---|
| `VITE_API_BASE_URL` | URL of deployed data-service (e.g. `https://data-service.up.railway.app`) |
| `VITE_AUTH_API_BASE_URL` | URL of deployed auth-service (e.g. `https://auth-service.up.railway.app`) |
| `VITE_DISPATCH_API_BASE_URL` | URL of deployed dispatch-service (e.g. `https://dispatch-service.up.railway.app`) |
| `VITE_DISPATCH_AUTH_HEADER` | Optional dispatch auth header name (default `x-dispatch-token`) |
| `VITE_DISPATCH_AUTH_TOKEN` | Optional dispatch auth token, only if dispatch routes are token-protected |

**data-service** service:

| Variable | Value |
|---|---|
| `APCA_API_KEY_ID` | Alpaca paper trading API key |
| `APCA_API_SECRET_KEY` | Alpaca paper trading secret |
| `ALPACA_TRADING_BASE_URL` | `https://paper-api.alpaca.markets/v2` |
| `ALLOWED_ORIGINS` | URL of deployed frontend |
| `FRONTEND_SHARED_SECRET` | Shared secret for frontend → data-service auth (optional but recommended) |
| `AUTH_API_BASE_URL` | URL of deployed auth-service for bearer session validation on watchlist routes (for example `https://auth-service.up.railway.app`) |
| `AUTH_API_TIMEOUT_MS` | Optional auth validation timeout in ms (default `5000`) |
| `SIGNAL_DISPATCH_URL` | Optional dispatch microservice endpoint for generated watchlist signals (for example `https://dispatch-service.up.railway.app/api/dispatch/signal`) |
| `SIGNAL_DISPATCH_AUTH_HEADER` | Optional dispatch auth header name (default `x-dispatch-token`) |
| `SIGNAL_DISPATCH_AUTH_TOKEN` | Optional dispatch auth token value |
| `SIGNAL_DISPATCH_TIMEOUT_MS` | Optional dispatch timeout in ms (default `5000`) |
| `WATCHLIST_SIGNAL_HISTORY_LIMIT` | Optional in-memory signal history size (default `500`) |

**auth-service** service:

| Variable | Value |
|---|---|
| `ALLOWED_ORIGINS` | URL of deployed frontend |
| `DATABASE_URL` | PostgreSQL connection string used for auth users/sessions |
| `AUTH_TOKEN_TTL_SECONDS` | Session token lifespan in seconds (default `2592000`) |
| `EMAIL_VERIFICATION_REQUIRED` | `true` to require verification before login |
| `EMAIL_VERIFICATION_TOKEN_TTL_SECONDS` | Verification token TTL (default `86400`) |
| `EMAIL_VERIFICATION_BASE_URL` | Frontend base URL used for verification links |
| `EMAIL_VERIFICATION_LOG_ONLY_MODE` | `true` for dev full-email logging, `false` to require SMTP send |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP server settings |
| `SMTP_USER`, `SMTP_PASS` | SMTP credentials |
| `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` | Sender identity for verification emails |
| `SMTP_REPLY_TO` | Optional reply-to address |

**dispatch-service** service:

| Variable | Value |
|---|---|
| `ALLOWED_ORIGINS` | Optional allowed origins for browser-based profile management |
| `DISPATCH_AUTH_HEADER` | Header name for dispatch API auth (default `x-dispatch-token`) |
| `DISPATCH_AUTH_TOKEN` | Shared token expected on `/api/dispatch/*` routes |
| `DISPATCH_STATE_FILE` | Optional custom path for profile persistence file |
| `DISPATCH_EVENT_HISTORY_LIMIT` | Optional in-memory dispatch event history size (default `500`) |
| `DISPATCH_EMAIL_LOG_ONLY_MODE` | `true` for dev email logging, `false` to use SMTP send |
| `DISPATCH_SMS_LOG_ONLY_MODE` | `true` for dev SMS logging, `false` to use Twilio send |
| `DISPATCH_SMTP_HOST`, `DISPATCH_SMTP_PORT`, `DISPATCH_SMTP_SECURE` | SMTP server settings for email dispatch |
| `DISPATCH_SMTP_USER`, `DISPATCH_SMTP_PASS` | SMTP credentials |
| `DISPATCH_SMTP_FROM_EMAIL`, `DISPATCH_SMTP_FROM_NAME` | Sender identity for dispatch emails |
| `DISPATCH_SMTP_REPLY_TO` | Optional reply-to address for dispatch emails |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio account credentials for SMS dispatch |
| `TWILIO_FROM_PHONE_E164` | Twilio sender phone number (E.164) |

### Deploy

Staging deploys automatically from GitHub:

1. Push to `main`
2. GitHub Actions deploys `frontend` and `data-service` to Railway `staging`

Production deploys are manual only:

1. Open Actions → `Deploy to Railway`
2. Run workflow
3. Provide `git_ref` (branch/tag/SHA)
4. Type `DEPLOY_PRODUCTION` in `confirm_production`
5. The workflow deploys `frontend` and `data-service` to Railway `production`

### Service names

The workflow uses:

- `railway up --service frontend`
- `railway up --service data-service`
- `railway up --service auth-service`
- `railway up --service dispatch-service`

If your Railway services use different names, update the `--service` flags in `.github/workflows/deploy-railway.yml`.

### Railway environments for CI

Ensure both Railway environments exist and are configured:

- `staging`
- `production`

The GitHub workflow deploys to these explicit Railway environments:

- Push to `main` -> `--environment staging`
- Manual dispatch -> `--environment production`

If/when `auth-service` and `dispatch-service` are added to these environments, extend the matrix in `.github/workflows/deploy-railway.yml`.

### Persistence notes

Railway has an ephemeral filesystem:

- `data-service/bot-state.json` is lost on redeploy.
- `data-service/watchlist-state.json` is lost on redeploy.
- `dispatch-service/dispatch-state.json` is lost on redeploy.

For production durability, move bot/auth/dispatch state to persistent storage (for example PostgreSQL) and optionally use Redis for cache/session layers.

---

## Local Dev

From repo root:

1. `npm install`
2. `npm run dev`
3. `npm run dev:dispatch` (for local email/SMS dispatch testing)

That runs:

- `data-service` on `http://127.0.0.1:3001`
- `auth-service` on `http://127.0.0.1:3002`
- `dispatch-service` on `http://127.0.0.1:3003` (via `npm run dev:dispatch`)
- `frontend` on `http://127.0.0.1:1420` (with `/api` proxy to data-service)
