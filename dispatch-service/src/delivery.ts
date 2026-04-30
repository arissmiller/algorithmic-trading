import nodemailer from "nodemailer";

export interface EmailMessage {
  toEmail: string;
  toName: string | null;
  subject: string;
  textBody: string;
  htmlBody: string;
}

export interface SmsMessage {
  toPhoneE164: string;
  body: string;
}

export interface DeliveryResponse {
  sent: boolean;
  skipped: boolean;
  error: string | null;
  providerMessageId: string | null;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
}

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromPhoneE164: string;
}

interface DispatchDeliveryInput {
  smtpConfig: SmtpConfig | null;
  twilioConfig: TwilioConfig | null;
  emailLogOnlyMode: boolean;
  smsLogOnlyMode: boolean;
}

export class DispatchDelivery {
  private smtpConfig: SmtpConfig | null;
  private twilioConfig: TwilioConfig | null;
  private emailLogOnlyMode: boolean;
  private smsLogOnlyMode: boolean;

  constructor(input: DispatchDeliveryInput) {
    this.smtpConfig = input.smtpConfig;
    this.twilioConfig = input.twilioConfig;
    this.emailLogOnlyMode = input.emailLogOnlyMode;
    this.smsLogOnlyMode = input.smsLogOnlyMode;
  }

  async sendEmail(message: EmailMessage): Promise<DeliveryResponse> {
    if (this.emailLogOnlyMode) {
      console.log(
        [
          "[dispatch-email] log-only message",
          `to=${message.toEmail}`,
          `subject=${message.subject}`,
          "--- text body ---",
          message.textBody,
        ].join("\n")
      );

      return {
        sent: true,
        skipped: false,
        error: null,
        providerMessageId: null,
      };
    }

    if (!this.smtpConfig) {
      console.log("[dispatch-email] skipped: SMTP is not configured");
      return {
        sent: false,
        skipped: true,
        error: "SMTP is not configured",
        providerMessageId: null,
      };
    }

    try {
      const transport = nodemailer.createTransport({
        host: this.smtpConfig.host,
        port: this.smtpConfig.port,
        secure: this.smtpConfig.secure,
        auth:
          this.smtpConfig.user && this.smtpConfig.pass
            ? {
                user: this.smtpConfig.user,
                pass: this.smtpConfig.pass,
              }
            : undefined,
      });

      const from = this.smtpConfig.fromName
        ? `${this.smtpConfig.fromName} <${this.smtpConfig.fromEmail}>`
        : this.smtpConfig.fromEmail;

      const result = await transport.sendMail({
        from,
        to: this.formatEmailRecipient(message.toEmail, message.toName),
        replyTo: this.smtpConfig.replyTo ?? undefined,
        subject: message.subject,
        text: message.textBody,
        html: message.htmlBody,
      });

      return {
        sent: true,
        skipped: false,
        error: null,
        providerMessageId: result.messageId ?? null,
      };
    } catch (err) {
      return {
        sent: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
        providerMessageId: null,
      };
    }
  }

  async sendSms(message: SmsMessage): Promise<DeliveryResponse> {
    if (this.smsLogOnlyMode) {
      console.log(
        [
          "[dispatch-sms] placeholder mode (skipped)",
          `to=${message.toPhoneE164}`,
          "--- body ---",
          message.body,
        ].join("\n")
      );

      return {
        sent: false,
        skipped: true,
        error: null,
        providerMessageId: null,
      };
    }

    if (!this.twilioConfig) {
      console.log("[dispatch-sms] skipped: Twilio is not configured");
      return {
        sent: false,
        skipped: true,
        error: "Twilio is not configured",
        providerMessageId: null,
      };
    }

    try {
      const auth = Buffer.from(
        `${this.twilioConfig.accountSid}:${this.twilioConfig.authToken}`
      ).toString("base64");

      const form = new URLSearchParams({
        To: message.toPhoneE164,
        From: this.twilioConfig.fromPhoneE164,
        Body: message.body,
      });

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.twilioConfig.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: form,
        }
      );

      const payload = (await response.json().catch(() => null)) as {
        sid?: string;
        message?: string;
      } | null;

      if (!response.ok) {
        const suffix = payload?.message ? `: ${payload.message}` : "";
        return {
          sent: false,
          skipped: false,
          error: `Twilio returned ${response.status}${suffix}`,
          providerMessageId: null,
        };
      }

      return {
        sent: true,
        skipped: false,
        error: null,
        providerMessageId: payload?.sid ?? null,
      };
    } catch (err) {
      return {
        sent: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
        providerMessageId: null,
      };
    }
  }

  private formatEmailRecipient(email: string, name: string | null): string {
    if (!name) {
      return email;
    }

    const safeName = name.replaceAll(/\"/g, "");
    return `${safeName} <${email}>`;
  }
}

export function readSmtpConfigFromEnv(): SmtpConfig | null {
  const host = trimToNull(process.env.DISPATCH_SMTP_HOST ?? process.env.SMTP_HOST);
  const fromEmail = trimToNull(
    process.env.DISPATCH_SMTP_FROM_EMAIL ?? process.env.SMTP_FROM_EMAIL
  );

  if (!host || !fromEmail) {
    return null;
  }

  return {
    host,
    port: parsePort(process.env.DISPATCH_SMTP_PORT ?? process.env.SMTP_PORT, 587),
    secure: parseBooleanEnv(
      process.env.DISPATCH_SMTP_SECURE ?? process.env.SMTP_SECURE,
      false
    ),
    user: trimToNull(process.env.DISPATCH_SMTP_USER ?? process.env.SMTP_USER),
    pass: trimToNull(process.env.DISPATCH_SMTP_PASS ?? process.env.SMTP_PASS),
    fromEmail,
    fromName:
      trimToNull(process.env.DISPATCH_SMTP_FROM_NAME ?? process.env.SMTP_FROM_NAME) ??
      "Smart Scale",
    replyTo: trimToNull(process.env.DISPATCH_SMTP_REPLY_TO ?? process.env.SMTP_REPLY_TO),
  };
}

export function readTwilioConfigFromEnv(): TwilioConfig | null {
  const accountSid = trimToNull(process.env.TWILIO_ACCOUNT_SID);
  const authToken = trimToNull(process.env.TWILIO_AUTH_TOKEN);
  const fromPhoneE164 = trimToNull(process.env.TWILIO_FROM_PHONE_E164);

  if (!accountSid || !authToken || !fromPhoneE164) {
    return null;
  }

  return {
    accountSid,
    authToken,
    fromPhoneE164,
  };
}

function trimToNull(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function parsePort(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.round(value);
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== "string") {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}
