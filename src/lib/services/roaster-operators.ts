import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/**
 * «مشغّل مسند» — who is assigned to a roaster. ONE source for every rule that asks it
 * (Settings › Production & roasting › «المشغّلون», RM5): a RoasterOperator row for
 * (roasterId, employeeId).
 *
 *   · the roast POST and the roasting station: 403 ROASTER_OPERATOR_REQUIRED for a non-admin who is
 *     not assigned (src/lib/services/roaster-controls.ts, station/claims.ts, station/queue.ts);
 *   · the roasting schedule: OPERATOR_NOT_ASSIGNED for a slot given to somebody who is not assigned
 *     (src/lib/services/schedule/schedule-db.ts eligibleOperators, which additionally requires the
 *     person to hold production › start_batch now — the roast POST asks the same through requireSub).
 *
 * Takes the Prisma client or a transaction.
 */
type Db = PrismaClient | Prisma.TransactionClient;

/** Whether this employee is an assigned operator of this roaster. */
export async function isAssignedOperator(db: Db, roasterId: string, employeeId: string): Promise<boolean> {
  const row = await db.roasterOperator.findFirst({ where: { roasterId, employeeId }, select: { id: true } });
  return !!row;
}

/** The employee ids assigned to this roaster. */
export async function assignedOperatorIds(db: Db, roasterId: string): Promise<string[]> {
  const rows = await db.roasterOperator.findMany({ where: { roasterId }, select: { employeeId: true } });
  return rows.map((r) => r.employeeId);
}

/** The roaster ids this employee is assigned to. */
export async function assignedRoasterIds(db: Db, employeeId: string): Promise<Set<string>> {
  const rows = await db.roasterOperator.findMany({ where: { employeeId }, select: { roasterId: true } });
  return new Set(rows.map((r) => r.roasterId));
}
