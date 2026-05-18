import http from "node:http";
import { ApiHttpError, fetchAlpacaAccountSnapshot, fetchMarketBars } from "../core.ts";
import { UserApiConnectionStore } from "../userApiConnections.ts";
import { DEFAULT_OPERATOR_USER_ID } from "../config.ts";

export async function handleBarsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  apiConnectionStore: UserApiConnectionStore
): Promise<void> {
  const symbolFromPath = url.pathname.match(/^\/api\/bars\/([^/]+)$/)?.[1];
  const isBarsRequest = url.pathname === "/api/bars" || Boolean(symbolFromPath);
  const isAlpacaPath = url.pathname.startsWith("/api/alpaca/");
  const isAlpacaAccountRequest = url.pathname === "/api/alpaca/account";

  if (isAlpacaPath && !isAlpacaAccountRequest) {
    res.writeHead(403);
    res.end(
      JSON.stringify({ error: "Trading endpoints are disabled. This service is read-only." })
    );
    return;
  }

  if (!isBarsRequest && !isAlpacaAccountRequest) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  try {
    if (isAlpacaAccountRequest) {
      const userCredentials =
        apiConnectionStore.getSecret(DEFAULT_OPERATOR_USER_ID) ?? undefined;
      const payload = await fetchAlpacaAccountSnapshot(userCredentials);
      res.writeHead(200);
      res.end(JSON.stringify(payload));
      return;
    }

    const symbol = url.searchParams.get("symbol") ?? symbolFromPath;
    const timeframeParam = url.searchParams.get("timeframe");
    const timeframe =
      timeframeParam === "1Hour" || timeframeParam === "15Min" || timeframeParam === "5Min"
        ? timeframeParam
        : "1Day";
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const payload = await fetchMarketBars({
      symbol: symbol ?? "",
      range: url.searchParams.get("range"),
      timeframe,
      startDate,
      endDate,
    });

    res.writeHead(200);
    res.end(JSON.stringify(payload));
  } catch (err) {
    if (err instanceof ApiHttpError) {
      res.writeHead(err.status);
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: msg }));
  }
}
