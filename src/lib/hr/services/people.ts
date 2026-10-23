// Native HR — people: directory, profile, private data, departments, account links.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { effectivePermissions, payrollDuties } from "../sod";
import { idNumberValid, normalizeIdNumber, revokeLoginAttestations, revokeVerification } from "../identity";
import { assertIdNumberFree, identityGuarded, requestEmployeeIdentityChangeIn, type EmployeeIdentityFields } from "./identity-verification";
import {
  HrError, type HrActor, type Db, TX, assertCan, can, resolveScope, scopeWhere, personInScope, audit, lock,
  readJson, reqText, text, oneOf, mapDbError,
} from "../core";
import { addDays, dayString, isDay, parseDay } from "../dates";
import { balances } from "./leave";
import { isSimpleMode } from "@/lib/simple-mode";
import { assertCompanyEmailFree, isValidEmail } from "@/lib/notify/recipients";

/** The company e-mail is unique among active people and accounts — as an HR refusal (Arabic via messages-ar). */
export async function companyEmailFree(tx: Prisma.TransactionClient, email: string | null, except: { hrEmployeeId?: string; accountId?: string }) {
  try {
    await assertCompanyEmailFree(tx, email, except);
  } catch (e) {
    const r = e as { _appCode?: number; errorEn?: string; code?: string };
    if (r && r._appCode) throw new HrError(r.errorEn ?? "That e-mail address is not valid.", r._appCode, r.code);
    throw e;
  }
}

const STATUSES = ["PROBATION", "ACTIVE", "NOTICE", "SUSPENDED", "SEPARATED"] as const;
const TYPES = ["FULL_TIME", "PART_TIME", "TEMPORARY"] as const;

/**
 * The ONLY projection the directory ever returns. Whitelisted field by field so that a new
 * sensitive column can never leak through it by default.
 */
export const DIRECTORY_SELECT = {
  id: true,
  employeeNo: true,
  fullNameAr: true,
  fullNameEn: true,
  jobTitle: true,
  status: true,
  employmentType: true,
  hireDate: true,
  probationEndDate: true,
  separationDate: true,
  accountId: true,
  department: { select: { id: true, nameAr: true, nameEn: true } },
  branch: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  manager: { select: { id: true, fullNameAr: true } },
} satisfies Prisma.HrEmployeeSelect;

type DirRow = Prisma.HrEmployeeGetPayload<{ select: typeof DIRECTORY_SELECT }>;

export function directoryDto(r: DirRow, extra: { contractEnd?: Date | null; onLeaveToday?: boolean } = {}) {
  return {
    id: r.id,
    employeeNo: r.employeeNo,
    fullNameAr: r.fullNameAr,
    fullNameEn: r.fullNameEn,
    jobTitle: r.jobTitle,
    status: r.status,
    employmentType: r.employmentType,
    hireDate: dayString(r.hireDate),
    probationEndDate: r.probationEndDate ? dayString(r.probationEndDate) : null,
    separationDate: r.separationDate ? dayString(r.separationDate) : null,
    hasAccount: r.accountId !== null,
    department: r.department,
    branch: r.branch,
    manager: r.manager,
    contractEnd: extra.contractEnd ? dayString(extra.contractEnd) : null,
    onLeaveToday: extra.onLeaveToday ?? false,
  };
}

export type DirectoryQuery = { q?: string | null; status?: string | null; view?: string | null; branchId?: string | null; departmentId?: string | null; page?: number; pageSize?: number };

export async function listDirectory(actor: HrActor, query: DirectoryQuery, today: Date) {
  assertCan(actor, "directory");
  const scope = await resolveScope(actor);
  const and: Prisma.HrEmployeeWhereInput[] = [scopeWhere(scope)];
  if (query.q) {
    const q = query.q.trim();
    and.push({ OR: [{ fullNameAr: { contains: q, mode: "insensitive" } }, { fullNameEn: { contains: q, mode: "insensitive" } }, { employeeNo: { contains: q, mode: "insensitive" } }, { jobTitle: { contains: q, mode: "insensitive" } }] });
  }
  if (query.branchId) and.push({ branchId: query.branchId });
  if (query.departmentId) and.push({ departmentId: query.departmentId });
  const horizon = addDays(today, 60);
  switch (query.view) {
    case "active": and.push({ status: { in: ["ACTIVE", "PROBATION", "NOTICE"] } }); break;
    case "probation": and.push({ status: "PROBATION" }); break;
    case "expiring": and.push({ status: { not: "SEPARATED" }, contracts: { some: { status: "ACTIVE", endDate: { gte: today, lte: horizon } } } }); break;
    case "separated": and.push({ status: "SEPARATED" }); break;
    default: break;
  }
  if (query.status && (STATUSES as readonly string[]).includes(query.status)) and.push({ status: query.status as (typeof STATUSES)[number] });
  const where: Prisma.HrEmployeeWhereInput = { AND: and };
  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const [total, rows, counts] = await Promise.all([
    prisma.hrEmployee.count({ where }),
    prisma.hrEmployee.findMany({ where, select: DIRECTORY_SELECT, orderBy: { employeeNo: "asc" }, skip: (page - 1) * pageSize, take: pageSize }),
    viewCounts(scopeWhere(scope), today),
  ]);
  const ids = rows.map((r) => r.id);
  const [contracts, leaves] = await Promise.all([
    prisma.hrContract.findMany({ where: { employeeId: { in: ids }, status: "ACTIVE" }, select: { employeeId: true, endDate: true } }),
    prisma.hrLeaveRequest.findMany({ where: { employeeId: { in: ids }, status: "APPROVED", startDate: { lte: today }, endDate: { gte: today } }, select: { employeeId: true } }),
  ]);
  const endBy = new Map(contracts.map((c) => [c.employeeId, c.endDate]));
  const onLeave = new Set(leaves.map((l) => l.employeeId));
  return {
    total,
    page,
    pageSize,
    counts,
    rows: rows.map((r) => directoryDto(r, { contractEnd: endBy.get(r.id) ?? null, onLeaveToday: onLeave.has(r.id) })),
  };
}

async function viewCounts(base: Prisma.HrEmployeeWhereInput, today: Date) {
  const horizon = addDays(today, 60);
  const [all, active, probation, expiring, separated, noAccount] = await Promise.all([
    prisma.hrEmployee.count({ where: base }),
    prisma.hrEmployee.count({ where: { AND: [base, { status: { in: ["ACTIVE", "PROBATION", "NOTICE"] } }] } }),
    prisma.hrEmployee.count({ where: { AND: [base, { status: "PROBATION" }] } }),
    prisma.hrEmployee.count({ where: { AND: [base, { status: { not: "SEPARATED" }, contracts: { some: { status: "ACTIVE", endDate: { gte: today, lte: horizon } } } }] } }),
    prisma.hrEmployee.count({ where: { AND: [base, { status: "SEPARATED" }] } }),
    prisma.hrEmployee.count({ where: { AND: [base, { accountId: null }] } }),
  ]);
  return { all, active, probation, expiring, separated, noAccount };
}

// ── Profile ────────────────────────────────────────────────────────────────────────

export async function getProfile(actor: HrActor, id: string, today: Date) {
  assertCan(actor, "directory");
  const scope = await resolveScope(actor);
  await personInScope(prisma, scope, id);
  const person = await prisma.hrEmployee.findUniqueOrThrow({ where: { id }, select: { ...DIRECTORY_SELECT, version: true, workPhone: true, workEmail: true, managerId: true, departmentId: true, branchId: true } });
  const out: Record<string, unknown> = {
    person: { ...directoryDto(person), version: person.version, workPhone: person.workPhone, workEmail: person.workEmail, managerId: person.managerId, departmentId: person.departmentId, branchId: person.branchId },
    permissions: {
      edit: can(actor, "people_manage"),
      privateView: can(actor, "private_view"),
      contracts: can(actor, "contracts_manage"),
      documents: can(actor, "documents_view"),
      documentsManage: can(actor, "documents_manage"),
      leave: can(actor, "leave_manage") || can(actor, "leave_approve"),
      advances: can(actor, "advances_manage") || can(actor, "advances_approve") || can(actor, "advances_disburse"),
      assets: can(actor, "assets_manage"),
      performance: can(actor, "performance_manage"),
      offboard: can(actor, "offboard"),
      attendance: can(actor, "attendance_manage") || can(actor, "attendance_approve"),
    },
  };
  if (person.accountId && can(actor, "people_manage")) {
    const acc = await prisma.employee.findUnique({ where: { id: person.accountId }, select: { name: true, username: true, active: true } });
    out.account = acc ? { name: acc.name, username: acc.username, active: acc.active } : null;
  }
  const activeContract = await prisma.hrContract.findFirst({ where: { employeeId: id, status: "ACTIVE" } });
  out.currentContract = activeContract ? { contractNo: activeContract.contractNo, type: activeContract.type, startDate: dayString(activeContract.startDate), endDate: activeContract.endDate ? dayString(activeContract.endDate) : null, noticeDays: activeContract.noticeDays } : null;
  if (can(actor, "contracts_manage")) {
    const [contracts, comps] = await Promise.all([
      prisma.hrContract.findMany({ where: { employeeId: id }, orderBy: { version: "desc" } }),
      prisma.hrCompensation.findMany({ where: { employeeId: id }, orderBy: { effectiveFrom: "desc" } }),
    ]);
    out.contracts = contracts.map(contractDto);
    out.compensation = comps.map(compensationDto);
  }
  if (can(actor, "documents_view")) {
    const docs = await prisma.hrDocument.findMany({ where: { employeeId: id, deletedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, category: true, title: true, fileName: true, mimeType: true, sizeBytes: true, confidential: true, expiresOn: true, createdAt: true } });
    out.documents = docs.map((d) => ({ ...d, expiresOn: d.expiresOn ? dayString(d.expiresOn) : null }));
  }
  if (can(actor, "assets_manage") || can(actor, "offboard")) {
    const a = await prisma.hrAssetAssignment.findMany({ where: { employeeId: id }, include: { asset: { select: { tag: true, name: true, category: true } } }, orderBy: { assignedOn: "desc" } });
    out.assets = a.map((x) => ({ id: x.id, tag: x.asset.tag, name: x.asset.name, category: x.asset.category, assignedOn: dayString(x.assignedOn), returnedOn: x.returnedOn ? dayString(x.returnedOn) : null }));
  }
  out.reminders = await reminders(actor, id, today);
  out.snapshot = await snapshot(actor, id, today);
  return out;
}

/**
 * The directory preview's operational facts (approved HR-01 preview): today's shift for
 * anyone with the directory; the annual-leave balance only with a leave duty; whether an
 * advance is open only with an advances duty. A key that is absent means "not yours to see",
 * null means "none".
 */
async function snapshot(actor: HrActor, id: string, today: Date) {
  const out: Record<string, unknown> = {};
  const sa = await prisma.hrShiftAssignment.findFirst({ where: { employeeId: id, effectiveFrom: { lte: today }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] }, include: { shift: true }, orderBy: { effectiveFrom: "desc" } });
  out.shift = sa ? { name: sa.shift.name, startTime: sa.shift.startTime, endTime: sa.shift.endTime } : null;
  if (can(actor, "leave_manage") || can(actor, "leave_approve")) {
    const b = await balances(prisma, id);
    const t = b.find((x) => x.code === "ANNUAL") ?? b.find((x) => x.tracksBalance) ?? null;
    out.leave = t ? { code: t.code, nameAr: t.nameAr, available: t.available } : null;
    // HR-02 summary: the next approved leave (same leave duty as the balance).
    const next = await prisma.hrLeaveRequest.findFirst({ where: { employeeId: id, status: "APPROVED", endDate: { gte: today } }, orderBy: { startDate: "asc" }, include: { leaveType: { select: { nameAr: true, code: true } } } });
    out.upcomingLeave = next ? { startDate: dayString(next.startDate), endDate: dayString(next.endDate), days: next.days.toFixed(2), type: next.leaveType.nameAr, typeCode: next.leaveType.code } : null;
  }
  if (can(actor, "advances_manage") || can(actor, "advances_approve") || can(actor, "advances_disburse")) {
    const a = await prisma.hrAdvance.findFirst({ where: { employeeId: id, status: { in: ["REQUESTED", "APPROVED", "DISBURSED"] } }, orderBy: { createdAt: "desc" }, select: { advanceNo: true, status: true } });
    out.advance = a ? { advanceNo: a.advanceNo, status: a.status } : null;
  }
  return out;
}

export function contractDto(c: { id: string; contractNo: string; version: number; type: string; startDate: Date; endDate: Date | null; probationDays: number | null; noticeDays: number; status: string; supersedesId: string | null; notes: string | null; activatedAt: Date | null; endedAt: Date | null; endReason: string | null }) {
  return { id: c.id, contractNo: c.contractNo, version: c.version, type: c.type, startDate: dayString(c.startDate), endDate: c.endDate ? dayString(c.endDate) : null, probationDays: c.probationDays, noticeDays: c.noticeDays, status: c.status, supersedesId: c.supersedesId, notes: c.notes, activatedAt: c.activatedAt, endedAt: c.endedAt, endReason: c.endReason };
}

export function compensationDto(c: { id: string; effectiveFrom: Date; effectiveTo: Date | null; basic: Prisma.Decimal; housing: Prisma.Decimal; transport: Prisma.Decimal; otherAllowance: Prisma.Decimal; reason: string }) {
  const total = c.basic.plus(c.housing).plus(c.transport).plus(c.otherAllowance);
  return { id: c.id, effectiveFrom: dayString(c.effectiveFrom), effectiveTo: c.effectiveTo ? dayString(c.effectiveTo) : null, basic: c.basic.toFixed(2), housing: c.housing.toFixed(2), transport: c.transport.toFixed(2), otherAllowance: c.otherAllowance.toFixed(2), total: total.toFixed(2), reason: c.reason };
}

/** Date-driven reminders for one person (or everyone in scope when id is null). */
export async function reminders(actor: HrActor, id: string | null, today: Date) {
  const scope = await resolveScope(actor);
  const people: Prisma.HrEmployeeWhereInput = id ? { id } : { AND: [scopeWhere(scope), { status: { not: "SEPARATED" } }] };
  const horizon = addDays(today, 60);
  const out: { kind: string; employeeId: string; employeeName: string; date: string; message: string }[] = [];
  const contracts = await prisma.hrContract.findMany({ where: { status: "ACTIVE", endDate: { not: null, lte: horizon }, employee: people }, include: { employee: { select: { id: true, fullNameAr: true } } } });
  for (const c of contracts) {
    const end = c.endDate as Date;
    const notice = addDays(end, -c.noticeDays);
    out.push({ kind: "CONTRACT_END", employeeId: c.employeeId, employeeName: c.employee.fullNameAr, date: dayString(end), message: `ينتهي العقد ${c.contractNo}` });
    if (notice <= horizon) out.push({ kind: "NOTICE_DEADLINE", employeeId: c.employeeId, employeeName: c.employee.fullNameAr, date: dayString(notice), message: `آخر موعد لإشعار التجديد أو عدمه (${c.noticeDays} يومًا)` });
  }
  const prob = await prisma.hrEmployee.findMany({ where: { AND: [people, { status: "PROBATION", probationEndDate: { not: null, lte: addDays(today, 30) } }] }, select: { id: true, fullNameAr: true, probationEndDate: true } });
  for (const p of prob) out.push({ kind: "PROBATION_END", employeeId: p.id, employeeName: p.fullNameAr, date: dayString(p.probationEndDate as Date), message: "نهاية فترة التجربة" });
  if (can(actor, "documents_view")) {
    const docs = await prisma.hrDocument.findMany({ where: { deletedAt: null, expiresOn: { not: null, lte: horizon }, employee: people }, include: { employee: { select: { id: true, fullNameAr: true } } } });
    for (const d of docs) out.push({ kind: "DOCUMENT_EXPIRY", employeeId: d.employeeId, employeeName: d.employee.fullNameAr, date: dayString(d.expiresOn as Date), message: `انتهاء ${d.title}` });
  }
  if (can(actor, "private_view")) {
    const ids = await prisma.hrEmployeePrivate.findMany({ where: { idExpiry: { not: null, lte: horizon }, employee: people }, include: { employee: { select: { id: true, fullNameAr: true } } } });
    for (const p of ids) out.push({ kind: "ID_EXPIRY", employeeId: p.employeeId, employeeName: p.employee.fullNameAr, date: dayString(p.idExpiry as Date), message: "انتهاء الهوية / الإقامة" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Writes ─────────────────────────────────────────────────────────────────────────

function day(v: unknown, field: string, required = false): Date | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HrError(`${field} is required.`, 400);
    return null;
  }
  if (!isDay(v)) throw new HrError(`${field} must be a date (YYYY-MM-DD).`, 400);
  return parseDay(v);
}

async function nextNumber(tx: Prisma.TransactionClient, prefix: string, table: "employee" | "advance" | "applicant"): Promise<string> {
  await lock(tx, `seq:${table}`);
  const rows: { n: number | null }[] =
    table === "employee"
      ? await tx.$queryRaw`SELECT MAX(CAST(SUBSTRING("employeeNo" FROM '[0-9]+$') AS INTEGER)) AS n FROM "HrEmployee" WHERE "employeeNo" LIKE ${prefix + "%"}`
      : table === "advance"
        ? await tx.$queryRaw`SELECT MAX(CAST(SUBSTRING("advanceNo" FROM '[0-9]+$') AS INTEGER)) AS n FROM "HrAdvance"`
        : await tx.$queryRaw`SELECT MAX(CAST(SUBSTRING("applicantNo" FROM '[0-9]+$') AS INTEGER)) AS n FROM "HrApplicant"`;
  const n = (rows[0]?.n ?? 0) + 1;
  return `${prefix}${String(n).padStart(table === "employee" ? 3 : 4, "0")}`;
}
export { nextNumber };

async function assertManagerValid(tx: Db, employeeId: string | null, managerId: string | null) {
  if (!managerId) return;
  if (managerId === employeeId) throw new HrError("A person cannot be their own manager.", 400);
  const m = await tx.hrEmployee.findUnique({ where: { id: managerId }, select: { id: true, status: true, managerId: true } });
  if (!m) throw new HrError("Manager not found.", 400);
  if (m.status === "SEPARATED") throw new HrError("A separated person cannot be a manager.", 400);
  // Walk up: the new manager may not report (directly or indirectly) to this person.
  let cur: string | null = m.managerId;
  for (let i = 0; cur && i < 50; i++) {
    if (cur === employeeId) throw new HrError("This reporting line would create a loop.", 400);
    const up: { managerId: string | null } | null = await tx.hrEmployee.findUnique({ where: { id: cur }, select: { managerId: true } });
    cur = up?.managerId ?? null;
  }
}

export type PersonInput = Record<string, unknown>;

export function parsePerson(b: PersonInput, partial = false) {
  const out: Prisma.HrEmployeeUncheckedUpdateInput & Record<string, unknown> = {};
  const has = (k: string) => k in b;
  if (!partial || has("fullNameAr")) out.fullNameAr = reqText(b.fullNameAr, "fullNameAr", 120);
  if (!partial || has("fullNameEn")) out.fullNameEn = text(b.fullNameEn, "fullNameEn", { max: 120 });
  if (!partial || has("jobTitle")) out.jobTitle = reqText(b.jobTitle, "jobTitle", 120);
  if (!partial || has("departmentId")) out.departmentId = text(b.departmentId, "departmentId", { max: 40 });
  if (!partial || has("branchId")) out.branchId = text(b.branchId, "branchId", { max: 40 });
  if (!partial || has("managerId")) out.managerId = text(b.managerId, "managerId", { max: 40 });
  if (!partial || has("employmentType")) out.employmentType = oneOf(b.employmentType, "employmentType", TYPES, "FULL_TIME");
  if (!partial || has("hireDate")) out.hireDate = day(b.hireDate, "hireDate", !partial) as Date;
  if (!partial || has("probationEndDate")) out.probationEndDate = day(b.probationEndDate, "probationEndDate");
  if (!partial || has("workPhone")) out.workPhone = text(b.workPhone, "workPhone", { max: 40 });
  // «بريد الشركة»: the company e-mail — the one address system notifications go to (lib/notify/recipients.ts).
  if (!partial || has("workEmail")) {
    out.workEmail = text(b.workEmail, "workEmail", { max: 120 });
    if (out.workEmail && !isValidEmail(String(out.workEmail).toLowerCase())) throw new HrError("That e-mail address is not valid.", 400, "EMAIL_INVALID");
  }
  if (out.hireDate && out.probationEndDate && (out.probationEndDate as Date) < (out.hireDate as Date)) throw new HrError("Probation cannot end before the hire date.", 400);
  return out;
}

export async function createPerson(actor: HrActor, b: PersonInput, opts: { tx?: Prisma.TransactionClient } = {}) {
  assertCan(actor, "people_manage");
  const data = parsePerson(b);
  const status = oneOf(b.status, "status", ["PROBATION", "ACTIVE"] as const, "PROBATION");
  const run = async (tx: Prisma.TransactionClient) => {
    const scope = await resolveScope(actor, tx);
    if (!scope.all && (!data.branchId || !scope.branchIds.includes(data.branchId as string))) {
      throw new HrError("You can only add people to a branch you have access to.", 403);
    }
    await assertManagerValid(tx, null, (data.managerId as string) ?? null);
    await companyEmailFree(tx, (data.workEmail as string) ?? null, {});
    const employeeNo = text(b.employeeNo, "employeeNo", { max: 20 }) ?? (await nextNumber(tx, "HR-", "employee"));
    const p = await tx.hrEmployee.create({
      data: {
        employeeNo,
        fullNameAr: data.fullNameAr as string,
        fullNameEn: (data.fullNameEn as string) ?? null,
        jobTitle: data.jobTitle as string,
        departmentId: (data.departmentId as string) ?? null,
        branchId: (data.branchId as string) ?? null,
        managerId: (data.managerId as string) ?? null,
        employmentType: data.employmentType as (typeof TYPES)[number],
        hireDate: data.hireDate as Date,
        probationEndDate: (data.probationEndDate as Date) ?? null,
        workPhone: (data.workPhone as string) ?? null,
        workEmail: (data.workEmail as string) ?? null,
        status,
        createdBy: actor.id,
      },
    });
    await tx.hrEmployeePrivate.create({ data: { employeeId: p.id, updatedBy: actor.id } });
    await audit(tx, { action: "PERSON_CREATE", entityType: "HrEmployee", entityId: p.id, employeeId: p.id, after: { ...p }, actorId: actor.id });
    return p;
  };
  try {
    return opts.tx ? await run(opts.tx) : await prisma.$transaction(run, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

export async function updatePerson(actor: HrActor, id: string, b: PersonInput) {
  assertCan(actor, "people_manage");
  const expected = Number(b.version);
  if (!Number.isInteger(expected)) throw new HrError("version is required (the version you read).", 400);
  const data = parsePerson(b, true);
  delete data.hireDate; // hire date changes go through a reason-bearing correction, not an edit
  if ("hireDate" in b) throw new HrError("The hire date is not edited here. Record a correction with a reason.", 400);
  try {
    return await prisma.$transaction(async (tx) => {
      const scope = await resolveScope(actor, tx);
      const before = await personInScope(tx, scope, id);
      if (before.status === "SEPARATED") throw new HrError("A separated person's record is closed.", 409);
      if ("branchId" in data && !scope.all && (!data.branchId || !scope.branchIds.includes(data.branchId as string))) {
        throw new HrError("You can only move people to a branch you have access to.", 403);
      }
      if ("managerId" in data) await assertManagerValid(tx, id, (data.managerId as string) ?? null);
      if ("workEmail" in data) await companyEmailFree(tx, (data.workEmail as string) ?? null, { hrEmployeeId: id });
      // Review P2-3: a name change of a VERIFIED person, or of one whose login holds duties, is a
      // request another person approves (the verification ends when it applies, not before). The
      // other fields apply now.
      const identifying: EmployeeIdentityFields = {};
      if ("fullNameAr" in data && data.fullNameAr !== before.fullNameAr) identifying.fullNameAr = data.fullNameAr as string;
      if ("fullNameEn" in data && (data.fullNameEn ?? null) !== (before.fullNameEn ?? null)) identifying.fullNameEn = (data.fullNameEn as string) ?? null;
      const guarded = Object.keys(identifying).length > 0 && (await identityGuarded(tx, id));
      if (guarded) { delete data.fullNameAr; delete data.fullNameEn; }
      const r = await tx.hrEmployee.updateMany({ where: { id, version: expected }, data: { ...data, version: { increment: 1 } } });
      if (r.count !== 1) throw new HrError("This record was changed by someone else. Reload and try again.", 409, "STALE");
      const after = await tx.hrEmployee.findUniqueOrThrow({ where: { id } });
      await audit(tx, { action: "PERSON_UPDATE", entityType: "HrEmployee", entityId: id, employeeId: id, before, after, actorId: actor.id });
      const identityChangePending = guarded ? await requestEmployeeIdentityChangeIn(tx, actor.id, id, identifying, typeof b.reason === "string" ? b.reason : "") : null;
      return { ...after, identityChangePending };
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

export async function setStatus(actor: HrActor, id: string, b: PersonInput) {
  assertCan(actor, "people_manage");
  const status = oneOf(b.status, "status", ["PROBATION", "ACTIVE", "NOTICE", "SUSPENDED"] as const);
  const reason = reqText(b.reason, "reason", 500, 3);
  return prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    const before = await personInScope(tx, scope, id);
    if (before.status === "SEPARATED") throw new HrError("Separation is completed through offboarding and cannot be undone here.", 409);
    const after = await tx.hrEmployee.update({ where: { id }, data: { status, version: { increment: 1 } } });
    await audit(tx, { action: "STATUS_CHANGE", entityType: "HrEmployee", entityId: id, employeeId: id, before: { status: before.status }, after: { status }, reason, actorId: actor.id });
    return after;
  }, TX);
}

/**
 * Owner decision 1: who holds a segregated duty is part of the control. A login holding one (or
 * the admin role) is neither linked, unlinked nor swapped — remove the duties first (a revocation
 * applies at once), change the link, then grant again (a second account editor approves the grant).
 * Shared by linkAccount, by hiring (QA2 P2-1) and by the users screen, so no path links a
 * duty-holding login quietly.
 *
 * SIMPLE MODE: the sole owner is the last admin (that protection stays), so he could never link his
 * own login to his HR file. The change is ALLOWED, and the caller records the returned marker in
 * the link's audit `after` ({ simpleModeBypass: true, privilegedLogins: [{ accountId, role, duties }] }),
 * so the control exception — and the duties held at that moment — stays visible. Returns null when
 * no privileged login is involved (nothing bypassed). With SIMPLE_MODE=off it refuses exactly as before.
 */
export type LinkChangeBypass = { simpleModeBypass: true; privilegedLogins: { accountId: string; role: string; duties: string[] }[] };

/** A login's segregated duties, and whether it is privileged for the link rule (admin role, or any duty). */
function linkPrivilege(r: { role: string; permissions: unknown }) {
  const duties: string[] = payrollDuties(effectivePermissions(r.permissions as string | null, r.role));
  return { duties, privileged: r.role === "admin" || duties.length > 0 };
}

export async function assertLinkChangeAllowed(tx: Prisma.TransactionClient, fromAccountId: string | null, toAccountId: string | null): Promise<LinkChangeBypass | null> {
  const logins = [fromAccountId, toAccountId].filter((x): x is string => !!x);
  if (!logins.length) return null;
  const rows = await tx.employee.findMany({ where: { id: { in: logins } }, select: { id: true, role: true, permissions: true } });
  const privileged = rows
    .map((r) => ({ accountId: r.id, role: r.role, ...linkPrivilege(r) }))
    .filter((r) => r.privileged)
    .map(({ accountId, role, duties }) => ({ accountId, role, duties }));
  if (!privileged.length) return null;
  // SIMPLE MODE: allowed, and the caller audits it as a control exception (see above).
  if (isSimpleMode()) return { simpleModeBypass: true, privilegedLogins: privileged };
  throw new HrError("A login that holds payroll or account-administration duties cannot be linked or unlinked. Remove those duties first, then grant them again after the change.", 409, "IDENTITY_LOCKED");
}

/** Link (or unlink with accountId null) the login a person uses. Never creates a login. */
export async function linkAccount(actor: HrActor, id: string, b: PersonInput) {
  assertCan(actor, "people_manage");
  const accountId = text(b.accountId, "accountId", { max: 40 });
  try {
    return await prisma.$transaction(async (tx) => {
      const scope = await resolveScope(actor, tx);
      const before = await personInScope(tx, scope, id);
      if (accountId) {
        const acc = await tx.employee.findUnique({ where: { id: accountId }, select: { id: true, active: true } });
        if (!acc) throw new HrError("Login account not found.", 400);
        const other = await tx.hrEmployee.findUnique({ where: { accountId }, select: { id: true } });
        if (other && other.id !== id) throw new HrError("This login is already linked to another person.", 409, "ACCOUNT_TAKEN");
        // Option A: one login, one person — never an employee record and an external person.
        if (await tx.hrExternalPerson.findUnique({ where: { accountId }, select: { id: true } })) throw new HrError("This login is already linked to another person.", 409, "ACCOUNT_TAKEN");
      }
      const bypass = (before.accountId ?? null) !== (accountId ?? null) ? await assertLinkChangeAllowed(tx, before.accountId, accountId) : null;
      const after = await tx.hrEmployee.update({ where: { id }, data: { accountId, version: { increment: 1 } } });
      await audit(tx, { action: accountId ? "ACCOUNT_LINK" : "ACCOUNT_UNLINK", entityType: "HrEmployee", entityId: id, employeeId: id, before: { accountId: before.accountId }, after: { accountId, ...bypass }, actorId: actor.id });
      // Review NEW-1: the login that leaves this person loses every attestation naming it.
      if (before.accountId && before.accountId !== accountId) await revokeLoginAttestations(tx, before.accountId, actor.id, "Login unlinked from its person.");
      return after;
    }, TX);
  } catch (e) {
    if (e instanceof HrError) throw e;
    mapDbError(e);
  }
}

/**
 * Login accounts that are not yet linked to any person — id and name only, never credentials.
 * `simpleModeException`: SIMPLE MODE is on and the login is privileged (admin role or a segregated
 * duty), so linking it is recorded as a control exception (assertLinkChangeAllowed) — the dialog says so.
 */
export async function linkableAccounts(actor: HrActor) {
  assertCan(actor, "people_manage");
  const rows = await prisma.employee.findMany({ where: { active: true, hrPerson: null, externalPerson: null }, select: { id: true, name: true, role: true, permissions: true }, orderBy: { name: "asc" } });
  const simple = isSimpleMode();
  return rows.map((r) => ({
    id: r.id, name: r.name, role: r.role,
    simpleModeException: simple && linkPrivilege(r).privileged,
  }));
}

// ── Private data ───────────────────────────────────────────────────────────────────

const PRIVATE_FIELDS = ["idType", "idNumber", "idExpiry", "nationality", "contributionGroup", "dateOfBirth", "gender", "personalPhone", "personalEmail", "address", "bankName", "iban", "emergencyName", "emergencyRelation", "emergencyPhone"] as const;

export function privateDto(p: Record<string, unknown> | null) {
  if (!p) return null;
  const o: Record<string, unknown> = {};
  for (const k of PRIVATE_FIELDS) {
    const v = p[k];
    o[k] = v instanceof Date ? dayString(v) : (v ?? null);
  }
  return o;
}

export async function getPrivate(actor: HrActor, id: string) {
  assertCan(actor, "private_view");
  return prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    await personInScope(tx, scope, id);
    const p = await tx.hrEmployeePrivate.findUnique({ where: { employeeId: id } });
    await audit(tx, { action: "PRIVATE_VIEW", entityType: "HrEmployeePrivate", entityId: id, employeeId: id, actorId: actor.id });
    return privateDto(p as unknown as Record<string, unknown>);
  }, TX);
}

export function parsePrivate(b: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  for (const k of PRIVATE_FIELDS) {
    if (!(k in b)) continue;
    if (k === "idExpiry" || k === "dateOfBirth") data[k] = day(b[k], k);
    else if (k === "iban") {
      const v = text(b[k], k, { max: 34 });
      if (v && !/^[A-Z]{2}[0-9A-Z]{13,32}$/.test(v.replace(/\s+/g, ""))) throw new HrError("IBAN format is not valid.", 400);
      data[k] = v ? v.replace(/\s+/g, "") : null;
    } else data[k] = text(b[k], k, { max: 200 });
  }
  return data;
}

export async function updatePrivate(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "private_view");
  assertCan(actor, "people_manage");
  const data = parsePrivate(b);
  return prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    await personInScope(tx, scope, id);
    const before = await tx.hrEmployeePrivate.findUnique({ where: { employeeId: id } });
    // Review NEW-3: an ambiguous number is refused whatever else the edit does.
    if ("idNumber" in data && !idNumberValid(data.idNumber as string | null)) throw new HrError("The identity number may contain only Latin letters A-Z and digits 0-9 (spaces, dashes and dots are ignored).", 400, "IDENTITY_NUMBER_INVALID");
    // Review P2-3: the identity document of a VERIFIED or duty-holding person changes only by a
    // second person's approved request; any other number must be free (one human, one record).
    const identifying: EmployeeIdentityFields = {};
    if ("idNumber" in data && normalizeIdNumber(data.idNumber as string | null) !== normalizeIdNumber(before?.idNumber)) identifying.idNumber = (data.idNumber as string) ?? null;
    if ("idType" in data && (data.idType ?? null) !== (before?.idType ?? null)) identifying.idType = (data.idType as string) ?? null;
    const guarded = Object.keys(identifying).length > 0 && (await identityGuarded(tx, id));
    if (guarded) { delete data.idNumber; delete data.idType; }
    else if ("idNumber" in identifying) await assertIdNumberFree(tx, identifying.idNumber, { employeeId: id });
    const after = await tx.hrEmployeePrivate.upsert({ where: { employeeId: id }, create: { employeeId: id, ...data, updatedBy: actor.id }, update: { ...data, updatedBy: actor.id } });
    // The audit records WHICH fields changed, not their values: the log must not become a
    // second copy of the private data.
    await audit(tx, { action: "PRIVATE_UPDATE", entityType: "HrEmployeePrivate", entityId: id, employeeId: id, after: { fields: Object.keys(data) }, actorId: actor.id });
    // An unguarded person has no live verification; revoking is a no-op kept for safety.
    if (!guarded && Object.keys(identifying).length) await revokeVerification(tx, "EMPLOYEE", id, actor.id, "Identifying details changed (identity document).");
    const identityChangePending = guarded ? await requestEmployeeIdentityChangeIn(tx, actor.id, id, identifying, typeof b.reason === "string" ? b.reason : "") : null;
    // Review NEW-7: the answer carries the private record in full (the editor sees what was
    // saved), so it is a view and audited as one, exactly like GET.
    await audit(tx, { action: "PRIVATE_VIEW", entityType: "HrEmployeePrivate", entityId: id, employeeId: id, after: { via: "update" }, actorId: actor.id });
    return { ...(privateDto(after as unknown as Record<string, unknown>) as Record<string, unknown>), identityChangePending };
  }, TX).catch((e) => { if (e instanceof HrError) throw e; return mapDbError(e); });
}

// ── Departments & branches ─────────────────────────────────────────────────────────

export async function listDepartments(actor: HrActor) {
  assertCan(actor, "directory");
  return prisma.hrDepartment.findMany({ orderBy: { code: "asc" } });
}

export async function createDepartment(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "people_manage");
  const code = reqText(b.code, "code", 20).toUpperCase();
  const nameAr = reqText(b.nameAr, "nameAr", 80);
  try {
    const d = await prisma.hrDepartment.create({ data: { code, nameAr, nameEn: text(b.nameEn, "nameEn", { max: 80 }), createdBy: actor.id } });
    await audit(prisma, { action: "DEPARTMENT_CREATE", entityType: "HrDepartment", entityId: d.id, after: d, actorId: actor.id });
    return d;
  } catch (e) {
    mapDbError(e);
  }
}

export async function listBranches(actor: HrActor) {
  assertCan(actor, "directory");
  const scope = await resolveScope(actor);
  return prisma.finBranch.findMany({ where: scope.all ? { active: true } : { active: true, id: { in: scope.branchIds } }, select: { id: true, code: true, nameAr: true, nameEn: true }, orderBy: { code: "asc" } });
}

/** People the actor may pick as a manager / subject (directory projection, active only). */
export async function pickList(actor: HrActor) {
  assertCan(actor, "directory");
  const scope = await resolveScope(actor);
  return prisma.hrEmployee.findMany({ where: { AND: [scopeWhere(scope), { status: { not: "SEPARATED" } }] }, select: { id: true, employeeNo: true, fullNameAr: true, jobTitle: true }, orderBy: { employeeNo: "asc" } });
}

export async function auditTrail(actor: HrActor, id: string) {
  assertCan(actor, "people_manage");
  const scope = await resolveScope(actor);
  await personInScope(prisma, scope, id);
  const rows = await prisma.hrAuditLog.findMany({ where: { employeeId: id }, orderBy: { createdAt: "desc" }, take: 200 });
  const actors = await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId).filter(Boolean) as string[])] } }, select: { id: true, name: true } });
  const name = new Map(actors.map((a) => [a.id, a.name]));
  // Private-data audit rows carry field names only; documents carry no bytes.
  return rows.map((r) => ({ id: r.id, action: r.action, entityType: r.entityType, reason: r.reason, actor: r.actorId ? name.get(r.actorId) ?? r.actorId : null, at: r.createdAt, after: r.entityType === "HrEmployeePrivate" ? r.after : null }));
}

export { readJson };
