import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { Decimal, validatePlanRules, findOverlappingAssignment, type PlanRules } from "./engine";

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
};

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
  const problems = validatePlanRules(rulesOf(input));
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
  input: { planId: string; version: VersionInput; actorId: string },
): Promise<{ planVersionId: string; version: number; closedPrevious: boolean }> {
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

  return { planVersionId: created.id, version: created.version, closedPrevious };
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
  if (input.employeeId === input.actorId) {
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
  if (a.employeeId === input.actorId) {
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
