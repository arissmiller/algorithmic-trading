import { DispatchDelivery } from "./delivery";
import { DispatchProfileStore } from "./profileStore";
import {
  ChannelDispatchResult,
  DispatchChannel,
  DispatchEvent,
  DispatchableTradingSignal,
  EmailDispatchProfile,
  TelegramDispatchProfile,
  SignalDispatchResult,
  TradingOrderResult,
  UserDispatchProfile,
} from "./types";
import { AlpacaConnector } from "./alpacaConnector";
import { TradingConnectionStore } from "./tradingConnections";

export class SignalDispatcher {
  private profileStore: DispatchProfileStore;
  private delivery: DispatchDelivery;
  private tradingStore: TradingConnectionStore | null;
  private eventHistoryLimit: number;
  private events: DispatchEvent[] = [];

  constructor(input: {
    profileStore: DispatchProfileStore;
    delivery: DispatchDelivery;
    tradingStore?: TradingConnectionStore | null;
    eventHistoryLimit: number;
  }) {
    this.profileStore = input.profileStore;
    this.delivery = input.delivery;
    this.tradingStore = input.tradingStore ?? null;
    this.eventHistoryLimit = Math.max(50, Math.min(10_000, input.eventHistoryLimit));
  }

  async dispatchSignal(signal: DispatchableTradingSignal): Promise<SignalDispatchResult> {
    const [notifResult, tradingResult] = await Promise.all([
      this.resolveNotifications(signal),
      this.resolveTrade(signal),
    ]);

    const result: SignalDispatchResult = { ...notifResult, tradingResult };
    this.pushEvent(signal, result);
    return result;
  }

  private async resolveNotifications(
    signal: DispatchableTradingSignal
  ): Promise<Omit<SignalDispatchResult, "tradingResult">> {
    const profile = this.profileStore.get(signal.userId);

    if (!profile) {
      return buildSkippedResult("No dispatch profile configured for user", signal.userId);
    }

    if (!profile.enabled) {
      return buildSkippedResult("Dispatch profile is disabled", profile.userId);
    }

    const requestedChannels = normalizeChannelList(signal.preferredChannels);
    const enabledChannels = resolveEnabledChannels(profile);
    const targetChannels =
      requestedChannels.length > 0
        ? enabledChannels.filter((channel) => requestedChannels.includes(channel))
        : enabledChannels;

    if (targetChannels.length === 0) {
      const reason =
        requestedChannels.length > 0
          ? "Requested channels are not enabled for this user"
          : "No enabled channels for this user";
      return buildSkippedResult(reason, profile.userId);
    }

    const channelResults: ChannelDispatchResult[] = [];

    for (const channel of targetChannels) {
      if (channel === "email") {
        channelResults.push(await this.dispatchEmail(signal, profile));
        continue;
      }

      if (channel === "sms") {
        channelResults.push(await this.dispatchSms(signal, profile));
        continue;
      }

      if (channel === "telegram") {
        channelResults.push(await this.dispatchTelegram(signal, profile));
      }
    }

    const sentCount = channelResults.filter((result) => result.status === "sent").length;
    const failedResults = channelResults.filter((result) => result.status === "failed");

    const status: SignalDispatchResult["status"] =
      sentCount > 0 && failedResults.length === 0
        ? "sent"
        : sentCount > 0
        ? "partial"
        : failedResults.length > 0
        ? "failed"
        : "skipped";

    const reason =
      status === "failed"
        ? failedResults.map((result) => `${result.channel}: ${result.error}`).join("; ")
        : status === "partial"
        ? "One or more channels failed"
        : null;

    return { status, reason, profileUserId: profile.userId, channelResults };
  }

  private async resolveTrade(
    signal: DispatchableTradingSignal
  ): Promise<TradingOrderResult | null> {
    if (!this.tradingStore) return null;

    const creds = this.tradingStore.getSecret(signal.userId);

    if (!creds) {
      return null;
    }

    if (!creds.enabled) {
      return {
        status: "skipped",
        reason: "Trading connection is disabled",
        orderId: null,
        symbol: signal.symbol,
        side: signal.action,
        qty: creds.defaultQty,
      };
    }

    const connector = new AlpacaConnector(creds.keyId, creds.secretKey, creds.paper);
    const orderResult = await connector.placeMarketOrder(
      signal.symbol,
      signal.action,
      creds.defaultQty
    );

    return {
      ...orderResult,
      symbol: signal.symbol,
      side: signal.action,
      qty: creds.defaultQty,
    };
  }

  getEventHistory(limit = 100): DispatchEvent[] {
    const safeLimit = Math.max(1, Math.min(2_000, Math.round(limit) || 100));
    return this.events.slice(0, safeLimit).map(cloneEvent);
  }

  getEventCount(): number {
    return this.events.length;
  }

  private async dispatchEmail(
    signal: DispatchableTradingSignal,
    profile: UserDispatchProfile
  ): Promise<ChannelDispatchResult> {
    const email = profile.email;
    if (!email || !email.enabled) {
      return {
        channel: "email",
        status: "skipped",
        error: "Email channel is disabled",
        providerMessageId: null,
      };
    }

    const message = buildEmailMessage(signal, email);
    const delivery = await this.delivery.sendEmail(message);

    return {
      channel: "email",
      status: delivery.sent ? "sent" : delivery.skipped ? "skipped" : "failed",
      error: delivery.skipped ? null : delivery.error,
      providerMessageId: delivery.providerMessageId,
    };
  }

  private async dispatchSms(
    signal: DispatchableTradingSignal,
    profile: UserDispatchProfile
  ): Promise<ChannelDispatchResult> {
    const sms = profile.sms;
    if (!sms || !sms.enabled) {
      return {
        channel: "sms",
        status: "skipped",
        error: "SMS channel is disabled",
        providerMessageId: null,
      };
    }

    const message = buildSmsMessage(signal);
    const delivery = await this.delivery.sendSms({
      toPhoneE164: sms.phoneE164,
      body: message,
    });

    return {
      channel: "sms",
      status: delivery.sent ? "sent" : delivery.skipped ? "skipped" : "failed",
      error: delivery.skipped ? null : delivery.error,
      providerMessageId: delivery.providerMessageId,
    };
  }

  private async dispatchTelegram(
    signal: DispatchableTradingSignal,
    profile: UserDispatchProfile
  ): Promise<ChannelDispatchResult> {
    const telegram = profile.telegram;
    if (!telegram || !telegram.enabled) {
      return {
        channel: "telegram",
        status: "skipped",
        error: "Telegram channel is disabled",
        providerMessageId: null,
      };
    }

    const message = buildTelegramMessage(signal, telegram);
    const delivery = await this.delivery.sendTelegram(message);

    return {
      channel: "telegram",
      status: delivery.sent ? "sent" : delivery.skipped ? "skipped" : "failed",
      error: delivery.skipped ? null : delivery.error,
      providerMessageId: delivery.providerMessageId,
    };
  }

  private pushEvent(signal: DispatchableTradingSignal, result: SignalDispatchResult): void {
    this.events.unshift({
      receivedAt: new Date().toISOString(),
      signal: cloneSignal(signal),
      result: cloneResult(result),
    });

    if (this.events.length > this.eventHistoryLimit) {
      this.events.length = this.eventHistoryLimit;
    }
  }
}

export function normalizeDispatchableTradingSignal(raw: unknown): DispatchableTradingSignal {
  if (!raw || typeof raw !== "object") {
    throw new Error("Signal payload must be an object");
  }

  const asRecord = raw as Record<string, unknown>;

  const timeframe = asRecord.timeframe;
  if (timeframe !== "1Day" && timeframe !== "1Hour") {
    throw new Error("timeframe must be '1Day' or '1Hour'");
  }

  const action = asRecord.action;
  if (action !== "buy" && action !== "sell") {
    throw new Error("action must be 'buy' or 'sell'");
  }

  return {
    id: normalizeStringField(asRecord.id, "id", 200),
    userId: normalizeStringField(asRecord.userId, "userId", 200),
    symbol: normalizeStringField(asRecord.symbol, "symbol", 24).toUpperCase(),
    timeframe,
    action,
    signalScore: normalizeNumberField(asRecord.signalScore, "signalScore"),
    rationale: normalizeStringField(asRecord.rationale, "rationale", 4_000),
    barTime: normalizeIsoField(asRecord.barTime, "barTime"),
    generatedAt: normalizeIsoField(asRecord.generatedAt, "generatedAt"),
    watchlistUpdatedAt: normalizeIsoField(asRecord.watchlistUpdatedAt, "watchlistUpdatedAt"),
    preferredChannels: normalizeChannelList(asRecord.preferredChannels),
  };
}

function resolveEnabledChannels(profile: UserDispatchProfile): DispatchChannel[] {
  const out: DispatchChannel[] = [];

  if (profile.email?.enabled) {
    out.push("email");
  }

  if (profile.sms?.enabled) {
    out.push("sms");
  }

  if (profile.telegram?.enabled) {
    out.push("telegram");
  }

  return out;
}

function buildEmailMessage(
  signal: DispatchableTradingSignal,
  profile: EmailDispatchProfile
): {
  toEmail: string;
  toName: string | null;
  subject: string;
  textBody: string;
  htmlBody: string;
} {
  const actionLabel = signal.action.toUpperCase();
  const subject = `[AI Investment Platform] ${actionLabel} ${signal.symbol} (${signal.timeframe})`;

  const textBody = [
    `Hi ${profile.name ?? signal.userId},`,
    "",
    `Signal: ${actionLabel} ${signal.symbol}`,
    `Timeframe: ${signal.timeframe}`,
    `Score: ${signal.signalScore.toFixed(3)}`,
    `Bar time: ${signal.barTime}`,
    `Generated at: ${signal.generatedAt}`,
    "",
    "Rationale:",
    signal.rationale,
    "",
    `Signal ID: ${signal.id}`,
  ].join("\n");

  const htmlBody = [
    `<p>Hi ${escapeHtml(profile.name ?? signal.userId)},</p>`,
    `<p><strong>Signal:</strong> ${escapeHtml(actionLabel)} ${escapeHtml(signal.symbol)}</p>`,
    `<p><strong>Timeframe:</strong> ${escapeHtml(signal.timeframe)}</p>`,
    `<p><strong>Score:</strong> ${escapeHtml(signal.signalScore.toFixed(3))}</p>`,
    `<p><strong>Bar time:</strong> ${escapeHtml(signal.barTime)}</p>`,
    `<p><strong>Generated at:</strong> ${escapeHtml(signal.generatedAt)}</p>`,
    `<p><strong>Rationale:</strong><br/>${escapeHtml(signal.rationale).replaceAll("\n", "<br/>")}</p>`,
    `<p><small>Signal ID: ${escapeHtml(signal.id)}</small></p>`,
  ].join("");

  return {
    toEmail: profile.address,
    toName: profile.name,
    subject,
    textBody,
    htmlBody,
  };
}

function buildSmsMessage(signal: DispatchableTradingSignal): string {
  return [
    `[AI Investment Platform] ${signal.action.toUpperCase()} ${signal.symbol}`,
    `TF ${signal.timeframe} | Score ${signal.signalScore.toFixed(2)}`,
    `Bar ${signal.barTime}`,
    trimToLength(signal.rationale.replaceAll(/\s+/g, " "), 100),
  ].join("\n");
}

function buildTelegramMessage(
  signal: DispatchableTradingSignal,
  telegram: TelegramDispatchProfile
): {
  chatId: string;
  body: string;
} {
  const header = `${signal.action.toUpperCase()} ${signal.symbol} (${signal.timeframe})`;
  const score = `Score: ${signal.signalScore.toFixed(3)}`;
  const timing = `Bar: ${signal.barTime}`;
  const rationale = trimToLength(signal.rationale.replaceAll(/\s+/g, " "), 280);

  return {
    chatId: telegram.chatId,
    body: [`[AI Investment Platform] ${header}`, score, timing, rationale].join("\n"),
  };
}

function buildSkippedResult(reason: string, profileUserId: string): SignalDispatchResult {
  return {
    status: "skipped",
    reason,
    profileUserId,
    channelResults: [],
  };
}

function normalizeStringField(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  if (normalized.length > maxLen) {
    throw new Error(`${field} is too long`);
  }
  return normalized;
}

function normalizeIsoField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be an ISO timestamp string`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be a valid ISO timestamp`);
  }

  return parsed.toISOString();
}

function normalizeNumberField(value: unknown, field: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${field} must be a finite number`);
  }

  return numeric;
}

function normalizeChannelList(raw: unknown): DispatchChannel[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const out: DispatchChannel[] = [];
  for (const value of raw) {
    if (value === "email" || value === "sms" || value === "telegram") {
      if (!out.includes(value)) {
        out.push(value);
      }
    }
  }

  return out;
}

function trimToLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}

function cloneSignal(signal: DispatchableTradingSignal): DispatchableTradingSignal {
  return {
    ...signal,
    preferredChannels: signal.preferredChannels ? [...signal.preferredChannels] : undefined,
  };
}

function cloneResult(result: SignalDispatchResult): SignalDispatchResult {
  return {
    status: result.status,
    reason: result.reason,
    profileUserId: result.profileUserId,
    channelResults: result.channelResults.map((item) => ({ ...item })),
  };
}

function cloneEvent(event: DispatchEvent): DispatchEvent {
  return {
    receivedAt: event.receivedAt,
    signal: cloneSignal(event.signal),
    result: cloneResult(event.result),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
