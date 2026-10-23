// Native HR — leave types, requests, decisions and the append-only balance ledger.
//
// ── Why the balance can never be overbooked ──
// • Balance = SUM(ledger.days) over ALL rows, future-dated TAKEs included (no date filter).
// • Available to a new request = balance − days held by the person's other PENDING requests.
// • Request, approve, cancel and every manual ledger entry for one person take the same
//   advisory lock, so two of them never decide on the same balance at once.
// • An approval writes a TAKE row in the same transaction that flips the status; a
//   cancellation of an approved leave writes a REVERSAL row. Nothing is ever edited.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, type Db, TX, accountNames, assertCan, can, resolveScope, personInScope, inScope, audit, lock, assertNotSelf, oneOf, reqText, text, mapDbError } from "../core";
import { addDays, dayString, isDay, isMonth, monthBounds, parseDay, workingDays } from "../dates";
import { activePolicyFor } from "./policy";
import { isSimpleMode } from "@/lib/simple-mode";

const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);

function dayArg(v: unknown, field: string): Date {
  if (!isDay(v)) throw new HrError(`${field} must be a date (YYYY-MM-DD).`, 400);
  return parseDay(v);
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────────

export async function listLeaveTypes() {
  return prisma.hrLeaveType.findMany({ orderBy: { code: "asc" } });
}

// New leave types go through ./config-change (request → independent approval → apply).

// ── Balances ───────────────────────────────────────────────────────────────────────

export async function ledgerBalance(db: Db, employeeId: string, leaveTypeId: string): Promise<Prisma.Decimal> {
  const r = await db.hrLeaveLedger.aggregate({ where: { employeeId, leaveTypeId }, _sum: { days: true } });
  return r._sum.days ?? D(0);
}

async function pendingHeld(db: Db, employeeId: string, leaveTypeId: string, exceptId?: string): Promise<Prisma.Decimal> {
  const r = await db.hrLeaveRequest.aggregate({ where: { employeeId, leaveTypeId, status: "PENDING", ...(exceptId ? { id: { not: exceptId } } : {}) }, _sum: { days: true } });
  return r._sum.days ?? D(0);
}

export async function balances(db: Db, employeeId: string) {
  const types = await db.hrLeaveType.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  return Promise.all(types.map(async (t) => {
    const [bal, held] = await Promise.all([ledgerBalance(db, employeeId, t.id), pendingHeld(db, employeeId, t.id)]);
    return { leaveTypeId: t.id, code: t.code, nameAr: t.nameAr, paid: t.paid, tracksBalance: t.tracksBalance, isProposal: t.isProposal, balance: bal.toFixed(2), pending: held.toFixed(2), available: bal.minus(held).toFixed(2) };
  }));
}

export async function balancesFor(actor: HrActor, employeeId: string) {
  assertAnyLeave(actor);
  await personInScope(prisma, await resolveScope(actor), employeeId);
  return balances(prisma, employeeId);
}

export async function ledger(actor: HrActor, employeeId: string, leaveTypeId: string) {
  assertAnyLeave(actor);
  const scope = await resolveScope(actor);
  await personInScope(prisma, scope, employeeId);
  const rows = await prisma.hrLeaveLedger.findMany({ where: { employeeId, leaveTypeId }, orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }] });
  let running = D(0);
  return rows.map((r) => {
    running = running.plus(r.days);
    return { id: r.id, entryType: r.entryType, days: r.days.toFixed(2), effectiveDate: dayString(r.effectiveDate), requestId: r.requestId, reason: r.reason, running: running.toFixed(2), createdAt: r.createdAt };
  });
}

function assertAnyLeave(actor: HrActor) {
  if (!can(actor, "leave_manage") && !can(actor, "leave_approve")) throw new HrError("Insufficient permissions", 403);
}

// ── Requests ───────────────────────────────────────────────────────────────────────

/** Preview: working days a request for [start, end] would count (no balance is touched). */
export async function previewDays(startS: unknown, endS: unknown) {
  if (!isDay(startS) || !isDay(endS)) throw new HrError("start and end must be dates.", 400);
  const start = parseDay(startS), end = parseDay(endS);
  if (end < start) throw new HrError("The leave cannot end before it starts.", 400);
  return { days: await countLeaveDays(prisma, start, end) };
}

export async function countLeaveDays(db: Db, start: Date, end: Date): Promise<number> {
  const policy = await activePolicyFor(db, start);
  if (!policy) throw new HrError("No active HR policy covers this date: the weekend days used to count leave are not configured.", 409, "NO_POLICY");
  return workingDays(start, end, policy.weekendDays);
}

type LeaveProblem = { message: string; status: number; code: string | null };
export type LeaveAssessment = {
  days: number | null; weekendDays: number[] | null; tracksBalance: boolean; allowNegative: boolean;
  balance: string | null; pending: string | null; available: string | null; after: string | null;
  problems: LeaveProblem[];
};

/**
 * Every rule a new leave request must satisfy, evaluated in one place. `requestLeave` throws
 * the first problem (under the person's lock); the quote endpoints return the whole result so
 * the form can show days, the projected balance and any refusal before it is submitted.
 * Nothing is written.
 */
export async function assessLeave(db: Db, a: { person: { id: string; status: string; hireDate: Date }; leaveTypeId: string; startDate: Date; endDate: Date; exceptRequestId?: string }): Promise<LeaveAssessment> {
  const { person, leaveTypeId, startDate, endDate } = a;
  const problems: LeaveProblem[] = [];
  const out: LeaveAssessment = { days: null, weekendDays: null, tracksBalance: false, allowNegative: false, balance: null, pending: null, available: null, after: null, problems };
  if (person.status === "SEPARATED") problems.push({ message: "This person has separated.", status: 409, code: null });
  if (startDate < person.hireDate) problems.push({ message: "Leave cannot start before the hire date.", status: 400, code: null });
  const type = await db.hrLeaveType.findUnique({ where: { id: leaveTypeId } });
  if (!type || !type.active) {
    problems.push({ message: "Leave type not found.", status: 400, code: null });
    return out;
  }
  out.tracksBalance = type.tracksBalance;
  out.allowNegative = type.allowNegative;
  const overlapping = await db.hrLeaveRequest.findFirst({ where: { employeeId: person.id, status: { in: ["PENDING", "APPROVED"] }, startDate: { lte: endDate }, endDate: { gte: startDate }, ...(a.exceptRequestId ? { id: { not: a.exceptRequestId } } : {}) } });
  if (overlapping) problems.push({ message: `These dates overlap leave ${dayString(overlapping.startDate)} → ${dayString(overlapping.endDate)} (${overlapping.status}).`, status: 409, code: "OVERLAP" });
  const policy = await activePolicyFor(db, startDate);
  if (!policy) {
    problems.push({ message: "No active HR policy covers this date: the weekend days used to count leave are not configured.", status: 409, code: "NO_POLICY" });
    return out;
  }
  const days = workingDays(startDate, endDate, policy.weekendDays);
  out.days = days;
  out.weekendDays = policy.weekendDays;
  if (days <= 0) problems.push({ message: "These dates contain no working days.", status: 400, code: null });
  if (type.tracksBalance) {
    const [bal, held] = await Promise.all([ledgerBalance(db, person.id, leaveTypeId), pendingHeld(db, person.id, leaveTypeId, a.exceptRequestId)]);
    const available = bal.minus(held);
    out.balance = bal.toFixed(2);
    out.pending = held.toFixed(2);
    out.available = available.toFixed(2);
    out.after = available.minus(days).toFixed(2);
    if (!type.allowNegative && days > 0 && available.lessThan(days)) problems.push({ message: `Not enough balance: ${available.toFixed(2)} day(s) available, ${days} requested.`, status: 409, code: "INSUFFICIENT_BALANCE" });
  }
  return out;
}

function quoteArgs(q: URLSearchParams) {
  const leaveTypeId = reqText(q.get("leaveTypeId"), "leaveTypeId", 40);
  const startDate = dayArg(q.get("startDate"), "startDate");
  const endDate = dayArg(q.get("endDate"), "endDate");
  if (endDate < startDate) throw new HrError("The leave cannot end before it starts.", 400);
  return { leaveTypeId, startDate, endDate };
}

/** Read-only preview of a request: the same assessment `requestLeave` enforces. */
export async function quoteLeave(actor: HrActor, q: URLSearchParams, opts: { selfEmployeeId?: string } = {}) {
  const args = quoteArgs(q);
  let person;
  if (opts.selfEmployeeId) {
    person = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: opts.selfEmployeeId } });
  } else {
    assertCan(actor, "leave_manage");
    person = await personInScope(prisma, await resolveScope(actor), reqText(q.get("employeeId"), "employeeId", 40));
  }
  return assessLeave(prisma, { person, ...args });
}

/**
 * Create a leave request. `self` = filed through self-service by the person themself;
 * otherwise an HR user with leave_manage files it for someone in scope.
 */
/**
 * feat/notifications: who may decide a request about `person` — active holders of hr › leave_approve
 * whose HR scope covers the person (every branch, the person's branch, or the person's manager),
 * never the person themself. The same rule as decideLeave's (resolveScope / inScope).
 */
async function leaveApproverAccounts(db: Db, person: { id: string; branchId: string | null; managerId: string | null; accountId: string | null }): Promise<string[]> {
  const { effectivePermissions } = await import("@/lib/notifications/recipients");
  const { hasSubPrivilege } = await import("@/lib/auth-shared");
  const rows = await db.employee.findMany({ where: { active: true }, select: { id: true, role: true, permissions: true } });
  const holders = rows.filter((r) => hasSubPrivilege(effectivePermissions(r), "hr", "leave_approve"));
  if (holders.length === 0) return [];
  const [branch, manager] = await Promise.all([
    person.branchId ? db.finBranchAccess.findMany({ where: { branchId: person.branchId, employeeId: { in: holders.map((h) => h.id) }, branch: { active: true } }, select: { employeeId: true } }) : Promise.resolve([]),
    person.managerId ? db.hrEmployee.findUnique({ where: { id: person.managerId }, select: { accountId: true } }) : Promise.resolve(null),
  ]);
  const inBranch = new Set(branch.map((b) => b.employeeId));
  return holders
    .filter((h) => h.id !== person.accountId && (hasSubPrivilege(effectivePermissions(h), "hr", "all_branches") || inBranch.has(h.id) || h.id === manager?.accountId))
    .map((h) => h.id);
}

export async function requestLeave(actor: HrActor, b: Record<string, unknown>, opts: { selfEmployeeId?: string } = {}) {
  const employeeId = opts.selfEmployeeId ?? reqText(b.employeeId, "employeeId", 40);
  if (!opts.selfEmployeeId) assertCan(actor, "leave_manage");
  const leaveTypeId = reqText(b.leaveTypeId, "leaveTypeId", 40);
  const startDate = dayArg(b.startDate, "startDate");
  const endDate = dayArg(b.endDate, "endDate");
  if (endDate < startDate) throw new HrError("The leave cannot end before it starts.", 400);
  const reason = text(b.reason, "reason", { max: 500 });
  const idempotencyKey = text(b.idempotencyKey, "idempotencyKey", { max: 80 });
  return guarded(() => prisma.$transaction(async (tx) => {
    if (idempotencyKey) {
      const prior = await tx.hrLeaveRequest.findUnique({ where: { requestedBy_idempotencyKey: { requestedBy: actor.id, idempotencyKey } } });
      if (prior) return { ...requestDto(prior), replayed: true };
    }
    const person = opts.selfEmployeeId
      ? await tx.hrEmployee.findUniqueOrThrow({ where: { id: employeeId } })
      : await personInScope(tx, await resolveScope(actor, tx), employeeId);
    await lock(tx, `leave:${employeeId}`);
    // Revalidated here, under the lock, whatever the form showed before submission.
    const check = await assessLeave(tx, { person, leaveTypeId, startDate, endDate });
    const first = check.problems[0];
    if (first) throw new HrError(first.message, first.status, first.code ?? undefined);
    const days = check.days as number;
    const row = await tx.hrLeaveRequest.create({ data: { employeeId, leaveTypeId, startDate, endDate, days: D(days), reason, requestedBy: actor.id, idempotencyKey } });
    await audit(tx, { action: "LEAVE_REQUEST", entityType: "HrLeaveRequest", entityId: row.id, employeeId, after: requestDto(row), actorId: actor.id });
    // feat/notifications: the approvers who may decide it (hr.leave_pending).
    const type = await tx.hrLeaveType.findUnique({ where: { id: leaveTypeId }, select: { nameAr: true } });
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, {
      event: "hr.leave_pending", dedupeKey: row.id, actorId: actor.id, entity: { type: "HrLeaveRequest", id: row.id },
      facts: { personName: person.fullNameAr, leaveTypeAr: type?.nameAr ?? "", from: dayString(startDate), to: dayString(endDate), days },
      people: { approvers: await leaveApproverAccounts(tx, person) },
    });
    return requestDto(row);
  }, TX));
}

export function requestDto(r: { id: string; employeeId: string; leaveTypeId: string; startDate: Date; endDate: Date; days: Prisma.Decimal; status: string; reason: string | null; requestedBy: string; createdAt: Date; decidedBy: string | null; decidedAt: Date | null; decisionNote: string | null; cancelledAt: Date | null; cancelReason: string | null }) {
  return { id: r.id, employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, startDate: dayString(r.startDate), endDate: dayString(r.endDate), days: r.days.toFixed(2), status: r.status, reason: r.reason, requestedBy: r.requestedBy, createdAt: r.createdAt, decidedBy: r.decidedBy, decidedAt: r.decidedAt, decisionNote: r.decisionNote, cancelledAt: r.cancelledAt, cancelReason: r.cancelReason };
}

export async function decideLeave(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "leave_approve");
  const decision = oneOf(b.decision, "decision", ["APPROVE", "REJECT"] as const);
  const note = text(b.note, "note", { max: 500 });
  if (decision === "REJECT" && !note) throw new HrError("A reason is required to reject.", 400);
  return guarded(() => prisma.$transaction(async (tx) => {
    const req = await tx.hrLeaveRequest.findUnique({ where: { id }, include: { employee: true, leaveType: true } });
    if (!req) throw new HrError("Leave request not found", 404);
    const scope = await resolveScope(actor, tx);
    if (!inScope(scope, req.employee)) throw new HrError("Leave request not found", 404);
    assertNotSelf(actor, req.employee, "decide leave");
    // SIMPLE MODE: a single owner may decide their own request / act on their own record.
    if (!isSimpleMode() && (req.requestedBy === actor.id)) throw new HrError("You filed this request; another approver must decide it.", 403, "SELF_ACTION");
    await lock(tx, `leave:${req.employeeId}`);
    const fresh = await tx.hrLeaveRequest.findUniqueOrThrow({ where: { id } });
    if (fresh.status !== "PENDING") throw new HrError(`This request is already ${fresh.status}.`, 409);
    if (decision === "APPROVE" && req.leaveType.tracksBalance) {
      const bal = await ledgerBalance(tx, req.employeeId, req.leaveTypeId);
      if (!req.leaveType.allowNegative && bal.lessThan(req.days)) {
        throw new HrError(`Not enough balance to approve: ${bal.toFixed(2)} day(s), ${req.days.toFixed(2)} requested.`, 409, "INSUFFICIENT_BALANCE");
      }
    }
    const r = await tx.hrLeaveRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: decision === "APPROVE" ? "APPROVED" : "REJECTED", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note } });
    if (r.count !== 1) throw new HrError("This request was decided meanwhile.", 409);
    if (decision === "APPROVE" && req.leaveType.tracksBalance) {
      await tx.hrLeaveLedger.create({ data: { employeeId: req.employeeId, leaveTypeId: req.leaveTypeId, entryType: "TAKE", days: req.days.negated(), effectiveDate: req.startDate, requestId: req.id, reason: "Approved leave", actorId: actor.id } });
    }
    const after = await tx.hrLeaveRequest.findUniqueOrThrow({ where: { id } });
    await audit(tx, { action: decision === "APPROVE" ? "LEAVE_APPROVE" : "LEAVE_REJECT", entityType: "HrLeaveRequest", entityId: id, employeeId: req.employeeId, after: requestDto(after), reason: note, actorId: actor.id });
    // feat/notifications: the person learns the decision (me.leave_decided).
    if (req.employee.accountId) {
      const { notify } = await import("@/lib/notifications/notify");
      await notify(tx, {
        event: "me.leave_decided", dedupeKey: `${id}:${decision}`, actorId: actor.id, entity: { type: "HrLeaveRequest", id },
        facts: { decision, from: dayString(req.startDate), to: dayString(req.endDate), note: note ?? null },
        people: { subject: req.employee.accountId },
      });
    }
    return requestDto(after);
  }, TX));
}

/** The requester withdraws a request that is still pending. */
export async function withdrawLeave(actor: HrActor, id: string) {
  return guarded(() => prisma.$transaction(async (tx) => {
    const req = await tx.hrLeaveRequest.findUnique({ where: { id }, include: { employee: { select: { accountId: true } } } });
    if (!req || (req.requestedBy !== actor.id && req.employee.accountId !== actor.id)) throw new HrError("Leave request not found", 404);
    await lock(tx, `leave:${req.employeeId}`);
    const r = await tx.hrLeaveRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "WITHDRAWN", cancelledBy: actor.id, cancelledAt: new Date() } });
    if (r.count !== 1) throw new HrError("Only a pending request can be withdrawn.", 409);
    await audit(tx, { action: "LEAVE_WITHDRAW", entityType: "HrLeaveRequest", entityId: id, employeeId: req.employeeId, actorId: actor.id });
    return { withdrawn: true };
  }, TX));
}

/**
 * Cancel an APPROVED leave: the days go back to the balance as a REVERSAL row. Before it
 * starts the person themself may cancel; once it has started only leave_manage may, with a
 * reason, because payroll may already rely on it. A leave inside an approved or paid
 * payroll month cannot be cancelled here at all (correct it with a correction run).
 */
export async function cancelLeave(actor: HrActor, id: string, b: Record<string, unknown>, today: Date) {
  const reason = reqText(b.reason, "reason", 500, 3);
  return guarded(() => prisma.$transaction(async (tx) => {
    const req = await tx.hrLeaveRequest.findUnique({ where: { id }, include: { employee: true, leaveType: true } });
    if (!req) throw new HrError("Leave request not found", 404);
    const own = req.employee.accountId === actor.id;
    if (!own) {
      assertCan(actor, "leave_manage");
      const scope = await resolveScope(actor, tx);
      if (!inScope(scope, req.employee)) throw new HrError("Leave request not found", 404);
    } else if (req.startDate <= today && !can(actor, "leave_manage")) {
      throw new HrError("This leave has started. Ask HR to cancel it.", 403);
    }
    await lock(tx, `leave:${req.employeeId}`);
    const settled = await tx.hrPayrollRun.findFirst({ where: { status: { in: ["APPROVED", "PAID"] }, periodStart: { lte: req.endDate }, periodEnd: { gte: req.startDate }, lines: { some: { employeeId: req.employeeId } } } });
    if (settled) throw new HrError(`Payroll ${settled.periodMonth} that includes this leave is ${settled.status}. Use a correction run.`, 409, "PERIOD_SETTLED");
    const r = await tx.hrLeaveRequest.updateMany({ where: { id, status: "APPROVED" }, data: { status: "CANCELLED", cancelledBy: actor.id, cancelledAt: new Date(), cancelReason: reason } });
    if (r.count !== 1) throw new HrError("Only an approved leave can be cancelled.", 409);
    if (req.leaveType.tracksBalance) {
      await tx.hrLeaveLedger.create({ data: { employeeId: req.employeeId, leaveTypeId: req.leaveTypeId, entryType: "REVERSAL", days: req.days, effectiveDate: req.startDate, requestId: req.id, reason: `Cancelled: ${reason}`, actorId: actor.id } });
    }
    await audit(tx, { action: "LEAVE_CANCEL", entityType: "HrLeaveRequest", entityId: id, employeeId: req.employeeId, reason, actorId: actor.id });
    return { cancelled: true };
  }, TX));
}

// ── Manual ledger entries ──────────────────────────────────────────────────────────

export async function ledgerEntry(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "leave_manage");
  const employeeId = reqText(b.employeeId, "employeeId", 40);
  const leaveTypeId = reqText(b.leaveTypeId, "leaveTypeId", 40);
  const entryType = oneOf(b.entryType, "entryType", ["OPENING", "GRANT", "ADJUSTMENT"] as const);
  const reason = reqText(b.reason, "reason", 500, 3);
  const effectiveDate = dayArg(b.effectiveDate, "effectiveDate");
  let days: Prisma.Decimal;
  try {
    days = D(String(b.days));
  } catch {
    throw new HrError("days must be a number.", 400);
  }
  if (days.isZero() || days.decimalPlaces() > 2) throw new HrError("days must be non-zero with at most two decimals.", 400);
  if (entryType !== "ADJUSTMENT" && days.lessThan(0)) throw new HrError(`${entryType} must be positive; use ADJUSTMENT to reduce.`, 400);
  return guarded(() => prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    const person = await personInScope(tx, scope, employeeId);
    assertNotSelf(actor, person, "change leave balance");
    await lock(tx, `leave:${employeeId}`);
    const type = await tx.hrLeaveType.findUnique({ where: { id: leaveTypeId } });
    if (!type || !type.tracksBalance) throw new HrError("This leave type has no balance.", 400);
    if (entryType === "OPENING" && (await tx.hrLeaveLedger.count({ where: { employeeId, leaveTypeId, entryType: "OPENING" } })) > 0) {
      throw new HrError("An opening balance already exists. Use ADJUSTMENT to correct it.", 409);
    }
    const bal = await ledgerBalance(tx, employeeId, leaveTypeId);
    const held = await pendingHeld(tx, employeeId, leaveTypeId);
    if (!type.allowNegative && bal.plus(days).minus(held).lessThan(0)) {
      throw new HrError(`This would leave ${bal.plus(days).minus(held).toFixed(2)} day(s) after approved and pending leave.`, 409, "INSUFFICIENT_BALANCE");
    }
    const row = await tx.hrLeaveLedger.create({ data: { employeeId, leaveTypeId, entryType, days, effectiveDate, reason, actorId: actor.id } });
    await audit(tx, { action: `LEAVE_${entryType}`, entityType: "HrLeaveLedger", entityId: row.id, employeeId, after: { days: days.toFixed(2), effectiveDate: dayString(effectiveDate) }, reason, actorId: actor.id });
    return { id: row.id, balance: bal.plus(days).toFixed(2) };
  }, TX));
}

/**
 * Monthly accrual. Credits accrualDaysPerYear/12 to everyone employed on the month's last
 * day. Idempotent: (employee, type, "YYYY-MM") is unique, so a re-run adds nothing.
 *
 * P-2 review P2-A5 (S-8.2.3): a leave type still marked as a PROPOSAL accrues nothing — like
 * payroll, proposed values never take effect. Such types are listed in `refused` and the refusal
 * is audited (HR_CONTROL_REFUSED); confirming them is a second policy manager's LEAVE_TYPE_CONFIRM.
 */
export async function runAccrual(actor: HrActor, month: string) {
  assertCan(actor, "leave_manage");
  // Company-wide job: it credits everyone, so it also needs the all-branches duty.
  assertCan(actor, "all_branches");
  if (!isMonth(month)) throw new HrError("month must look like 2026-10.", 400);
  const { start, end } = monthBounds(month);
  const all = await prisma.hrLeaveType.findMany({ where: { active: true, tracksBalance: true, accrualDaysPerYear: { not: null } } });
  const refused = all.filter((t) => t.isProposal).map((t) => t.code).sort();
  if (refused.length) await audit(prisma, { action: "HR_CONTROL_REFUSED", entityType: "HrLeaveLedger", entityId: month, after: { step: "LEAVE_ACCRUAL", code: "LEAVE_TYPE_PROPOSAL", leaveTypes: refused }, actorId: actor.id });
  const types = all.filter((t) => !t.isProposal);
  const people = await prisma.hrEmployee.findMany({ where: { hireDate: { lte: end }, OR: [{ separationDate: null }, { separationDate: { gte: end } }], status: { not: "SEPARATED" } }, select: { id: true, hireDate: true } });
  let created = 0;
  for (const t of types) {
    const per = (t.accrualDaysPerYear as Prisma.Decimal).dividedBy(12).toDecimalPlaces(2);
    if (per.isZero()) continue;
    for (const p of people) {
      const r = await prisma.hrLeaveLedger.createMany({ data: [{ employeeId: p.id, leaveTypeId: t.id, entryType: "ACCRUAL", days: per, effectiveDate: end, accrualKey: month, reason: `Monthly accrual ${month}`, actorId: actor.id }], skipDuplicates: true });
      created += r.count;
    }
  }
  await audit(prisma, { action: "LEAVE_ACCRUAL_RUN", entityType: "HrLeaveLedger", entityId: month, after: { created, from: dayString(start), refusedProposalTypes: refused }, actorId: actor.id });
  return { month, created, refused };
}

// ── Queues ─────────────────────────────────────────────────────────────────────────

export async function listRequests(actor: HrActor, q: { view?: string | null }) {
  assertAnyLeave(actor);
  const scope = await resolveScope(actor);
  const people = scope.all ? {} : { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.reportIds } }] };
  const where: Prisma.HrLeaveRequestWhereInput = { employee: people };
  if (q.view === "mine") {
    // pending requests I may decide: not filed by me, not about me
    Object.assign(where, { status: "PENDING", requestedBy: { not: actor.id }, NOT: { employee: { accountId: actor.id } } });
  } else if (q.view === "pending") where.status = "PENDING";
  const rows = await prisma.hrLeaveRequest.findMany({ where, include: { employee: { select: { id: true, fullNameAr: true, employeeNo: true, accountId: true } }, leaveType: { select: { code: true, nameAr: true, paid: true } } }, orderBy: [{ status: "asc" }, { startDate: "desc" }], take: 200 });
  const names = await accountNames(prisma, rows.flatMap((r) => [r.requestedBy, r.decidedBy]));
  return rows.map((r) => ({ ...requestDto(r), employee: { id: r.employee.id, fullNameAr: r.employee.fullNameAr, employeeNo: r.employee.employeeNo }, leaveType: r.leaveType, requestedByName: names.get(r.requestedBy) ?? null, decidedByName: r.decidedBy ? names.get(r.decidedBy) ?? null : null, isMine: r.employee.accountId === actor.id || r.requestedBy === actor.id }));
}

/** Calendar days of APPROVED unpaid leave inside [from, to], counted as the request counted them (working days). */
export async function unpaidLeaveDays(db: Db, employeeId: string, from: Date, to: Date, weekendDays: number[]): Promise<Date[]> {
  const reqs = await db.hrLeaveRequest.findMany({ where: { employeeId, status: "APPROVED", leaveType: { paid: false }, startDate: { lte: to }, endDate: { gte: from } } });
  const out: Date[] = [];
  for (const r of reqs) for (let d = r.startDate > from ? r.startDate : from; d <= (r.endDate < to ? r.endDate : to); d = addDays(d, 1)) if (!weekendDays.includes(d.getUTCDay())) out.push(d);
  return out;
}
