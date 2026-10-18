// Native HR — minutes worked, late and overtime for one attendance day. Pure.
//
// Shift times are wall-clock in the policy time zone; check-in/out are UTC instants. The
// shift is anchored to the work date in that zone, and a shift whose end is not after its
// start ends on the next calendar day (night shift).
import { addDays, instantAt, minutesOf } from "./dates";

export type ShiftDef = { startTime: string; endTime: string; breakMinutes: number; graceMinutes: number };

export function scheduledMinutes(s: ShiftDef): number {
  let span = minutesOf(s.endTime) - minutesOf(s.startTime);
  if (span <= 0) span += 24 * 60;
  return Math.max(0, span - s.breakMinutes);
}

export function computeDay(input: {
  workDate: Date;
  timeZone: string;
  shift: ShiftDef | null;
  checkInAt: Date;
  checkOutAt: Date | null;
}): { workedMinutes: number | null; lateMinutes: number; overtimeMinutes: number } {
  const { shift, checkInAt, checkOutAt } = input;
  let late = 0;
  if (shift) {
    const start = instantAt(input.workDate, shift.startTime, input.timeZone);
    const lateBy = Math.floor((checkInAt.getTime() - start.getTime()) / 60_000);
    late = lateBy > shift.graceMinutes ? lateBy : 0;
  }
  if (!checkOutAt) return { workedMinutes: null, lateMinutes: late, overtimeMinutes: 0 };
  if (checkOutAt <= checkInAt) throw new RangeError("Check-out must be after check-in.");
  const gross = Math.floor((checkOutAt.getTime() - checkInAt.getTime()) / 60_000);
  const worked = Math.max(0, gross - (shift?.breakMinutes ?? 0));
  const overtime = shift ? Math.max(0, worked - scheduledMinutes(shift)) : 0;
  return { workedMinutes: worked, lateMinutes: late, overtimeMinutes: overtime };
}

/** The UTC window in which a check-in may count for a work date (shift start −4h … +12h). */
export function shiftWindow(workDate: Date, shift: ShiftDef, timeZone: string): { from: Date; to: Date } {
  const start = instantAt(workDate, shift.startTime, timeZone);
  return { from: new Date(start.getTime() - 4 * 3600_000), to: new Date(start.getTime() + 12 * 3600_000) };
}

export function nextDay(d: Date): Date {
  return addDays(d, 1);
}
