export function deriveInclusiveDaySpan(startDate: string, endDate: string): number {
  const dayMs = 86_400_000;
  const startTs = Date.parse(`${startDate}T00:00:00Z`);
  const endTs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
    throw new Error("Start and end dates must both be valid ISO dates.");
  }
  if (endTs < startTs) {
    throw new Error("End date must be on or after start date.");
  }
  return Math.max(1, Math.floor((endTs - startTs) / dayMs) + 1);
}

export function addDaysIso(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map((value) => Number(value));
  const nextDate = new Date(Date.UTC(year, month - 1, day + days));
  return nextDate.toISOString().split("T")[0];
}
