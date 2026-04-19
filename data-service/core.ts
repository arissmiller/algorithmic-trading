const RANGE_MAP: Record<string, string> = {
  "1y": "1y",
  "2y": "2y",
  "5y": "5y",
  max: "max",
};

export class ApiHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function fetchYahooBars(input: {
  symbol: string;
  range: string | null;
}): Promise<{ symbol: string; bars: ApiBar[] }> {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) {
    throw new ApiHttpError(400, "Missing symbol");
  }

  const range = RANGE_MAP[input.range ?? "2y"] ?? "2y";

  const yfUrl =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=${range}&includeAdjustedClose=true`;

  const yfRes = await fetch(yfUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
    },
  });

  if (!yfRes.ok) {
    throw new ApiHttpError(502, `Yahoo Finance returned ${yfRes.status}`);
  }

  const json = (await yfRes.json()) as YFChartResponse;
  const result = json.chart?.result?.[0];

  if (!result) {
    const errMsg = json.chart?.error?.description ?? "No data returned";
    throw new ApiHttpError(404, errMsg);
  }

  const timestamps = result.timestamp ?? [];
  const quote = result.indicators.quote[0];
  const adjClose = result.indicators.adjclose?.[0]?.adjclose ?? [];

  const bars = timestamps
    .map((ts, i) => ({
      t: new Date(ts * 1000).toISOString(),
      o: quote.open[i],
      h: quote.high[i],
      l: quote.low[i],
      c: adjClose[i] ?? quote.close[i],
      v: quote.volume[i] ?? 0,
    }))
    .filter((bar) => bar.o != null && bar.c != null)
    .map((bar) => ({
      t: bar.t,
      o: round(bar.o!),
      h: round(bar.h!),
      l: round(bar.l!),
      c: round(bar.c!),
      v: bar.v,
    }));

  return { symbol, bars };
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

interface ApiBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

interface YFChartResponse {
  chart: {
    result?: Array<{
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose: (number | null)[] }>;
      };
    }>;
    error?: { description: string };
  };
}
