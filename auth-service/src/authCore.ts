import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
  private pool: Pool;
  private tokenTtlSeconds: number;
  private emailVerificationRequired: boolean;
  private emailVerificationTokenTtlSeconds: number;

  constructor(input: {
    databaseUrl: string;
    tokenTtlSeconds: number;
    emailVerificationRequired: boolean;
    emailVerificationTokenTtlSeconds: number;
  }) {
    this.pool = new Pool({ connectionString: input.databaseUrl });
    this.tokenTtlSeconds = Math.max(300, Math.round(input.tokenTtlSeconds));
    this.emailVerificationRequired = input.emailVerificationRequired;
    this.emailVerificationTokenTtlSeconds = Math.max(
      EMAIL_VERIFICATION_MIN_TTL_SECONDS,
      Math.round(input.emailVerificationTokenTtlSeconds)
    );
  }

  async load(): Promise<void> {
    await this.pool.query(`
      create table if not exists auth_users (
        id uuid primary key,
        email text not null unique,
        name text not null,
        created_at timestamptz not null,
        email_verified_at timestamptz null,
        password_hash text not null,
        email_verification_token_hash text null,
        email_verification_token_expires_at timestamptz null
      );
    `);

    await this.pool.query(`
      create table if not exists auth_sessions (
        id uuid primary key,
        user_id uuid not null references auth_users(id) on delete cascade,
        token_hash text not null unique,
        created_at timestamptz not null,
        expires_at timestamptz not null,
        revoked_at timestamptz null,
        last_seen_at timestamptz not null,
        created_from_ip text null,
        created_from_user_agent text null
      );
    `);

    await this.pool.query(
      "create index if not exists idx_auth_sessions_user_id on auth_sessions(user_id);"
    );
    await this.pool.query(
      "create index if not exists idx_auth_sessions_expires_at on auth_sessions(expires_at);"
    );
    await this.pool.query(
      "create index if not exists idx_auth_users_verification_hash on auth_users(email_verification_token_hash);"
    );

    await this.pruneExpiredSessions();
    await this.pruneExpiredVerificationTokens();
  }

  async register(
    input: { email: string; password: string; name?: string },
    meta: SessionMetadata
  ): Promise<RegisterResult> {
    const email = normalizeEmail(input.email);
    const password = normalizePassword(input.password);
    const name = normalizeName(input.name);

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

    const client = await this.pool.connect();
    try {
      await client.query("begin");

      await client.query(
        `
          insert into auth_users (
            id,
            email,
            name,
            created_at,
            email_verified_at,
            password_hash,
            email_verification_token_hash,
            email_verification_token_expires_at
          )
          values ($1, $2, $3, $4, $5, $6, null, null)
        `,
        [user.id, user.email, user.name, user.createdAt, user.emailVerifiedAt, user.passwordHash]
      );

      if (this.emailVerificationRequired) {
        const verification = this.issueEmailVerificationToken(user, now);

        await client.query(
          `
            update auth_users
            set email_verification_token_hash = $2,
                email_verification_token_expires_at = $3
            where id = $1
          `,
          [user.id, user.emailVerificationTokenHash, user.emailVerificationTokenExpiresAt]
        );

        await client.query("commit");
        return {
          user: toPublicUser(user),
          token: null,
          expiresAt: null,
          requiresEmailVerification: true,
          verificationToken: verification.token,
          verificationExpiresAt: verification.expiresAt,
        };
      }

      const session = await this.issueSession(client, user, meta);
      await client.query("commit");
      return {
        user: session.user,
        token: session.token,
        expiresAt: session.expiresAt,
        requiresEmailVerification: false,
        verificationToken: null,
        verificationExpiresAt: null,
      };
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      if (isUniqueViolation(err, "auth_users_email_key")) {
        throw new AuthError(409, "An account with this email already exists");
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async login(
    input: { email: string; password: string },
    meta: SessionMetadata
  ): Promise<IssueSessionResult> {
    const email = normalizeEmail(input.email);
    const password = normalizePassword(input.password);

    const userResult = await this.pool.query(
      `
        select
          id,
          email,
          name,
          created_at,
          email_verified_at,
          password_hash,
          email_verification_token_hash,
          email_verification_token_expires_at
        from auth_users
        where email = $1
        limit 1
      `,
      [email]
    );

    const user = mapDbUser(userResult.rows[0]);
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

    return this.issueSession(this.pool, user, meta);
  }

  async verifyEmail(token: string): Promise<PublicUser> {
    const normalizedToken = normalizeVerificationToken(token);
    const tokenHash = hashToken(normalizedToken);
    const result = await this.pool.query(
      `
        update auth_users
        set email_verified_at = now(),
            email_verification_token_hash = null,
            email_verification_token_expires_at = null
        where email_verification_token_hash = $1
          and email_verification_token_expires_at is not null
          and email_verification_token_expires_at > now()
        returning id, email, name, created_at, email_verified_at
      `,
      [tokenHash]
    );

    if (result.rowCount === 0) {
      throw new AuthError(400, "Invalid or expired verification token");
    }

    return mapDbPublicUser(result.rows[0]);
  }

  async logout(token: string): Promise<void> {
    const tokenHash = hashToken(token);

    await this.pool.query(
      `
        update auth_sessions
        set revoked_at = now()
        where token_hash = $1 and revoked_at is null
      `,
      [tokenHash]
    );
  }

  async getSessionUser(token: string): Promise<PublicUser | null> {
    const tokenHash = hashToken(token);

    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const result = await client.query(
        `
          select
            u.id,
            u.email,
            u.name,
            u.created_at,
            u.email_verified_at,
            s.id as session_id
          from auth_sessions s
          inner join auth_users u on u.id = s.user_id
          where s.token_hash = $1
            and s.revoked_at is null
            and s.expires_at > now()
          limit 1
        `,
        [tokenHash]
      );

      if (result.rowCount === 0) {
        await client.query("commit");
        return null;
      }

      const row = result.rows[0];
      await client.query(
        `
          update auth_sessions
          set last_seen_at = now()
          where id = $1
        `,
        [row.session_id as string]
      );

      await client.query("commit");
      return mapDbPublicUser(row);
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async issueSession(
    executor: Pool | PoolClient,
    user: AuthUser,
    meta: SessionMetadata
  ): Promise<IssueSessionResult> {
    await this.pruneExpiredSessions();

    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.tokenTtlSeconds * 1000);

    const sessionId = randomUUID();
    await executor.query(
      `
        insert into auth_sessions (
          id,
          user_id,
          token_hash,
          created_at,
          expires_at,
          revoked_at,
          last_seen_at,
          created_from_ip,
          created_from_user_agent
        )
        values ($1, $2, $3, $4, $5, null, $4, $6, $7)
      `,
      [
        sessionId,
        user.id,
        hashToken(token),
        createdAt.toISOString(),
        expiresAt.toISOString(),
        meta.ip,
        meta.userAgent,
      ]
    );

    return {
      user: toPublicUser(user),
      token,
      expiresAt: expiresAt.toISOString(),
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

  private async pruneExpiredSessions(): Promise<void> {
    await this.pool.query(
      `
        delete from auth_sessions
        where revoked_at is not null
           or expires_at <= now()
      `
    );
  }

  private async pruneExpiredVerificationTokens(): Promise<void> {
    await this.pool.query(
      `
        update auth_users
        set email_verification_token_hash = null,
            email_verification_token_expires_at = null
        where email_verification_token_expires_at is not null
          and email_verification_token_expires_at <= now()
      `
    );
  }
}

interface DbPublicUserRow {
  id: string;
  email: string;
  name: string;
  created_at: Date | string;
  email_verified_at: Date | string | null;
}

interface DbUserRow extends DbPublicUserRow {
  password_hash: string;
  email_verification_token_hash: string | null;
  email_verification_token_expires_at: Date | string | null;
}

function mapDbPublicUser(row: DbPublicUserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: toIsoString(row.created_at),
    emailVerifiedAt: toNullableIsoString(row.email_verified_at),
  };
}

function mapDbUser(row: DbUserRow | undefined): AuthUser | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: toIsoString(row.created_at),
    emailVerifiedAt: toNullableIsoString(row.email_verified_at),
    passwordHash: row.password_hash,
    emailVerificationTokenHash: row.email_verification_token_hash,
    emailVerificationTokenExpiresAt: toNullableIsoString(row.email_verification_token_expires_at),
  };
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function toNullableIsoString(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return toIsoString(value);
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const candidate = err as { code?: string; constraint?: string };
  return candidate.code === "23505" && candidate.constraint === constraint;
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
