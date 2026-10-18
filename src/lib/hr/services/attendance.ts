// Native HR — shifts, check-in/out, corrections and overtime.
//
// Time zone: every wall-clock time (shift start/end, a requested correction time) is read
// in the ACTIVE policy's IANA zone; every instant is stored in UTC. The work date of a
// check-in is its calendar day in that zone. Nothing reads the server's own zone.
//
// Overtime minutes are computed on check-out (or on an approved correction) and recorded as
// a PENDING HrOvertime; payroll pays only APPROVED overtime, and claims it, so the same
// minutes are never paid twice. A correction never edits silently: the previous values are
// kept in `before`, the change is decided by someone else, and it is refused once payroll
// has used that day's overtime.
import { prisma } from "@/lib/db";
import { HrError, type HrActor, type Db, TX, assertCan, can, resolveScope, personInScope, inScope, audit, lock, assertNotSelf, int, oneOf, reqText, text, mapDbError } from "../core";
import { addDays, dayString, instantAt, isDay, localDay, localTime, parseDay } from "../dates";
import { computeDay, type ShiftDef } from "../attendance-calc";
import { activePolicyFor } from "./policy";

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

async function zoneFor(db: Db, on: Date) {
  const p = await activePolicyFor(db, on);
  if (!p) throw new HrError("No active HR policy: the attendance time zone is not configured.", 409, "NO_POLICY");
  return p.timezone;
}

// ── Shifts ─────────────────────────────────────────────────────────────────────────

export async function listShifts() {
  return prisma.hrShift.findMany({ orderBy: { code: "asc" } });
}

export async function createShift(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "attendance_manage");
  const startTime = reqText(b.startTime, "startTime", 5);
  const endTime = reqText(b.endTime, "endTime", 5);
  if (!HHMM.test(startTime) || !HHMM.test(endTime)) throw new HrError("Shift times are HH:MM.", 400);
  return guarded(async () => {
    const s = await prisma.hrShift.create({ data: { code: reqText(b.code, "code", 20).toUpperCase(), name: reqText(b.name, "name", 80), startTime, endTime, breakMinutes: int(b.breakMinutes, "breakMinutes", { min: 0, max: 240 }) ?? 0, graceMinutes: int(b.graceMinutes, "graceMinutes", { min: 0, max: 120 }) ?? 0 } });
    await audit(prisma, { action: "SHIFT_CREATE", entityType: "HrShift", entityId: s.id, after: s, actorId: actor.id });
    return s;
  });
}

export async function assignShift(actor: HrActor, employeeId: string, b: Record<string, unknown>) {
  assertCan(actor, "attendance_manage");
  const shiftId = reqText(b.shiftId, "shiftId", 40);
  if (!isDay(b.effectiveFrom)) throw new HrError("effectiveFrom must be a date.", 400);
  const effectiveFrom = parseDay(b.effectiveFrom);
  const weekdays = Array.isArray(b.weekdays) ? (b.weekdays as unknown[]).map(Number) : [];
  if (weekdays.length === 0 || weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HrError("weekdays must list working days 0–6 (0 = Sunday).", 400);
  return guarded(() => prisma.$transaction(async (tx) => {
    await personInScope(tx, await resolveScope(actor, tx), employeeId);
    const shift = await tx.hrShift.findUnique({ where: { id: shiftId } });
    if (!shift || !shift.active) throw new HrError("Shift not found.", 400);
    await lock(tx, `shift:${employeeId}`);
    const later = await tx.hrShiftAssignment.findFirst({ where: { employeeId, effectiveFrom: { gte: effectiveFrom } } });
    if (later) throw new HrError("An assignment already starts on or after this date.", 409);
    await tx.hrShiftAssignment.updateMany({ where: { employeeId, effectiveTo: null }, data: { effectiveTo: addDays(effectiveFrom, -1) } });
    const a = await tx.hrShiftAssignment.create({ data: { employeeId, shiftId, effectiveFrom, weekdays: [...new Set(weekdays)], createdBy: actor.id } });
    await audit(tx, { action: "SHIFT_ASSIGN", entityType: "HrShiftAssignment", entityId: a.id, employeeId, after: a, actorId: actor.id });
    return a;
  }, TX));
}

export async function shiftFor(db: Db, employeeId: string, workDate: Date): Promise<(ShiftDef & { id: string; code: string; name: string }) | null> {
  const a = await db.hrShiftAssignment.findFirst({ where: { employeeId, effectiveFrom: { lte: workDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: workDate } }] }, include: { shift: true }, orderBy: { effectiveFrom: "desc" } });
  if (!a || !a.weekdays.includes(workDate.getUTCDay())) return null;
  return { id: a.shift.id, code: a.shift.code, name: a.shift.name, startTime: a.shift.startTime, endTime: a.shift.endTime, breakMinutes: a.shift.breakMinutes, graceMinutes: a.shift.graceMinutes };
}

// ── Check-in / check-out ───────────────────────────────────────────────────────────

/**
 * Record a check-in for `employeeId` at `now`. Self-service passes the caller's own person
 * and source SELF; a kiosk/HR user with attendance_manage passes source DEVICE or MANUAL.
 */
export async function checkIn(actor: HrActor, employeeId: string, now: Date, source: "SELF" | "DEVICE" | "MANUAL", opts: { self: boolean }) {
  if (!opts.self) assertCan(actor, "attendance_manage");
  return guarded(() => prisma.$transaction(async (tx) => {
    const person = opts.self ? await tx.hrEmployee.findUniqueOrThrow({ where: { id: employeeId } }) : await personInScope(tx, await resolveScope(actor, tx), employeeId);
    if (person.status === "SEPARATED") throw new HrError("This person has separated.", 409);
    const tz = await zoneFor(tx, now);
    const workDate = localDay(now, tz);
    await lock(tx, `attendance:${employeeId}`);
    const open = await tx.hrAttendance.findFirst({ where: { employeeId, status: "OPEN", workDate: { gte: addDays(workDate, -1) } } });
    if (open) throw new HrError(`Already checked in on ${dayString(open.workDate)} and not checked out.`, 409, "ALREADY_IN");
    const existing = await tx.hrAttendance.findUnique({ where: { employeeId_workDate: { employeeId, workDate } } });
    if (existing) throw new HrError(`Attendance for ${dayString(workDate)} is already recorded. Request a correction to change it.`, 409, "DAY_RECORDED");
    const shift = await shiftFor(tx, employeeId, workDate);
    const calc = computeDay({ workDate, timeZone: tz, shift, checkInAt: now, checkOutAt: null });
    const row = await tx.hrAttendance.create({ data: { employeeId, workDate, shiftId: shift?.id ?? null, checkInAt: now, source, lateMinutes: calc.lateMinutes, status: "OPEN", createdBy: actor.id } });
    await audit(tx, { action: "CHECK_IN", entityType: "HrAttendance", entityId: row.id, employeeId, after: { workDate: dayString(workDate), at: now.toISOString(), source }, actorId: actor.id });
    return attendanceDto(row, tz);
  }, TX));
}

export async function checkOut(actor: HrActor, employeeId: string, now: Date, opts: { self: boolean }) {
  if (!opts.self) assertCan(actor, "attendance_manage");
  return guarded(() => prisma.$transaction(async (tx) => {
    if (!opts.self) await personInScope(tx, await resolveScope(actor, tx), employeeId);
    const tz = await zoneFor(tx, now);
    await lock(tx, `attendance:${employeeId}`);
    const open = await tx.hrAttendance.findFirst({ where: { employeeId, status: "OPEN" }, orderBy: { workDate: "desc" } });
    if (!open || !open.checkInAt) throw new HrError("There is no open check-in to close.", 409, "NOT_IN");
    if (now.getTime() - open.checkInAt.getTime() > 20 * 3600_000) throw new HrError("The open check-in is more than 20 hours old. Request a correction instead.", 409, "STALE_CHECKIN");
    const shift = await shiftFor(tx, employeeId, open.workDate);
    const calc = computeDay({ workDate: open.workDate, timeZone: tz, shift, checkInAt: open.checkInAt, checkOutAt: now });
    const row = await tx.hrAttendance.update({ where: { id: open.id }, data: { checkOutAt: now, workedMinutes: calc.workedMinutes, lateMinutes: calc.lateMinutes, overtimeMinutes: calc.overtimeMinutes, status: "CLOSED" } });
    if (calc.overtimeMinutes > 0) await tx.hrOvertime.create({ data: { employeeId, workDate: open.workDate, minutes: calc.overtimeMinutes, attendanceId: open.id, source: "ATTENDANCE", requestedBy: actor.id } });
    await audit(tx, { action: "CHECK_OUT", entityType: "HrAttendance", entityId: row.id, employeeId, after: { at: now.toISOString(), worked: calc.workedMinutes, overtime: calc.overtimeMinutes }, actorId: actor.id });
    return attendanceDto(row, tz);
  }, TX));
}

export function attendanceDto(r: { id: string; employeeId: string; workDate: Date; checkInAt: Date | null; checkOutAt: Date | null; source: string; workedMinutes: number | null; lateMinutes: number | null; overtimeMinutes: number | null; status: string; notes: string | null }, tz: string) {
  return { id: r.id, employeeId: r.employeeId, workDate: dayString(r.workDate), checkInAt: r.checkInAt, checkOutAt: r.checkOutAt, checkIn: r.checkInAt ? localTime(r.checkInAt, tz) : null, checkOut: r.checkOutAt ? localTime(r.checkOutAt, tz) : null, source: r.source, workedMinutes: r.workedMinutes, lateMinutes: r.lateMinutes, overtimeMinutes: r.overtimeMinutes, status: r.status, notes: r.notes, timezone: tz };
}

/** HR records a day that has no record yet (with times), or marks it ABSENT. */
export async function manualDay(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "attendance_manage");
  const employeeId = reqText(b.employeeId, "employeeId", 40);
  if (!isDay(b.workDate)) throw new HrError("workDate must be a date.", 400);
  const workDate = parseDay(b.workDate);
  const absent = b.absent === true;
  const reason = reqText(b.reason, "reason", 300, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    const person = await personInScope(tx, await resolveScope(actor, tx), employeeId);
    assertNotSelf(actor, person, "record your own attendance manually");
    const tz = await zoneFor(tx, workDate);
    await lock(tx, `attendance:${employeeId}`);
    const exists = await tx.hrAttendance.findUnique({ where: { employeeId_workDate: { employeeId, workDate } } });
    if (exists) throw new HrError("This day already has a record. Use a correction.", 409, "DAY_RECORDED");
    const shift = await shiftFor(tx, employeeId, workDate);
    if (absent) {
      const row = await tx.hrAttendance.create({ data: { employeeId, workDate, shiftId: shift?.id ?? null, source: "MANUAL", status: "ABSENT", notes: reason, createdBy: actor.id } });
      await audit(tx, { action: "MARK_ABSENT", entityType: "HrAttendance", entityId: row.id, employeeId, reason, actorId: actor.id });
      return attendanceDto(row, tz);
    }
    const ci = text(b.checkIn, "checkIn", { max: 5 });
    const co = text(b.checkOut, "checkOut", { max: 5 });
    if (!ci || !HHMM.test(ci) || !co || !HHMM.test(co)) throw new HrError("checkIn and checkOut are HH:MM.", 400);
    const inAt = instantAt(workDate, ci, tz);
    let outAt = instantAt(workDate, co, tz);
    if (outAt <= inAt) outAt = instantAt(addDays(workDate, 1), co, tz);
    const calc = computeDay({ workDate, timeZone: tz, shift, checkInAt: inAt, checkOutAt: outAt });
    const row = await tx.hrAttendance.create({ data: { employeeId, workDate, shiftId: shift?.id ?? null, checkInAt: inAt, checkOutAt: outAt, source: "MANUAL", workedMinutes: calc.workedMinutes, lateMinutes: calc.lateMinutes, overtimeMinutes: calc.overtimeMinutes, status: "CLOSED", notes: reason, createdBy: actor.id } });
    if (calc.overtimeMinutes > 0) await tx.hrOvertime.create({ data: { employeeId, workDate, minutes: calc.overtimeMinutes, attendanceId: row.id, source: "ATTENDANCE", requestedBy: actor.id } });
    await audit(tx, { action: "MANUAL_DAY", entityType: "HrAttendance", entityId: row.id, employeeId, reason, after: attendanceDto(row, tz), actorId: actor.id });
    return attendanceDto(row, tz);
  }, TX));
}

// ── Corrections ────────────────────────────────────────────────────────────────────

export async function requestCorrection(actor: HrActor, b: Record<string, unknown>, opts: { selfEmployeeId?: string }) {
  const employeeId = opts.selfEmployeeId ?? reqText(b.employeeId, "employeeId", 40);
  if (!opts.selfEmployeeId) assertCan(actor, "attendance_manage");
  if (!isDay(b.workDate)) throw new HrError("workDate must be a date.", 400);
  const workDate = parseDay(b.workDate);
  const ci = text(b.checkIn, "checkIn", { max: 5 });
  const co = text(b.checkOut, "checkOut", { max: 5 });
  if ((!ci && !co) || (ci && !HHMM.test(ci)) || (co && !HHMM.test(co))) throw new HrError("Give checkIn and/or checkOut as HH:MM.", 400);
  const reason = reqText(b.reason, "reason", 500, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    if (!opts.selfEmployeeId) {
      const person = await personInScope(tx, await resolveScope(actor, tx), employeeId);
      assertNotSelf(actor, person, "file an attendance correction on behalf of");
    }
    const tz = await zoneFor(tx, workDate);
    const att = await tx.hrAttendance.findUnique({ where: { employeeId_workDate: { employeeId, workDate } } });
    const pending = await tx.hrAttendanceCorrection.findFirst({ where: { employeeId, workDate, status: "PENDING" } });
    if (pending) throw new HrError("A correction for this day is already waiting.", 409);
    const reqIn = ci ? instantAt(workDate, ci, tz) : null;
    let reqOut = co ? instantAt(workDate, co, tz) : null;
    const baseIn = reqIn ?? att?.checkInAt ?? null;
    if (reqOut && baseIn && reqOut <= baseIn) reqOut = instantAt(addDays(workDate, 1), co as string, tz);
    const row = await tx.hrAttendanceCorrection.create({ data: { employeeId, attendanceId: att?.id ?? null, workDate, requestedCheckIn: reqIn, requestedCheckOut: reqOut, reason, requestedBy: actor.id } });
    await audit(tx, { action: "CORRECTION_REQUEST", entityType: "HrAttendanceCorrection", entityId: row.id, employeeId, after: { workDate: dayString(workDate), checkIn: ci, checkOut: co }, reason, actorId: actor.id });
    return row;
  }, TX));
}

export async function decideCorrection(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "attendance_approve");
  const decision = oneOf(b.decision, "decision", ["APPROVE", "REJECT"] as const);
  const note = text(b.note, "note", { max: 500 });
  if (decision === "REJECT" && !note) throw new HrError("A reason is required to reject.", 400);
  return guarded(() => prisma.$transaction(async (tx) => {
    const c = await tx.hrAttendanceCorrection.findUnique({ where: { id }, include: { employee: true } });
    if (!c || !inScope(await resolveScope(actor, tx), c.employee)) throw new HrError("Correction not found", 404);
    assertNotSelf(actor, c.employee, "decide an attendance correction");
    if (c.requestedBy === actor.id) throw new HrError("You filed this correction; another approver must decide it.", 403, "SELF_ACTION");
    await lock(tx, `attendance:${c.employeeId}`);
    if (decision === "REJECT") {
      const r = await tx.hrAttendanceCorrection.updateMany({ where: { id, status: "PENDING" }, data: { status: "REJECTED", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note } });
      if (r.count !== 1) throw new HrError("Already decided.", 409);
      await audit(tx, { action: "CORRECTION_REJECT", entityType: "HrAttendanceCorrection", entityId: id, employeeId: c.employeeId, reason: note, actorId: actor.id });
      return { status: "REJECTED" };
    }
    const tz = await zoneFor(tx, c.workDate);
    const att = await tx.hrAttendance.findUnique({ where: { employeeId_workDate: { employeeId: c.employeeId, workDate: c.workDate } }, include: { overtime: true } });
    if (att?.overtime?.payrollRunId) throw new HrError("Payroll has already used this day's overtime. Correct it through payroll instead.", 409, "PERIOD_SETTLED");
    const inAt = c.requestedCheckIn ?? att?.checkInAt ?? null;
    const outAt = c.requestedCheckOut ?? att?.checkOutAt ?? null;
    if (!inAt) throw new HrError("The corrected day still has no check-in.", 409);
    const shift = await shiftFor(tx, c.employeeId, c.workDate);
    const calc = computeDay({ workDate: c.workDate, timeZone: tz, shift, checkInAt: inAt, checkOutAt: outAt });
    const before = att ? { checkInAt: att.checkInAt, checkOutAt: att.checkOutAt, workedMinutes: att.workedMinutes, overtimeMinutes: att.overtimeMinutes, status: att.status } : null;
    const data = { checkInAt: inAt, checkOutAt: outAt, workedMinutes: calc.workedMinutes, lateMinutes: calc.lateMinutes, overtimeMinutes: calc.overtimeMinutes, status: outAt ? ("CLOSED" as const) : ("OPEN" as const), source: "CORRECTION", shiftId: shift?.id ?? null };
    const row = att ? await tx.hrAttendance.update({ where: { id: att.id }, data }) : await tx.hrAttendance.create({ data: { employeeId: c.employeeId, workDate: c.workDate, ...data, createdBy: actor.id } });
    if (att?.overtime) {
      if (calc.overtimeMinutes > 0) await tx.hrOvertime.update({ where: { id: att.overtime.id }, data: { minutes: calc.overtimeMinutes, status: "PENDING", decidedBy: null, decidedAt: null, decisionNote: "Recomputed by an approved correction" } });
      else await tx.hrOvertime.update({ where: { id: att.overtime.id }, data: { status: "REJECTED", decisionNote: "No overtime after correction", decidedBy: actor.id, decidedAt: new Date() } });
    } else if (calc.overtimeMinutes > 0) {
      await tx.hrOvertime.create({ data: { employeeId: c.employeeId, workDate: c.workDate, minutes: calc.overtimeMinutes, attendanceId: row.id, source: "ATTENDANCE", requestedBy: c.requestedBy } });
    }
    const r = await tx.hrAttendanceCorrection.updateMany({ where: { id, status: "PENDING" }, data: { status: "APPROVED", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note, attendanceId: row.id, before: before as never } });
    if (r.count !== 1) throw new HrError("Already decided.", 409);
    await audit(tx, { action: "CORRECTION_APPROVE", entityType: "HrAttendance", entityId: row.id, employeeId: c.employeeId, before, after: attendanceDto(row, tz), reason: c.reason, actorId: actor.id });
    return attendanceDto(row, tz);
  }, TX));
}

// ── Overtime ───────────────────────────────────────────────────────────────────────

export async function requestOvertime(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "attendance_manage");
  const employeeId = reqText(b.employeeId, "employeeId", 40);
  if (!isDay(b.workDate)) throw new HrError("workDate must be a date.", 400);
  const minutes = int(b.minutes, "minutes", { min: 1, max: 960, required: true }) as number;
  const reason = reqText(b.reason, "reason", 300, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    const person = await personInScope(tx, await resolveScope(actor, tx), employeeId);
    assertNotSelf(actor, person, "record your own overtime");
    const row = await tx.hrOvertime.create({ data: { employeeId, workDate: parseDay(b.workDate as string), minutes, source: "MANUAL", requestedBy: actor.id, reason } });
    await audit(tx, { action: "OVERTIME_REQUEST", entityType: "HrOvertime", entityId: row.id, employeeId, reason, actorId: actor.id });
    return row;
  }, TX));
}

export async function decideOvertime(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "attendance_approve");
  const decision = oneOf(b.decision, "decision", ["APPROVE", "REJECT"] as const);
  const note = text(b.note, "note", { max: 500 });
  return guarded(() => prisma.$transaction(async (tx) => {
    const o = await tx.hrOvertime.findUnique({ where: { id }, include: { employee: true } });
    if (!o || !inScope(await resolveScope(actor, tx), o.employee)) throw new HrError("Overtime not found", 404);
    assertNotSelf(actor, o.employee, "approve overtime");
    if (o.requestedBy === actor.id) throw new HrError("You recorded this overtime; another approver must decide it.", 403, "SELF_ACTION");
    const r = await tx.hrOvertime.updateMany({ where: { id, status: "PENDING", payrollRunId: null }, data: { status: decision === "APPROVE" ? "APPROVED" : "REJECTED", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note } });
    if (r.count !== 1) throw new HrError("Only pending overtime can be decided.", 409);
    await audit(tx, { action: `OVERTIME_${decision}`, entityType: "HrOvertime", entityId: id, employeeId: o.employeeId, reason: note, actorId: actor.id });
    return { status: decision === "APPROVE" ? "APPROVED" : "REJECTED" };
  }, TX));
}

// ── Board & queues ─────────────────────────────────────────────────────────────────

export async function dayBoard(actor: HrActor, dayStr: string | null, now: Date) {
  if (!can(actor, "attendance_manage") && !can(actor, "attendance_approve")) throw new HrError("Insufficient permissions", 403);
  const scope = await resolveScope(actor);
  const tzNow = await zoneFor(prisma, now);
  const day = dayStr && isDay(dayStr) ? parseDay(dayStr) : localDay(now, tzNow);
  const tz = (await activePolicyFor(prisma, day))?.timezone ?? tzNow;
  const people = await prisma.hrEmployee.findMany({ where: { AND: [scope.all ? {} : { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.reportIds } }] }, { status: { not: "SEPARATED" } }, { hireDate: { lte: day } }] }, select: { id: true, employeeNo: true, fullNameAr: true, accountId: true }, orderBy: { employeeNo: "asc" } });
  const ids = people.map((p) => p.id);
  const [att, leaves, ot, corr] = await Promise.all([
    prisma.hrAttendance.findMany({ where: { employeeId: { in: ids }, workDate: day }, include: { overtime: true } }),
    prisma.hrLeaveRequest.findMany({ where: { employeeId: { in: ids }, status: "APPROVED", startDate: { lte: day }, endDate: { gte: day } }, include: { leaveType: { select: { nameAr: true, paid: true } } } }),
    prisma.hrOvertime.findMany({ where: { employeeId: { in: ids }, status: "PENDING" }, include: { employee: { select: { fullNameAr: true, accountId: true } } }, orderBy: { workDate: "desc" } }),
    prisma.hrAttendanceCorrection.findMany({ where: { employeeId: { in: ids }, status: "PENDING" }, include: { employee: { select: { fullNameAr: true, accountId: true } }, attendance: { select: { checkInAt: true, checkOutAt: true } } }, orderBy: { workDate: "desc" } }),
  ]);
  const rows = [];
  for (const p of people) {
    const a = att.find((x) => x.employeeId === p.id);
    const l = leaves.find((x) => x.employeeId === p.id);
    const shift = await shiftFor(prisma, p.id, day);
    rows.push({ employee: { id: p.id, employeeNo: p.employeeNo, fullNameAr: p.fullNameAr }, shift: shift ? { name: shift.name, startTime: shift.startTime, endTime: shift.endTime } : null, attendance: a ? attendanceDto(a, tz) : null, overtimeStatus: a?.overtime?.status ?? null, leave: l ? { nameAr: l.leaveType.nameAr, paid: l.leaveType.paid } : null });
  }
  return {
    day: dayString(day), timezone: tz, rows,
    overtime: ot.map((o) => ({ id: o.id, employeeId: o.employeeId, employeeName: o.employee.fullNameAr, workDate: dayString(o.workDate), minutes: o.minutes, source: o.source, reason: o.reason, isMine: o.employee.accountId === actor.id || o.requestedBy === actor.id })),
    corrections: corr.map((c) => ({ id: c.id, employeeId: c.employeeId, employeeName: c.employee.fullNameAr, workDate: dayString(c.workDate), checkIn: c.requestedCheckIn ? localTime(c.requestedCheckIn, tz) : null, checkOut: c.requestedCheckOut ? localTime(c.requestedCheckOut, tz) : null, currentCheckIn: c.attendance?.checkInAt ? localTime(c.attendance.checkInAt, tz) : null, currentCheckOut: c.attendance?.checkOutAt ? localTime(c.attendance.checkOutAt, tz) : null, reason: c.reason, isMine: c.employee.accountId === actor.id || c.requestedBy === actor.id })),
  };
}
