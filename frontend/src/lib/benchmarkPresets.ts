export type BenchmarkPreset = {
  id: string;
  label: string;
  symbols: string[];
  description?: string;
};

const SYMBOL_PATTERN = /^[A-Z0-9.\^/_-]+$/;

const DEFAULT_MARKET_BENCHMARKS = ["^GSPC", "^DJI", "QQQ"] as const;

const MARKET_INDEX_PRESET: BenchmarkPreset = {
  id: "market_indexes",
  label: "Broad Market",
  symbols: [...DEFAULT_MARKET_BENCHMARKS],
  description: "S&P 500, Dow Jones, and Nasdaq-100.",
};

const LIVE_PORTFOLIO_THEME_PRESETS: Record<string, BenchmarkPreset> = {
  advanced_industrials_automation: {
    id: "semiconductors_etf_peers",
    label: "Semiconductors ETFs",
    symbols: ["SOXX", "SMH", "XSD", "SOXQ"],
    description: "Semiconductor-focused ETF peers, with SOXX as the primary default benchmark.",
  },
  enterprise_software: {
    id: "enterprise_software_etf_peers",
    label: "Enterprise Software ETFs",
    symbols: ["IGV", "SKYY", "CLOU", "CIBR", "HACK"],
    description: "Software, cloud, and cybersecurity ETF peers.",
  },
  healthcare_automation_innovation: {
    id: "healthcare_automation_etf_peers",
    label: "Healthcare Automation ETFs",
    symbols: ["IHI", "XHE", "VHT", "XLV", "ARKG"],
    description: "Medical devices, healthcare equipment, genomics, and broad healthcare ETF peers.",
  },
};

export function defaultMarketBenchmarkSymbols(): string[] {
  return [...DEFAULT_MARKET_BENCHMARKS];
}

export function normalizeBenchmarkSymbolList(symbols: readonly string[]): string[] {
  const unique = new Set<string>();

  for (const rawSymbol of symbols) {
    if (typeof rawSymbol !== "string") continue;
    const symbol = rawSymbol.trim().toUpperCase();
    if (!symbol || !SYMBOL_PATTERN.test(symbol)) continue;
    unique.add(symbol);
  }

  return Array.from(unique);
}

export function getLivePortfolioBenchmarkPresets(portfolioKey?: string): BenchmarkPreset[] {
  const normalizedKey = normalizePortfolioKey(portfolioKey);
  const themedPreset = normalizedKey ? LIVE_PORTFOLIO_THEME_PRESETS[normalizedKey] : undefined;

  if (!themedPreset) return [MARKET_INDEX_PRESET];
  return [themedPreset, MARKET_INDEX_PRESET];
}

export function getDefaultLivePortfolioBenchmarkSymbols(portfolioKey?: string): string[] {
  const presets = getLivePortfolioBenchmarkPresets(portfolioKey);
  const firstPreset = presets[0];
  if (!firstPreset) return defaultMarketBenchmarkSymbols();

  const normalized = normalizeBenchmarkSymbolList(firstPreset.symbols);
  if (normalized.length > 0) return normalized;
  return defaultMarketBenchmarkSymbols();
}

function normalizePortfolioKey(value?: string): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
