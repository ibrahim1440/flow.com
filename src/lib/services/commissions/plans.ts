import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { Decimal, validatePlanRules, findOverlappingAssignment, parseFiniteDecimal, type PlanRules } from "./engine";
import { parseComponents, type Components } from "./builder";
import { isSimpleMode } from "@/lib/simple-mode";

type Tx = PrismaNS.TransactionClient;

/**
 * Administering commission plans: creating them, versioning them, and deciding who is on
 * which one.
 *
 * ── The rule that shapes this file ──
 * A plan version is IMMUTABLE once anything has accrued against it. Editing a live rule in
 * place would restate commissions people have already been told they earned, and the first
 * anyone would know is a payslip disagreeing with last month's. So an edit is a new
 * version with its own effective date, and the old one keeps governing the money that was
 * earned under it.
 *
 * ── The other rule ──
 * Nobody sets their own rate. `manage_plans` gates the endpoints, and this service refuses
 * an assignment whose employee is the actor regardless of privilege, because the privilege
 * may legitimately sit with a sales manager who is themselves on a plan.
 */

export type TierInput = {
  fromAmount: Decimal;
  toAmount: Decimal | null;
  ratePercent: Decimal;
};

export type VersionInput = {
  baseRatePercent: Decimal;
  tierMode: "INCREMENTAL" | "RETROACTIVE";
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  tiers: TierInput[];
  /**
   * Commission plan builder: a COMPONENTS version (order sequence, target bonus, over-target
   * incentive) instead of the tiered rules. Null / absent = the tiered version exactly as before.
   */
  components?: Components | null;
};

/**
 * Request JSON → a validated version input. Shared by plan creation, a new version and the edit
 * of a not-yet-used version. Amounts and rates arrive as strings and become Decimals here; NaN,
 * Infinity and hex are refused (parseFiniteDecimal). With `components`, the tiered fields are
 * ignored: a COMPONENTS version has base rate 0 and no tiers.
 */
export function parseVersionBody(b: Record<string, unknown>): VersionInput {
  const dec = (v: unknown, field: string): Decimal => {
    const d = parseFiniteDecimal(v);
    if (!d) throw { _appCode: 400, message: `${field} is not a number.` };
    return d;
  };
  const effectiveFrom = new Date(String(b.effectiveFrom ?? ""));
  if (Number.isNaN(effectiveFrom.getTime())) {
    throw { _appCode: 400, message: "effectiveFrom is required and must be a date." };
  }
  let effectiveTo: Date | null = null;
  if (b.effectiveTo) {
    effectiveTo = new Date(String(b.effectiveTo));
    if (Number.isNaN(effectiveTo.getTime())) throw { _appCode: 400, message: "effectiveTo is not a date." };
  }
  const currency = typeof b.currency === "string" ? b.currency : "SAR";

  if (b.components !== undefined && b.components !== null) {
    const { components, problems } = parseComponents(b.components);
    if (!components) {
      throw { _appCode: 400, message: problems[0].messageAr, errorEn: problems[0].message, problems };
    }
    return { baseRatePercent: new Decimal(0), tierMode: "INCREMENTAL", currency, effectiveFrom, effectiveTo, tiers: [], components };
  }

  const rawTiers = Array.isArray(b.tiers) ? b.tiers : [];
  if (rawTiers.length > 20) throw { _appCode: 400, message: "A plan version may have at most 20 tiers." };
  const tiers: TierInput[] = rawTiers.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    return {
      fromAmount: dec(t.fromAmount ?? "0", `Tier ${i + 1} start`),
      toAmount:
        t.toAmount === null || t.toAmount === undefined || t.toAmount === ""
          ? null
          : dec(t.toAmount, `Tier ${i + 1} end`),
      ratePercent: dec(t.ratePercent ?? "0", `Tier ${i + 1} rate`),
    };
  });
  return {
    baseRatePercent: dec(b.baseRatePercent ?? "0", "The base rate"),
    tierMode: b.tierMode === "RETROACTIVE" ? "RETROACTIVE" : "INCREMENTAL",
    currency,
    effectiveFrom,
    effectiveTo,
    tiers,
  };
}

const componentsJson = (c: Components | null | undefined) =>
  c ? (JSON.parse(JSON.stringify(c)) as PrismaNS.InputJsonValue) : undefined;

function rulesOf(input: VersionInput): PlanRules {
  return {
    basis: "NET_COLLECTION",
    tierMode: input.tierMode,
    baseRatePercent: input.baseRatePercent,
    currency: input.currency,
    tiers: input.tiers,
  };
}

/**
 * Validate a proposed version and refuse it as a whole if anything is wrong.
 *
 * All problems are reported, not just the first: someone entering a five-band tier table
 * should be told about every overlapping band in one pass rather than discovering them one
 * save at a time.
 */
export function assertVersionValid(input: VersionInput): void {
  // A COMPONENTS version has no base rate or tiers to check; its components were validated when
  // parsed. Currency and dates are checked by the same rules as every version.
  const problems = validatePlanRules(input.components ? { ...rulesOf(input), baseRatePercent: new Decimal(0), tiers: [] } : rulesOf(input));
  if (input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) {
    problems.push({ code: "PERIOD_EMPTY", message: "The end date must be after the start date." });
  }
  if (problems.length > 0) {
    throw { _appCode: 400, message: problems[0].message, problems };
  }
}

/** Create a plan with its first version, in one step — a plan with no rules pays nothing. */
export async function createPlan(
  tx: Tx,
  input: {
    code: string;
    name: string;
    nameAr?: string | null;
    description?: string | null;
    templateKey?: string | null;
    version: VersionInput;
    actorId: string;
  },
): Promise<{ planId: string; planVersionId: string; version: number }> {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
    throw {
      _appCode: 400,
      message: "A plan code is 2–32 characters of letters, digits, hyphen or underscore.",
    };
  }
  if (input.name.trim().length < 2) {
    throw { _appCode: 400, message: "A plan needs a name." };
  }
  assertVersionValid(input.version);

  const plan = await tx.commissionPlan.create({
    data: {
      code,
      name: input.name.trim(),
      nameAr: input.nameAr?.trim() || null,
      description: input.description?.trim() || null,
      templateKey: input.templateKey ?? null,
      createdById: input.actorId,
    },
    select: { id: true },
  });

  const version = await tx.commissionPlanVersion.create({
    data: {
      planId: plan.id,
      version: 1,
      basis: "NET_COLLECTION",
      tierMode: input.version.tierMode,
      baseRatePercent: input.version.baseRatePercent,
      currency: input.version.currency,
      effectiveFrom: input.version.effectiveFrom,
      effectiveTo: input.version.effectiveTo,
      components: componentsJson(input.version.components),
      createdById: input.actorId,
      tiers: {
        create: input.version.tiers.map((t, i) => ({
          fromAmount: t.fromAmount,
          toAmount: t.toAmount,
          ratePercent: t.ratePercent,
          position: i,
        })),
      },
    },
    select: { id: true, version: true },
  });

  return { planId: plan.id, planVersionId: version.id, version: version.version };
}

/**
 * Add a new version to an existing plan.
 *
 * The previous version is closed at the new one's start date if it was open-ended, so there
 * is never a moment with two live versions of one plan — `selectPlanVersion` would then have
 * to guess, and guessing is how somebody gets paid under a rule that was replaced.
 */
export async function addPlanVersion(
  tx: Tx,
  input: { planId: string; version: VersionInput; actorId: string; moveAssignees?: boolean },
): Promise<{ planVersionId: string; version: number; closedPrevious: boolean; movedAssignees: number }> {
  assertVersionValid(input.version);

  const plan = await tx.commissionPlan.findUnique({
    where: { id: input.planId },
    select: { id: true },
  });
  if (!plan) throw { _appCode: 404, message: "Plan not found." };

  const latest = await tx.commissionPlanVersion.findFirst({
    where: { planId: input.planId },
    orderBy: { version: "desc" },
    select: { id: true, version: true, effectiveFrom: true, effectiveTo: true },
  });

  if (latest && input.version.effectiveFrom.getTime() <= latest.effectiveFrom.getTime()) {
    throw {
      _appCode: 409,
      message:
        "A new version must start after the current one. Backdating a rule change would " +
        "restate commission that has already been earned.",
    };
  }

  let closedPrevious = false;
  if (latest && latest.effectiveTo === null) {
    await tx.commissionPlanVersion.update({
      where: { id: latest.id },
      data: { effectiveTo: input.version.effectiveFrom },
    });
    closedPrevious = true;
  }

  const created = await tx.commissionPlanVersion.create({
    data: {
      planId: input.planId,
      version: (latest?.version ?? 0) + 1,
      basis: "NET_COLLECTION",
      tierMode: input.version.tierMode,
      baseRatePercent: input.version.baseRatePercent,
      currency: input.version.currency,
      effectiveFrom: input.version.effectiveFrom,
      effectiveTo: input.version.effectiveTo,
      components: componentsJson(input.version.components),
      createdById: input.actorId,
      tiers: {
        create: input.version.tiers.map((t, i) => ({
          fromAmount: t.fromAmount,
          toAmount: t.toAmount,
          ratePercent: t.ratePercent,
          position: i,
        })),
      },
    },
    select: { id: true, version: true },
  });

  // Optionally carry the people on the previous version over to this one from its start date:
  // each open assignment to an earlier version of this plan ends where the new version starts
  // and a new assignment begins there. The past keeps the version it was computed with.
  let movedAssignees = 0;
  if (input.moveAssignees && latest) {
    const from = input.version.effectiveFrom;
    const open = await tx.commissionAssignment.findMany({
      where: {
        planId: input.planId,
        planVersionId: { not: created.id },
        effectiveFrom: { lt: from },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: from } }],
      },
      select: { id: true, employeeId: true, effectiveTo: true, employee: { select: { active: true } } },
    });
    for (const a of open) {
      if (!a.employee.active) continue;
      // SIMPLE MODE: a single owner may act on their own record.
      if (!isSimpleMode() && a.employeeId === input.actorId) continue;
      await tx.commissionAssignment.update({ where: { id: a.id }, data: { effectiveTo: from } });
      await tx.commissionAssignment.create({
        data: { employeeId: a.employeeId, planId: input.planId, planVersionId: created.id, effectiveFrom: from, effectiveTo: a.effectiveTo, createdById: input.actorId },
      });
      movedAssignees++;
    }
  }

  return { planVersionId: created.id, version: created.version, closedPrevious, movedAssignees };
}

/**
 * Edit a COMPONENTS version in place — only while nothing at all hangs off it: no assignment, no
 * accrual, no ledger movement, no monthly result and no decision. Until then it has governed
 * nobody's pay and an edit restates nothing (a freshly made template plan is the case this is
 * for). From the first assignment on, a change is a new version, as for every plan.
 */
export async function updateUnusedVersion(
  tx: Tx,
  input: { planId: string; planVersionId: string; version: VersionInput; actorId: string },
): Promise<{ planVersionId: string }> {
  if (!input.version.components) {
    throw { _appCode: 400, message: "Only a COMPONENTS version can be edited in place; change a tiered plan with a new version." };
  }
  assertVersionValid(input.version);
  const v = await tx.commissionPlanVersion.findUnique({
    where: { id: input.planVersionId },
    select: {
      id: true, planId: true, components: true,
      _count: { select: { accruals: true, assignments: true, ledgerEntries: true, periodResults: true, bonusDecisions: true } },
    },
  });
  if (!v || v.planId !== input.planId) throw { _appCode: 404, message: "Plan version not found." };
  if (v.components === null) throw { _appCode: 400, message: "This is a tiered version; change it with a new version." };
  const c = v._count;
  if (c.accruals + c.assignments + c.ledgerEntries + c.periodResults + c.bonusDecisions > 0) {
    throw {
      _appCode: 409,
      message: "هذه النسخة مُسندة أو استُحقّت تحتها عمولة؛ التعديل يكون بإصدار جديد بتاريخ سريان.",
      errorEn: "This version is assigned or has commission under it; change it with a new version and an effective date.",
    };
  }
  const prev = await tx.commissionPlanVersion.findFirst({
    where: { planId: input.planId, id: { not: v.id }, effectiveFrom: { gte: input.version.effectiveFrom } },
    select: { id: true },
  });
  if (prev) throw { _appCode: 409, message: "A version cannot start on or before an earlier version of the same plan." };
  await tx.commissionPlanVersion.update({
    where: { id: v.id },
    data: {
      components: componentsJson(input.version.components),
      currency: input.version.currency,
      effectiveFrom: input.version.effectiveFrom,
      effectiveTo: input.version.effectiveTo,
    },
  });
  return { planVersionId: v.id };
}

/**
 * Put an employee on a plan version for a period.
 *
 * Two refusals worth naming:
 *
 *  - **Overlap.** Two live assignments for one person have no defined answer; the accrual
 *    service picks one by latest start, which would silently make the other rule fiction.
 *  - **Self-assignment.** Refused whatever the caller's privilege. `manage_plans` can
 *    reasonably belong to a sales manager, and a sales manager is usually on a plan too.
 */
export async function assignPlan(
  tx: Tx,
  input: {
    employeeId: string;
    planVersionId: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    actorId: string;
  },
): Promise<{ assignmentId: string }> {
  // SIMPLE MODE: a single owner may decide their own request / act on their own record.
  if (!isSimpleMode() && (input.employeeId === input.actorId)) {
    throw {
      _appCode: 403,
      message:
        "You cannot put yourself on a commission plan. Ask another administrator to do it, " +
        "so no one sets their own rate.",
    };
  }
  if (input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) {
    throw { _appCode: 400, message: "The end date must be after the start date." };
  }

  const employee = await tx.employee.findUnique({
    where: { id: input.employeeId },
    select: { id: true, active: true },
  });
  if (!employee) throw { _appCode: 404, message: "Employee not found." };
  if (!employee.active) {
    throw { _appCode: 400, message: "An inactive employee cannot be assigned a commission plan." };
  }

  const version = await tx.commissionPlanVersion.findUnique({
    where: { id: input.planVersionId },
    select: { id: true, planId: true, effectiveFrom: true, effectiveTo: true },
  });
  if (!version) throw { _appCode: 404, message: "Plan version not found." };

  // An assignment outside the version's own validity would select nothing at accrual time
  // and read to the operator as "assigned but never paid".
  if (input.effectiveFrom.getTime() < version.effectiveFrom.getTime()) {
    throw {
      _appCode: 400,
      message: "The assignment cannot start before the plan version it points at.",
    };
  }
  if (version.effectiveTo && input.effectiveFrom.getTime() >= version.effectiveTo.getTime()) {
    throw { _appCode: 400, message: "That plan version had already ended by this start date." };
  }

  const existing = await tx.commissionAssignment.findMany({
    where: { employeeId: input.employeeId },
    select: { id: true, effectiveFrom: true, effectiveTo: true, planVersion: { select: { version: true, plan: { select: { code: true } } } } },
  });
  const clash = findOverlappingAssignment(existing, {
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
  });
  if (clash) {
    throw {
      _appCode: 409,
      message:
        `This overlaps an existing assignment to ${clash.planVersion.plan.code} v${clash.planVersion.version} ` +
        `starting ${clash.effectiveFrom.toISOString().slice(0, 10)}. End that one first.`,
    };
  }

  const created = await tx.commissionAssignment.create({
    data: {
      employeeId: input.employeeId,
      planId: version.planId,
      planVersionId: version.id,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      createdById: input.actorId,
    },
    select: { id: true },
  });

  return { assignmentId: created.id };
}

/**
 * End an open assignment.
 *
 * Deleting it is not offered. Money has accrued under it and the accrual rows point at the
 * plan version through it; removing the row would leave a payslip nobody could explain.
 */
export async function endAssignment(
  tx: Tx,
  input: { assignmentId: string; effectiveTo: Date; actorId: string },
): Promise<{ assignmentId: string }> {
  const a = await tx.commissionAssignment.findUnique({
    where: { id: input.assignmentId },
    select: { id: true, employeeId: true, effectiveFrom: true, effectiveTo: true },
  });
  if (!a) throw { _appCode: 404, message: "Assignment not found." };
  // SIMPLE MODE: a single owner may decide their own request / act on their own record.
  if (!isSimpleMode() && (a.employeeId === input.actorId)) {
    throw { _appCode: 403, message: "You cannot change your own commission assignment." };
  }
  if (input.effectiveTo.getTime() <= a.effectiveFrom.getTime()) {
    throw { _appCode: 400, message: "The end date must be after the assignment started." };
  }

  await tx.commissionAssignment.update({
    where: { id: input.assignmentId },
    data: { effectiveTo: input.effectiveTo },
  });
  return { assignmentId: a.id };
}

/** Whether anything has accrued against a version — which is what freezes it. */
export async function versionIsInUse(tx: Tx, planVersionId: string): Promise<boolean> {
  const n = await tx.commissionAccrual.count({ where: { planVersionId } });
  return n > 0;
}
