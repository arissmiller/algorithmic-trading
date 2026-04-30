import nodemailer from "nodemailer";

export interface EmailVerificationMessage {
  toEmail: string;
  toName: string;
  verificationUrl: string;
  verificationToken: string;
  expiresAt: string;
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

export class AuthEmailDelivery {
  private smtpConfig: SmtpConfig | null;
  private logOnlyMode: boolean;

  constructor(input: { smtpConfig: SmtpConfig | null; logOnlyMode: boolean }) {
    this.smtpConfig = input.smtpConfig;
    this.logOnlyMode = input.logOnlyMode;
  }

  async sendVerification(message: EmailVerificationMessage): Promise<{ delivered: boolean }> {
    const subject = "Verify your Smart Scale account";
    const expiresText = new Date(message.expiresAt).toUTCString();
    const textBody = [
      `Hi ${message.toName},`,
      "",
      "Please verify your email to activate your Smart Scale account:",
      message.verificationUrl,
      "",
      `This link expires at ${expiresText}.`,
      "",
      "If you did not request this account, you can ignore this email.",
    ].join("\n");
    const htmlBody = [
      `<p>Hi ${escapeHtml(message.toName)},</p>`,
      "<p>Please verify your email to activate your Smart Scale account:</p>",
      `<p><a href=\"${escapeHtml(message.verificationUrl)}\">Verify Email</a></p>`,
      `<p>Or paste this token in the app:<br/><code>${escapeHtml(message.verificationToken)}</code></p>`,
      `<p>This link expires at ${escapeHtml(expiresText)}.</p>`,
      "<p>If you did not request this account, you can ignore this email.</p>",
    ].join("");

    if (this.logOnlyMode) {
      console.log(
        [
          "[auth-email] log-only verification email",
          `to=${message.toEmail}`,
          `subject=${subject}`,
          `verificationUrl=${message.verificationUrl}`,
          `verificationToken=${message.verificationToken}`,
          "--- text body ---",
          textBody,
          "--- html body ---",
          htmlBody,
        ].join("\n")
      );
      return { delivered: true };
    }

    if (!this.smtpConfig) {
      return { delivered: false };
    }

    const transportOptions: {
      host: string;
      port: number;
      secure: boolean;
      auth?: {
        user: string;
        pass: string;
      };
    } = {
      host: this.smtpConfig.host,
      port: this.smtpConfig.port,
      secure: this.smtpConfig.secure,
    };

    if (this.smtpConfig.user && this.smtpConfig.pass) {
      transportOptions.auth = {
        user: this.smtpConfig.user,
        pass: this.smtpConfig.pass,
      };
    }

    const transport = nodemailer.createTransport(transportOptions);

    const fromHeader = this.smtpConfig.fromName
      ? `${this.smtpConfig.fromName} <${this.smtpConfig.fromEmail}>`
      : this.smtpConfig.fromEmail;

    await transport.sendMail({
      from: fromHeader,
      to: message.toEmail,
      replyTo: this.smtpConfig.replyTo ?? undefined,
      subject,
      text: textBody,
      html: htmlBody,
    });

    return { delivered: true };
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
