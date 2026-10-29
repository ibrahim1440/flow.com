// «المعاملات المتكررة» (feat/recurring-journals, 20261120090000_recurring_journals) — the schedule's date maths. Pure:
// no database, safe in unit tests and in client components (the form previews the next dates with it).
//
// A schedule is a rule (frequency, interval, start date, optional end date and / or occurrence count). Occurrence k
// (0-based) is computed FROM THE START, never from the previous occurrence, so a month-end never drifts:
//   · DAILY   start + k·interval days;           WEEKLY  start + 7·k·interval days;
//   · MONTHLY the start's month + k·interval, on the start's day — or the month's last day when the month is shorter
//             (31 Jan → 28 / 29 Feb → 31 Mar → 30 Apr …);
//   · YEARLY  the start's year + k·interval, same month and day — 29 Feb → 28 Feb in a common year, 29 Feb again in a
//             leap year.
// An occurrence past the end date, or at / past the occurrence count, does not exist (null). Days are "YYYY-MM-DD"
// business days (Asia/Riyadh calendar days, carried as 00:00 UTC — ../dates).

export const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export type ScheduleRule = {
  frequency: Frequency;
  interval: number;
  startDate: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
};

/** The widest interval and count a rule accepts (a decade of daily runs at most). */
export const MAX_INTERVAL = 366;
export const MAX_OCCURRENCES = 3660;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(day: string): [number, number, number] {
  const m = DAY.exec(day);
  if (!m) throw new RangeError(`Not a date (YYYY-MM-DD): "${day}".`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) throw new RangeError(`Not a calendar date: "${day}".`);
  return [y, mo, d];
}

const text = (t: Date) => t.toISOString().slice(0, 10);

/** Days in a month (month 1–12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The k-th occurrence's date, ignoring the end (k ≥ 0). */
export function rawOccurrence(rule: Pick<ScheduleRule, "frequency" | "interval" | "startDate">, k: number): string {
  if (!Number.isInteger(k) || k < 0) throw new RangeError("The occurrence index is a whole number ≥ 0.");
  const [y, m, d] = parts(rule.startDate);
  const n = rule.interval;
  switch (rule.frequency) {
    case "DAILY":
      return text(new Date(Date.UTC(y, m - 1, d + k * n)));
    case "WEEKLY":
      return text(new Date(Date.UTC(y, m - 1, d + 7 * k * n)));
    case "MONTHLY": {
      const idx = m - 1 + k * n;
      const yy = y + Math.floor(idx / 12), mm = (idx % 12) + 1;
      return text(new Date(Date.UTC(yy, mm - 1, Math.min(d, daysInMonth(yy, mm)))));
    }
    case "YEARLY": {
      const yy = y + k * n;
      return text(new Date(Date.UTC(yy, m - 1, Math.min(d, daysInMonth(yy, m)))));
    }
  }
}

/** The k-th occurrence's date, or null when the rule has ended before it (end date or occurrence count). */
export function occurrenceDate(rule: ScheduleRule, k: number): string | null {
  if (rule.maxOccurrences != null && k >= rule.maxOccurrences) return null;
  const day = rawOccurrence(rule, k);
  if (rule.endDate && day > rule.endDate) return null;
  return day;
}

/** Up to `count` occurrences from index `from` (the form's preview, the detail page's «القادمة»). */
export function upcoming(rule: ScheduleRule, from: number, count: number): { index: number; date: string }[] {
  const out: { index: number; date: string }[] = [];
  for (let k = from; out.length < count; k++) {
    const day = occurrenceDate(rule, k);
    if (!day) break;
    out.push({ index: k, date: day });
  }
  return out;
}

/** The first occurrence index whose date is on / after `day` (resume without back-filling); null when none is left. */
export function firstIndexOnOrAfter(rule: ScheduleRule, day: string, from = 0): number | null {
  // Jump close first (an old daily schedule resumed years later), then walk.
  let k = from;
  const [sy, sm, sd] = parts(rule.startDate);
  const [ty, tm, td] = parts(day);
  const daysBetween = Math.floor((Date.UTC(ty, tm - 1, td) - Date.UTC(sy, sm - 1, sd)) / 86_400_000);
  if (daysBetween > 0) {
    const approx = rule.frequency === "DAILY" ? Math.floor(daysBetween / rule.interval)
      : rule.frequency === "WEEKLY" ? Math.floor(daysBetween / (7 * rule.interval))
      : rule.frequency === "MONTHLY" ? Math.floor(((ty - sy) * 12 + (tm - sm)) / rule.interval) - 1
      : Math.floor((ty - sy) / rule.interval) - 1;
    k = Math.max(from, approx);
  }
  for (let guard = 0; guard < 100_000; guard++, k++) {
    const d = occurrenceDate(rule, k);
    if (!d) return null;
    if (d >= day) return k;
  }
  return null;
}

export type RuleProblem = { field: string; ar: string; en: string };

/** Parse a rule from a request body; returns the clean rule or the problems (Arabic and English). */
export function parseRule(raw: Record<string, unknown>): { rule: ScheduleRule | null; problems: RuleProblem[] } {
  const problems: RuleProblem[] = [];
  const p = (field: string, ar: string, en: string) => problems.push({ field, ar, en });
  const frequency = typeof raw.frequency === "string" && (FREQUENCIES as readonly string[]).includes(raw.frequency) ? (raw.frequency as Frequency) : null;
  if (!frequency) p("frequency", "اختر التكرار: يومي أو أسبوعي أو شهري أو سنوي.", "Choose the frequency: daily, weekly, monthly or yearly.");
  const interval = raw.interval === undefined || raw.interval === null || raw.interval === "" ? 1 : Number(raw.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) p("interval", `الفاصل رقم صحيح من 1 إلى ${MAX_INTERVAL}.`, `The interval is a whole number from 1 to ${MAX_INTERVAL}.`);
  const okDay = (v: unknown) => { if (typeof v !== "string") return false; try { parts(v); return true; } catch { return false; } };
  const startDate = okDay(raw.startDate) ? (raw.startDate as string) : null;
  if (!startDate) p("startDate", "تاريخ البدء مطلوب (YYYY-MM-DD).", "The start date is required (YYYY-MM-DD).");
  const endDate = raw.endDate === undefined || raw.endDate === null || raw.endDate === "" ? null : okDay(raw.endDate) ? (raw.endDate as string) : undefined;
  if (endDate === undefined) p("endDate", "تاريخ الانتهاء غير صالح.", "The end date is not a valid date.");
  if (startDate && endDate && endDate < startDate) p("endDate", "تاريخ الانتهاء لا يسبق تاريخ البدء.", "The end date is not before the start date.");
  const max = raw.maxOccurrences === undefined || raw.maxOccurrences === null || raw.maxOccurrences === "" ? null : Number(raw.maxOccurrences);
  if (max !== null && (!Number.isInteger(max) || max < 1 || max > MAX_OCCURRENCES)) p("maxOccurrences", `عدد المرات رقم صحيح من 1 إلى ${MAX_OCCURRENCES}.`, `The number of occurrences is a whole number from 1 to ${MAX_OCCURRENCES}.`);
  if (problems.length || !frequency || !startDate) return { rule: null, problems };
  return { rule: { frequency, interval, startDate, endDate: endDate ?? null, maxOccurrences: max }, problems };
}
