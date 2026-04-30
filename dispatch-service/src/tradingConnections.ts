import { readFile, writeFile } from "node:fs/promises";

export interface UserTradingConnection {
  userId: string;
  alpacaKeyId: string;
  alpacaSecretKeyTail: string;
  paper: boolean;
  enabled: boolean;
  defaultQty: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserTradingConnectionInput {
  alpacaKeyId?: string;
  alpacaSecretKey?: string;
  paper?: boolean;
  enabled?: boolean;
  defaultQty?: number;
}

interface StoredTradingConnection {
  userId: string;
  alpacaKeyId: string;
  alpacaSecretKey: string;
  paper: boolean;
  enabled: boolean;
  defaultQty: number;
  createdAt: string;
  updatedAt: string;
}

interface PersistedState {
  connections: StoredTradingConnection[];
}

export class TradingConnectionStore {
  private statePath: string;
  private connections = new Map<string, StoredTradingConnection>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(statePath: string) {
    this.statePath = statePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      const rows = Array.isArray(parsed.connections) ? parsed.connections : [];
      this.connections.clear();
      for (const row of rows) {
        if (isValidConnection(row)) {
          this.connections.set(row.userId, row);
        }
      }
    } catch {
      // Fresh startup.
    }
  }

  list(): UserTradingConnection[] {
    return Array.from(this.connections.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(toPublic);
  }

  get(userId: string): UserTradingConnection | null {
    const conn = this.connections.get(userId.trim());
    return conn ? toPublic(conn) : null;
  }

  getSecret(
    userId: string
  ): { keyId: string; secretKey: string; paper: boolean; enabled: boolean; defaultQty: number } | null {
    const conn = this.connections.get(userId.trim());
    if (!conn) return null;
    return {
      keyId: conn.alpacaKeyId,
      secretKey: conn.alpacaSecretKey,
      paper: conn.paper,
      enabled: conn.enabled,
      defaultQty: conn.defaultQty,
    };
  }

  upsert(userId: string, input: UserTradingConnectionInput): UserTradingConnection {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) throw new Error("userId is required");
    if (normalizedUserId.length > 200) throw new Error("userId is too long");

    const existing = this.connections.get(normalizedUserId);
    const now = new Date().toISOString();

    const keyId =
      input.alpacaKeyId !== undefined
        ? input.alpacaKeyId.trim()
        : existing?.alpacaKeyId ?? "";
    const secretKey =
      input.alpacaSecretKey !== undefined
        ? input.alpacaSecretKey.trim()
        : existing?.alpacaSecretKey ?? "";

    if (!keyId) throw new Error("Alpaca key ID is required");
    if (keyId.length > 200) throw new Error("Alpaca key ID is too long");
    if (!secretKey) throw new Error("Alpaca secret key is required");
    if (secretKey.length > 200) throw new Error("Alpaca secret key is too long");

    const rawQty =
      input.defaultQty !== undefined ? Number(input.defaultQty) : (existing?.defaultQty ?? 1);
    if (!Number.isFinite(rawQty) || rawQty <= 0) {
      throw new Error("defaultQty must be a positive number");
    }

    const conn: StoredTradingConnection = {
      userId: normalizedUserId,
      alpacaKeyId: keyId,
      alpacaSecretKey: secretKey,
      paper: input.paper !== undefined ? input.paper !== false : (existing?.paper ?? true),
      enabled: input.enabled !== undefined ? input.enabled !== false : (existing?.enabled ?? true),
      defaultQty: rawQty,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.connections.set(normalizedUserId, conn);
    void this.persist();
    return toPublic(conn);
  }

  remove(userId: string): boolean {
    const removed = this.connections.delete(userId.trim());
    if (removed) void this.persist();
    return removed;
  }

  private persist(): Promise<void> {
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        const payload: PersistedState = {
          connections: Array.from(this.connections.values()),
        };
        await writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf8");
      });
    return this.persistChain;
  }
}

function toPublic(conn: StoredTradingConnection): UserTradingConnection {
  return {
    userId: conn.userId,
    alpacaKeyId: conn.alpacaKeyId,
    alpacaSecretKeyTail: `****${conn.alpacaSecretKey.slice(-4)}`,
    paper: conn.paper,
    enabled: conn.enabled,
    defaultQty: conn.defaultQty,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

function isValidConnection(value: unknown): value is StoredTradingConnection {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<StoredTradingConnection>;
  return (
    typeof c.userId === "string" &&
    typeof c.alpacaKeyId === "string" &&
    typeof c.alpacaSecretKey === "string" &&
    typeof c.paper === "boolean" &&
    typeof c.enabled === "boolean" &&
    typeof c.defaultQty === "number" &&
    typeof c.createdAt === "string" &&
    typeof c.updatedAt === "string"
  );
}
