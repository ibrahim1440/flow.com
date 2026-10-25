// Native HR — self-service. Every function here resolves the subject from the SESSION
// (HrEmployee.accountId = the caller's login id) and never from a request parameter, so a
// person can only ever read or act on their own record.
import { prisma } from "@/lib/db";
import { HrError, type HrActor, TX, audit } from "../core";
import { dayString, localDay, localTime } from "../dates";
import { balances, requestDto } from "./leave";
import { advanceDto } from "./advances";
import { attendanceDto, shiftFor } from "./attendance";
import { activePolicyFor } from "./policy";
import { privateDto } from "./people";

export async function selfPerson(actor: HrActor) {
  const p = await prisma.hrEmployee.findUnique({ where: { accountId: actor.id } });
  if (!p) throw new HrError("Your login is not linked to an HR record. Ask HR to link it.", 404, "NOT_LINKED");
  return p;
}

const mask = (v: string | null | undefined, keep = 4) => (v ? `${"•".repeat(Math.max(0, v.length - keep))}${v.slice(-keep)}` : null);

export async function overview(actor: HrActor, now: Date) {
  const p = await prisma.hrEmployee.findUnique({ where: { accountId: actor.id }, include: { manager: { select: { fullNameAr: true } }, department: { select: { nameAr: true, nameEn: true } }, branch: { select: { nameAr: true, nameEn: true, code: true } }, private: true } });
  if (!p) return { linked: false as const };
  const policy = await activePolicyFor(prisma, now);
  const tz = policy?.timezone ?? "Asia/Riyadh";
  const today = localDay(now, tz);
  const [contract, leaves, reqs, advances, att, lines, corrections, reviews] = await Promise.all([
    prisma.hrContract.findFirst({ where: { employeeId: p.id, status: "ACTIVE" } }),
    balances(prisma, p.id),
    prisma.hrLeaveRequest.findMany({ where: { employeeId: p.id }, include: { leaveType: { select: { nameAr: true, code: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.hrAdvance.findMany({ where: { employeeId: p.id }, orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.hrAttendance.findFirst({ where: { employeeId: p.id, OR: [{ workDate: today }, { status: "OPEN" }] }, orderBy: { workDate: "desc" } }),
    prisma.hrPayrollLine.findMany({ where: { employeeId: p.id, run: { status: { in: ["APPROVED", "PAID"] } } }, include: { run: { select: { periodMonth: true, status: true, kind: true, runNo: true } } }, orderBy: { run: { periodMonth: "desc" } }, take: 24 }),
    prisma.hrAttendanceCorrection.findMany({ where: { employeeId: p.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.hrReview.findMany({ where: { employeeId: p.id, status: { in: ["SUBMITTED", "ACKNOWLEDGED"] } }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);
  // The decider's name beside a decision («خدماتي · طلباتي» shows who approved or rejected, with the reason).
  const deciderIds = [...reqs.map((r) => r.decidedBy), ...advances.map((a) => a.decidedBy), ...corrections.map((c) => c.decidedBy)].filter((x): x is string => !!x);
  const deciders = new Map(deciderIds.length ? (await prisma.employee.findMany({ where: { id: { in: [...new Set(deciderIds)] } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]) : []);
  const decidedByName = (id: string | null) => (id ? deciders.get(id) ?? null : null);
  return {
    linked: true as const,
    timezone: tz,
    today: dayString(today),
    policyConfigured: !!policy,
    person: { id: p.id, employeeNo: p.employeeNo, fullNameAr: p.fullNameAr, jobTitle: p.jobTitle, status: p.status, hireDate: dayString(p.hireDate), manager: p.manager?.fullNameAr ?? null, department: p.department?.nameAr ?? null, branch: p.branch?.nameAr ?? null, departmentEn: p.department?.nameEn ?? null, branchEn: p.branch?.nameEn ?? null },
    contract: contract ? { contractNo: contract.contractNo, type: contract.type, endDate: contract.endDate ? dayString(contract.endDate) : null } : null,
    privateMasked: { iban: mask(p.private?.iban), idNumber: mask(p.private?.idNumber), emergency: p.private?.emergencyName ? `${p.private.emergencyName} · ${mask(p.private.emergencyPhone) ?? ""}` : null },
    leaveBalances: leaves,
    leaveRequests: reqs.map((r) => ({ ...requestDto(r), leaveType: r.leaveType.nameAr, leaveTypeCode: r.leaveType.code, decidedByName: decidedByName(r.decidedBy) })),
    advances: await Promise.all(advances.map(async (a) => ({ ...(await advanceDto(prisma, a.id)), decidedByName: decidedByName(a.decidedBy) }))),
    today_attendance: att ? attendanceDto(att, tz) : null,
    payslips: lines.map((l) => ({ lineId: l.id, periodMonth: l.run.periodMonth, kind: l.run.kind, runNo: l.run.runNo, status: l.run.status, gross: l.gross.toFixed(2), net: l.net.toFixed(2) })),
    corrections: corrections.map((c) => ({ id: c.id, workDate: dayString(c.workDate), status: c.status, reason: c.reason, decisionNote: c.decisionNote, decidedByName: decidedByName(c.decidedBy), checkIn: c.requestedCheckIn ? localTime(c.requestedCheckIn, tz) : null, checkOut: c.requestedCheckOut ? localTime(c.requestedCheckOut, tz) : null })),
    todayShift: await shiftFor(prisma, p.id, today),
    reviews: reviews.map((r) => ({ id: r.id, periodLabel: r.periodLabel, rating: r.rating, status: r.status, strengths: r.strengths, improvements: r.improvements })),
  };
}

/** The person's own private data, unmasked. Audited like any other private read. */
export async function myPrivate(actor: HrActor) {
  const p = await selfPerson(actor);
  return prisma.$transaction(async (tx) => {
    const row = await tx.hrEmployeePrivate.findUnique({ where: { employeeId: p.id } });
    await audit(tx, { action: "PRIVATE_VIEW_SELF", entityType: "HrEmployeePrivate", entityId: p.id, employeeId: p.id, actorId: actor.id });
    return privateDto(row as unknown as Record<string, unknown>);
  }, TX);
}

export async function acknowledgeReview(actor: HrActor, reviewId: string) {
  const p = await selfPerson(actor);
  const r = await prisma.hrReview.updateMany({ where: { id: reviewId, employeeId: p.id, status: "SUBMITTED" }, data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date() } });
  if (r.count !== 1) throw new HrError("Review not found", 404);
  await audit(prisma, { action: "REVIEW_ACKNOWLEDGE", entityType: "HrReview", entityId: reviewId, employeeId: p.id, actorId: actor.id });
  return { acknowledged: true };
}
