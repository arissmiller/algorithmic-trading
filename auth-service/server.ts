import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AuthCore, AuthError } from "./src/authCore";
import { AuthEmailDelivery } from "./src/emailDelivery";

const PORT = Number(process.env.PORT ?? 3002);
const ALLOWED_ORIGINS = parseCsvEnv("ALLOWED_ORIGINS");
const REQUIRE_ORIGIN_HEADER = parseBooleanEnv(
  "REQUIRE_ORIGIN_HEADER",
  ALLOWED_ORIGINS.length > 0
);
const TOKEN_TTL_SECONDS = Number(process.env.AUTH_TOKEN_TTL_SECONDS ?? 2_592_000);
const EMAIL_VERIFICATION_REQUIRED = parseBooleanEnv("EMAIL_VERIFICATION_REQUIRED", true);
const EMAIL_VERIFICATION_TOKEN_TTL_SECONDS = Number(
  process.env.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS ?? 86_400
);
const EMAIL_VERIFICATION_BASE_URL = trimToNull(process.env.EMAIL_VERIFICATION_BASE_URL);
const EMAIL_VERIFICATION_LOG_ONLY_MODE = parseBooleanEnv(
  "EMAIL_VERIFICATION_LOG_ONLY_MODE",
  process.env.NODE_ENV !== "production"
);
const REGISTRATION_INVITE_CODE = "SMARTSCALE-INVITE-2026";
const AUTH_EXPOSE_VERIFICATION_TOKEN = parseBooleanEnv(
  "AUTH_EXPOSE_VERIFICATION_TOKEN",
  EMAIL_VERIFICATION_LOG_ONLY_MODE && process.env.NODE_ENV !== "production"
);
const STATE_FILE =
  process.env.AUTH_STATE_FILE ?? new URL("./auth-state.json", import.meta.url).pathname;

const authCore = new AuthCore({
  statePath: STATE_FILE,
  tokenTtlSeconds: TOKEN_TTL_SECONDS,
  emailVerificationRequired: EMAIL_VERIFICATION_REQUIRED,
  emailVerificationTokenTtlSeconds: EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
});

const emailDelivery = new AuthEmailDelivery({
  smtpConfig: getSmtpConfig(),
  logOnlyMode: EMAIL_VERIFICATION_LOG_ONLY_MODE,
});

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const reqOrigin = firstHeaderValue(req.headers.origin);
  const allowedOrigin = resolveAllowedOrigin(reqOrigin);

  if (REQUIRE_ORIGIN_HEADER && url.pathname !== "/api/health" && !reqOrigin) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "Missing origin" }));
    return;
  }

  if (reqOrigin && !allowedOrigin) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "Origin not allowed" }));
    return;
  }

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  try {
    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const body = (await readJsonBody(req)) as {
        email?: string;
        password?: string;
        name?: string;
        inviteCode?: string;
      };

      assertValidInviteCode(body.inviteCode);

      const result = await authCore.register(
        {
          email: body.email ?? "",
          password: body.password ?? "",
          name: body.name,
        },
        {
          ip: getClientIp(req),
          userAgent: firstHeaderValue(req.headers["user-agent"]),
        }
      );

      if (result.requiresEmailVerification) {
        const verificationToken = result.verificationToken;
        const verificationExpiresAt = result.verificationExpiresAt;

        if (!verificationToken || !verificationExpiresAt) {
          throw new AuthError(500, "Unable to issue verification token");
        }

        const verificationUrl = buildVerificationUrl(
          resolveVerificationBaseUrl(reqOrigin),
          verificationToken
        );

        console.log(
          [
            "[auth-email] verification dispatch requested",
            `userId=${result.user.id}`,
            `email=${result.user.email}`,
            `logOnlyMode=${EMAIL_VERIFICATION_LOG_ONLY_MODE}`,
          ].join(" ")
        );

        let sendResult: { delivered: boolean };
        try {
          sendResult = await emailDelivery.sendVerification({
            toEmail: result.user.email,
            toName: result.user.name,
            verificationUrl,
            verificationToken,
            expiresAt: verificationExpiresAt,
          });
        } catch (sendErr) {
          const sendMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
          console.error(`[auth-email] verification send failed: ${sendMsg}`);
          throw new AuthError(500, "Verification email service is unavailable");
        }

        if (sendResult.delivered) {
          console.log(
            `[auth-email] verification dispatch accepted userId=${result.user.id} email=${result.user.email}`
          );
        }

        if (!sendResult.delivered) {
          console.warn(
            `[auth-email] verification dispatch unavailable userId=${result.user.id} email=${result.user.email}`
          );
          throw new AuthError(500, "Verification email service is unavailable");
        }

        res.writeHead(201);
        res.end(
          JSON.stringify({
            requiresEmailVerification: true,
            email: result.user.email,
            verificationExpiresAt,
            verificationEmailSent: true,
            ...(AUTH_EXPOSE_VERIFICATION_TOKEN ? { verificationToken } : {}),
          })
        );
        return;
      }

      res.writeHead(201);
      res.end(
        JSON.stringify({
          user: result.user,
          token: result.token,
          expiresAt: result.expiresAt,
          requiresEmailVerification: false,
        })
      );
      return;
    }

    if (url.pathname === "/api/auth/verify-email" && req.method === "POST") {
      const body = (await readJsonBody(req)) as {
        token?: string;
      };

      const user = await authCore.verifyEmail(body.token ?? "");
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, user }));
      return;
    }

    if (url.pathname === "/api/auth/verify-email" && req.method === "GET") {
      const token = url.searchParams.get("token") ?? "";
      const user = await authCore.verifyEmail(token);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, user }));
      return;
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const body = (await readJsonBody(req)) as {
        email?: string;
        password?: string;
      };

      const result = await authCore.login(
        {
          email: body.email ?? "",
          password: body.password ?? "",
        },
        {
          ip: getClientIp(req),
          userAgent: firstHeaderValue(req.headers["user-agent"]),
        }
      );

      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const token = extractBearerToken(req);
      if (!token) {
        throw new AuthError(401, "Missing bearer token");
      }

      const user = await authCore.getSessionUser(token);
      if (!user) {
        throw new AuthError(401, "Invalid or expired session");
      }

      res.writeHead(200);
      res.end(JSON.stringify({ user }));
      return;
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const token = extractBearerToken(req);
      if (!token) {
        throw new AuthError(401, "Missing bearer token");
      }

      await authCore.logout(token);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    if (err instanceof AuthError) {
      res.writeHead(err.status);
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    if (err instanceof SyntaxError) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: msg }));
  }
});

async function start(): Promise<void> {
  await authCore.load();
  server.listen(PORT, () => {
    console.log(`Auth service listening on http://localhost:${PORT}`);
  });
}

void start().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Auth service failed to start: ${msg}`);
  process.exit(1);
});

function parseCsvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : null;
  }
  return null;
}

function resolveAllowedOrigin(origin: string | null): string | null {
  if (!origin) {
    return null;
  }

  if (ALLOWED_ORIGINS.length === 0) {
    return origin;
  }

  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const authHeader = firstHeaderValue(req.headers.authorization);
  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function getClientIp(req: http.IncomingMessage): string | null {
  const fwd = firstHeaderValue(req.headers["x-forwarded-for"]);
  if (fwd) {
    return fwd.split(",")[0]?.trim() ?? null;
  }
  return req.socket.remoteAddress ?? null;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function trimToNull(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveVerificationBaseUrl(reqOrigin: string | null): string {
  const candidate = EMAIL_VERIFICATION_BASE_URL ?? reqOrigin;
  if (!candidate) {
    throw new AuthError(500, "Email verification URL is not configured");
  }
  return candidate;
}

function buildVerificationUrl(baseUrl: string, token: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/verify-email?token=${encodeURIComponent(token)}`;
}

function getSmtpConfig(): {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
} | null {
  const host = trimToNull(process.env.SMTP_HOST);
  const user = trimToNull(process.env.SMTP_USER);
  const pass = trimToNull(process.env.SMTP_PASS);
  const fromEmail = trimToNull(process.env.SMTP_FROM_EMAIL);

  if (!host || !fromEmail) {
    return null;
  }

  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: parseBooleanEnv("SMTP_SECURE", false),
    user,
    pass,
    fromEmail,
    fromName: trimToNull(process.env.SMTP_FROM_NAME) ?? "Smart Scale",
    replyTo: trimToNull(process.env.SMTP_REPLY_TO),
  };
}

function assertValidInviteCode(candidate: string | undefined): void {
  const normalized = typeof candidate === "string" ? candidate.trim() : "";
  if (!normalized) {
    throw new AuthError(403, "Invite code is required");
  }

  if (!secureStringEquals(normalized, REGISTRATION_INVITE_CODE)) {
    throw new AuthError(403, "Invalid invite code");
  }
}

function secureStringEquals(aRaw: string, bRaw: string): boolean {
  const a = Buffer.from(aRaw);
  const b = Buffer.from(bRaw);
  if (a.length !== b.length) {
    return false;
  }
  return a.length > 0 && timingSafeEqual(a, b);
}
