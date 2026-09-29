/**
 * Calendar-date helpers. Dates are "YYYY-MM-DD" strings in the company's
 * time zone; @db.Date columns round-trip as UTC midnight.
 */

export const COMPANY_TIME_ZONE = 'Asia/Kolkata';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Date column → "YYYY-MM-DD". */
export const toIsoDate = (d: Date) => d.toISOString().slice(0, 10);

/** "YYYY-MM-DD" → UTC midnight, matching how @db.Date columns round-trip. */
export const fromIsoDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Today's date in the company time zone. */
export function todayIso(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: COMPANY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(iso: string, days: number): string {
  return toIsoDate(new Date(fromIsoDate(iso).getTime() + days * DAY_MS));
}

/** Whole days from `a` to `b` (negative if b is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((fromIsoDate(b).getTime() - fromIsoDate(a).getTime()) / DAY_MS);
}

/** Every date from start to end, inclusive. */
export function eachDay(start: string, end: string): string[] {
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

export function isWeekend(iso: string): boolean {
  const day = fromIsoDate(iso).getUTCDay();
  return day === 0 || day === 6;
}

export const yearOf = (iso: string) => Number(iso.slice(0, 4));

/** "2026-10-12" → "12 Oct 2026". */
export function formatDate(iso: string): string {
  return fromIsoDate(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
