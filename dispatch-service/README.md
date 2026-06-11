# Dispatch Service

This service receives generated watchlist signals and routes them to user delivery channels (`email`, `sms`, and `telegram`).

If you are reading the code for the first time, start in `server.ts`, then jump to `src/dispatcher.ts` and `src/delivery.ts`. That path shows the full request lifecycle from inbound signal to per-channel delivery result.

## What This Service Owns

- Accept signal payloads from `data-service`.
- Resolve delivery channels using per-user dispatch profiles.
- Fan out messages through SMTP email, Twilio SMS, and Telegram bot messages (or log-only mode in development).
- Persist per-user dispatch preferences and trading-connection settings.

## Start Here In The Code

- `server.ts`: HTTP entrypoint, auth/origin checks, route handling
- `src/dispatcher.ts`: signal normalization, channel selection, event history
- `src/delivery.ts`: SMTP, Twilio, and Telegram delivery adapters
- `src/profileStore.ts`: file-backed dispatch profile persistence
- `src/tradingConnections.ts`: file-backed trading connection persistence
- `src/types.ts`: API-facing data shapes
- `src/alpacaConnector.ts`: broker-side trading connection utilities

## Runtime

- Entry point: `server.ts`
- Core modules:
  - `src/profileStore.ts` for user channel profile persistence
  - `src/dispatcher.ts` for signal-to-channel routing
  - `src/delivery.ts` for email/SMS provider integrations

## Request Flow

- `server.ts` validates origin and optional shared auth.
- User profile routes and trading-connection routes persist file-backed state.
- `POST /api/dispatch/signal` normalizes the inbound payload.
- `SignalDispatcher` resolves enabled channels for that user.
- `DispatchDelivery` either sends through real providers or records a `skipped`/log-only result when credentials are intentionally absent.
- Recent dispatch events stay in memory for `GET /api/dispatch/events`.

## API

- `GET /api/health`
- `GET /api/dispatch/users`
- `GET /api/dispatch/users/:userId`
- `PUT /api/dispatch/users/:userId`
- `DELETE /api/dispatch/users/:userId`
- `GET /api/dispatch/trading-connections`
- `GET /api/dispatch/users/:userId/trading-connection`
- `PUT /api/dispatch/users/:userId/trading-connection`
- `DELETE /api/dispatch/users/:userId/trading-connection`
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
  "preferredChannels": ["email", "telegram"]
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
  },
  "telegram": {
    "enabled": true,
    "chatId": "-1001234567890"
  }
}
```

Rules:

- `email: null` clears email configuration.
- `sms: null` clears SMS configuration.
- `telegram: null` clears Telegram configuration.
- If a channel is enabled, that channel must have a valid destination.
- Phone numbers must be E.164 format.
- Telegram `chatId` may be a numeric chat/channel ID (for example `-100...`) or an `@channel_username`.

## Trading Connection Contract

`PUT /api/dispatch/users/:userId/trading-connection` body:

```json
{
  "provider": "alpaca",
  "enabled": true,
  "paper": true,
  "apiKeyId": "alpaca-key",
  "apiSecretKey": "alpaca-secret",
  "baseUrl": "https://paper-api.alpaca.markets"
}
```

Use this when a user-level trading connection needs to be persisted alongside dispatch preferences.

## Stateful Files

By default the service persists JSON files next to the service code:

- `dispatch-state.json`: runtime-generated dispatch profile state
- `dispatch-trading-state.json`: runtime-generated trading connection state

The exact paths can be overridden with:

- `DISPATCH_STATE_FILE`
- `DISPATCH_TRADING_STATE_FILE`

## Environment Variables

See `.env.example` for full list.

Key values:

- `DISPATCH_AUTH_TOKEN`: auth token expected on protected routes.
- `DISPATCH_AUTH_HEADER`: caller header name, default `x-dispatch-token`.
- `ALLOWED_ORIGINS`: optional browser allowlist.
- `REQUIRE_ORIGIN_HEADER`: require browser-like origin headers on non-health routes.
- `DISPATCH_EVENT_HISTORY_LIMIT`: max in-memory dispatch events retained.
- `DISPATCH_STATE_FILE`: optional override for persisted dispatch profile state.
- `DISPATCH_TRADING_STATE_FILE`: optional override for persisted trading connection state.
- `DISPATCH_EMAIL_LOG_ONLY_MODE`: `true` to log email instead of SMTP send.
- `DISPATCH_SMS_LOG_ONLY_MODE`: `true` to keep SMS in placeholder mode (`skipped`).
- `DISPATCH_TELEGRAM_LOG_ONLY_MODE`: `true` to log Telegram messages instead of sending.
- `DISPATCH_SMTP_*`: SMTP provider configuration.
- `TWILIO_*`: Twilio SMS credentials.
- `DISPATCH_TELEGRAM_BOT_TOKEN`: Telegram bot token used for `sendMessage`.

If SMTP, Twilio, or Telegram credentials are missing, channel delivery is marked as `skipped` (not `failed`) so placeholder environments do not throw delivery errors.

Recommended setup when SMTP + Telegram are ready but SMS is not:

- `DISPATCH_EMAIL_LOG_ONLY_MODE=false`
- `DISPATCH_TELEGRAM_LOG_ONLY_MODE=false`
- `DISPATCH_SMS_LOG_ONLY_MODE=true`

## Local Dev

From repo root:

1. `npm install`
2. `npm run dev:dispatch`

From inside `dispatch-service/`:

1. `npm install`
2. `npm run dev`

By default the service runs on `http://127.0.0.1:3003`.
