# Auth Service

Standalone authentication service for Smart Scale.

## Purpose

Provide account registration, email verification, login, session validation, and logout for frontend users.

## API contract

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/verify-email`
- `GET /api/auth/verify-email?token=...`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`

Registration is invite-gated. `POST /api/auth/register` must include `inviteCode`, and it must match the hardcoded server value in `server.ts`.

## Environment variables

- `PORT` (default `3002`)
- `ALLOWED_ORIGINS` comma-separated CORS allowlist
- `AUTH_TOKEN_TTL_SECONDS` (default `2592000` = 30 days)
- `AUTH_STATE_FILE` optional path for JSON persistence file
- `EMAIL_VERIFICATION_REQUIRED` (default `true`)
- `EMAIL_VERIFICATION_TOKEN_TTL_SECONDS` (default `86400` = 24 hours)
- `EMAIL_VERIFICATION_BASE_URL` frontend base URL used for verification links
- `EMAIL_VERIFICATION_LOG_ONLY_MODE` logs full verification email content instead of SMTP send (default `true` outside production)
- `AUTH_EXPOSE_VERIFICATION_TOKEN` include verification token in register response (default `true` when `EMAIL_VERIFICATION_LOG_ONLY_MODE=true` outside production, otherwise `false`; dev/debug only)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`
- `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`, `SMTP_REPLY_TO`

## Notes

- This version persists users/sessions in a JSON file (`auth-state.json`) including email verification state.
- For production multi-instance deployments, move state to PostgreSQL.
