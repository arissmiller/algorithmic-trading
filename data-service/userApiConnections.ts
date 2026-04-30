import { readFile, writeFile } from "node:fs/promises";

export interface UserApiConnectionPublic {
  userId: string;
  alpacaKeyId: string;
  alpacaSecretKeyTail: string;
  paper: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserApiConnectionInput {
  alpacaKeyId: string;
  alpacaSecretKey: string;
  paper: boolean;
}

interface UserApiConnection {
  userId: string;
  alpacaKeyId: string;
  alpacaSecretKey: string;
  paper: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PersistedState {
  connections: UserApiConnection[];
}

export class UserApiConnectionStore {
  private statePath: string;
  private connections = new Map<string, UserApiConnection>();
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

  get(userId: string): UserApiConnectionPublic | null {
    const conn = this.connections.get(userId);
    return conn ? toPublic(conn) : null;
  }

  getSecret(userId: string): { keyId: string; secretKey: string; paper: boolean } | null {
    const conn = this.connections.get(userId);
    if (!conn) return null;
    return { keyId: conn.alpacaKeyId, secretKey: conn.alpacaSecretKey, paper: conn.paper };
  }

  upsert(userId: string, input: UserApiConnectionInput): UserApiConnectionPublic {
    const keyId = (input.alpacaKeyId ?? "").trim();
    const secretKey = (input.alpacaSecretKey ?? "").trim();
    if (!keyId) throw new Error("Alpaca key ID is required");
    if (keyId.length > 200) throw new Error("Alpaca key ID is too long");
    if (!secretKey) throw new Error("Alpaca secret key is required");
    if (secretKey.length > 200) throw new Error("Alpaca secret key is too long");

    const existing = this.connections.get(userId);
    const now = new Date().toISOString();
    const conn: UserApiConnection = {
      userId,
      alpacaKeyId: keyId,
      alpacaSecretKey: secretKey,
      paper: input.paper !== false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.connections.set(userId, conn);
    void this.persist();
    return toPublic(conn);
  }

  remove(userId: string): boolean {
    const removed = this.connections.delete(userId);
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

function toPublic(conn: UserApiConnection): UserApiConnectionPublic {
  const tail = conn.alpacaSecretKey.slice(-4);
  return {
    userId: conn.userId,
    alpacaKeyId: conn.alpacaKeyId,
    alpacaSecretKeyTail: `****${tail}`,
    paper: conn.paper,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

function isValidConnection(value: unknown): value is UserApiConnection {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<UserApiConnection>;
  return (
    typeof c.userId === "string" &&
    typeof c.alpacaKeyId === "string" &&
    typeof c.alpacaSecretKey === "string" &&
    typeof c.paper === "boolean" &&
    typeof c.createdAt === "string" &&
    typeof c.updatedAt === "string"
  );
}
