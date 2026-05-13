export type DispatchChannel = "email" | "sms" | "telegram";

export interface DispatchableTradingSignal {
  id: string;
  userId: string;
  symbol: string;
  timeframe: "1Day" | "1Hour";
  action: "buy" | "sell";
  signalScore: number;
  rationale: string;
  barTime: string;
  generatedAt: string;
  watchlistUpdatedAt: string;
  preferredChannels?: DispatchChannel[];
}

export interface EmailDispatchProfile {
  enabled: boolean;
  address: string;
  name: string | null;
}

export interface SmsDispatchProfile {
  enabled: boolean;
  phoneE164: string;
}

export interface TelegramDispatchProfile {
  enabled: boolean;
  chatId: string;
}

export interface UserDispatchProfile {
  userId: string;
  enabled: boolean;
  email: EmailDispatchProfile | null;
  sms: SmsDispatchProfile | null;
  telegram: TelegramDispatchProfile | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserDispatchProfileInput {
  enabled?: boolean;
  email?: {
    enabled?: boolean;
    address?: string;
    name?: string | null;
  } | null;
  sms?: {
    enabled?: boolean;
    phoneE164?: string;
  } | null;
  telegram?: {
    enabled?: boolean;
    chatId?: string;
  } | null;
}

export interface ChannelDispatchResult {
  channel: DispatchChannel;
  status: "sent" | "failed" | "skipped";
  error: string | null;
  providerMessageId: string | null;
}

export interface TradingOrderResult {
  status: "placed" | "failed" | "skipped";
  reason: string | null;
  orderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
}

export interface SignalDispatchResult {
  status: "sent" | "partial" | "failed" | "skipped";
  reason: string | null;
  profileUserId: string | null;
  channelResults: ChannelDispatchResult[];
  tradingResult?: TradingOrderResult | null;
}

export interface DispatchEvent {
  receivedAt: string;
  signal: DispatchableTradingSignal;
  result: SignalDispatchResult;
}
