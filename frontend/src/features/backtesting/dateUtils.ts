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

export function addMonthsIso(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split("-").map((value) => Number(value));
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, targetMonthIndex + 1, 0)
  ).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);
  return new Date(Date.UTC(targetYear, targetMonthIndex, clampedDay))
    .toISOString()
    .split("T")[0];
}

export function normalizeIsoDateInput(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ts = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  return trimmed;
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function yearsAgoIso(years: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate())
  )
    .toISOString()
    .slice(0, 10);
}

export function monthsAgoIso(months: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate())
  )
    .toISOString()
    .slice(0, 10);
}
