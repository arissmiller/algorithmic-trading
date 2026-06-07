export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function normalizeCryptoSymbol(symbol: string): string {
  return normalizeSymbol(symbol).replace(/[-_]/g, "/");
}

export function isLikelyCryptoSymbol(symbol: string): boolean {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  if (SUPPORTED_CRYPTO_BASES.has(normalized)) return true;
  if (normalized.includes("/")) return true;
  return /^[A-Z0-9]{2,10}[-_](USD|USDT|USDC|BTC|ETH|EUR|GBP|JPY)$/.test(normalized);
}

const SUPPORTED_CRYPTO_BASES = new Set([
  "AAVE",
  "ALGO",
  "AVAX",
  "BAT",
  "BCH",
  "BTC",
  "CRV",
  "DOGE",
  "DOT",
  "ETH",
  "GRT",
  "LINK",
  "LTC",
  "MKR",
  "NEAR",
  "PAXG",
  "SHIB",
  "SOL",
  "SUSHI",
  "TRX",
  "UNI",
  "USDC",
  "USDT",
  "WBTC",
  "XTZ",
  "YFI",
]);
