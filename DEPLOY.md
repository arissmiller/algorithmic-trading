# Deploy

## GitHub Pages (Frontend)

GitHub Pages can host only the static frontend. It cannot run the Node API server.

Use an external API host for:

- `GET /api/health`
- `GET /api/bars?symbol=AAPL&range=2y`

Then configure the frontend to call that API by setting:

- `VITE_API_BASE_URL=https://your-api-host.example.com`

### 1) Configure repo variable

In GitHub repository settings:

1. Go to Settings -> Secrets and variables -> Actions -> Variables
2. Add `VITE_API_BASE_URL` with your API host URL

### 2) Enable Pages

In GitHub repository settings:

1. Go to Settings -> Pages
2. Source: `GitHub Actions`

### 3) Deploy

Push to `main` (or run the workflow manually):

- `.github/workflows/deploy-pages.yml`

The workflow builds `frontend/` and publishes `frontend/dist` to Pages.

## Vercel API Deploy From GitHub

If you want to run deploys from this GitHub repo, use:

- `.github/workflows/deploy-api-vercel.yml`

This deploys your API routes to Vercel on every push to `main`.
The shared backend logic lives in `data-service/core.ts`.

### One-time setup

1. Create a Vercel account with GitHub login.
2. In Vercel, create/import a project from this repo (one time) with Root Directory set to `data-service`.
3. In Vercel account settings, create an access token.
4. In GitHub repository settings -> Secrets and variables -> Actions -> Secrets, add:
   - `VERCEL_TOKEN`
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID`
5. If you are not sure where org/project IDs are, run `vercel pull` locally once.
   It writes `data-service/.vercel/project.json` with both values.

### Connect Pages frontend to the Vercel API

1. Copy your production API host (example: `https://your-project.vercel.app`).
2. In GitHub repository settings -> Secrets and variables -> Actions -> Variables, set:
   - `VITE_API_BASE_URL=https://your-project.vercel.app`
3. Re-run or push to trigger `.github/workflows/deploy-pages.yml`.

## Local Dev

From repo root:

1. `npm install`
2. `npm run dev`

That runs:

- `data-service` on `http://127.0.0.1:3001`
- `frontend` on `http://127.0.0.1:1420` (with `/api` proxy to data-service)

## Split Into Two Repos (Optional)

If you want independent frontend/backend repositories, follow:

- `SPLIT_REPOS.md`
