const SIGNAL_DISPATCH_URL = (process.env.SIGNAL_DISPATCH_URL ?? "").trim();
const SIGNAL_DISPATCH_TIMEOUT_MS = Number(
  process.env.SIGNAL_DISPATCH_TIMEOUT_MS ?? 5_000
);
const SIGNAL_DISPATCH_AUTH_HEADER = (
  process.env.SIGNAL_DISPATCH_AUTH_HEADER ?? "x-dispatch-token"
).trim();
const SIGNAL_DISPATCH_AUTH_TOKEN = (
  process.env.SIGNAL_DISPATCH_AUTH_TOKEN ?? ""
).trim();

export interface DispatchableTradingSignal {
  id: string;
  userId: string;
  symbol: string;
  timeframe: "1Day" | "1Hour";
  action: "buy" | "sell";
  signalScore: number;
  rationale: string;
  barTime: string;
  generatedAt: string;
  watchlistUpdatedAt: string;
  preferredChannels?: ("email" | "sms")[];
}

export interface SignalDispatchResult {
  status: "sent" | "skipped" | "failed";
  statusCode: number | null;
  error: string | null;
}

export async function dispatchTradingSignal(
  signal: DispatchableTradingSignal
): Promise<SignalDispatchResult> {
  if (!SIGNAL_DISPATCH_URL) {
    return {
      status: "skipped",
      statusCode: null,
      error: "SIGNAL_DISPATCH_URL is not configured",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIGNAL_DISPATCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-signal-source": "data-service",
    };

    if (SIGNAL_DISPATCH_AUTH_TOKEN) {
      headers[SIGNAL_DISPATCH_AUTH_HEADER] = SIGNAL_DISPATCH_AUTH_TOKEN;
    }

    const response = await fetch(SIGNAL_DISPATCH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(signal),
      signal: controller.signal,
    });

    const payload = await readDispatchResponseBody(response);

    if (!response.ok) {
      const details = payload.errorText;
      return {
        status: "failed",
        statusCode: response.status,
        error: `Dispatch service returned ${response.status}${
          details ? `: ${details}` : ""
        }`,
      };
    }

    const dispatchStatus = payload.json?.status;
    if (dispatchStatus === "skipped") {
      return {
        status: "skipped",
        statusCode: response.status,
        error: payload.json?.reason ?? "Dispatch service skipped delivery",
      };
    }

    if (dispatchStatus === "failed" || dispatchStatus === "partial") {
      return {
        status: "failed",
        statusCode: response.status,
        error: payload.json?.reason ?? `Dispatch service reported ${dispatchStatus}`,
      };
    }

    return {
      status: "sent",
      statusCode: response.status,
      error: null,
    };
  } catch (err) {
    return {
      status: "failed",
      statusCode: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readDispatchResponseBody(response: Response): Promise<{
  errorText: string;
  json: { status?: string; reason?: string } | null;
}> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return {
        errorText: "",
        json: null,
      };
    }

    let json: { status?: string; reason?: string } | null = null;
    try {
      const parsed = JSON.parse(text) as { status?: unknown; reason?: unknown };
      json = {
        status: typeof parsed.status === "string" ? parsed.status : undefined,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    } catch {
      // Not JSON, keep raw error text.
    }

    return {
      errorText: text.slice(0, 300),
      json,
    };
  } catch {
    return {
      errorText: "",
      json: null,
    };
  }
}
