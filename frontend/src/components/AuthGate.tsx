import { useEffect, useMemo, useState } from "react";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  emailVerifiedAt: string | null;
}

interface AuthSessionPayload {
  user: AuthUser;
  token: string;
  expiresAt: string;
  requiresEmailVerification?: false;
}

interface AuthRegisterPendingVerificationPayload {
  requiresEmailVerification: true;
  email: string;
  verificationExpiresAt: string;
  verificationEmailSent: boolean;
  verificationToken?: string;
}

type Mode = "login" | "register" | "verify";

const TOKEN_STORAGE_KEY = "smart_scale_auth_token";

function getAuthApiPrefix(): string {
  const configured = (import.meta.env.VITE_AUTH_API_BASE_URL ?? "").replace(/\/+$/, "");
  if (configured.length > 0) {
    return `${configured}/api`;
  }

  if (import.meta.env.DEV) {
    return "http://127.0.0.1:3002/api";
  }

  return "/api";
}

const AUTH_API_PREFIX = getAuthApiPrefix();

export default function AuthGate({
  onAuthUserChange,
}: {
  onAuthUserChange?: (user: AuthUser | null) => void;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [authOpen, setAuthOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [pendingEmail, setPendingEmail] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [form, setForm] = useState({
    email: "",
    password: "",
    name: "",
    inviteCode: "",
  });

  useEffect(() => {
    async function restoreSession() {
      const token = readStoredToken();
      if (!token) {
        setLoading(false);
        return;
      }

      try {
        const currentUser = await fetchCurrentUser(token);
        setUser(currentUser);
      } catch {
        clearStoredToken();
      } finally {
        setLoading(false);
      }
    }

    void restoreSession();
  }, []);

  useEffect(() => {
    async function consumeVerificationTokenFromUrl() {
      if (typeof window === "undefined") return;
      const token = new URLSearchParams(window.location.search).get("token");
      if (!token) return;

      setMode("verify");
      setAuthOpen(true);
      setInfo("Finishing email verification...");
      setError(null);

      try {
        await verifyEmailToken(token);
        setInfo("Email verified. You can now sign in.");
        setMode("login");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Email verification failed");
      } finally {
        const cleanedUrl = new URL(window.location.href);
        cleanedUrl.searchParams.delete("token");
        window.history.replaceState({}, "", cleanedUrl.toString());
      }
    }

    void consumeVerificationTokenFromUrl();
  }, []);

  useEffect(() => {
    onAuthUserChange?.(user);
  }, [onAuthUserChange, user]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    setInfo(null);

    try {
      if (mode === "verify") {
        await verifyEmailToken(verificationToken);
        setVerificationToken("");
        setMode("login");
        setInfo("Email verified. You can now sign in.");
        return;
      }

      if (mode === "register") {
        const payload = await authRegister(form);
        if (payload.requiresEmailVerification) {
          setPendingEmail(payload.email);
          setMode("verify");
          setVerificationToken(payload.verificationToken ?? "");
          setInfo(
            "Check your email for a verification link. If needed, paste your verification token below."
          );
          return;
        }

        writeStoredToken(payload.token);
        setUser(payload.user);
        setAuthOpen(false);
        setInfo(null);
        setForm({
          email: payload.user.email,
          password: "",
          name: payload.user.name,
          inviteCode: "",
        });
        return;
      }

      const payload = await authLogin(form);
      writeStoredToken(payload.token);
      setUser(payload.user);
      setAuthOpen(false);
      setInfo(null);
      setForm({
        email: payload.user.email,
        password: "",
        name: payload.user.name,
        inviteCode: "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    const token = readStoredToken();
    try {
      if (token) {
        await authLogout(token);
      }
    } catch {
      // Ignore logout failures and clear local session anyway.
    }

    clearStoredToken();
    setUser(null);
    setError(null);
    setInfo(null);
    setMode("login");
    setAuthOpen(false);
    setForm((prev) => ({ ...prev, password: "" }));
  }

  const heading = useMemo(() => {
    if (mode === "register") return "Create your account";
    if (mode === "verify") return "Verify your email";
    return "Sign in";
  }, [mode]);

  return (
    <>
      <div className="fixed right-3 top-3 z-[80]">
        {user ? (
          <div className="flex items-center gap-2 rounded border border-border bg-surface-1/95 px-3 py-1.5 text-xs shadow-[0_0_14px_rgba(70,215,255,0.15)] backdrop-blur-[2px]">
            <span className="text-text-secondary">Signed in as</span>
            <span className="max-w-[170px] truncate text-text-primary">{user.email}</span>
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="rounded border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
            >
              Logout
            </button>
          </div>
        ) : !authOpen ? (
          <button
            type="button"
            onClick={() => {
              setAuthOpen(true);
              setError(null);
              setInfo(null);
            }}
            disabled={loading}
            className="rounded border border-border bg-surface-1/95 px-3 py-1.5 text-xs font-semibold text-text-primary shadow-[0_0_14px_rgba(70,215,255,0.15)] transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Checking..." : "Login"}
          </button>
        ) : null
        }
      </div>

      {!user && authOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-surface-0/80 p-4 text-text-primary backdrop-blur-[1px]">
          <div className="w-full max-w-md rounded border border-border bg-surface-1 p-5 shadow-[0_0_22px_rgba(70,215,255,0.12)]">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-widest text-text-secondary">Smart Scale</p>
                <h1 className="mt-1 text-lg font-semibold text-text-primary">{heading}</h1>
                <p className="mt-1 text-xs text-text-secondary">
                  Sign in to sync your workspace and unlock account-only features.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAuthOpen(false)}
                className="rounded border border-border bg-surface-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
              >
                Close
              </button>
            </div>

            <form className="space-y-3" onSubmit={handleSubmit}>
              {mode === "register" && (
                <label className="block">
                  <span className={fieldLabel}>Name</span>
                  <input
                    className={inputClass}
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                    placeholder="Trader"
                    autoComplete="name"
                  />
                </label>
              )}

              {mode === "register" && (
                <div className="rounded border border-accent/30 bg-accent/8 px-3 py-2 text-xs text-text-secondary">
                  <span className="font-semibold text-text-primary">Public profile:</span> your display name and watchlists are visible to all users on the Community page.
                </div>
              )}

              {mode === "register" && (
                <label className="block">
                  <span className={fieldLabel}>Invite Code</span>
                  <input
                    className={inputClass}
                    value={form.inviteCode}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, inviteCode: event.target.value }))
                    }
                    placeholder="Enter invite code"
                    autoComplete="one-time-code"
                    required
                  />
                </label>
              )}

              {(mode === "login" || mode === "register") && (
                <label className="block">
                  <span className={fieldLabel}>Email</span>
                  <input
                    type="email"
                    className={inputClass}
                    value={form.email}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, email: event.target.value }))
                    }
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                  />
                </label>
              )}

              {(mode === "login" || mode === "register") && (
                <label className="block">
                  <span className={fieldLabel}>Password</span>
                  <input
                    type="password"
                    className={inputClass}
                    value={form.password}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, password: event.target.value }))
                    }
                    placeholder="At least 8 characters"
                    autoComplete={mode === "register" ? "new-password" : "current-password"}
                    required
                  />
                </label>
              )}

              {mode === "verify" && (
                <>
                  <div className="rounded border border-border bg-surface-2 px-3 py-2 text-xs text-text-secondary">
                    Enter the verification token from your email
                    {pendingEmail ? ` for ${pendingEmail}` : ""}.
                  </div>
                  <label className="block">
                    <span className={fieldLabel}>Verification Token</span>
                    <input
                      className={inputClass}
                      value={verificationToken}
                      onChange={(event) => setVerificationToken(event.target.value)}
                      placeholder="Paste token"
                      autoComplete="one-time-code"
                      required
                    />
                  </label>
                </>
              )}

              {info && (
                <div className="rounded border border-buy/30 bg-buy/10 px-3 py-2 text-xs text-buy">
                  {info}
                </div>
              )}

              {error && (
                <div className="rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded bg-accent py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting
                  ? mode === "register"
                    ? "Creating account..."
                    : mode === "verify"
                      ? "Verifying..."
                      : "Signing in..."
                  : mode === "register"
                    ? "Create Account"
                    : mode === "verify"
                      ? "Verify Email"
                      : "Sign In"}
              </button>
            </form>

            <div className="mt-3 text-center text-xs text-text-secondary">
              {(mode === "login" || mode === "register") && (
                <>
                  {mode === "register" ? "Already have an account?" : "Need an account?"}{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setMode((prev) => (prev === "register" ? "login" : "register"));
                      setError(null);
                      setInfo(null);
                    }}
                    className="text-accent hover:underline"
                  >
                    {mode === "register" ? "Sign in" : "Create one"}
                  </button>
                </>
              )}
              {mode === "verify" && (
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setError(null);
                  }}
                  className="text-accent hover:underline"
                >
                  Back to sign in
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

async function authRegister(input: {
  email: string;
  password: string;
  name: string;
  inviteCode: string;
}): Promise<AuthSessionPayload | AuthRegisterPendingVerificationPayload> {
  return authRequest<AuthSessionPayload | AuthRegisterPendingVerificationPayload>("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      name: input.name,
      inviteCode: input.inviteCode,
    }),
  });
}

async function authLogin(input: {
  email: string;
  password: string;
}): Promise<AuthSessionPayload> {
  return authRequest<AuthSessionPayload>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
    }),
  });
}

async function verifyEmailToken(token: string): Promise<void> {
  await authRequest<{ ok: boolean; user: AuthUser }>("/auth/verify-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

async function fetchCurrentUser(token: string): Promise<AuthUser> {
  const payload = await authRequest<{ user: AuthUser }>("/auth/me", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return payload.user;
}

async function authLogout(token: string): Promise<void> {
  await authRequest<{ ok: boolean }>("/auth/logout", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

async function authRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${AUTH_API_PREFIX}${path}`, init);
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & T;

  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }

  return body;
}

function readStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const token = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    return token && token.trim().length > 0 ? token : null;
  } catch {
    return null;
  }
}

function writeStoredToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

const fieldLabel = "mb-1 block text-[11px] text-text-secondary";
const inputClass =
  "w-full rounded border border-border bg-surface-3 px-2.5 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none";
