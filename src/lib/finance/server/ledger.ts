// Balances derived from the append-only ledgers. Nothing here writes.
//
// Definitions (the same words appear on screen):
//   Book cash            opening balance + CONFIRMED lines, per account. Pending and void
//                        lines are excluded.
//   Restricted cash      book cash of accounts flagged restricted — reported, never allocatable.
//   Eligible cash        unrestricted book cash LESS pending outgoing lines that are confirmed
//                        commitments, each economic movement counted once (exactly-once.ts):
//                        unreviewed imported pending outflows are "awaiting review" (shown, not
//                        deducted); possible-duplicate pairs count once until reviewed; pending
//                        incoming lines are never added. This is the allocation pool.
//   Category balance     opening carried + allocations + incoming adjustments/transfers
//                        − payments − outgoing adjustments/transfers.
//   Reserved             ACTIVE + PENDING_APPROVAL payment reservations.
//   Available in category = category balance − reserved.
//   Allocated (pool)     Σ categoryCommitment = Σ max(balance, approved reservations, 0): money
//                        held back from new allocation. An approved commitment beyond a
//                        category's balance holds back the difference; an overspent category
//                        (negative balance) holds nothing and frees nothing.
//   Unallocated cash     eligible cash − allocated: the only figure that means "not earmarked
//                        or committed", and the cap for new allocations. Negative is shown as a
//                        shortfall.
//   Pending receipts     PENDING inflows — shown, never counted as cash.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { toMinor, type Minor } from "../money";
import { categoryCommitment, eligibleEffect, matchReservationPayments, type CashLine } from "../exactly-once";
import { addDays } from "../dates";
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

export async function reservedByCategory(db: Db, categoryIds?: string[], statuses: ("ACTIVE" | "PENDING_APPROVAL")[] = ["ACTIVE", "PENDING_APPROVAL"]): Promise<Map<string, Minor>> {
  const rows = await db.paymentReservation.groupBy({
    by: ["categoryId"],
    where: { status: { in: statuses }, ...(categoryIds ? { categoryId: { in: categoryIds } } : {}) },
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
  /** Σ max(balance, approved reservations, 0) — held back from new allocation. */
  allocated: Minor;
  /** Eligible − allocated: the cap for new allocations. */
  unallocated: Minor;
  /** Σ category balances as booked (can include negative, overspent categories). */
  ledgerAllocated: Minor;
  /** Approved commitments beyond their category's balance (already inside "allocated"). */
  committedBeyondBalance: Minor;
  /** Σ −balance of overspent categories (cash already gone; frees nothing). */
  overspent: Minor;
  reserved: Minor;
  reservedApproved: Minor;
  reservedAwaitingApproval: Minor;
  pendingIn: Minor;
  /** Pending outgoing commitments deducted from eligible cash. */
  pendingOut: Minor;
  /** Imported pending outgoing lines nobody has confirmed: not deducted, alerted. */
  pendingOutAwaitingReview: Minor;
  /** Unresolved possible-duplicate pairs (counted once) and the amount not double-counted. */
  duplicatePairs: number;
  duplicateAdjustment: Minor;
  /** Approved payment requests with an unlinked outgoing line of the same amount: counted once, awaiting "Record payment made". */
  unlinkedPayments: { reservationId: string; lineId: string; amount: Minor }[];
  unlinkedPaymentsAmbiguous: number;
  negativeCategories: number;
};

const LINE_SELECT = { id: true, cashAccountId: true, amount: true, status: true, source: true, reviewStatus: true, transferPeerId: true, possibleDuplicateOfId: true, txnDate: true } as const;
type LineRow = { id: string; cashAccountId: string; amount: Prisma.Decimal; status: CashLine["status"]; source: CashLine["source"]; reviewStatus: CashLine["reviewStatus"]; transferPeerId: string | null; possibleDuplicateOfId: string | null; txnDate: Date };

async function withPayments(db: Db, rows: LineRow[]): Promise<(CashLine & { txnDate: string })[]> {
  const pay = rows.length
    ? await db.allocationEntry.groupBy({ by: ["sourceTxnId", "entryType"], where: { sourceTxnId: { in: rows.map((r) => r.id) }, sourceType: "PAYMENT" }, _sum: { amount: true } })
    : [];
  return rows.map((r) => ({
    id: r.id, cashAccountId: r.cashAccountId, amount: toMinor(r.amount), status: r.status, source: r.source, reviewStatus: r.reviewStatus,
    transferPeerId: r.transferPeerId, possibleDuplicateOfId: r.possibleDuplicateOfId, txnDate: r.txnDate.toISOString().slice(0, 10),
    paymentsBooked: pay.filter((p) => p.sourceTxnId === r.id).reduce((acc, p) => acc + (p.entryType === "PAYMENT" ? 1 : -1) * toMinor(p._sum.amount), 0),
  }));
}

/**
 * Lines that can differ from "confirmed only": pending lines, possible-duplicate pairs, and —
 * when approved payment requests are open — outgoing lines that could be their payment.
 */
async function uncertainLines(db: Db, accountIds: string[], openSince: string | null): Promise<(CashLine & { txnDate: string })[]> {
  if (accountIds.length === 0) return [];
  const or: Prisma.BankTransactionWhereInput[] = [{ status: "PENDING" }, { possibleDuplicateOfId: { not: null } }];
  if (openSince) or.push({ amount: { lt: 0 }, transferPeerId: null, txnDate: { gte: new Date(`${addDays(openSince, -3)}T00:00:00Z`) } });
  const first = await db.bankTransaction.findMany({ where: { cashAccountId: { in: accountIds }, status: { not: "VOID" }, OR: or }, select: LINE_SELECT });
  const have = new Set(first.map((l) => l.id));
  const partnerIds = [...new Set(first.map((l) => l.possibleDuplicateOfId).filter((x): x is string => !!x && !have.has(x)))];
  const partners = partnerIds.length ? await db.bankTransaction.findMany({ where: { id: { in: partnerIds } }, select: LINE_SELECT }) : [];
  return withPayments(db, [...first, ...partners]);
}

/** Pool figures per branch key. Allocated + unallocated = eligible cash, exactly. */
export async function poolSummaries(db: Db, scope: FinanceScope): Promise<PoolSummary[]> {
  const accounts = await accountBalances(db, scope);
  const cats = await db.allocationCategory.findMany({
    where: scope.all ? {} : { branchKey: { in: scope.branchKeys } },
    select: { id: true, branchKey: true },
  });
  const ledgers = await categoryLedgers(db, { categoryId: { in: cats.map((c) => c.id) } });
  const approved = await reservedByCategory(db, cats.map((c) => c.id), ["ACTIVE"]);
  const waiting = await reservedByCategory(db, cats.map((c) => c.id), ["PENDING_APPROVAL"]);
  const open = await db.paymentReservation.findMany({ where: { categoryId: { in: cats.map((c) => c.id) }, status: "ACTIVE" }, select: { id: true, categoryId: true, branchKey: true, amount: true, createdAt: true } });
  const openSince = open.length ? open.map((r) => r.createdAt.toISOString().slice(0, 10)).sort()[0] : null;
  const lines = await uncertainLines(db, accounts.filter((a) => !a.isRestricted).map((a) => a.id), openSince);
  const keys = new Set<string>([...accounts.map((a) => a.branchKey), ...cats.map((c) => c.branchKey)]);
  return [...keys].sort().map((k) => {
    const accs = accounts.filter((a) => a.branchKey === k);
    const kc = cats.filter((c) => c.branchKey === k);
    const bookCash = accs.reduce((acc, a) => acc + a.bookBalance, 0);
    const restrictedCash = accs.filter((a) => a.isRestricted).reduce((acc, a) => acc + a.bookBalance, 0);
    const ids = new Set(accs.filter((a) => !a.isRestricted).map((a) => a.id));
    // An approved request and its not-yet-linked payment line are one payment: treat the pair
    // as linked (line = committed outflow, category balance and reservation both reduced).
    const { matches, ambiguous } = matchReservationPayments(
      open.filter((r) => r.branchKey === k).map((r) => ({ id: r.id, categoryId: r.categoryId, amount: toMinor(r.amount), createdDate: r.createdAt.toISOString().slice(0, 10) })),
      lines.filter((l) => ids.has(l.cashAccountId)),
      addDays,
    );
    const linked = new Map(matches.map((m) => [m.lineId, m.amount]));
    const catAdj = new Map<string, Minor>();
    for (const m of matches) catAdj.set(m.categoryId, (catAdj.get(m.categoryId) ?? 0) + m.amount);
    const kl = lines.filter((l) => ids.has(l.cashAccountId)).map((l) => (linked.has(l.id) ? { ...l, paymentsBooked: linked.get(l.id)! } : l));
    // Confirmed lines are already in book cash; add only what the uncertain lines change.
    const e = eligibleEffect(kl);
    const confirmedInLines = kl.filter((l) => l.status === "CONFIRMED").reduce((acc, l) => acc + l.amount, 0);
    const eligibleCash = bookCash - restrictedCash + (e.effect - confirmedInLines);
    const bal = (id: string) => ledgers.get(id)?.balance ?? 0;
    const allocated = kc.reduce((acc, c) => acc + categoryCommitment(bal(c.id) - (catAdj.get(c.id) ?? 0), (approved.get(c.id) ?? 0) - (catAdj.get(c.id) ?? 0)), 0);
    const ledgerAllocated = kc.reduce((acc, c) => acc + bal(c.id), 0);
    const overspent = kc.reduce((acc, c) => acc + Math.max(0, -bal(c.id)), 0);
    const reservedApproved = kc.reduce((acc, c) => acc + (approved.get(c.id) ?? 0), 0);
    const reservedAwaitingApproval = kc.reduce((acc, c) => acc + (waiting.get(c.id) ?? 0), 0);
    return {
      branchKey: k,
      bookCash,
      restrictedCash,
      eligibleCash,
      allocated,
      unallocated: eligibleCash - allocated,
      ledgerAllocated,
      committedBeyondBalance: allocated - ledgerAllocated - overspent,
      overspent,
      reserved: reservedApproved + reservedAwaitingApproval,
      reservedApproved,
      reservedAwaitingApproval,
      pendingIn: accs.reduce((acc, a) => acc + a.pendingIn, 0),
      pendingOut: e.pendingOutCommitted,
      pendingOutAwaitingReview: e.pendingOutAwaitingReview,
      duplicatePairs: e.duplicatePairs,
      duplicateAdjustment: e.duplicateAdjustment,
      unlinkedPayments: matches.map((m) => ({ reservationId: m.reservationId, lineId: m.lineId, amount: m.amount })),
      unlinkedPaymentsAmbiguous: ambiguous,
      negativeCategories: kc.filter((c) => bal(c.id) < 0).length,
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
