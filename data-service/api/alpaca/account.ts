import { ApiHttpError, fetchAlpacaAccountSnapshot } from "../../core";

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

  try {
    const payload = await fetchAlpacaAccountSnapshot();
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
