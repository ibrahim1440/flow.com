// Balances derived from the append-only ledgers. Nothing here writes.
//
// Definitions (the same words appear on screen):
//   Book cash            opening balance + CONFIRMED lines, per account. Pending and void
//                        lines are excluded.
//   Restricted cash      book cash of accounts flagged restricted — reported, never allocatable.
//   Eligible cash        book cash of unrestricted accounts in the scope, LESS pending outgoing
//                        lines (money already paid out but not yet on a statement). Pending
//                        incoming lines are never added. This is the allocation pool.
//   Category balance     opening carried + allocations + incoming adjustments/transfers
//                        − payments − outgoing adjustments/transfers.
//   Reserved             ACTIVE + PENDING_APPROVAL payment reservations.
//   Available in category = category balance − reserved.
//   Unallocated cash     eligible cash − Σ category balances. This is the only figure that
//                        means "not earmarked for anything". It can go negative when cash
//                        left the bank outside any category; that is shown as a shortfall.
//   Pending receipts     PENDING inflows — shown, never counted as cash.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { toMinor, type Minor } from "../money";
import type { Db, FinanceScope } from "./context";

const IN_TYPES = ["ALLOCATION", "TRANSFER_IN", "ADJUSTMENT_IN"] as const;

export type CategoryLedger = {
  categoryId: string;
  allocations: Minor;
  incoming: Minor; // transfers in + adjustments in
  payments: Minor;
  outgoing: Minor; // transfers out + adjustments out
  balance: Minor;
};

export async function categoryLedgers(
  db: Db,
  where: Prisma.AllocationEntryWhereInput,
): Promise<Map<string, CategoryLedger>> {
  const rows = await db.allocationEntry.groupBy({ by: ["categoryId", "entryType"], where, _sum: { amount: true } });
  const out = new Map<string, CategoryLedger>();
  for (const r of rows) {
    const l = out.get(r.categoryId) ?? { categoryId: r.categoryId, allocations: 0, incoming: 0, payments: 0, outgoing: 0, balance: 0 };
    const v = toMinor(r._sum.amount);
    switch (r.entryType) {
      case "ALLOCATION": l.allocations += v; break;
      case "TRANSFER_IN": case "ADJUSTMENT_IN": l.incoming += v; break;
      case "PAYMENT": l.payments += v; break;
      case "TRANSFER_OUT": case "ADJUSTMENT_OUT": l.outgoing += v; break;
    }
    l.balance = l.allocations + l.incoming - l.payments - l.outgoing;
    out.set(r.categoryId, l);
  }
  return out;
}

export async function reservedByCategory(db: Db, categoryIds?: string[]): Promise<Map<string, Minor>> {
  const rows = await db.paymentReservation.groupBy({
    by: ["categoryId"],
    where: { status: { in: ["ACTIVE", "PENDING_APPROVAL"] }, ...(categoryIds ? { categoryId: { in: categoryIds } } : {}) },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.categoryId, toMinor(r._sum.amount)]));
}

export type AccountBalance = {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  type: string;
  branchKey: string;
  isRestricted: boolean;
  opening: Minor;
  confirmed: Minor;
  pendingIn: Minor;
  pendingOut: Minor;
  bookBalance: Minor;
  lastReconciledDate: string | null;
  lastReconciledDifference: Minor | null;
};

export async function accountBalances(db: Db, scope: FinanceScope, asOf?: string): Promise<AccountBalance[]> {
  const accounts = await db.cashAccount.findMany({
    where: { active: true, ...(scope.all ? {} : { branchKey: { in: scope.branchKeys } }) },
    orderBy: { code: "asc" },
  });
  if (accounts.length === 0) return [];
  const ids = accounts.map((a) => a.id);
  const dateFilter = asOf ? { txnDate: { lte: new Date(`${asOf}T00:00:00Z`) } } : {};
  const sums = await db.bankTransaction.groupBy({
    by: ["cashAccountId", "status"],
    where: { cashAccountId: { in: ids }, status: { in: ["CONFIRMED", "PENDING"] }, ...dateFilter },
    _sum: { amount: true },
  });
  const pendingSplit = await db.bankTransaction.groupBy({
    by: ["cashAccountId"],
    where: { cashAccountId: { in: ids }, status: "PENDING", amount: { gt: 0 }, ...dateFilter },
    _sum: { amount: true },
  });
  const recons = await db.bankReconciliation.findMany({
    where: { cashAccountId: { in: ids }, status: "COMPLETED" },
    orderBy: { statementDate: "desc" },
    distinct: ["cashAccountId"],
    select: { cashAccountId: true, statementDate: true, difference: true },
  });
  return accounts.map((a) => {
    const confirmed = toMinor(sums.find((s) => s.cashAccountId === a.id && s.status === "CONFIRMED")?._sum.amount);
    const pendingAll = toMinor(sums.find((s) => s.cashAccountId === a.id && s.status === "PENDING")?._sum.amount);
    const pendingIn = toMinor(pendingSplit.find((s) => s.cashAccountId === a.id)?._sum.amount);
    const opening = toMinor(a.openingBalance);
    const r = recons.find((x) => x.cashAccountId === a.id);
    return {
      id: a.id,
      code: a.code,
      nameEn: a.nameEn,
      nameAr: a.nameAr,
      type: a.type,
      branchKey: a.branchKey,
      isRestricted: a.isRestricted,
      opening,
      confirmed,
      pendingIn,
      pendingOut: pendingIn - pendingAll,
      bookBalance: opening + confirmed,
      lastReconciledDate: r ? r.statementDate.toISOString().slice(0, 10) : null,
      lastReconciledDifference: r ? toMinor(r.difference) : null,
    };
  });
}

export type PoolSummary = {
  branchKey: string;
  bookCash: Minor;
  restrictedCash: Minor;
  eligibleCash: Minor;
  allocated: Minor;
  unallocated: Minor;
  reserved: Minor;
  pendingIn: Minor;
  pendingOut: Minor;
  negativeCategories: number;
};

/** Pool figures per branch key. Allocated + unallocated = eligible cash, exactly. */
export async function poolSummaries(db: Db, scope: FinanceScope): Promise<PoolSummary[]> {
  const accounts = await accountBalances(db, scope);
  const cats = await db.allocationCategory.findMany({
    where: scope.all ? {} : { branchKey: { in: scope.branchKeys } },
    select: { id: true, branchKey: true },
  });
  const ledgers = await categoryLedgers(db, { categoryId: { in: cats.map((c) => c.id) } });
  const reserved = await reservedByCategory(db, cats.map((c) => c.id));
  const keys = new Set<string>([...accounts.map((a) => a.branchKey), ...cats.map((c) => c.branchKey)]);
  return [...keys].sort().map((k) => {
    const accs = accounts.filter((a) => a.branchKey === k);
    const kc = cats.filter((c) => c.branchKey === k);
    const bookCash = accs.reduce((s, a) => s + a.bookBalance, 0);
    const restrictedCash = accs.filter((a) => a.isRestricted).reduce((s, a) => s + a.bookBalance, 0);
    // A payment made outside the application and recorded as a pending line has already left
    // (or is leaving) the bank: it reduces what can be earmarked before the statement confirms it.
    // Otherwise a category payment recorded against it would free the same cash twice.
    const pendingOutUnrestricted = accs.filter((a) => !a.isRestricted).reduce((s, a) => s + a.pendingOut, 0);
    const eligibleCash = bookCash - restrictedCash - pendingOutUnrestricted;
    const allocated = kc.reduce((s, c) => s + (ledgers.get(c.id)?.balance ?? 0), 0);
    return {
      branchKey: k,
      bookCash,
      restrictedCash,
      eligibleCash,
      allocated,
      unallocated: eligibleCash - allocated,
      reserved: kc.reduce((s, c) => s + (reserved.get(c.id) ?? 0), 0),
      pendingIn: accs.reduce((s, a) => s + a.pendingIn, 0),
      pendingOut: accs.reduce((s, a) => s + a.pendingOut, 0),
      negativeCategories: kc.filter((c) => (ledgers.get(c.id)?.balance ?? 0) < 0).length,
    };
  });
}

export async function poolUnallocated(db: Db, branchKey: string): Promise<Minor> {
  const [p] = await poolSummaries(db, { all: false, branchKeys: [branchKey] });
  return p?.unallocated ?? 0;
}

/** Receipt amount not yet earmarked: amount − allocations + reversals of those allocations. */
export async function receiptUnallocated(db: Db, txnId: string, amount: Minor): Promise<Minor> {
  const rows = await db.allocationEntry.groupBy({
    by: ["entryType", "sourceType"],
    where: { sourceTxnId: txnId, sourceType: { in: ["RECEIPT", "RECEIPT_REVERSAL"] } },
    _sum: { amount: true },
  });
  let allocated = 0;
  for (const r of rows) {
    if (r.entryType === "ALLOCATION") allocated += toMinor(r._sum.amount);
    if (r.entryType === "ADJUSTMENT_OUT" && r.sourceType === "RECEIPT_REVERSAL") allocated -= toMinor(r._sum.amount);
  }
  return amount - allocated;
}

/** Opening-balance cash still unallocated for one account. */
export async function openingUnallocated(db: Db, accountId: string, opening: Minor): Promise<Minor> {
  const agg = await db.allocationEntry.aggregate({
    where: { sourceCashAccountId: accountId, sourceType: "OPENING_BALANCE", entryType: "ALLOCATION" },
    _sum: { amount: true },
  });
  return opening - toMinor(agg._sum.amount);
}

export { IN_TYPES, prisma };
