/**
 * P2 ERR-15 (owner decision ب2): a date that schedules something to do — a lead's follow-up, a deal's next follow-up,
 * «ذكّرني بعد», a planned task — is never a day already gone (Riyadh). Today is accepted; a date that was already stored
 * and is sent back unchanged is accepted too (an old follow-up never blocks saving another field).
 */
export const riyadhDayOf = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);

/** Gate B2: «unchanged» is the same Riyadh DAY — the forms send a date (YYYY-MM-DD), the column holds a timestamp. */
export function sameRiyadhDay(a: Date | null | undefined, b: Date | null | undefined): boolean {
  return !!a && !!b && riyadhDayOf(a) === riyadhDayOf(b);
}

/** Whether `d` falls on a Riyadh day before today's. */
export function isPastDay(d: Date, now: Date = new Date()): boolean {
  return riyadhDayOf(d) < riyadhDayOf(now);
}

export function pastDateRefusal(fieldAr: string, fieldEn: string) {
  const ar = `${fieldAr} في يوم فات — اختر اليوم أو بعده.`;
  return { _appCode: 400, code: "DATE_IN_PAST", message: ar, error: ar, errorAr: ar, errorEn: `The ${fieldEn} is a day already gone — choose today or later.` };
}

/** Throws the coded 400 when `next` is a past day and not the unchanged stored value `stored`. */
export function assertNotPast(next: Date | null | undefined, stored: Date | null | undefined, fieldAr: string, fieldEn: string, now: Date = new Date()): void {
  if (!next) return;
  if (sameRiyadhDay(stored, next)) return;
  if (isPastDay(next, now)) throw pastDateRefusal(fieldAr, fieldEn);
}
