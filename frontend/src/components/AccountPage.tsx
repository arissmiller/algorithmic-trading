import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthUser } from "./AuthGate";

interface DispatchEmailProfile {
  enabled: boolean;
  address: string;
  name: string | null;
}

interface DispatchSmsProfile {
  enabled: boolean;
  phoneE164: string;
}

interface UserDispatchProfile {
  userId: string;
  enabled: boolean;
  email: DispatchEmailProfile | null;
  sms: DispatchSmsProfile | null;
  createdAt: string;
  updatedAt: string;
}

interface UserDispatchProfileInput {
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
}

type DispatchProfilePayload = {
  profile?: UserDispatchProfile;
  error?: string;
};

interface ApiConnection {
  userId: string;
  alpacaKeyId: string;
  alpacaSecretKeyTail: string;
  paper: boolean;
  updatedAt: string;
}

type ApiConnectionForm = {
  alpacaKeyId: string;
  alpacaSecretKey: string;
  paper: boolean;
};

interface TradingConnection {
  userId: string;
  alpacaKeyId: string;
  alpacaSecretKeyTail: string;
  paper: boolean;
  enabled: boolean;
  defaultQty: number;
  updatedAt: string;
}

type TradingConnectionForm = {
  alpacaKeyId: string;
  alpacaSecretKey: string;
  paper: boolean;
  enabled: boolean;
  defaultQty: string;
};

type CommunicationForm = {
  profileEnabled: boolean;
  emailEnabled: boolean;
  emailAddress: string;
  emailName: string;
  smsEnabled: boolean;
  smsPhoneE164: string;
};

const inputClass =
  "w-full rounded border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent/60 focus:outline-none";
const fieldLabelClass =
  "mb-1 block text-[10px] font-semibold uppercase tracking-widest text-text-secondary";
const helperTextClass = "mt-1 text-[10px] text-text-secondary";

const DATA_API_PREFIX = (() => {
  const base = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
  if (base) return `${base}/api`;
  if (import.meta.env.DEV) return "http://127.0.0.1:3001/api";
  return "/api";
})();

const AUTH_TOKEN_STORAGE_KEY = "smart_scale_auth_token";

function readStoredAuthToken(): string | null {
  try {
    const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    return token && token.trim() ? token : null;
  } catch {
    return null;
  }
}

const DISPATCH_AUTH_HEADER =
  (import.meta.env.VITE_DISPATCH_AUTH_HEADER ?? "x-dispatch-token").trim() ||
  "x-dispatch-token";
const DISPATCH_AUTH_TOKEN = (import.meta.env.VITE_DISPATCH_AUTH_TOKEN ?? "").trim();
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

const DISPATCH_API_PREFIX = getDispatchApiPrefix();

export default function AccountPage({
  authUser,
}: {
  authUser: AuthUser | null;
}) {
  const [profile, setProfile] = useState<UserDispatchProfile | null>(null);
  const [form, setForm] = useState<CommunicationForm>(() => buildDefaultForm(null));
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [apiConn, setApiConn] = useState<ApiConnection | null>(null);
  const [apiConnLoading, setApiConnLoading] = useState(false);
  const [apiConnEditing, setApiConnEditing] = useState(false);
  const [apiConnForm, setApiConnForm] = useState<ApiConnectionForm>({
    alpacaKeyId: "",
    alpacaSecretKey: "",
    paper: true,
  });
  const [apiConnSaving, setApiConnSaving] = useState(false);
  const [apiConnRemoving, setApiConnRemoving] = useState(false);
  const [apiConnTesting, setApiConnTesting] = useState(false);
  const [apiConnError, setApiConnError] = useState<string | null>(null);
  const [apiConnTestResult, setApiConnTestResult] = useState<string | null>(null);

  const [tradingConn, setTradingConn] = useState<TradingConnection | null>(null);
  const [tradingConnLoading, setTradingConnLoading] = useState(false);
  const [tradingConnEditing, setTradingConnEditing] = useState(false);
  const [tradingConnForm, setTradingConnForm] = useState<TradingConnectionForm>({
    alpacaKeyId: "",
    alpacaSecretKey: "",
    paper: true,
    enabled: true,
    defaultQty: "1",
  });
  const [tradingConnSaving, setTradingConnSaving] = useState(false);
  const [tradingConnRemoving, setTradingConnRemoving] = useState(false);
  const [tradingConnError, setTradingConnError] = useState<string | null>(null);

  const loadProfile = useCallback(async (user: AuthUser, options: { silent: boolean }) => {
    if (options.silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await fetch(
        `${DISPATCH_API_PREFIX}/users/${encodeURIComponent(user.id)}`,
        {
          method: "GET",
          headers: buildDispatchHeaders(),
        }
      );

      const payload = (await response.json().catch(() => ({}))) as DispatchProfilePayload;

      if (response.status === 404) {
        setProfile(null);
        setForm(buildDefaultForm(user));
        setError(null);
        return;
      }

      if (!response.ok) {
        throw new Error(payload.error ?? `Dispatch profile request failed (${response.status})`);
      }

      if (!payload.profile) {
        throw new Error("Dispatch service returned an invalid profile payload.");
      }

      setProfile(payload.profile);
      setForm(formFromProfile(payload.profile, user));
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to load communication preferences.";
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadApiConnection = useCallback(async () => {
    const token = readStoredAuthToken();
    if (!token) return;
    setApiConnLoading(true);
    setApiConnError(null);
    try {
      const res = await fetch(`${DATA_API_PREFIX}/bot/api-connection`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json().catch(() => ({}))) as {
        connection?: ApiConnection | null;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setApiConn(body.connection ?? null);
    } catch (err) {
      setApiConnError(err instanceof Error ? err.message : "Failed to load API connection");
    } finally {
      setApiConnLoading(false);
    }
  }, []);

  const saveApiConnection = useCallback(async () => {
    const token = readStoredAuthToken();
    if (!token) return;
    setApiConnSaving(true);
    setApiConnError(null);
    setApiConnTestResult(null);
    try {
      const res = await fetch(`${DATA_API_PREFIX}/bot/api-connection`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(apiConnForm),
      });
      const body = (await res.json().catch(() => ({}))) as {
        connection?: ApiConnection;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setApiConn(body.connection ?? null);
      setApiConnEditing(false);
    } catch (err) {
      setApiConnError(err instanceof Error ? err.message : "Failed to save API connection");
    } finally {
      setApiConnSaving(false);
    }
  }, [apiConnForm]);

  const removeApiConnection = useCallback(async () => {
    const token = readStoredAuthToken();
    if (!token) return;
    setApiConnRemoving(true);
    setApiConnError(null);
    setApiConnTestResult(null);
    try {
      const res = await fetch(`${DATA_API_PREFIX}/bot/api-connection`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setApiConn(null);
      setApiConnEditing(false);
      setApiConnForm({ alpacaKeyId: "", alpacaSecretKey: "", paper: true });
    } catch (err) {
      setApiConnError(err instanceof Error ? err.message : "Failed to remove API connection");
    } finally {
      setApiConnRemoving(false);
    }
  }, []);

  const testApiConnection = useCallback(async (useForm: boolean) => {
    const token = readStoredAuthToken();
    if (!token) return;
    setApiConnTesting(true);
    setApiConnError(null);
    setApiConnTestResult(null);
    try {
      const body = useForm
        ? { alpacaKeyId: apiConnForm.alpacaKeyId, alpacaSecretKey: apiConnForm.alpacaSecretKey, paper: apiConnForm.paper }
        : {};
      const res = await fetch(`${DATA_API_PREFIX}/bot/api-connection/test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const resBody = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        account?: { status?: string; equity?: number; buyingPower?: number };
        error?: string;
      };
      if (!res.ok) throw new Error(resBody.error ?? `HTTP ${res.status}`);
      const acct = resBody.account;
      setApiConnTestResult(
        `Connected — status: ${acct?.status ?? "?"}, equity: $${(acct?.equity ?? 0).toLocaleString()}`
      );
    } catch (err) {
      setApiConnError(err instanceof Error ? err.message : "Connection test failed");
    } finally {
      setApiConnTesting(false);
    }
  }, [apiConnForm]);

  const loadTradingConnection = useCallback(async (userId: string) => {
    setTradingConnLoading(true);
    setTradingConnError(null);
    try {
      const res = await fetch(
        `${DISPATCH_API_PREFIX}/users/${encodeURIComponent(userId)}/trading-connection`,
        { headers: buildDispatchHeaders() }
      );
      if (res.status === 404) {
        setTradingConn(null);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        connection?: TradingConnection;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setTradingConn(body.connection ?? null);
    } catch (err) {
      setTradingConnError(err instanceof Error ? err.message : "Failed to load trading connection");
    } finally {
      setTradingConnLoading(false);
    }
  }, []);

  const saveTradingConnection = useCallback(async (userId: string) => {
    setTradingConnSaving(true);
    setTradingConnError(null);
    try {
      const qty = Number(tradingConnForm.defaultQty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error("Default qty must be a positive number");
      }
      const res = await fetch(
        `${DISPATCH_API_PREFIX}/users/${encodeURIComponent(userId)}/trading-connection`,
        {
          method: "PUT",
          headers: buildDispatchHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            alpacaKeyId: tradingConnForm.alpacaKeyId,
            alpacaSecretKey: tradingConnForm.alpacaSecretKey || undefined,
            paper: tradingConnForm.paper,
            enabled: tradingConnForm.enabled,
            defaultQty: qty,
          }),
        }
      );
      const body = (await res.json().catch(() => ({}))) as {
        connection?: TradingConnection;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setTradingConn(body.connection ?? null);
      setTradingConnEditing(false);
    } catch (err) {
      setTradingConnError(err instanceof Error ? err.message : "Failed to save trading connection");
    } finally {
      setTradingConnSaving(false);
    }
  }, [tradingConnForm]);

  const removeTradingConnection = useCallback(async (userId: string) => {
    setTradingConnRemoving(true);
    setTradingConnError(null);
    try {
      const res = await fetch(
        `${DISPATCH_API_PREFIX}/users/${encodeURIComponent(userId)}/trading-connection`,
        { method: "DELETE", headers: buildDispatchHeaders() }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setTradingConn(null);
      setTradingConnEditing(false);
      setTradingConnForm({ alpacaKeyId: "", alpacaSecretKey: "", paper: true, enabled: true, defaultQty: "1" });
    } catch (err) {
      setTradingConnError(err instanceof Error ? err.message : "Failed to remove trading connection");
    } finally {
      setTradingConnRemoving(false);
    }
  }, []);

  useEffect(() => {
    setMessage(null);
    setError(null);
    setProfile(null);
    setForm(buildDefaultForm(authUser));
    setApiConn(null);
    setApiConnEditing(false);
    setApiConnError(null);
    setApiConnTestResult(null);
    setApiConnForm({ alpacaKeyId: "", alpacaSecretKey: "", paper: true });
    setTradingConn(null);
    setTradingConnEditing(false);
    setTradingConnError(null);
    setTradingConnForm({ alpacaKeyId: "", alpacaSecretKey: "", paper: true, enabled: true, defaultQty: "1" });

    if (!authUser) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    void loadProfile(authUser, { silent: false });
    void loadApiConnection();
    void loadTradingConnection(authUser.id);
  }, [authUser, loadProfile, loadApiConnection, loadTradingConnection]);

  const canSave = useMemo(() => {
    if (!authUser) return false;
    if (saving || removing || loading) return false;
    return true;
  }, [authUser, saving, removing, loading]);

  async function handleSave(): Promise<void> {
    if (!authUser) return;

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const payload = buildProfileInput(form, profile);
      const response = await fetch(
        `${DISPATCH_API_PREFIX}/users/${encodeURIComponent(authUser.id)}`,
        {
          method: "PUT",
          headers: buildDispatchHeaders({
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(payload),
        }
      );

      const body = (await response.json().catch(() => ({}))) as DispatchProfilePayload;
      if (!response.ok) {
        throw new Error(body.error ?? `Dispatch profile save failed (${response.status})`);
      }
      if (!body.profile) {
        throw new Error("Dispatch service returned an invalid profile payload.");
      }

      setProfile(body.profile);
      setForm(formFromProfile(body.profile, authUser));
      setMessage("Communication preferences saved.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to save communication preferences.";
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveProfile(): Promise<void> {
    if (!authUser) return;

    setRemoving(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(
        `${DISPATCH_API_PREFIX}/users/${encodeURIComponent(authUser.id)}`,
        {
          method: "DELETE",
          headers: buildDispatchHeaders(),
        }
      );

      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok && response.status !== 404) {
        throw new Error(body.error ?? `Dispatch profile delete failed (${response.status})`);
      }

      setProfile(null);
      setForm(buildDefaultForm(authUser));
      setMessage("Saved communication profile cleared.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to clear communication profile.";
      setError(msg);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="h-full overflow-auto p-4">
      <section className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-sm font-semibold mb-1">Account Communication Preferences</h2>
          <p className="text-xs text-text-secondary">
            Choose how Smart Scale sends watchlist signal notifications for your signed-in account.
          </p>
        </div>

        {authUser ? (
          <button
            type="button"
            onClick={() => void loadProfile(authUser, { silent: false })}
            disabled={loading || refreshing || saving || removing}
            className="ml-auto rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading || refreshing ? "Refreshing..." : "Refresh"}
          </button>
        ) : null}
      </section>

      {!authUser ? (
        <div className="rounded border border-border bg-surface-1 px-4 py-4 text-xs text-text-secondary">
          Sign in from the top-right auth menu to manage your notification preferences.
        </div>
      ) : (
        <>
          <section className="mb-4 rounded border border-border bg-surface-1 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-text-secondary">Email</p>
                <p className="mt-1 text-xs text-text-primary">{authUser.email}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest text-text-secondary">User ID</p>
                <p className="mt-1 break-all text-xs text-text-primary">{authUser.id}</p>
              </div>
            </div>
            <p className="mt-3 text-[10px] text-text-secondary">
              {profile
                ? `Last saved ${new Date(profile.updatedAt).toLocaleString()}`
                : "No saved communication profile yet."}
            </p>
          </section>

          {error && (
            <div className="mb-4 rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
              {error}
            </div>
          )}

          {message && (
            <div className="mb-4 rounded border border-buy/30 bg-buy/10 px-3 py-2 text-xs text-buy">
              {message}
            </div>
          )}

          <section className="rounded border border-border bg-surface-1 p-4">
            <label className="mb-4 flex items-start gap-2 rounded border border-border/70 bg-surface-2 px-3 py-2">
              <input
                type="checkbox"
                checked={form.profileEnabled}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, profileEnabled: event.target.checked }))
                }
                className="mt-0.5 h-4 w-4 rounded border-border bg-surface-3 text-accent focus:ring-accent/30"
              />
              <div>
                <p className="text-xs font-medium text-text-primary">Enable all communication</p>
                <p className={helperTextClass}>
                  When disabled, watchlist signals are generated but not sent to channels.
                </p>
              </div>
            </label>

            <div className="mb-4 rounded border border-border/70 bg-surface-2 p-3">
              <label className="mb-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={form.emailEnabled}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, emailEnabled: event.target.checked }))
                  }
                  className="mt-0.5 h-4 w-4 rounded border-border bg-surface-3 text-accent focus:ring-accent/30"
                />
                <div>
                  <p className="text-xs font-medium text-text-primary">Email notifications</p>
                  <p className={helperTextClass}>Send signal alerts to your email inbox.</p>
                </div>
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className={fieldLabelClass}>Email Address</span>
                  <input
                    type="email"
                    className={inputClass}
                    value={form.emailAddress}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, emailAddress: event.target.value }))
                    }
                    placeholder="you@example.com"
                  />
                </label>
                <label className="block">
                  <span className={fieldLabelClass}>Display Name (Optional)</span>
                  <input
                    className={inputClass}
                    value={form.emailName}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, emailName: event.target.value }))
                    }
                    placeholder="Trader name"
                  />
                </label>
              </div>
            </div>

            <div className="rounded border border-border/70 bg-surface-2 p-3">
              <label className="mb-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={form.smsEnabled}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, smsEnabled: event.target.checked }))
                  }
                  className="mt-0.5 h-4 w-4 rounded border-border bg-surface-3 text-accent focus:ring-accent/30"
                />
                <div>
                  <p className="text-xs font-medium text-text-primary">SMS notifications</p>
                  <p className={helperTextClass}>Send text alerts for new watchlist signals.</p>
                </div>
              </label>

              <label className="block">
                <span className={fieldLabelClass}>Phone Number (E.164)</span>
                <input
                  className={inputClass}
                  value={form.smsPhoneE164}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, smsPhoneE164: event.target.value }))
                  }
                  placeholder="+14155551212"
                />
                <p className={helperTextClass}>Use international format like +14155551212.</p>
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!canSave}
                className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save Preferences"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setForm(buildDefaultForm(authUser));
                  setMessage("Reverted local form to defaults. Save to persist.");
                  setError(null);
                }}
                disabled={saving || removing || loading}
                className="rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                Reset Form
              </button>

              <button
                type="button"
                onClick={() => void handleRemoveProfile()}
                disabled={saving || removing || loading}
                className="rounded border border-sell/40 bg-sell/10 px-3 py-1.5 text-xs text-sell transition-colors hover:border-sell/70 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {removing ? "Clearing..." : "Clear Saved Profile"}
              </button>
            </div>
          </section>

          <section className="mt-6 rounded border border-border bg-surface-1 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <div>
                <h2 className="text-sm font-semibold">Alpaca Market Data Connection</h2>
                <p className="mt-0.5 text-xs text-text-secondary">
                  Store your Alpaca API key to use your own account for market data and portfolio.
                </p>
              </div>
              {apiConn && !apiConnEditing && (
                <button
                  type="button"
                  onClick={() => void testApiConnection(false)}
                  disabled={apiConnTesting || apiConnRemoving}
                  className="ml-auto rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {apiConnTesting ? "Testing..." : "Test"}
                </button>
              )}
            </div>

            {apiConnError && (
              <div className="mb-3 rounded border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-sell">
                {apiConnError}
              </div>
            )}
            {apiConnTestResult && (
              <div className="mb-3 rounded border border-buy/30 bg-buy/10 px-3 py-2 text-xs text-buy">
                {apiConnTestResult}
              </div>
            )}

            {apiConnLoading ? (
              <p className="text-xs text-text-secondary">Loading...</p>
            ) : apiConn && !apiConnEditing ? (
              <div>
                <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-text-secondary">Key ID</p>
                    <p className="mt-1 break-all text-xs text-text-primary">{apiConn.alpacaKeyId}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-text-secondary">Secret</p>
                    <p className="mt-1 text-xs text-text-primary">{apiConn.alpacaSecretKeyTail}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-text-secondary">Mode</p>
                    <p className="mt-1 text-xs text-text-primary">{apiConn.paper ? "Paper" : "Live"}</p>
                  </div>
                </div>
                <p className="mb-3 text-[10px] text-text-secondary">
                  Last saved {new Date(apiConn.updatedAt).toLocaleString()}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setApiConnForm({ alpacaKeyId: apiConn.alpacaKeyId, alpacaSecretKey: "", paper: apiConn.paper });
                      setApiConnEditing(true);
                      setApiConnError(null);
                      setApiConnTestResult(null);
                    }}
                    disabled={apiConnRemoving}
                    className="rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Update Keys
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeApiConnection()}
                    disabled={apiConnRemoving}
                    className="rounded border border-sell/40 bg-sell/10 px-3 py-1.5 text-xs text-sell transition-colors hover:border-sell/70 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {apiConnRemoving ? "Removing..." : "Remove"}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className={fieldLabelClass}>API Key ID</span>
                    <input
                      className={inputClass}
                      value={apiConnForm.alpacaKeyId}
                      onChange={(e) => setApiConnForm((p) => ({ ...p, alpacaKeyId: e.target.value }))}
                      placeholder="PKXXXXXXXXXXXXXXXX"
                      autoComplete="off"
                    />
                  </label>
                  <label className="block">
                    <span className={fieldLabelClass}>Secret Key</span>
                    <input
                      type="password"
                      className={inputClass}
                      value={apiConnForm.alpacaSecretKey}
                      onChange={(e) => setApiConnForm((p) => ({ ...p, alpacaSecretKey: e.target.value }))}
                      placeholder={apiConn ? "Leave blank to keep existing" : "Secret key"}
                      autoComplete="new-password"
                    />
                  </label>
                </div>
                <label className="mb-3 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={apiConnForm.paper}
                    onChange={(e) => setApiConnForm((p) => ({ ...p, paper: e.target.checked }))}
                    className="h-4 w-4 rounded border-border bg-surface-3 text-accent focus:ring-accent/30"
                  />
                  <span className="text-xs text-text-primary">Paper trading account</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void testApiConnection(true)}
                    disabled={apiConnTesting || apiConnSaving || !apiConnForm.alpacaKeyId || !apiConnForm.alpacaSecretKey}
                    className="rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {apiConnTesting ? "Testing..." : "Test"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveApiConnection()}
                    disabled={apiConnSaving || apiConnTesting || !apiConnForm.alpacaKeyId || !apiConnForm.alpacaSecretKey}
                    className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {apiConnSaving ? "Saving..." : "Save"}
                  </button>
                  {apiConnEditing && (
                    <button
                      type="button"
                      onClick={() => { setApiConnEditing(false); setApiConnError(null); setApiConnTestResult(null); }}
                      disabled={apiConnSaving}
                      className="rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function buildProfileInput(
  form: CommunicationForm,
  existing: UserDispatchProfile | null
): UserDispatchProfileInput {
  const normalizedEmail = form.emailAddress.trim().toLowerCase();
  const normalizedName = trimToNull(form.emailName);
  const normalizedPhone = form.smsPhoneE164.trim();

  if (form.emailEnabled && !normalizedEmail) {
    throw new Error("Email address is required when email notifications are enabled.");
  }

  if (form.smsEnabled && !normalizedPhone) {
    throw new Error("SMS phone number is required when SMS notifications are enabled.");
  }

  if (form.smsEnabled && !E164_PATTERN.test(normalizedPhone)) {
    throw new Error("SMS phone number must be valid E.164 format (for example +14155551212).");
  }

  const fallbackEmailAddress = normalizedEmail || (existing?.email?.address ?? "");
  const fallbackSmsPhone = normalizedPhone || (existing?.sms?.phoneE164 ?? "");

  const email =
    fallbackEmailAddress.length > 0
      ? {
          enabled: form.emailEnabled,
          address: fallbackEmailAddress,
          name: normalizedName ?? existing?.email?.name ?? null,
        }
      : null;

  const sms =
    fallbackSmsPhone.length > 0
      ? {
          enabled: form.smsEnabled,
          phoneE164: fallbackSmsPhone,
        }
      : null;

  return {
    enabled: form.profileEnabled,
    email,
    sms,
  };
}

function buildDefaultForm(authUser: AuthUser | null): CommunicationForm {
  return {
    profileEnabled: true,
    emailEnabled: true,
    emailAddress: authUser?.email ?? "",
    emailName: authUser?.name ?? "",
    smsEnabled: false,
    smsPhoneE164: "",
  };
}

function formFromProfile(profile: UserDispatchProfile, authUser: AuthUser): CommunicationForm {
  return {
    profileEnabled: profile.enabled,
    emailEnabled: profile.email?.enabled ?? false,
    emailAddress: profile.email?.address ?? authUser.email,
    emailName: profile.email?.name ?? authUser.name,
    smsEnabled: profile.sms?.enabled ?? false,
    smsPhoneE164: profile.sms?.phoneE164 ?? "",
  };
}

function getDispatchApiPrefix(): string {
  const configured = (import.meta.env.VITE_DISPATCH_API_BASE_URL ?? "").replace(/\/+$/, "");
  if (configured.length > 0) {
    return `${configured}/api/dispatch`;
  }

  if (import.meta.env.DEV) {
    return "http://127.0.0.1:3003/api/dispatch";
  }

  return "/api/dispatch";
}

function buildDispatchHeaders(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...(extra ?? {}) };
  if (DISPATCH_AUTH_TOKEN.length > 0) {
    out[DISPATCH_AUTH_HEADER] = DISPATCH_AUTH_TOKEN;
  }
  return out;
}

function trimToNull(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
