// Reconciliation of an account against a bank statement balance at a date.
//
//   ledger balance = opening balance + CONFIRMED lines dated on or before the statement date
//   difference     = statement balance − ledger balance
// Pending lines are listed separately (they may explain a timing difference) and are never
// included in the ledger balance. A reconciliation can only be COMPLETED at a zero
// difference; with a difference it is saved as a DRAFT that shows the gap. Completing it
// stamps the covered lines, which then cannot be voided or re-dated.
import { prisma } from "@/lib/db";
import { fromMinor, parseMoney, toMinor } from "../money";
import { dbDate, isDateString } from "../dates";
import { assertCan, assertScope, audit, FinanceError, str, type Db, type FinanceActor, type FinanceScope } from "./context";

async function computeRecon(db: Db, accountId: string, statementDate: string) {
  const acc = await db.cashAccount.findUniqueOrThrow({ where: { id: accountId } });
  const d = dbDate(statementDate);
  const [confirmed, pending, unreconciled] = await Promise.all([
    db.bankTransaction.aggregate({ where: { cashAccountId: accountId, status: "CONFIRMED", txnDate: { lte: d } }, _sum: { amount: true } }),
    db.bankTransaction.aggregate({ where: { cashAccountId: accountId, status: "PENDING", txnDate: { lte: d } }, _sum: { amount: true } }),
    db.bankTransaction.findMany({
      where: { cashAccountId: accountId, status: { in: ["CONFIRMED", "PENDING"] }, txnDate: { lte: d }, reconciliationId: null },
      orderBy: { txnDate: "asc" }, take: 500,
      select: { id: true, txnDate: true, amount: true, status: true, bankReference: true, description: true, reviewStatus: true },
    }),
  ]);
  const ledger = toMinor(acc.openingBalance) + toMinor(confirmed._sum.amount);
  return { account: acc, ledger, pendingTotal: toMinor(pending._sum.amount), unreconciled };
}

export async function previewReconciliation(scope: FinanceScope, accountId: string, statementDate: string, statementBalance: unknown) {
  const acc = await prisma.cashAccount.findUnique({ where: { id: accountId } });
  if (!acc) throw new FinanceError("Not found", 404);
  assertScope(scope, acc.branchKey);
  if (!isDateString(statementDate)) throw new FinanceError("Statement date is required.", 400);
  const bal = parseMoney(statementBalance);
  if (bal === null) throw new FinanceError("Statement balance must be a SAR amount.", 400);
  const r = await computeRecon(prisma, accountId, statementDate);
  return { statementDate, statementBalance: bal, ledgerBalance: r.ledger, pendingTotal: r.pendingTotal, difference: bal - r.ledger, unreconciled: r.unreconciled };
}

export async function saveReconciliation(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "reconcile");
  const accountId = String(body.cashAccountId ?? "");
  const statementDate = String(body.statementDate ?? "");
  const acc = await prisma.cashAccount.findUnique({ where: { id: accountId } });
  if (!acc) throw new FinanceError("Not found", 404);
  assertScope(scope, acc.branchKey);
  if (!isDateString(statementDate)) throw new FinanceError("Statement date is required.", 400);
  const bal = parseMoney(body.statementBalance);
  if (bal === null) throw new FinanceError("Statement balance must be a SAR amount.", 400);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "CashAccount" WHERE id = ${accountId} FOR UPDATE`;
    const last = await tx.bankReconciliation.findFirst({ where: { cashAccountId: accountId, status: "COMPLETED" }, orderBy: { statementDate: "desc" } });
    if (last && last.statementDate.toISOString().slice(0, 10) >= statementDate) {
      throw new FinanceError(`This account is already reconciled through ${last.statementDate.toISOString().slice(0, 10)}.`, 409);
    }
    const r = await computeRecon(tx, accountId, statementDate);
    const difference = bal - r.ledger;
    const status = difference === 0 ? "COMPLETED" : "DRAFT";
    const rec = await tx.bankReconciliation.create({
      data: {
        cashAccountId: accountId, statementDate: dbDate(statementDate), statementBalance: fromMinor(bal),
        ledgerBalance: fromMinor(r.ledger), pendingTotal: fromMinor(r.pendingTotal), difference: fromMinor(difference),
        status, notes: str(body.notes, 1000), createdBy: actor.id,
        ...(status === "COMPLETED" ? { completedAt: new Date(), completedBy: actor.id } : {}),
      },
    });
    if (status === "COMPLETED") {
      await tx.bankTransaction.updateMany({
        where: { cashAccountId: accountId, status: "CONFIRMED", txnDate: { lte: dbDate(statementDate) }, reconciliationId: null },
        data: { reconciliationId: rec.id },
      });
    }
    await audit(tx, { action: `reconciliation.${status.toLowerCase()}`, entityType: "BankReconciliation", entityId: rec.id, branchKey: acc.branchKey, after: rec, userId: actor.id });
    return rec;
  });
}

export async function listReconciliations(db: Db, scope: FinanceScope, accountId?: string) {
  return db.bankReconciliation.findMany({
    where: { ...(accountId ? { cashAccountId: accountId } : {}), cashAccount: scope.all ? {} : { branchKey: { in: scope.branchKeys } } },
    include: { cashAccount: { select: { code: true, nameEn: true, nameAr: true } } },
    orderBy: { statementDate: "desc" }, take: 100,
  });
}
