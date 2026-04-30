const ALPACA_PAPER_BASE = "https://paper-api.alpaca.markets";
const ALPACA_LIVE_BASE = "https://api.alpaca.markets";

export interface AlpacaOrderResult {
  status: "placed" | "failed" | "skipped";
  reason: string | null;
  orderId: string | null;
}

export class AlpacaConnector {
  private keyId: string;
  private secretKey: string;
  private baseUrl: string;

  constructor(keyId: string, secretKey: string, paper: boolean) {
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.baseUrl = paper ? ALPACA_PAPER_BASE : ALPACA_LIVE_BASE;
  }

  async placeMarketOrder(
    symbol: string,
    side: "buy" | "sell",
    qty: number
  ): Promise<AlpacaOrderResult> {
    try {
      const response = await fetch(`${this.baseUrl}/v2/orders`, {
        method: "POST",
        headers: {
          "APCA-API-KEY-ID": this.keyId,
          "APCA-API-SECRET-KEY": this.secretKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          symbol,
          qty: String(qty),
          side,
          type: "market",
          time_in_force: "day",
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        id?: string;
        message?: string;
        code?: number;
      } | null;

      if (!response.ok) {
        const message = payload?.message ?? `HTTP ${response.status}`;
        return { status: "failed", reason: `Alpaca: ${message}`, orderId: null };
      }

      return { status: "placed", reason: null, orderId: payload?.id ?? null };
    } catch (err) {
      return {
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
        orderId: null,
      };
    }
  }
}
