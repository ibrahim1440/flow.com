// Accounting A3 — commissions in the ledger. How a commission is COMPUTED is unchanged (the commission engine);
// this only books what it approved and what was paid:
//   • ACCRUED — when a login's month is approved (no accrual left waiting), and again for every later correction of
//     an approved month (an adjustment, a reversal against approved figures): Dr COMMISSION_EXPENSE / Cr
//     COMMISSION_PAYABLE (party = the person, when the login is linked to an HR record) for the difference between
//     what is approved and what the ledger already holds. `commissions · COMMISSION · <login>:<yyyy-mm> · ACCRUED[.n]`.
//   • PAID — a standalone payout: Dr COMMISSION_PAYABLE / Cr BANK. `… · PAID.<ledger entry>`.
//     A payout through payroll posts nothing here: the payroll run's HR journal carries the commission line, and the
//     HR key COMMISSION_EXPENSE is aligned to the COMMISSION_PAYABLE account (payroll-alignment.ts), so payroll
//     clears the payable instead of expensing the commission a second time.
// Approvals made while the engine posts nothing (before go-live) are recorded as the baseline of the month (part of
// the opening balances, never posted later — no retro-posting).
import type { Prisma } from "@/generated/prisma/client";
import { postEntry } from "../posting-engine";
import { Decimal, ZERO, roundMoney } from "../money";
import { dayText, riyadhDay } from "../dates";

type Tx = Prisma.TransactionClient;

const monthOf = (periodStart: Date) => dayText(riyadhDay(periodStart)).slice(0, 7);

async function partyOf(tx: Tx, loginId: string) {
  const p = await tx.hrEmployee.findUnique({ where: { accountId: loginId }, select: { id: true } });
  return p ? { type: "EMPLOYEE" as const, id: p.id } : null;
}

/** Bring the ledger to the approved total of one login × month (no-op while any accrual awaits approval). */
export async function syncCommissionPeriod(tx: Tx, employeeId: string, periodStart: Date, actorId: string): Promise<{ posted: Decimal; skipped: Decimal } | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commission-gl:${employeeId}:${periodStart.toISOString()}`}, 0))`;
  const pending = await tx.commissionAccrual.count({ where: { employeeId, periodStart, status: "ACCRUED" } });
  const approved = await tx.commissionAccrual.count({ where: { employeeId, periodStart, status: { in: ["APPROVED", "PAID"] } } });
  if (pending > 0 || approved === 0) return null;
  const sums = await tx.commissionLedgerEntry.groupBy({ by: ["type"], where: { employeeId, periodStart, type: { in: ["ACCRUAL", "REVERSAL", "ADJUSTMENT"] } }, _sum: { amount: true } });
  const target = roundMoney(sums.reduce((s, r) => s.plus(r._sum.amount ?? ZERO), ZERO));
  const row = await tx.commissionGlSync.upsert({ where: { employeeId_periodStart: { employeeId, periodStart } }, create: { employeeId, periodStart }, update: {} });
  const delta = target.minus(row.postedTotal).minus(row.baselineTotal);
  if (delta.isZero()) return { posted: ZERO, skipped: ZERO };
  const party = await partyOf(tx, employeeId);
  const month = monthOf(periodStart);
  const amt = delta.abs().toFixed(2);
  const dims = party ? { party } : undefined;
  const r = await postEntry(tx, {
    source: { module: "commissions", type: "COMMISSION", id: `${employeeId}:${month}`, event: row.postings === 0 ? "ACCRUED" : `ACCRUED.${row.postings + 1}` },
    date: dayText(riyadhDay()), whenPeriodNotOpen: "nextOpenPeriod", createdBy: actorId,
    memo: `عمولات معتمدة ${month}${delta.isNegative() ? " (تصحيح بالنقص)" : ""}`,
    lines: delta.isNegative()
      ? [{ role: "COMMISSION_PAYABLE", debit: amt, dims }, { role: "COMMISSION_EXPENSE", credit: amt, dims }]
      : [{ role: "COMMISSION_EXPENSE", debit: amt, dims }, { role: "COMMISSION_PAYABLE", credit: amt, dims }],
  });
  if (r.status === "posted") {
    await tx.commissionGlSync.update({ where: { id: row.id }, data: { postedTotal: { increment: delta }, postings: { increment: 1 } } });
    return { posted: delta, skipped: ZERO };
  }
  await tx.commissionGlSync.update({ where: { id: row.id }, data: { baselineTotal: { increment: delta } } });
  return { posted: ZERO, skipped: delta };
}

/** A standalone payout (the payout ledger entry): Dr COMMISSION_PAYABLE / Cr BANK. */
export async function postCommissionPayout(tx: Tx, a: { ledgerEntryId: string; employeeId: string; periodStart: Date; amount: Decimal; actorId: string }) {
  const party = await partyOf(tx, a.employeeId);
  const amt = roundMoney(a.amount).toFixed(2);
  return postEntry(tx, {
    source: { module: "commissions", type: "COMMISSION", id: `${a.employeeId}:${monthOf(a.periodStart)}`, event: `PAID.${a.ledgerEntryId}` },
    date: dayText(riyadhDay()), whenPeriodNotOpen: "nextOpenPeriod", createdBy: a.actorId, memo: `صرف عمولة ${monthOf(a.periodStart)}`,
    lines: [{ role: "COMMISSION_PAYABLE", debit: amt, dims: party ? { party } : undefined }, { role: "BANK", credit: amt }],
  });
}
