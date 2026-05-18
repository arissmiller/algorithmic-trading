import { ApiHttpError, fetchMarketBars } from "../core";

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const symbolParam = firstQueryValue(req.query?.symbol);
  const rangeParam = firstQueryValue(req.query?.range) ?? null;
  const timeframeParam = firstQueryValue(req.query?.timeframe);
  const timeframe =
    timeframeParam === "1Hour" || timeframeParam === "15Min" || timeframeParam === "5Min"
      ? timeframeParam
      : "1Day";
  const startDate = firstQueryValue(req.query?.startDate);
  const endDate = firstQueryValue(req.query?.endDate);

  try {
    const payload = await fetchMarketBars({
      symbol: symbolParam ?? "",
      range: rangeParam,
      timeframe,
      startDate,
      endDate,
    });

    res.statusCode = 200;
    res.end(JSON.stringify(payload));
  } catch (err) {
    if (err instanceof ApiHttpError) {
      res.statusCode = err.status;
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: msg }));
  }
}

function firstQueryValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : null;
  }
  return typeof value === "string" ? value : null;
}
