// «مساحة عملي» — deadlines in Asia/Riyadh. Pure; no database, no server clock zone.
//
// Instants are stored UTC. Riyadh keeps UTC+03:00 all year (no daylight saving), so a wall-clock
// time there is the instant shifted by a fixed three hours — the conversion never depends on the
// server's own time zone.
//
// Two ways to count a quick deadline («خلال 4 ساعات»):
//   * CLOCK    — actual hours: now + 4 h, whatever the day or the hour.
//   * BUSINESS — working hours only, from WorkSettings (days, start, end): the clock runs inside the
//                working window and stops outside it, so 4 working hours asked at 16:00 on a Thursday
//                with an 08:00–17:00 Sunday–Thursday week end at 11:00 on Sunday.
// Neither is applied silently: the screen shows the computed instant before saving.

export const RIYADH_TZ = "Asia/Riyadh";
const OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export type WorkHours = { workDays: number[]; dayStart: string; dayEnd: string };
export const DEFAULT_HOURS: WorkHours = { workDays: [0, 1, 2, 3, 4], dayStart: "08:00", dayEnd: "17:00" };

export type RiyadhParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

/** The Riyadh wall clock of an instant. `month` is 1–12, `weekday` 0 = Sunday. */
export function riyadhParts(at: Date): RiyadhParts {
  const d = new Date(at.getTime() + OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() };
}

/** The instant of a Riyadh wall-clock time. */
export function fromRiyadh(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - OFFSET_MS);
}

/** "YYYY-MM-DD" of the Riyadh calendar day an instant falls on. */
export function riyadhDay(at: Date): string {
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** The first instant of the Riyadh day an instant falls on. */
export function startOfRiyadhDay(at: Date): Date {
  const p = riyadhParts(at);
  return fromRiyadh(p.year, p.month, p.day);
}

/** The first instant of a Riyadh day given as "YYYY-MM-DD" (null when malformed). */
export function riyadhDayStart(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = fromRiyadh(+m[1], +m[2], +m[3]);
  return riyadhDay(d) === day ? d : null;
}

/** Parse a datetime-local value («2026-10-25T14:30») as Riyadh wall clock. Null when malformed. */
export function parseRiyadhLocal(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const d = fromRiyadh(+m[1], +m[2], +m[3], +m[4], +m[5]);
  const p = riyadhParts(d);
  return p.year === +m[1] && p.month === +m[2] && p.day === +m[3] && p.hour === +m[4] && p.minute === +m[5] ? d : null;
}

/** «2026-10-25T14:30» — the Riyadh wall clock for a datetime-local input. */
export function toRiyadhLocal(at: Date): string {
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 16);
}

const minutesOf = (hhmm: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? +m[1] * 60 + +m[2] : NaN;
};

/** Whether the settings describe a usable working week. */
export function validHours(h: WorkHours): boolean {
  const s = minutesOf(h.dayStart), e = minutesOf(h.dayEnd);
  return Array.isArray(h.workDays) && h.workDays.length > 0 && h.workDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) && s >= 0 && e > s && e <= 24 * 60;
}

/** The working window [start, end) of the Riyadh day containing `at`, or null on a day off. */
function windowOf(at: Date, h: WorkHours): { start: Date; end: Date } | null {
  const p = riyadhParts(at);
  if (!h.workDays.includes(p.weekday)) return null;
  const day = fromRiyadh(p.year, p.month, p.day);
  return { start: new Date(day.getTime() + minutesOf(h.dayStart) * MIN_MS), end: new Date(day.getTime() + minutesOf(h.dayEnd) * MIN_MS) };
}

/** now + `minutes` of working time (see the header). */
export function addWorkingMinutes(now: Date, minutes: number, h: WorkHours = DEFAULT_HOURS): Date {
  if (!validHours(h)) throw new RangeError("Working hours are not valid.");
  let left = Math.max(0, Math.round(minutes));
  let cursor = now;
  for (let guard = 0; guard < 400; guard++) {
    const w = windowOf(cursor, h);
    if (w && cursor < w.end) {
      const from = cursor < w.start ? w.start : cursor;
      const room = Math.floor((w.end.getTime() - from.getTime()) / MIN_MS);
      if (left <= room) return new Date(from.getTime() + left * MIN_MS);
      left -= room;
    }
    // Next Riyadh day, at its first instant.
    cursor = new Date(startOfRiyadhDay(cursor).getTime() + DAY_MS);
  }
  throw new RangeError("No working time within a year.");
}

export type QuickDue = "h4" | "h5" | "h8" | "eod" | "tomorrow";
export type DueBasis = "CLOCK" | "BUSINESS";

/**
 * The deadline of a quick pick.
 *   h4 / h5 / h8 — that many hours, CLOCK or BUSINESS;
 *   eod          — the end of today's working window (CLOCK basis: 23:59 today); when today's window is
 *                  over or today is a day off, the end of the next working day;
 *   tomorrow     — 09:00 tomorrow (BUSINESS: the start of the next working day).
 */
export function quickDue(kind: QuickDue, now: Date, basis: DueBasis, h: WorkHours = DEFAULT_HOURS): Date {
  const hours = kind === "h4" ? 4 : kind === "h5" ? 5 : kind === "h8" ? 8 : 0;
  if (hours) return basis === "BUSINESS" ? addWorkingMinutes(now, hours * 60, h) : new Date(now.getTime() + hours * 3_600_000);
  if (kind === "eod") {
    if (basis === "CLOCK") return new Date(startOfRiyadhDay(now).getTime() + DAY_MS - MIN_MS);
    const w = windowOf(now, h);
    if (w && now < w.end) return w.end;
    let c = new Date(startOfRiyadhDay(now).getTime() + DAY_MS);
    for (let i = 0; i < 14; i++, c = new Date(c.getTime() + DAY_MS)) {
      const nw = windowOf(c, h);
      if (nw) return nw.end;
    }
    throw new RangeError("No working day within two weeks.");
  }
  // tomorrow
  const t = new Date(startOfRiyadhDay(now).getTime() + DAY_MS);
  if (basis === "CLOCK") return new Date(t.getTime() + 9 * 3_600_000);
  for (let c = t, i = 0; i < 14; i++, c = new Date(c.getTime() + DAY_MS)) {
    const nw = windowOf(c, h);
    if (nw) return nw.start;
  }
  throw new RangeError("No working day within two weeks.");
}

export type DueBucket = "OVERDUE" | "TODAY" | "TOMORROW" | "THIS_WEEK" | "LATER";

/** Where a deadline falls relative to now, in Riyadh days. */
export function dueBucket(dueAt: Date, now: Date): DueBucket {
  if (dueAt.getTime() < now.getTime()) return "OVERDUE";
  const days = Math.round((startOfRiyadhDay(dueAt).getTime() - startOfRiyadhDay(now).getTime()) / DAY_MS);
  if (days <= 0) return "TODAY";
  if (days === 1) return "TOMORROW";
  if (days <= 7) return "THIS_WEEK";
  return "LATER";
}

/** Overdue is a fact about time, never a status: open and past its deadline. */
export function isOverdue(t: { status: string; dueAt: Date | string }, now: Date): boolean {
  return t.status !== "DONE" && t.status !== "CANCELLED" && new Date(t.dueAt).getTime() < now.getTime();
}

/** Completed after its deadline — kept for ever, whatever happens next. */
export function completedLate(t: { completedAt: Date | string | null; dueAt: Date | string }): boolean {
  return !!t.completedAt && new Date(t.completedAt).getTime() > new Date(t.dueAt).getTime();
}

/** The next occurrence of a recurring deadline (calendar arithmetic in Riyadh; month-end clamps). */
export function nextOccurrence(from: Date, rule: "DAILY" | "WEEKLY" | "MONTHLY", interval: number): Date {
  const n = Math.max(1, Math.floor(interval));
  if (rule === "DAILY") return new Date(from.getTime() + n * DAY_MS);
  if (rule === "WEEKLY") return new Date(from.getTime() + n * 7 * DAY_MS);
  const p = riyadhParts(from);
  const total = p.month - 1 + n;
  const y = p.year + Math.floor(total / 12), m = (total % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return fromRiyadh(y, m, Math.min(p.day, last), p.hour, p.minute);
}
