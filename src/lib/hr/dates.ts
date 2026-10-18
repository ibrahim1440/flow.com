// Native HR — calendar-day and time-zone arithmetic. Pure; no database.
//
// ── The two kinds of time HR handles ──
// • Calendar days (hire date, leave from/to, payroll period): stored as @db.Date and handled
//   here as UTC-midnight Date objects. They have no time zone and are never converted.
// • Instants (check-in, check-out): stored as UTC timestamptz. They become a calendar day and
//   a wall-clock time only through an explicit IANA time zone (the payroll policy's, default
//   Asia/Riyadh). Nothing here reads the server's local time zone.

const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Parse "YYYY-MM-DD" into a UTC-midnight Date, rejecting impossible dates (2026-02-30). */
export function parseDay(v: string): Date {
  const m = ISO_DAY.exec(v);
  if (!m) throw new RangeError(`Not a calendar date: ${v}`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new RangeError(`Not a calendar date: ${v}`);
  }
  return d;
}

export function isDay(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    parseDay(v);
    return true;
  } catch {
    return false;
  }
}

export function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** Whole days from a to b (b − a). Both must be calendar days. */
export function diffDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** Inclusive count of calendar days in [from, to]. */
export function daysInclusive(from: Date, to: Date): number {
  return to < from ? 0 : diffDays(from, to) + 1;
}

export function isMonth(v: unknown): v is string {
  return typeof v === "string" && ISO_MONTH.test(v);
}

export function monthBounds(month: string): { start: Date; end: Date; days: number } {
  const m = ISO_MONTH.exec(month);
  if (!m) throw new RangeError(`Not a month: ${month}`);
  const start = new Date(Date.UTC(+m[1], +m[2] - 1, 1));
  const end = new Date(Date.UTC(+m[1], +m[2], 0));
  return { start, end, days: end.getUTCDate() };
}

export function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const { start } = monthBounds(month);
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + n, 1));
  return monthOf(d);
}

/** Overlap of two inclusive ranges; null when they do not meet. `to` may be null (open). */
export function overlap(aFrom: Date, aTo: Date | null, bFrom: Date, bTo: Date | null): { from: Date; to: Date } | null {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const ends = [aTo, bTo].filter((x): x is Date => x !== null);
  if (ends.length === 0) return null; // both open: caller must clamp first
  const to = ends.reduce((m, x) => (x < m ? x : m));
  return from <= to ? { from, to } : null;
}

/** Days in [from, to] that are not weekend days. weekendDays: 0 = Sunday … 6 = Saturday. */
export function workingDays(from: Date, to: Date, weekendDays: number[]): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (!weekendDays.includes(d.getUTCDay())) n++;
  return n;
}

// ── Time zones ──────────────────────────────────────────────────────────────────────

function parts(instant: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(instant)) o[p.type] = p.value;
  return o;
}

/** The calendar day an instant falls on in a time zone. */
export function localDay(instant: Date, timeZone: string): Date {
  const p = parts(instant, timeZone);
  return parseDay(`${p.year}-${p.month}-${p.day}`);
}

/** "HH:MM" wall-clock time of an instant in a time zone. */
export function localTime(instant: Date, timeZone: string): string {
  const p = parts(instant, timeZone);
  return `${p.hour}:${p.minute}`;
}

/** Offset of the zone from UTC at an instant, in minutes (Riyadh: +180). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The UTC instant of a wall-clock time on a calendar day in a zone. Two passes handle a zone
 * whose offset differs either side of the moment (DST); Asia/Riyadh has none.
 */
export function instantAt(day: Date, hhmm: string, timeZone: string): Date {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new RangeError(`Not a time: ${hhmm}`);
  const naive = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), +m[1], +m[2]);
  let t = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000;
  t = naive - zoneOffsetMinutes(new Date(t), timeZone) * 60_000;
  return new Date(t);
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
