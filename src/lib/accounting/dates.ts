// Accounting core A1 — business days. The company's day is the Asia/Riyadh calendar day (UTC+3, no DST): a
// sale at 23:30 Riyadh on 31 October is an October sale even though it is 20:30 UTC. The ledger stores an
// entry date as that calendar day at 00:00 UTC (a date, carried in a timestamp column), and a period spans
// [first day 00:00 UTC, last day 23:59:59.999 UTC]. Pure.

const RIYADH_OFFSET_MS = 3 * 3600_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The Riyadh calendar day of an instant, as 00:00 UTC of that day. */
export function riyadhDay(at: Date = new Date()): Date {
  const shifted = new Date(at.getTime() + RIYADH_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** "YYYY-MM-DD" → that day at 00:00 UTC; refuses impossible dates (2026-02-30). */
export function parseBusinessDay(v: string): Date {
  const m = DAY.exec(String(v ?? "").trim());
  if (!m) throw new RangeError(`Not a date (YYYY-MM-DD): "${v}".`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new RangeError(`Not a calendar date: "${v}".`);
  }
  return d;
}

export function isBusinessDay(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try { parseBusinessDay(v); return true; } catch { return false; }
}

/** A stored business day (00:00 UTC) → "YYYY-MM-DD". */
export function dayText(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Normalise any date the caller passes to the business day it means: a 00:00 UTC date stays; an instant → its Riyadh day. */
export function toBusinessDay(d: Date): Date {
  const isMidnightUtc = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return isMidnightUtc ? d : riyadhDay(d);
}

/** The month [start, end] of a Gregorian period: start 00:00 UTC of day 1, end 23:59:59.999 UTC of the last day. */
export function monthPeriod(year: number, month: number): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)) };
}

export function addDaysUtc(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}
