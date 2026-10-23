// Native HR — openings, applicants, interviews, offers, and conversion to an employee.
//
// Conversion is one transaction and idempotent: applicant.hiredEmployeeId is unique and set
// once (trigger), so converting twice returns the same person. It never creates a login;
// linking an existing login is optional and goes through the same unique link as everywhere.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, TX, assertCan, audit, lock, int, oneOf, reqText, text, mapDbError } from "../core";
import { addDays, dayString, isDay, parseDay } from "../dates";
import { parseAmount } from "../money";
import { assertLinkChangeAllowed, createPerson, nextNumber } from "./people";

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}
const amt = (v: unknown, f: string, zero = true) => {
  if ((v === undefined || v === null || v === "") && zero) return new Prisma.Decimal(0);
  try {
    return new Prisma.Decimal(parseAmount(v, { allowZero: zero }).toString());
  } catch (e) {
    throw new HrError(`${f}: ${(e as Error).message}`, 400);
  }
};

export async function listOpenings(actor: HrActor) {
  assertCan(actor, "recruit");
  return prisma.hrJobOpening.findMany({ orderBy: { createdAt: "desc" }, include: { department: { select: { nameAr: true, nameEn: true } }, branch: { select: { code: true, nameAr: true, nameEn: true } }, _count: { select: { applicants: true } } } });
}

export async function createOpening(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "recruit");
  return guarded(async () => {
    const o = await prisma.hrJobOpening.create({ data: { code: reqText(b.code, "code", 20).toUpperCase(), title: reqText(b.title, "title", 120), departmentId: text(b.departmentId, "departmentId", { max: 40 }), branchId: text(b.branchId, "branchId", { max: 40 }), openings: int(b.openings, "openings", { min: 1, max: 100 }) ?? 1, createdBy: actor.id } });
    await audit(prisma, { action: "OPENING_CREATE", entityType: "HrJobOpening", entityId: o.id, after: o, actorId: actor.id });
    return o;
  });
}

export async function setOpeningStatus(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "recruit");
  const status = oneOf(b.status, "status", ["OPEN", "ON_HOLD", "CLOSED"] as const);
  const o = await prisma.hrJobOpening.update({ where: { id }, data: { status } }).catch(() => { throw new HrError("Opening not found", 404); });
  await audit(prisma, { action: "OPENING_STATUS", entityType: "HrJobOpening", entityId: id, after: { status }, actorId: actor.id });
  return o;
}

export async function listApplicants(actor: HrActor, q: { stage?: string | null }) {
  assertCan(actor, "recruit");
  const rows = await prisma.hrApplicant.findMany({
    where: q.stage === "active" ? { stage: { in: ["APPLIED", "SCREENING", "INTERVIEW", "OFFER"] } } : q.stage ? { stage: q.stage as never } : {},
    include: { opening: { select: { code: true, title: true, departmentId: true, branchId: true } }, interviews: { orderBy: { scheduledAt: "asc" } }, offers: { orderBy: { createdAt: "desc" } }, hiredEmployee: { select: { id: true, employeeNo: true } } },
    orderBy: { createdAt: "desc" }, take: 200,
  });
  return rows.map((a) => ({ ...a, offers: a.offers.map((o) => ({ ...o, startDate: dayString(o.startDate), basic: o.basic.toFixed(2), housing: o.housing.toFixed(2), transport: o.transport.toFixed(2), otherAllowance: o.otherAllowance.toFixed(2) })) }));
}

export async function createApplicant(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "recruit");
  return guarded(() => prisma.$transaction(async (tx) => {
    const applicantNo = await nextNumber(tx, "APP-", "applicant");
    const a = await tx.hrApplicant.create({ data: { applicantNo, openingId: text(b.openingId, "openingId", { max: 40 }), fullName: reqText(b.fullName, "fullName", 120), email: text(b.email, "email", { max: 120 }), phone: text(b.phone, "phone", { max: 40 }), source: text(b.source, "source", { max: 60 }), notes: text(b.notes, "notes", { max: 1000 }), createdBy: actor.id } });
    await audit(tx, { action: "APPLICANT_CREATE", entityType: "HrApplicant", entityId: a.id, after: { applicantNo, fullName: a.fullName }, actorId: actor.id });
    return a;
  }, TX));
}

const NEXT: Record<string, string[]> = { APPLIED: ["SCREENING", "REJECTED", "WITHDRAWN"], SCREENING: ["INTERVIEW", "REJECTED", "WITHDRAWN"], INTERVIEW: ["OFFER", "REJECTED", "WITHDRAWN"], OFFER: ["REJECTED", "WITHDRAWN"] };

export async function setStage(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "recruit");
  const stage = oneOf(b.stage, "stage", ["SCREENING", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"] as const);
  const a = await prisma.hrApplicant.findUnique({ where: { id } });
  if (!a) throw new HrError("Applicant not found", 404);
  if (!(NEXT[a.stage] ?? []).includes(stage)) throw new HrError(`An applicant in ${a.stage} cannot move to ${stage}.`, 409);
  const r = await prisma.hrApplicant.updateMany({ where: { id, stage: a.stage }, data: { stage } });
  if (r.count !== 1) throw new HrError("The applicant changed meanwhile.", 409);
  await audit(prisma, { action: "APPLICANT_STAGE", entityType: "HrApplicant", entityId: id, before: { stage: a.stage }, after: { stage }, reason: text(b.note, "note", { max: 300 }), actorId: actor.id });
  return { stage };
}

export async function addInterview(actor: HrActor, applicantId: string, b: Record<string, unknown>) {
  assertCan(actor, "recruit");
  const at = typeof b.scheduledAt === "string" ? new Date(b.scheduledAt) : null;
  if (!at || Number.isNaN(at.getTime())) throw new HrError("scheduledAt must be a date-time.", 400);
  const a = await prisma.hrApplicant.findUnique({ where: { id: applicantId }, select: { stage: true } });
  if (!a) throw new HrError("Applicant not found", 404);
  if (!["SCREENING", "INTERVIEW", "OFFER"].includes(a.stage)) throw new HrError(`An applicant in ${a.stage} cannot be interviewed.`, 409);
  const i = await prisma.hrInterview.create({ data: { applicantId, scheduledAt: at, kind: reqText(b.kind, "kind", 60), interviewerAccountId: text(b.interviewerAccountId, "interviewerAccountId", { max: 40 }), notes: text(b.notes, "notes", { max: 1000 }), createdBy: actor.id } });
  await audit(prisma, { action: "INTERVIEW_ADD", entityType: "HrInterview", entityId: i.id, actorId: actor.id });
  return i;
}

export async function interviewOutcome(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "recruit");
  const outcome = oneOf(b.outcome, "outcome", ["PASS", "FAIL", "NO_SHOW"] as const);
  const r = await prisma.hrInterview.updateMany({ where: { id }, data: { outcome, notes: text(b.notes, "notes", { max: 1000 }) } });
  if (r.count !== 1) throw new HrError("Interview not found", 404);
  const i = await prisma.hrInterview.findUniqueOrThrow({ where: { id } });
  await audit(prisma, { action: "INTERVIEW_OUTCOME", entityType: "HrInterview", entityId: id, after: { outcome }, actorId: actor.id });
  return i;
}

export async function createOffer(actor: HrActor, applicantId: string, b: Record<string, unknown>) {
  assertCan(actor, "recruit");
  if (!isDay(b.startDate)) throw new HrError("startDate must be a date.", 400);
  const contractType = oneOf(b.contractType, "contractType", ["FIXED_TERM", "OPEN_ENDED"] as const);
  const months = int(b.contractMonths, "contractMonths", { min: 1, max: 120 });
  if (contractType === "FIXED_TERM" && !months) throw new HrError("A fixed-term offer needs contractMonths.", 400);
  return guarded(() => prisma.$transaction(async (tx) => {
    const a = await tx.hrApplicant.findUnique({ where: { id: applicantId } });
    if (!a) throw new HrError("Applicant not found", 404);
    if (a.stage !== "OFFER") throw new HrError("Move the applicant to OFFER first.", 409);
    await tx.hrOffer.updateMany({ where: { applicantId, status: { in: ["DRAFT", "SENT"] } }, data: { status: "WITHDRAWN" } });
    const o = await tx.hrOffer.create({ data: { applicantId, jobTitle: reqText(b.jobTitle, "jobTitle", 120), basic: amt(b.basic, "basic", false), housing: amt(b.housing, "housing"), transport: amt(b.transport, "transport"), otherAllowance: amt(b.otherAllowance, "otherAllowance"), startDate: parseDay(b.startDate as string), contractType, contractMonths: months, probationDays: int(b.probationDays, "probationDays", { min: 0, max: 365 }), noticeDays: int(b.noticeDays, "noticeDays", { min: 0, max: 365 }) ?? 30, status: "SENT", createdBy: actor.id } });
    await audit(tx, { action: "OFFER_SEND", entityType: "HrOffer", entityId: o.id, actorId: actor.id });
    return o;
  }, TX));
}

export async function decideOffer(actor: HrActor, offerId: string, b: Record<string, unknown>) {
  assertCan(actor, "recruit");
  const decision = oneOf(b.decision, "decision", ["ACCEPTED", "DECLINED"] as const);
  const r = await prisma.hrOffer.updateMany({ where: { id: offerId, status: "SENT" }, data: { status: decision, decidedAt: new Date() } });
  if (r.count !== 1) throw new HrError("Only a sent offer can be accepted or declined.", 409);
  await audit(prisma, { action: `OFFER_${decision}`, entityType: "HrOffer", entityId: offerId, actorId: actor.id });
  return { status: decision };
}

/**
 * Convert an applicant with an ACCEPTED offer into one HR person, with a DRAFT→ACTIVE
 * contract and the first compensation version taken from the offer. No login is created.
 */
export async function hireApplicant(actor: HrActor, applicantId: string, b: Record<string, unknown>) {
  assertCan(actor, "recruit");
  assertCan(actor, "people_manage");
  assertCan(actor, "contracts_manage");
  return guarded(() => prisma.$transaction(async (tx) => {
    await lock(tx, `hire:${applicantId}`);
    const a = await tx.hrApplicant.findUnique({ where: { id: applicantId }, include: { offers: { where: { status: "ACCEPTED" }, orderBy: { decidedAt: "desc" }, take: 1 } } });
    if (!a) throw new HrError("Applicant not found", 404);
    if (a.hiredEmployeeId) return { employeeId: a.hiredEmployeeId, replayed: true };
    const offer = a.offers[0];
    if (!offer) throw new HrError("The applicant has no accepted offer.", 409);
    const person = await createPerson(actor, {
      fullNameAr: a.fullName, jobTitle: offer.jobTitle, hireDate: dayString(offer.startDate),
      probationEndDate: offer.probationDays ? dayString(addDays(offer.startDate, offer.probationDays - 1)) : null,
      branchId: b.branchId, departmentId: b.departmentId, managerId: b.managerId, status: offer.probationDays ? "PROBATION" : "ACTIVE",
      // The company e-mail («بريد الشركة») is assigned at hiring (optional); the applicant's own
      // address is their PERSONAL e-mail (feat/credit-hold, owner e-mail model) — not the company's.
      workPhone: a.phone, workEmail: typeof b.workEmail === "string" ? b.workEmail : null,
    }, { tx });
    if (a.email) await tx.hrEmployeePrivate.update({ where: { employeeId: person!.id }, data: { personalEmail: a.email, updatedBy: actor.id } });
    if (!person) throw new HrError("Could not create the person.", 500);
    const end = offer.contractType === "FIXED_TERM" && offer.contractMonths
      ? addDays(new Date(Date.UTC(offer.startDate.getUTCFullYear(), offer.startDate.getUTCMonth() + offer.contractMonths, offer.startDate.getUTCDate())), -1)
      : null;
    await tx.hrContract.create({ data: { employeeId: person.id, contractNo: `C-${person.employeeNo}-1`, version: 1, type: offer.contractType, startDate: offer.startDate, endDate: end, probationDays: offer.probationDays, noticeDays: offer.noticeDays, status: "ACTIVE", createdBy: actor.id, activatedBy: actor.id, activatedAt: new Date(), notes: `From offer ${offer.id}` } });
    await tx.hrCompensation.create({ data: { employeeId: person.id, effectiveFrom: offer.startDate, basic: offer.basic, housing: offer.housing, transport: offer.transport, otherAllowance: offer.otherAllowance, reason: "Accepted offer", createdBy: actor.id } });
    const accountId = text(b.accountId, "accountId", { max: 40 });
    if (accountId) {
      // QA2 P2-1: the same checks and audit as linkAccount — the login exists, is free, and holds
      // no segregated duty (IDENTITY_LOCKED); the link is recorded as ACCOUNT_LINK.
      const acc = await tx.employee.findUnique({ where: { id: accountId }, select: { id: true } });
      if (!acc) throw new HrError("Login account not found.", 400);
      const taken = (await tx.hrEmployee.findUnique({ where: { accountId } })) ?? (await tx.hrExternalPerson.findUnique({ where: { accountId } }));
      if (taken) throw new HrError("This login is already linked to another person.", 409, "ACCOUNT_TAKEN");
      // SIMPLE MODE: a privileged login is allowed and its audit carries the bypass marker.
      const bypass = await assertLinkChangeAllowed(tx, null, accountId);
      await tx.hrEmployee.update({ where: { id: person.id }, data: { accountId, version: { increment: 1 } } });
      await audit(tx, { action: "ACCOUNT_LINK", entityType: "HrEmployee", entityId: person.id, employeeId: person.id, before: { accountId: null }, after: { accountId, ...bypass }, actorId: actor.id });
    }
    const r = await tx.hrApplicant.updateMany({ where: { id: applicantId, hiredEmployeeId: null }, data: { stage: "HIRED", hiredEmployeeId: person.id } });
    if (r.count !== 1) throw new HrError("The applicant was converted meanwhile.", 409);
    await audit(tx, { action: "APPLICANT_HIRE", entityType: "HrApplicant", entityId: applicantId, employeeId: person.id, after: { employeeNo: person.employeeNo, offerId: offer.id }, actorId: actor.id });
    return { employeeId: person.id, employeeNo: person.employeeNo, replayed: false };
  }, TX));
}
