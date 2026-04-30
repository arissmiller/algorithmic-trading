import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_HASH_KEYLEN = 64;
const PASSWORD_SALT_BYTES = 16;
const EMAIL_VERIFICATION_MIN_TTL_SECONDS = 300;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  emailVerifiedAt: string | null;
}

interface AuthUser extends PublicUser {
  passwordHash: string;
  emailVerificationTokenHash: string | null;
  emailVerificationTokenExpiresAt: string | null;
}

interface AuthSession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string;
  createdFromIp: string | null;
  createdFromUserAgent: string | null;
}

interface AuthState {
  users: AuthUser[];
  sessions: AuthSession[];
}

interface SessionMetadata {
  ip: string | null;
  userAgent: string | null;
}

export interface IssueSessionResult {
  user: PublicUser;
  token: string;
  expiresAt: string;
}

export interface RegisterResult {
  user: PublicUser;
  token: string | null;
  expiresAt: string | null;
  requiresEmailVerification: boolean;
  verificationToken: string | null;
  verificationExpiresAt: string | null;
}

interface VerificationTokenResult {
  token: string;
  expiresAt: string;
}

export class AuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class AuthCore {
  private statePath: string;
  private tokenTtlSeconds: number;
  private emailVerificationRequired: boolean;
  private emailVerificationTokenTtlSeconds: number;
  private state: AuthState = { users: [], sessions: [] };
  private persistChain: Promise<void> = Promise.resolve();

  constructor(input: {
    statePath: string;
    tokenTtlSeconds: number;
    emailVerificationRequired: boolean;
    emailVerificationTokenTtlSeconds: number;
  }) {
    this.statePath = input.statePath;
    this.tokenTtlSeconds = Math.max(300, Math.round(input.tokenTtlSeconds));
    this.emailVerificationRequired = input.emailVerificationRequired;
    this.emailVerificationTokenTtlSeconds = Math.max(
      EMAIL_VERIFICATION_MIN_TTL_SECONDS,
      Math.round(input.emailVerificationTokenTtlSeconds)
    );
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AuthState>;
      const users = Array.isArray(parsed.users) ? parsed.users : [];
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];

      this.state = {
        users: users
          .map((value) => normalizeAuthUser(value))
          .filter((value): value is AuthUser => value !== null),
        sessions: sessions.filter(isAuthSession),
      };

      this.pruneExpiredSessions();
      this.pruneExpiredVerificationTokens();
      await this.persist();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") {
        this.state = { users: [], sessions: [] };
        return;
      }
      throw err;
    }
  }

  async register(
    input: { email: string; password: string; name?: string },
    meta: SessionMetadata
  ): Promise<RegisterResult> {
    const email = normalizeEmail(input.email);
    const password = normalizePassword(input.password);
    const name = normalizeName(input.name);

    if (this.state.users.some((user) => user.email === email)) {
      throw new AuthError(409, "An account with this email already exists");
    }

    const passwordHash = await hashPassword(password);
    const now = new Date();
    const createdAt = now.toISOString();

    const user: AuthUser = {
      id: randomUUID(),
      email,
      name,
      createdAt,
      emailVerifiedAt: this.emailVerificationRequired ? null : createdAt,
      passwordHash,
      emailVerificationTokenHash: null,
      emailVerificationTokenExpiresAt: null,
    };

    this.state.users.push(user);

    if (this.emailVerificationRequired) {
      const verification = this.issueEmailVerificationToken(user, now);
      await this.persist();
      return {
        user: toPublicUser(user),
        token: null,
        expiresAt: null,
        requiresEmailVerification: true,
        verificationToken: verification.token,
        verificationExpiresAt: verification.expiresAt,
      };
    }

    const session = this.issueSession(user, meta);
    await this.persist();
    return {
      user: session.user,
      token: session.token,
      expiresAt: session.expiresAt,
      requiresEmailVerification: false,
      verificationToken: null,
      verificationExpiresAt: null,
    };
  }

  async login(
    input: { email: string; password: string },
    meta: SessionMetadata
  ): Promise<IssueSessionResult> {
    const email = normalizeEmail(input.email);
    const password = normalizePassword(input.password);

    const user = this.state.users.find((candidate) => candidate.email === email);
    if (!user) {
      throw new AuthError(401, "Invalid email or password");
    }

    const matches = await verifyPassword(password, user.passwordHash);
    if (!matches) {
      throw new AuthError(401, "Invalid email or password");
    }

    if (this.emailVerificationRequired && !user.emailVerifiedAt) {
      throw new AuthError(403, "Email not verified. Please verify your email before signing in.");
    }

    const session = this.issueSession(user, meta);
    await this.persist();
    return session;
  }

  async verifyEmail(token: string): Promise<PublicUser> {
    const normalizedToken = normalizeVerificationToken(token);
    const tokenHash = hashToken(normalizedToken);
    const nowMs = Date.now();

    const user = this.state.users.find((candidate) => {
      if (!candidate.emailVerificationTokenHash) return false;
      if (candidate.emailVerificationTokenHash !== tokenHash) return false;
      if (!candidate.emailVerificationTokenExpiresAt) return false;
      const expiry = new Date(candidate.emailVerificationTokenExpiresAt).getTime();
      return Number.isFinite(expiry) && expiry > nowMs;
    });

    if (!user) {
      throw new AuthError(400, "Invalid or expired verification token");
    }

    const nowIso = new Date().toISOString();
    user.emailVerifiedAt = nowIso;
    user.emailVerificationTokenHash = null;
    user.emailVerificationTokenExpiresAt = null;
    await this.persist();

    return toPublicUser(user);
  }

  async logout(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    const session = this.state.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (!session || session.revokedAt) {
      return;
    }

    session.revokedAt = new Date().toISOString();
    await this.persist();
  }

  async getSessionUser(token: string): Promise<PublicUser | null> {
    const tokenHash = hashToken(token);
    const nowMs = Date.now();

    const session = this.state.sessions.find((candidate) => {
      if (candidate.tokenHash !== tokenHash) return false;
      if (candidate.revokedAt) return false;
      const expiry = new Date(candidate.expiresAt).getTime();
      return Number.isFinite(expiry) && expiry > nowMs;
    });

    if (!session) {
      return null;
    }

    const user = this.state.users.find((candidate) => candidate.id === session.userId);
    if (!user) {
      return null;
    }

    session.lastSeenAt = new Date().toISOString();
    await this.persist();
    return toPublicUser(user);
  }

  private issueSession(user: AuthUser, meta: SessionMetadata): IssueSessionResult {
    this.pruneExpiredSessions();

    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.tokenTtlSeconds * 1000);

    const session: AuthSession = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revokedAt: null,
      lastSeenAt: createdAt.toISOString(),
      createdFromIp: meta.ip,
      createdFromUserAgent: meta.userAgent,
    };

    this.state.sessions.push(session);
    return {
      user: toPublicUser(user),
      token,
      expiresAt: session.expiresAt,
    };
  }

  private issueEmailVerificationToken(user: AuthUser, createdAt: Date): VerificationTokenResult {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(createdAt.getTime() + this.emailVerificationTokenTtlSeconds * 1000);

    user.emailVerificationTokenHash = hashToken(token);
    user.emailVerificationTokenExpiresAt = expiresAt.toISOString();

    return {
      token,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private pruneExpiredSessions(): void {
    const nowMs = Date.now();
    this.state.sessions = this.state.sessions.filter((session) => {
      if (session.revokedAt) return false;
      const expiry = new Date(session.expiresAt).getTime();
      return Number.isFinite(expiry) && expiry > nowMs;
    });
  }

  private pruneExpiredVerificationTokens(): void {
    const nowMs = Date.now();
    for (const user of this.state.users) {
      if (!user.emailVerificationTokenExpiresAt) continue;
      const expiry = new Date(user.emailVerificationTokenExpiresAt).getTime();
      if (!Number.isFinite(expiry) || expiry <= nowMs) {
        user.emailVerificationTokenHash = null;
        user.emailVerificationTokenExpiresAt = null;
      }
    }
  }

  private async persist(): Promise<void> {
    const payload: AuthState = {
      users: this.state.users,
      sessions: this.state.sessions,
    };

    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.statePath), { recursive: true });
        await writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf8");
      });

    await this.persistChain;
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    throw new AuthError(400, "A valid email is required");
  }
  if (normalized.length > 254) {
    throw new AuthError(400, "Email is too long");
  }
  return normalized;
}

function normalizePassword(password: string): string {
  const normalized = password.trim();
  if (normalized.length < PASSWORD_MIN_LENGTH) {
    throw new AuthError(400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (normalized.length > 1024) {
    throw new AuthError(400, "Password is too long");
  }
  return normalized;
}

function normalizeName(name: string | undefined): string {
  const normalized = (name ?? "").trim();
  if (!normalized) {
    return "Trader";
  }
  return normalized.slice(0, 80);
}

function normalizeVerificationToken(token: string): string {
  const normalized = token.trim();
  if (!normalized || normalized.length < 16) {
    throw new AuthError(400, "A valid verification token is required");
  }
  if (normalized.length > 512) {
    throw new AuthError(400, "Verification token is too long");
  }
  return normalized;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_SALT_BYTES).toString("hex");
  const derived = (await scrypt(password, salt, PASSWORD_HASH_KEYLEN)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  const salt = parts[1];
  const expected = Buffer.from(parts[2], "hex");
  const actual = (await scrypt(password, salt, PASSWORD_HASH_KEYLEN)) as Buffer;

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}

function toPublicUser(user: AuthUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    emailVerifiedAt: user.emailVerifiedAt,
  };
}

function normalizeAuthUser(value: unknown): AuthUser | null {
  if (!value || typeof value !== "object") return null;
  const user = value as Partial<AuthUser>;
  if (
    typeof user.id !== "string" ||
    typeof user.email !== "string" ||
    typeof user.name !== "string" ||
    typeof user.createdAt !== "string" ||
    typeof user.passwordHash !== "string"
  ) {
    return null;
  }

  const emailVerifiedAt =
    typeof user.emailVerifiedAt === "string"
      ? user.emailVerifiedAt
      : user.emailVerifiedAt === null
        ? null
        : user.createdAt;

  const emailVerificationTokenHash =
    typeof user.emailVerificationTokenHash === "string" ? user.emailVerificationTokenHash : null;

  const emailVerificationTokenExpiresAt =
    typeof user.emailVerificationTokenExpiresAt === "string"
      ? user.emailVerificationTokenExpiresAt
      : null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    emailVerifiedAt,
    passwordHash: user.passwordHash,
    emailVerificationTokenHash,
    emailVerificationTokenExpiresAt,
  };
}

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<AuthSession>;
  return (
    typeof session.id === "string" &&
    typeof session.userId === "string" &&
    typeof session.tokenHash === "string" &&
    typeof session.createdAt === "string" &&
    typeof session.expiresAt === "string" &&
    (session.revokedAt === null || typeof session.revokedAt === "string") &&
    typeof session.lastSeenAt === "string"
  );
}
