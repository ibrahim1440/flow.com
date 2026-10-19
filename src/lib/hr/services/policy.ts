// Native HR — payroll policy, contribution rules, account map and settings.
//
// Nothing here ships with an approved value. A policy is created as DRAFT by one person and
// activated by ANOTHER (DB CHECK as well). Only the drafter changes a DRAFT (values or
// contribution rules); activation names the exact content it approves (`fingerprint`) and is
// refused if the draft changed since. ACTIVE / RETIRED versions never change (service and DB
// triggers, migration 20261009120000_hr_policy_immutable). No rule is seeded. A draft still
// marked as a proposal is never activated, and payroll never runs under a proposal (F2).
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, type Db, TX, assertCan, audit, bool, oneOf, reqText, text, mapDbError } from "../core";
import { assertPayrollLive } from "../payroll-lock";
import { dayString, isDay, parseDay } from "../dates";
import { assertVerifiedActor } from "../identity";
import { assertTestPath } from "../test-path";
import { deductionPolicyContent, deductionPolicyFields, deductionPolicyGaps } from "../deductions";
import { isSimpleMode } from "@/lib/simple-mode";

const COMPONENTS = ["BASIC", "HOUSING", "TRANSPORT", "OTHER"] as const;
export const ACCOUNT_KEYS = [
  "SALARY_EXPENSE",
  "ALLOWANCE_EXPENSE",
  "OVERTIME_EXPENSE",
  "COMMISSION_EXPENSE",
  "EMPLOYER_CONTRIB_EXPENSE",
  "SALARIES_PAYABLE",
  "CONTRIB_PAYABLE",
  "OTHER_DEDUCTIONS_PAYABLE",
  "ADVANCES_RECEIVABLE",
  "PAYROLL_CASH",
  // P-2 finding 8 (final settlements): the account-mapping hook. Which accounts these are is the
  // accountant's decision; until each is mapped (second-person approved), system posting refuses.
  "EOS_PROVISION",
  "EOS_EXPENSE",
  "LEAVE_PROVISION",
  "LEAVE_ENCASHMENT_EXPENSE",
  "FINAL_SETTLEMENT_PAYABLE",
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];

const D = (v: unknown, field: string) => {
  try {
    return new Prisma.Decimal(String(v));
  } catch {
    throw new HrError(`${field} must be a number.`, 400);
  }
};

/** The ACTIVE policy in force on a date: the latest effectiveFrom on or before it. */
export async function activePolicyFor(db: Db, on: Date) {
  return db.hrPayrollPolicy.findFirst({ where: { status: "ACTIVE", effectiveFrom: { lte: on } }, orderBy: { effectiveFrom: "desc" }, include: { contributionRules: true } });
}

type PolicyWithRules = Prisma.HrPayrollPolicyGetPayload<{ include: { contributionRules: true } }>;

/**
 * A digest of everything a reviewer approves: the values and the contribution rules (not who or
 * when). The approver's activation must name it, so an edit between review and activation is
 * refused instead of activating values nobody else checked.
 */
export function policyFingerprint(p: PolicyWithRules): string {
  const content = {
    effectiveFrom: dayString(p.effectiveFrom), dayBasis: p.dayBasis, standardDailyHours: p.standardDailyHours.toString(), overtimeMultiplier: p.overtimeMultiplier.toString(),
    maxDeductionPercent: p.maxDeductionPercent.toString(), unpaidLeaveComponents: [...p.unpaidLeaveComponents].sort(), overtimeComponents: [...p.overtimeComponents].sort(),
    timezone: p.timezone, weekendDays: [...p.weekendDays].sort(), isProposal: p.isProposal, notes: p.notes ?? null,
    // P-2 findings 2/3: the deduction categories are approved with the version.
    deductions: deductionPolicyContent(p),
    rules: [...p.contributionRules].sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.code, r.nameAr, r.employeeRatePercent.toString(), r.employerRatePercent.toString(), [...r.baseComponents].sort(), r.appliesToGroup, r.monthlyBaseCap?.toString() ?? null, r.sourceNote]),
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 24);
}

export function policyDto(p: PolicyWithRules) {
  return {
    fingerprint: policyFingerprint(p),
    id: p.id, version: p.version, effectiveFrom: dayString(p.effectiveFrom), status: p.status, dayBasis: p.dayBasis,
    standardDailyHours: p.standardDailyHours.toString(), overtimeMultiplier: p.overtimeMultiplier.toString(), maxDeductionPercent: p.maxDeductionPercent.toString(),
    unpaidLeaveComponents: p.unpaidLeaveComponents, overtimeComponents: p.overtimeComponents, timezone: p.timezone, weekendDays: p.weekendDays,
    isProposal: p.isProposal, notes: p.notes, ...deductionPolicyContent(p), deductionGaps: deductionPolicyGaps(p), createdBy: p.createdBy, activatedBy: p.activatedBy, activatedAt: p.activatedAt,
    contributionRules: p.contributionRules.map((r) => ({ id: r.id, code: r.code, nameAr: r.nameAr, employeeRatePercent: r.employeeRatePercent.toString(), employerRatePercent: r.employerRatePercent.toString(), baseComponents: r.baseComponents, appliesToGroup: r.appliesToGroup, monthlyBaseCap: r.monthlyBaseCap?.toFixed(2) ?? null, sourceNote: r.sourceNote })),
  };
}

export async function listPolicies() {
  const rows = await prisma.hrPayrollPolicy.findMany({ include: { contributionRules: true }, orderBy: { version: "desc" } });
  const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.activatedBy]).filter(Boolean) as string[])];
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  return rows.map((r) => ({ ...policyDto(r), createdByName: names.get(r.createdBy) ?? null, activatedByName: r.activatedBy ? names.get(r.activatedBy) ?? null : null }));
}

function components(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new HrError(`${field} must list at least one of ${COMPONENTS.join(", ")}.`, 400);
  for (const c of v) if (!(COMPONENTS as readonly string[]).includes(c)) throw new HrError(`${field}: unknown component ${String(c)}.`, 400);
  return [...new Set(v as string[])];
}

/** The editable values of a policy version, validated the same way for a new draft and an edit. */
function policyFields(b: Record<string, unknown>) {
  if (!isDay(b.effectiveFrom)) throw new HrError("effectiveFrom must be a date.", 400);
  const tz = reqText(b.timezone ?? "Asia/Riyadh", "timezone", 60);
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new HrError("timezone is not a valid IANA time zone.", 400);
  }
  const weekend = Array.isArray(b.weekendDays) ? (b.weekendDays as unknown[]).map(Number) : null;
  if (!weekend || weekend.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HrError("weekendDays must be a list of 0–6 (0 = Sunday).", 400);
  return {
    effectiveFrom: parseDay(b.effectiveFrom as string),
    dayBasis: oneOf(b.dayBasis, "dayBasis", ["CALENDAR_DAYS", "FIXED_30"] as const),
    standardDailyHours: D(b.standardDailyHours, "standardDailyHours"),
    overtimeMultiplier: D(b.overtimeMultiplier, "overtimeMultiplier"),
    maxDeductionPercent: D(b.maxDeductionPercent, "maxDeductionPercent"),
    unpaidLeaveComponents: components(b.unpaidLeaveComponents, "unpaidLeaveComponents"),
    overtimeComponents: components(b.overtimeComponents, "overtimeComponents"),
    timezone: tz,
    weekendDays: [...new Set(weekend)],
    isProposal: bool(b.isProposal, true),
    notes: text(b.notes, "notes", { max: 1000 }),
    ...deductionPolicyFields(b),
  };
}

export async function createPolicy(actor: HrActor, b: Record<string, unknown>) {
  assertCan(actor, "policy_manage");
  await assertVerifiedActor(actor, "POLICY_MANAGE");
  const fields = policyFields(b);
  return prisma.$transaction(async (tx) => {
    const last = await tx.hrPayrollPolicy.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    try {
      const p = await tx.hrPayrollPolicy.create({
        data: { version: (last?.version ?? 0) + 1, ...fields, createdBy: actor.id },
        include: { contributionRules: true },
      });
      await audit(tx, { action: "POLICY_CREATE", entityType: "HrPayrollPolicy", entityId: p.id, after: policyDto(p), actorId: actor.id });
      return policyDto(p);
    } catch (e) {
      mapDbError(e);
    }
  }, TX);
}

/**
 * Edit a DRAFT version. Approved (ACTIVE) and RETIRED versions never change: the update is
 * conditional on status = DRAFT in the same statement, so a draft activated meanwhile is not
 * touched. Only the person who drafted it may edit it — otherwise the second manager who
 * activates it could have written values nobody else checked (four-eyes).
 */
export async function updateDraftPolicy(actor: HrActor, id: string, b: Record<string, unknown>) {
  assertCan(actor, "policy_manage");
  await assertVerifiedActor(actor, "POLICY_MANAGE");
  const fields = policyFields(b);
  return prisma.$transaction(async (tx) => {
    const before = await tx.hrPayrollPolicy.findUnique({ where: { id }, include: { contributionRules: true } });
    if (!before) throw new HrError("Policy not found", 404);
    const n = await tx.hrPayrollPolicy.updateMany({ where: { id, status: "DRAFT", createdBy: actor.id }, data: fields });
    if (n.count === 0) {
      const now = await tx.hrPayrollPolicy.findUniqueOrThrow({ where: { id } });
      if (now.status !== "DRAFT") throw new HrError(`Only a DRAFT policy can be edited; this one is ${now.status} and never changes. Create a new draft instead.`, 409, "POLICY_LOCKED");
      throw new HrError("Only the person who drafted this policy can edit it.", 403, "NOT_DRAFTER");
    }
    const after = await tx.hrPayrollPolicy.findUniqueOrThrow({ where: { id }, include: { contributionRules: true } });
    await audit(tx, { action: "POLICY_UPDATE", entityType: "HrPayrollPolicy", entityId: id, before: policyDto(before), after: policyDto(after), actorId: actor.id });
    return policyDto(after);
  }, TX);
}

/**
 * Activate a DRAFT. `expected` is the fingerprint of the version the approver reviewed; the HTTP
 * route always passes it (null when absent → refused). The row is locked first, so a concurrent
 * edit either lands before (fingerprint mismatch → 409) or after (no longer a DRAFT → 409).
 * In-process callers (fixture, tests) may omit it ONLY on a marked disposable, non-production
 * database (../test-path); anywhere else the omission is refused and audited.
 */
export async function activatePolicy(actor: HrActor, id: string, expected?: string | null) {
  assertCan(actor, "policy_manage");
  await assertVerifiedActor(actor, "POLICY_MANAGE");
  // Phase 1 lock: policies may be drafted, never activated, while payroll is locked.
  await assertPayrollLive("POLICY_ACTIVATE");
  return prisma.$transaction(async (tx) => {
    await assertPayrollLive("POLICY_ACTIVATE", tx); // F8: again inside the transaction
    await tx.$queryRaw`SELECT 1 FROM "HrPayrollPolicy" WHERE "id" = ${id} FOR UPDATE`;
    const p = await tx.hrPayrollPolicy.findUnique({ where: { id }, include: { contributionRules: true } });
    if (!p) throw new HrError("Policy not found", 404);
    if (p.status !== "DRAFT") throw new HrError(`Only a DRAFT policy can be activated (this one is ${p.status}).`, 409);
    // SIMPLE MODE: a single owner may decide their own request / act on their own record.
    if (!isSimpleMode() && (p.createdBy === actor.id)) throw new HrError("The person who drafted a policy cannot activate it. Another policy manager must.", 403, "SELF_ACTION");
    // P-2 / E-1: omitting the fingerprint is an in-process test/fixture path only (./test-path).
    if (expected === undefined) await assertTestPath(tx, "Activation without a reviewed fingerprint", actor.id);
    else {
      if (!expected) throw new HrError("expected must name the version you reviewed (its fingerprint).", 400);
      if (expected !== policyFingerprint(p)) throw new HrError("This draft changed after you reviewed it. Reload it and review it again.", 409, "POLICY_CHANGED");
    }
    // F2 / finding 10: proposed values never take effect. The drafter clears the proposal mark
    // once the accountant has confirmed the values (an audited draft edit); only then may a
    // second manager activate it.
    if (p.isProposal) throw new HrError("This draft is still marked as a proposal, so it cannot take effect. Its drafter must confirm the values (clear the proposal mark) before another manager activates it.", 409, "POLICY_PROPOSAL");
    // Review P2-B6: a version without the accountant-approved deduction settings never takes effect
    // (payroll could not run under it anyway, corrections included). Nothing is defaulted.
    const gaps = deductionPolicyGaps(p);
    if (gaps.length) throw new HrError(`This draft has no accountant-approved deduction settings (${gaps.join(", ")}), so it cannot take effect: payroll — regular or correction runs — refuses a version without them. Its drafter sets them from the accountant's decision first.`, 409, "DEDUCTION_POLICY_UNSET");
    const same = await tx.hrPayrollPolicy.findFirst({ where: { status: "ACTIVE", effectiveFrom: p.effectiveFrom } });
    if (same) await tx.hrPayrollPolicy.update({ where: { id: same.id }, data: { status: "RETIRED" } });
    try {
      const after = await tx.hrPayrollPolicy.update({ where: { id }, data: { status: "ACTIVE", activatedBy: actor.id, activatedAt: new Date() }, include: { contributionRules: true } });
      await audit(tx, { action: "POLICY_ACTIVATE", entityType: "HrPayrollPolicy", entityId: id, before: same ? { retired: same.id } : null, after: policyDto(after), actorId: actor.id });
      return policyDto(after);
    } catch (e) {
      mapDbError(e);
    }
  }, TX);
}

export async function addContributionRule(actor: HrActor, policyId: string, b: Record<string, unknown>) {
  assertCan(actor, "policy_manage");
  await assertVerifiedActor(actor, "POLICY_MANAGE");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "HrPayrollPolicy" WHERE "id" = ${policyId} FOR UPDATE`;
    const p = await tx.hrPayrollPolicy.findUnique({ where: { id: policyId } });
    if (!p) throw new HrError("Policy not found", 404);
    if (p.status !== "DRAFT") throw new HrError("Rules are added to a DRAFT policy; an active policy is never changed.", 409);
    // Same four-eyes reasoning as value edits: a manager who adds a rule to someone else's draft
    // could then activate it with nobody else having checked the rule.
    if (p.createdBy !== actor.id) throw new HrError("Only the person who drafted this policy can edit it.", 403, "NOT_DRAFTER");
    return addRuleIn(tx, actor, policyId, b);
  }, TX);
}

async function addRuleIn(tx: Prisma.TransactionClient, actor: HrActor, policyId: string, b: Record<string, unknown>) {
  try {
    const r = await tx.hrContributionRule.create({
      data: {
        policyId,
        code: reqText(b.code, "code", 20).toUpperCase(),
        nameAr: reqText(b.nameAr, "nameAr", 80),
        employeeRatePercent: D(b.employeeRatePercent, "employeeRatePercent"),
        employerRatePercent: D(b.employerRatePercent, "employerRatePercent"),
        baseComponents: components(b.baseComponents, "baseComponents"),
        appliesToGroup: reqText(b.appliesToGroup, "appliesToGroup", 40),
        monthlyBaseCap: b.monthlyBaseCap === undefined || b.monthlyBaseCap === null || b.monthlyBaseCap === "" ? null : D(b.monthlyBaseCap, "monthlyBaseCap"),
        sourceNote: reqText(b.sourceNote, "sourceNote", 500, 10),
      },
    });
    await audit(tx, { action: "CONTRIBUTION_RULE_ADD", entityType: "HrContributionRule", entityId: r.id, after: r, actorId: actor.id });
    return r;
  } catch (e) {
    mapDbError(e);
  }
}

// ── Account map ────────────────────────────────────────────────────────────────────

export async function accountMap() {
  const [rows, accounts] = await Promise.all([
    prisma.hrAccountMap.findMany({ include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true, isActive: true, allowPosting: true } } } }),
    prisma.account.findMany({ where: { isActive: true, allowPosting: true, children: { none: {} } }, select: { id: true, code: true, nameAr: true, nameEn: true, type: true }, orderBy: { code: "asc" } }),
  ]);
  const by = new Map(rows.map((r) => [r.key, r.account]));
  return { keys: ACCOUNT_KEYS.map((k) => ({ key: k, account: by.get(k) ?? null })), postable: accounts };
}

// Account map changes go through ./config-change (request → independent approval → apply).

export async function settings(db: Db = prisma) {
  const row = await db.hrSettings.findUnique({ where: { id: "singleton" } });
  if (row) return row;
  // Re-review N2 (P3): created idempotently. Two first readers at once no longer race on the
  // primary key (a unique violation that `guarded()` misreported as another conflict).
  await db.$executeRaw`INSERT INTO "HrSettings" ("id", "updatedAt") VALUES ('singleton', now()) ON CONFLICT ("id") DO NOTHING`;
  return db.hrSettings.findUniqueOrThrow({ where: { id: "singleton" } });
}

// HR accounting on/off goes through ./config-change (request → independent approval → apply).
