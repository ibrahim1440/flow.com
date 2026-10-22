import type { Prisma } from "@/generated/prisma/client";
import { isAssignedOperator } from "@/lib/services/roaster-operators";

/**
 * Roaster controls at «تسجيل دفعة» (owner decision D5, ROASTERS.md §5.12; Workstations W1).
 *
 * Applied by POST /api/roasting-batches — the ERP roast sheet and the roasting station both
 * record through it — and only when the request names a roaster (`roasterId`). With no roaster
 * chosen, or none configured (production had 0 when this shipped), a roast records exactly as
 * before: nothing here runs.
 *
 *   1. The roaster must exist and be in service (not RETIRED).
 *   2. Operator (owner change, 22 Oct 2026): an employee who is not an assigned RoasterOperator of
 *      the roaster is refused (403 ROASTER_OPERATOR_REQUIRED). An admin is never blocked; the
 *      bypass is written to RoasterControlLog (kind OPERATOR_ADMIN_BYPASS), as the SIMPLE MODE
 *      bypasses are kept visible elsewhere (`simpleModeBypass`).
 *   3. Green above the manufacturer capacity (nominalCapacityKg) is always refused: 409
 *      ROASTER_CAPACITY, no override, no reason, no permission lets it through.
 *   4. Green outside the configured min–max (but within nominal) needs an explicit acknowledgement
 *      (`ack: true`), else 422 ACK_REQUIRED. The acknowledgement is logged (CAPACITY_ACK): who,
 *      when, the values and the roaster.
 *
 * The verdicts are pure (unit-tested); the database part reads the roaster and its operators and
 * writes the log rows in the caller's transaction, after the batch exists.
 */

export type RoasterLimits = { nominalCapacityKg: number; minBatchKg: number; maxBatchKg: number };

export type CapacityVerdict =
  | { kind: "ok" }
  | { kind: "over_nominal"; nominalKg: number }
  | { kind: "outside_range"; direction: "BELOW_MIN" | "ABOVE_MAX"; minKg: number; maxKg: number };

const r3 = (n: number) => +n.toFixed(3);

/** Where a green charge sits against the roaster's limits. Gram precision, as everywhere else. */
export function capacityVerdict(limits: RoasterLimits, greenKg: number): CapacityVerdict {
  const g = r3(greenKg);
  const nominal = r3(limits.nominalCapacityKg);
  if (g > nominal) return { kind: "over_nominal", nominalKg: nominal };
  const min = r3(limits.minBatchKg), max = r3(limits.maxBatchKg);
  if (g < min) return { kind: "outside_range", direction: "BELOW_MIN", minKg: min, maxKg: max };
  if (g > max) return { kind: "outside_range", direction: "ABOVE_MAX", minKg: min, maxKg: max };
  return { kind: "ok" };
}

export type OperatorVerdict = { kind: "assigned" } | { kind: "admin_bypass" } | { kind: "refused" };

/** Owner change 22 Oct 2026: only assigned operators record on a roaster; an admin is never blocked. */
export function operatorVerdict(role: string, assigned: boolean): OperatorVerdict {
  if (assigned) return { kind: "assigned" };
  if (role === "admin") return { kind: "admin_bypass" };
  return { kind: "refused" };
}

const kgAr = (n: number) => n.toFixed(2);

/** The refusals, in the shape handleDomainError turns into a response (Arabic first, code kept). */
export const ROASTER_OPERATOR_REQUIRED_AR = "أنت غير مربوط بهذه الحمّاصة. اطلب من المسؤول ربطك بها من إعدادات الحمّاصات.";
export const ROASTER_OPERATOR_REQUIRED_EN = "You are not assigned to this roaster. Ask the administrator to assign you in the roaster settings.";

export function operatorRefusal(roasterName: string) {
  return {
    _appCode: 403,
    code: "ROASTER_OPERATOR_REQUIRED",
    message: ROASTER_OPERATOR_REQUIRED_AR,
    errorEn: ROASTER_OPERATOR_REQUIRED_EN,
    errorAr: ROASTER_OPERATOR_REQUIRED_AR,
    roasterName,
  };
}

export function capacityRefusal(roasterName: string, greenKg: number, nominalKg: number) {
  return {
    _appCode: 409,
    code: "ROASTER_CAPACITY",
    message: `السعة القصوى لـ ${roasterName} ${kgAr(nominalKg)} كغ أخضر حسب المصنّع، فلا يمكن تسجيل ${kgAr(greenKg)} كغ. لم يُسجَّل شيء.`,
    errorEn: `${roasterName} takes at most ${kgAr(nominalKg)} kg of green (manufacturer capacity); ${kgAr(greenKg)} kg cannot be recorded. Nothing was roasted.`,
    errorAr: `السعة القصوى لـ ${roasterName} ${kgAr(nominalKg)} كغ أخضر حسب المصنّع، فلا يمكن تسجيل ${kgAr(greenKg)} كغ. لم يُسجَّل شيء.`,
  };
}

export function ackRequired(roasterName: string, greenKg: number, v: Extract<CapacityVerdict, { kind: "outside_range" }>) {
  const below = v.direction === "BELOW_MIN";
  return {
    _appCode: 422,
    code: "ACK_REQUIRED",
    message: `${kgAr(greenKg)} كغ ${below ? "أقل من الحد الأدنى" : "أعلى من الحد الأعلى"} للدفعة على ${roasterName} (${kgAr(v.minKg)}–${kgAr(v.maxKg)} كغ). أكّد للتسجيل؛ يُسجَّل تأكيدك.`,
    errorEn: `${kgAr(greenKg)} kg is ${below ? "below the minimum" : "above the maximum"} batch of ${roasterName} (${kgAr(v.minKg)}–${kgAr(v.maxKg)} kg). Confirm to record it anyway; the confirmation is logged.`,
    errorAr: `${kgAr(greenKg)} كغ ${below ? "أقل من الحد الأدنى" : "أعلى من الحد الأعلى"} للدفعة على ${roasterName} (${kgAr(v.minKg)}–${kgAr(v.maxKg)} كغ). أكّد للتسجيل؛ يُسجَّل تأكيدك.`,
    direction: v.direction,
    minKg: v.minKg,
    maxKg: v.maxKg,
  };
}

export type RoasterCheckResult = {
  roaster: { id: string; name: string; nominalKg: number; minKg: number; maxKg: number };
  ack: { direction: "BELOW_MIN" | "ABOVE_MAX" } | null;
  bypass: boolean;
};

type Db = Prisma.TransactionClient;

/**
 * Decide whether this caller may record `greenKg` on `roasterId`. Throws the coded refusal (for
 * handleDomainError) or returns what must be logged once the batch exists.
 */
export async function checkRoasterForRoast(
  db: Db,
  args: { roasterId: string; greenKg: number; ack: boolean; user: { id: string; role: string } },
): Promise<RoasterCheckResult> {
  const r = await db.roaster.findUnique({
    where: { id: args.roasterId },
    select: { id: true, name: true, status: true, nominalCapacityKg: true, minBatchKg: true, maxBatchKg: true },
  });
  if (!r || r.status === "RETIRED") {
    throw { _appCode: 404, code: "ROASTER_NOT_FOUND", message: "الحمّاصة غير موجودة أو خرجت من الخدمة.", errorEn: "Roaster not found or retired." };
  }
  const roaster = { id: r.id, name: r.name, nominalKg: Number(r.nominalCapacityKg), minKg: Number(r.minBatchKg), maxKg: Number(r.maxBatchKg) };
  // The same RoasterOperator source as the schedule's OPERATOR_NOT_ASSIGNED (roaster-operators.ts).
  const op = operatorVerdict(args.user.role, await isAssignedOperator(db, r.id, args.user.id));
  if (op.kind === "refused") throw operatorRefusal(r.name);
  const v = capacityVerdict({ nominalCapacityKg: roaster.nominalKg, minBatchKg: roaster.minKg, maxBatchKg: roaster.maxKg }, args.greenKg);
  if (v.kind === "over_nominal") throw capacityRefusal(r.name, args.greenKg, v.nominalKg);
  if (v.kind === "outside_range" && !args.ack) throw ackRequired(r.name, args.greenKg, v);
  return { roaster, ack: v.kind === "outside_range" ? { direction: v.direction } : null, bypass: op.kind === "admin_bypass" };
}

/** Write the RoasterControlLog rows a successful roast carries (same transaction as the batch). */
export async function logRoasterControls(
  db: Db,
  check: RoasterCheckResult,
  ctx: {
    batch: { id: string; batchNumber: string };
    requestKey: string | null;
    greenKg: number;
    user: { id: string; name: string; role: string };
    sourceInterface: "WEB" | "STATION";
  },
) {
  const base = {
    roasterId: check.roaster.id,
    roasterName: check.roaster.name,
    batchId: ctx.batch.id,
    batchNumber: ctx.batch.batchNumber,
    requestKey: ctx.requestKey,
    employeeId: ctx.user.id,
    employeeName: ctx.user.name,
    employeeRole: ctx.user.role,
    greenKg: r3(ctx.greenKg),
    nominalKg: check.roaster.nominalKg,
    minKg: check.roaster.minKg,
    maxKg: check.roaster.maxKg,
    sourceInterface: ctx.sourceInterface,
  };
  if (check.ack) {
    await db.roasterControlLog.create({ data: { ...base, kind: "CAPACITY_ACK", direction: check.ack.direction, detail: { acknowledged: true } } });
  }
  if (check.bypass) {
    await db.roasterControlLog.create({ data: { ...base, kind: "OPERATOR_ADMIN_BYPASS", detail: { adminBypass: true, reason: "not an assigned RoasterOperator; the admin role is never blocked" } } });
  }
}
