// Calendar handling for the finance module. The business runs on Asia/Riyadh (UTC+3, no
// daylight saving), so a "day" and a "month" are always Riyadh calendar days/months.
// @db.Date columns are exchanged as "YYYY-MM-DD" strings and stored at UTC midnight.

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

export function riyadhDateString(at: Date = new Date()): string {
  return new Date(at.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

export function monthOf(dateStr: string): string {
  return dateStr.slice(0, 7);
}

export function isDateString(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isMonthString(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** "YYYY-MM-DD" → Date at UTC midnight, the representation Prisma uses for @db.Date. */
export function dbDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

/** Date from a @db.Date column → "YYYY-MM-DD". */
export function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

export function addDays(s: string, n: number): string {
  const d = dbDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return dateStr(d);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function diffDays(a: string, b: string): number {
  return Math.round((dbDate(b).getTime() - dbDate(a).getTime()) / 86_400_000);
}
