// Native HR ↔ the existing sales commission ledger.
//
// ── One payout path per commission period ──
// A commission period (login account × Riyadh month) is payable when every accrual in it
// is APPROVED and the ledger shows an outstanding amount. A payroll run RESERVES the period
// (partial unique index: one RESERVED row per period), the standalone payout in
// /api/commissions/review/actions refuses a reserved period, and both paths take the same
// advisory lock first — so neither can read "outstanding" while the other is writing.
// When the run's payment is recorded, the reservation SETTLES by writing the same PAYOUT
// ledger entry and APPROVED → PAID transition the standalone payout writes. A cancelled run
// RELEASES its reservations; nothing was paid.
import type { Prisma } from "@/generated/prisma/client";
import { periodStatement } from "@/lib/services/commissions/accrual";
import { riyadhMonthStart } from "@/lib/services/commissions/engine";
import { HrError } from "../core";

type Tx = Prisma.TransactionClient;

export async function lockCommissionPeriod(tx: Tx, employeeId: string, periodStart: Date) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"commission-period:" + employeeId + ":" + periodStart.toISOString()}))`;
}

export async function isReservedByPayroll(tx: Tx, employeeId: string, periodStart: Date) {
  return (await tx.hrCommissionReservation.count({ where: { accountEmployeeId: employeeId, periodStart, status: "RESERVED" } })) > 0;
}

/**
 * Periods payable through a run for `month` (YYYY-MM): every Riyadh month up to and
 * including the run's month that is fully approved, has something outstanding, and is not
 * reserved by another run.
 */
export async function payablePeriods(tx: Tx, accountId: string, month: string): Promise<{ periodStart: Date; amount: Prisma.Decimal }[]> {
  const cutoff = riyadhMonthStart(new Date(`${month}-15T12:00:00Z`));
  const periods = await tx.commissionAccrual.findMany({ where: { employeeId: accountId, periodStart: { lte: cutoff }, status: { in: ["APPROVED", "ACCRUED"] } }, distinct: ["periodStart"], select: { periodStart: true }, orderBy: { periodStart: "asc" } });
  const out: { periodStart: Date; amount: Prisma.Decimal }[] = [];
  for (const { periodStart } of periods) {
    const pending = await tx.commissionAccrual.count({ where: { employeeId: accountId, periodStart, status: "ACCRUED" } });
    if (pending > 0) continue;
    if (await isReservedByPayroll(tx, accountId, periodStart)) continue;
    const st = await periodStatement(tx, accountId, periodStart);
    if (st.outstanding.greaterThan(0)) out.push({ periodStart, amount: st.outstanding });
  }
  return out;
}

export async function reservePeriod(tx: Tx, input: { runId: string; lineId: string | null; accountId: string; periodStart: Date; amount: Prisma.Decimal }) {
  await lockCommissionPeriod(tx, input.accountId, input.periodStart);
  if (await isReservedByPayroll(tx, input.accountId, input.periodStart)) {
    throw new HrError("This commission period is already reserved by another payroll run.", 409, "COMMISSION_RESERVED");
  }
  const st = await periodStatement(tx, input.accountId, input.periodStart);
  if (!st.outstanding.equals(input.amount)) throw new HrError("The commission owed changed while the run was being prepared. Rebuild the run.", 409, "COMMISSION_CHANGED");
  return tx.hrCommissionReservation.create({ data: { runId: input.runId, lineId: input.lineId, accountEmployeeId: input.accountId, periodStart: input.periodStart, amount: input.amount } });
}

/** Re-check a run's reservations against the ledger (approval and payment both call this). */
export async function verifyReservations(tx: Tx, runId: string) {
  const rows = await tx.hrCommissionReservation.findMany({ where: { runId, status: "RESERVED" } });
  for (const r of rows) {
    await lockCommissionPeriod(tx, r.accountEmployeeId, r.periodStart);
    const st = await periodStatement(tx, r.accountEmployeeId, r.periodStart);
    const pending = await tx.commissionAccrual.count({ where: { employeeId: r.accountEmployeeId, periodStart: r.periodStart, status: "ACCRUED" } });
    if (pending > 0 || st.outstanding.lessThan(r.amount)) {
      throw new HrError(`Commission for ${r.periodStart.toISOString().slice(0, 7)} changed after the run reserved it (owed now ${st.outstanding.toFixed(2)}, reserved ${r.amount.toFixed(2)}). Cancel and re-prepare the run.`, 409, "COMMISSION_CHANGED");
    }
  }
  return rows;
}

export async function settleReservations(tx: Tx, runId: string, runNo: number, actorId: string) {
  const rows = await verifyReservations(tx, runId);
  for (const r of rows) {
    const entry = await tx.commissionLedgerEntry.create({ data: { type: "PAYOUT", employeeId: r.accountEmployeeId, periodStart: r.periodStart, amount: r.amount, reason: `Paid through payroll run #${runNo}`, actorId } });
    await tx.commissionAccrual.updateMany({ where: { employeeId: r.accountEmployeeId, periodStart: r.periodStart, status: "APPROVED" }, data: { status: "PAID" } });
    await tx.hrCommissionReservation.update({ where: { id: r.id }, data: { status: "SETTLED", ledgerEntryId: entry.id } });
  }
  return rows.length;
}

export async function releaseReservations(tx: Tx, runId: string) {
  const r = await tx.hrCommissionReservation.updateMany({ where: { runId, status: "RESERVED" }, data: { status: "RELEASED" } });
  return r.count;
}
