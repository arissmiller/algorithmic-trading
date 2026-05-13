import { readFile, writeFile } from "node:fs/promises";
import {
  EmailDispatchProfile,
  SmsDispatchProfile,
  TelegramDispatchProfile,
  UserDispatchProfile,
  UserDispatchProfileInput,
} from "./types";

interface PersistedDispatchState {
  profiles: UserDispatchProfile[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export class DispatchProfileStore {
  private statePath: string;
  private profiles = new Map<string, UserDispatchProfile>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(statePath: string) {
    this.statePath = statePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedDispatchState | UserDispatchProfile[];
      const rows = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.profiles)
        ? parsed.profiles
        : [];

      this.profiles.clear();
      for (const candidate of rows) {
        try {
          const normalized = normalizePersistedProfile(candidate);
          this.profiles.set(normalized.userId, normalized);
        } catch {
          // Skip invalid persisted profile rows.
        }
      }
    } catch {
      // Fresh startup.
    }
  }

  list(): UserDispatchProfile[] {
    return Array.from(this.profiles.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(cloneProfile);
  }

  get(userId: string): UserDispatchProfile | null {
    const normalizedUserId = normalizeUserId(userId);
    const existing = this.profiles.get(normalizedUserId);
    return existing ? cloneProfile(existing) : null;
  }

  upsert(userId: string, input: UserDispatchProfileInput): UserDispatchProfile {
    const normalizedUserId = normalizeUserId(userId);
    const existing = this.profiles.get(normalizedUserId);
    const next = normalizeProfileInput(normalizedUserId, input, existing);
    this.profiles.set(normalizedUserId, next);
    void this.persist();
    return cloneProfile(next);
  }

  remove(userId: string): boolean {
    const normalizedUserId = normalizeUserId(userId);
    const removed = this.profiles.delete(normalizedUserId);
    if (removed) {
      void this.persist();
    }
    return removed;
  }

  private persist(): Promise<void> {
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        const payload: PersistedDispatchState = {
          profiles: this.list(),
        };
        await writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf8");
      });

    return this.persistChain;
  }
}

function normalizeProfileInput(
  userId: string,
  input: UserDispatchProfileInput,
  existing?: UserDispatchProfile
): UserDispatchProfile {
  if (!input || typeof input !== "object") {
    throw new Error("Profile body must be an object");
  }

  const now = new Date().toISOString();
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const email = normalizeEmailChannel(input.email, existing?.email);
  const sms = normalizeSmsChannel(input.sms, existing?.sms);
  const telegram = normalizeTelegramChannel(input.telegram, existing?.telegram);

  return {
    userId,
    enabled,
    email,
    sms,
    telegram,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function normalizePersistedProfile(raw: UserDispatchProfile): UserDispatchProfile {
  const userId = normalizeUserId(raw.userId);
  const createdAt = asIso(raw.createdAt) ?? new Date().toISOString();
  const updatedAt = asIso(raw.updatedAt) ?? createdAt;

  return {
    userId,
    enabled: raw.enabled !== false,
    email: normalizeEmailChannel(raw.email, undefined),
    sms: normalizeSmsChannel(raw.sms, undefined),
    telegram: normalizeTelegramChannel(raw.telegram, undefined),
    createdAt,
    updatedAt,
  };
}

function normalizeEmailChannel(
  input: UserDispatchProfileInput["email"] | EmailDispatchProfile | undefined,
  existing?: EmailDispatchProfile | null
): EmailDispatchProfile | null {
  if (input === null) {
    return null;
  }

  if (typeof input === "undefined") {
    return existing ? cloneEmail(existing) : null;
  }

  if (!input || typeof input !== "object") {
    throw new Error("Email channel must be an object or null");
  }

  const address = "address" in input ? normalizeEmail(input.address) : existing?.address;
  const enabled = "enabled" in input ? input.enabled !== false : existing?.enabled ?? true;

  if (!address) {
    if (enabled) {
      throw new Error("Email address is required when email channel is enabled");
    }
    return null;
  }

  const name =
    "name" in input
      ? normalizeNullableName(input.name)
      : existing?.name ?? null;

  return {
    enabled,
    address,
    name,
  };
}

function normalizeSmsChannel(
  input: UserDispatchProfileInput["sms"] | SmsDispatchProfile | undefined,
  existing?: SmsDispatchProfile | null
): SmsDispatchProfile | null {
  if (input === null) {
    return null;
  }

  if (typeof input === "undefined") {
    return existing ? cloneSms(existing) : null;
  }

  if (!input || typeof input !== "object") {
    throw new Error("SMS channel must be an object or null");
  }

  const phoneE164 =
    "phoneE164" in input ? normalizePhone(input.phoneE164) : existing?.phoneE164;
  const enabled = "enabled" in input ? input.enabled !== false : existing?.enabled ?? true;

  if (!phoneE164) {
    if (enabled) {
      throw new Error("SMS phone number is required when SMS channel is enabled");
    }
    return null;
  }

  return {
    enabled,
    phoneE164,
  };
}

function normalizeTelegramChannel(
  input: UserDispatchProfileInput["telegram"] | TelegramDispatchProfile | undefined,
  existing?: TelegramDispatchProfile | null
): TelegramDispatchProfile | null {
  if (input === null) {
    return null;
  }

  if (typeof input === "undefined") {
    return existing ? cloneTelegram(existing) : null;
  }

  if (!input || typeof input !== "object") {
    throw new Error("Telegram channel must be an object or null");
  }

  const chatId = "chatId" in input ? normalizeTelegramChatId(input.chatId) : existing?.chatId;
  const enabled = "enabled" in input ? input.enabled !== false : existing?.enabled ?? true;

  if (!chatId) {
    if (enabled) {
      throw new Error(
        "Telegram chat ID is required when Telegram channel is enabled"
      );
    }
    return null;
  }

  return {
    enabled,
    chatId,
  };
}

function normalizeUserId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("userId is required");
  }
  if (normalized.length > 200) {
    throw new Error("userId is too long");
  }
  return normalized;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Email address must be a string");
  }

  const normalized = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new Error("Email address is invalid");
  }

  if (normalized.length > 320) {
    throw new Error("Email address is too long");
  }

  return normalized;
}

function normalizePhone(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("SMS phone number must be a string");
  }

  const normalized = value.trim();
  if (!E164_PATTERN.test(normalized)) {
    throw new Error("SMS phone number must be valid E.164 format (for example +14155551212)");
  }

  return normalized;
}

function normalizeNullableName(value: unknown): string | null {
  if (value === null || typeof value === "undefined") {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error("Email name must be a string when provided");
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > 200) {
    throw new Error("Email name is too long");
  }

  return normalized;
}

function normalizeTelegramChatId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Telegram chat ID must be a string");
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Telegram chat ID is required");
  }
  if (normalized.length > 200) {
    throw new Error("Telegram chat ID is too long");
  }

  return normalized;
}

function asIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function cloneEmail(email: EmailDispatchProfile): EmailDispatchProfile {
  return {
    enabled: email.enabled,
    address: email.address,
    name: email.name,
  };
}

function cloneSms(sms: SmsDispatchProfile): SmsDispatchProfile {
  return {
    enabled: sms.enabled,
    phoneE164: sms.phoneE164,
  };
}

function cloneTelegram(telegram: TelegramDispatchProfile): TelegramDispatchProfile {
  return {
    enabled: telegram.enabled,
    chatId: telegram.chatId,
  };
}

function cloneProfile(profile: UserDispatchProfile): UserDispatchProfile {
  return {
    userId: profile.userId,
    enabled: profile.enabled,
    email: profile.email ? cloneEmail(profile.email) : null,
    sms: profile.sms ? cloneSms(profile.sms) : null,
    telegram: profile.telegram ? cloneTelegram(profile.telegram) : null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}
