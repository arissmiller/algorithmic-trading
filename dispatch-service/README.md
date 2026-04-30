# Dispatch Service

This service receives generated watchlist signals and routes them to user delivery channels (`email` and `sms`).

## Purpose

- Accept signal payloads from `data-service`.
- Resolve delivery channels using per-user dispatch profiles.
- Fan out messages through SMTP email and Twilio SMS (or log-only mode in development).

## Runtime

- Entry point: `server.ts`
- Core modules:
  - `src/profileStore.ts` for user channel profile persistence
  - `src/dispatcher.ts` for signal-to-channel routing
  - `src/delivery.ts` for email/SMS provider integrations

## API

- `GET /api/health`
- `GET /api/dispatch/users`
- `GET /api/dispatch/users/:userId`
- `PUT /api/dispatch/users/:userId`
- `DELETE /api/dispatch/users/:userId`
- `POST /api/dispatch/signal`
- `GET /api/dispatch/events?limit=100`

All `/api/dispatch/*` routes require `DISPATCH_AUTH_TOKEN` if configured. Pass it using:

- `Authorization: Bearer <token>`
- Or `DISPATCH_AUTH_HEADER` (default `x-dispatch-token`)

## Signal Ingest Contract

`POST /api/dispatch/signal` body:

```json
{
  "id": "uuid",
  "userId": "user-123",
  "symbol": "AAPL",
  "timeframe": "1Day",
  "action": "buy",
  "signalScore": 0.83,
  "rationale": "RSI recovered and price crossed SMA20.",
  "barTime": "2026-04-29T20:00:00.000Z",
  "generatedAt": "2026-04-29T20:01:00.000Z",
  "watchlistUpdatedAt": "2026-04-28T14:12:00.000Z",
  "preferredChannels": ["email", "sms"]
}
```

`preferredChannels` is optional. If omitted, dispatch sends to all enabled channels in the user profile.

## User Profile Contract

`PUT /api/dispatch/users/:userId` body:

```json
{
  "enabled": true,
  "email": {
    "enabled": true,
    "address": "trader@example.com",
    "name": "Jane Trader"
  },
  "sms": {
    "enabled": true,
    "phoneE164": "+14155551212"
  }
}
```

Rules:

- `email: null` clears email configuration.
- `sms: null` clears SMS configuration.
- If a channel is enabled, that channel must have a valid destination.
- Phone numbers must be E.164 format.

## Environment Variables

See `.env.example` for full list.

Key values:

- `DISPATCH_AUTH_TOKEN`: auth token expected on protected routes.
- `DISPATCH_EMAIL_LOG_ONLY_MODE`: `true` to log email instead of SMTP send.
- `DISPATCH_SMS_LOG_ONLY_MODE`: `true` to keep SMS in placeholder mode (`skipped`).
- `DISPATCH_SMTP_*`: SMTP provider configuration.
- `TWILIO_*`: Twilio SMS credentials.

If SMTP or Twilio credentials are missing, channel delivery is marked as `skipped` (not `failed`) so placeholder environments do not throw delivery errors.

Recommended setup when SMTP is ready but SMS is not:

- `DISPATCH_EMAIL_LOG_ONLY_MODE=false`
- `DISPATCH_SMS_LOG_ONLY_MODE=true`

## Local Dev

From repo root:

1. `npm --prefix dispatch-service install`
2. `npm --prefix dispatch-service run dev`

By default the service runs on `http://127.0.0.1:3003`.
