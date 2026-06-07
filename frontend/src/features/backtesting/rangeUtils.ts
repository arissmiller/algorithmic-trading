export function rangeForStartDate(startDate: string): string {
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(startTs)) {
    return "2y";
  }

  const warmupDays = 90;
  const daysBack = (Date.now() - startTs) / 86_400_000;
  if (daysBack > 5 * 365 - warmupDays) return "max";
  if (daysBack > 2 * 365 - warmupDays) return "5y";
  if (daysBack > 365 - warmupDays) return "2y";
  return "1y";
}
