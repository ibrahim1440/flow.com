// Stage 2 read models and mappings: AP aging and supplier statements (subledger tied to the
// payables control account), bank ↔ ledger reconciliation per cash account, and the mappings
// that bank posting needs (cash account → GL account, budget category → GL account).
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ledgerTx } from "./journal-service";
import { auditAccounting } from "./audit";
import { ZERO, dec } from "./money";
import { postedBankLines } from "./bank-posted";
import { openItemBalances, partyMoves, unpostedEvents } from "./open-items";

const POSTED = ["POSTED", "REVERSED"] as const;
const DAY = 86_400_000;

/** Ledger balance (debit − credit) of an account up to a date, optionally for one party. */
export async function ledgerBalance(accountId: string, asOf: Date, party?: { partyType: string; partyId: string }, includeProvisional = true) {
  const r = await prisma.journalEntryLine.aggregate({
    where: {
      accountId, ...(party ? { partyType: party.partyType as never, partyId: party.partyId } : {}),
      journalEntry: { status: { in: [...POSTED] }, entryDate: { lte: asOf }, ...(includeProvisional ? {} : { isProvisional: false }) },
    },
    _sum: { debit: true, credit: true },
  });
  return dec(r._sum.debit).sub(dec(r._sum.credit));
}

async function apAccountId() {
  const m = await prisma.accountMapping.findUnique({ where: { role: "AP_CONTROL" } });
  return m?.accountId ?? null;
}

export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90p"] as const;
export type Bucket = (typeof AGING_BUCKETS)[number];
export function agingBucket(dueDate: Date, asOf: Date): Bucket {
  const days = Math.floor((asOf.getTime() - dueDate.getTime()) / DAY);
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90p";
}

/**
 * AP aging from the posted ledger: each payables line names the bill it opens or settles
 * (open-items.ts), so the open amount of a bill on a date is the sum of its lines dated on or
 * before it. A bill reversed or a payment voided later still counts for earlier dates, and the
 * subledger equals the payables account at every cutoff.
 */
export async function apAging(asOf: Date) {
  const ap = await apAccountId();
  const items = ap ? await openItemBalances(ap, asOf) : [];
  const billIds = items.filter((i) => i.type === "SUPPLIER_BILL" && i.id).map((i) => i.id!);
  const bills = new Map((await prisma.supplierBill.findMany({ where: { id: { in: billIds } }, select: { id: true, billNo: true, dueDate: true, supplierId: true } })).map((b) => [b.id, b]));
  const suppliers = new Map((await prisma.supplier.findMany({ where: { id: { in: [...new Set(items.map((i) => i.partyId!).filter(Boolean))] } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
  type Row = { supplierId: string; supplier: string; buckets: Record<Bucket, string>; total: string; bills: number };
  const bySupplier = new Map<string, { b: Record<Bucket, Prisma.Decimal>; n: number }>();
  const tot: Record<Bucket, Prisma.Decimal> = { current: ZERO, d1_30: ZERO, d31_60: ZERO, d61_90: ZERO, d90p: ZERO };
  const open: { billId: string; billNo: number; supplier: string; dueDate: Date; remaining: string; bucket: Bucket }[] = [];
  // Bills paid more than their total and payables with no bill are supplier debit balances: kept
  // apart from the buckets but part of the subledger, so the tie-out still holds.
  const overpaid: { billId: string; billNo: number; supplier: string; amount: string }[] = [];
  let overpaidTotal = ZERO;
  // Supplier credit notes not yet applied to a bill (debit balances; part of the subledger).
  const credits: { creditNoteId: string; billNo: number; supplier: string; amount: string }[] = [];
  const creditNos = new Map((await prisma.supplierBill.findMany({ where: { id: { in: items.filter((i) => i.type === "SUPPLIER_CREDIT" && i.id).map((i) => i.id!) } }, select: { id: true, billNo: true } })).map((b) => [b.id, b.billNo]));
  for (const it of items) {
    const remaining = it.balance.neg();                 // payables are credit-normal
    if (remaining.isZero() || !it.partyId) continue;
    if (it.type === "SUPPLIER_CREDIT" && it.id) { credits.push({ creditNoteId: it.id, billNo: creditNos.get(it.id) ?? 0, supplier: suppliers.get(it.partyId) ?? "", amount: remaining.toFixed(2) }); overpaidTotal = overpaidTotal.add(remaining); continue; }
    const b = it.type === "SUPPLIER_BILL" && it.id ? bills.get(it.id) : undefined;
    const name = suppliers.get(it.partyId) ?? "";
    if (!b || remaining.isNegative()) { overpaid.push({ billId: b?.id ?? "", billNo: b?.billNo ?? 0, supplier: name, amount: remaining.toFixed(2) }); overpaidTotal = overpaidTotal.add(remaining); continue; }
    const k = agingBucket(b.dueDate, asOf);
    const e = bySupplier.get(it.partyId) ?? { b: { current: ZERO, d1_30: ZERO, d31_60: ZERO, d61_90: ZERO, d90p: ZERO }, n: 0 };
    e.b[k] = e.b[k].add(remaining); e.n++; tot[k] = tot[k].add(remaining);
    bySupplier.set(it.partyId, e);
    open.push({ billId: b.id, billNo: b.billNo, supplier: name, dueDate: b.dueDate, remaining: remaining.toFixed(2), bucket: k });
  }
  const rows: Row[] = [...bySupplier.entries()].map(([supplierId, e]) => ({
    supplierId, supplier: suppliers.get(supplierId) ?? "", bills: e.n,
    buckets: Object.fromEntries(AGING_BUCKETS.map((k) => [k, e.b[k].toFixed(2)])) as Record<Bucket, string>,
    total: AGING_BUCKETS.reduce((s, k) => s.add(e.b[k]), ZERO).toFixed(2),
  })).sort((a, b) => a.supplier.localeCompare(b.supplier, "ar"));
  const subledger = AGING_BUCKETS.reduce((s, k) => s.add(tot[k]), ZERO).add(overpaidTotal);
  const ledger = ap ? (await ledgerBalance(ap, asOf)).neg() : null;
  const difference = ledger === null ? null : ledger.sub(subledger);

  // Not yet in the ledger (explanations only; they do not enter the figures above).
  const pendingBills = await unpostedEvents(["ap.bill.posted", "ap.bill.reversed"]);
  const unposted = await prisma.bankTransactionMatch.findMany({
    where: { targetType: "OBLIGATION", active: true, transaction: { status: "CONFIRMED", txnDate: { lte: asOf } } },
    select: { transactionId: true, amount: true },
  });
  const postedTxn = await postedBankLines(prisma, unposted.map((m) => m.transactionId));
  const notInLedger = unposted.filter((m) => !postedTxn.has(m.transactionId)).reduce((s, m) => s.add(m.amount), ZERO);
  return {
    asOf, rows, open, overpaid, credits, overpaidTotal: overpaidTotal.toFixed(2),
    totals: Object.fromEntries(AGING_BUCKETS.map((k) => [k, tot[k].toFixed(2)])) as Record<Bucket, string>,
    subledger: subledger.toFixed(2),
    ledger: ledger?.toFixed(2) ?? null,
    difference: difference?.toFixed(2) ?? null,
    reconciled: difference !== null && difference.isZero(),
    explanation: { paymentsMatchedNotYetPostedFromBank: notInLedger.toFixed(2), billsPostedWithoutJournal: pendingBills },
  };
}

/** Supplier statement: the supplier's posted lines on the payables account (credit-normal balance). */
export async function supplierStatement(supplierId: string, from: Date, to: Date) {
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw new AccountingError("Supplier not found.", 404);
  if (from > to) throw new AccountingError("The start date is after the end date.", 400);
  const ap = await apAccountId();
  const { opening, moves } = await partyMoves(ap ? [ap] : [], supplierId, from, to);
  const bills = new Map((await prisma.supplierBill.findMany({ where: { id: { in: moves.filter((m) => m.sourceModule === "payables").map((m) => m.sourceDocumentId!) } }, select: { id: true, billNo: true, supplierInvoiceNo: true, kind: true } })).map((b) => [b.id, b]));
  const txns = new Map((await prisma.bankTransaction.findMany({ where: { id: { in: moves.filter((m) => m.sourceModule === "bank").map((m) => m.sourceDocumentId!) } }, select: { id: true, bankReference: true } })).map((t) => [t.id, t]));
  let bal = opening.neg();
  const lines = moves.filter((m) => !m.net.isZero()).map((m) => {
    const reversal = !!m.eventType && /\.(reversed|voided)$/.test(m.eventType);
    const b = m.sourceDocumentId ? bills.get(m.sourceDocumentId) : undefined;
    const kind = m.sourceModule === "bank" ? "payment" : reversal ? "reversal" : m.eventType?.startsWith("ap.credit.") ? "credit_applied" : b?.kind === "CREDIT_NOTE" ? "credit_note" : "bill";
    const ref = b ? `ف-${b.billNo}` : txns.get(m.sourceDocumentId ?? "")?.bankReference ?? `#${m.entryNo}`;
    bal = bal.sub(m.net);
    return { date: m.date, kind, ref, refId: m.sourceDocumentId ?? m.entryId, text: m.description ?? "", debit: (m.net.isPositive() ? m.net : ZERO).toFixed(2), credit: (m.net.isNegative() ? m.net.neg() : ZERO).toFixed(2), balance: bal.toFixed(2) };
  });
  const ledger = ap ? (await ledgerBalance(ap, to, { partyType: "SUPPLIER", partyId: supplierId })).neg() : null;
  return {
    supplier: { id: supplier.id, name: supplier.name, vatNumber: supplier.vatNumber, crNumber: supplier.crNumber, paymentTermsDays: supplier.paymentTermsDays },
    from, to, opening: opening.neg().toFixed(2), lines, closing: bal.toFixed(2),
    totals: { debit: lines.reduce((s, l) => s.add(l.debit), ZERO).toFixed(2), credit: lines.reduce((s, l) => s.add(l.credit), ZERO).toFixed(2) },
    ledgerBalance: ledger?.toFixed(2) ?? null,
  };
}

/** Bank book (Finance) vs ledger, per cash account, with every difference itemised. */
export async function bankReconciliation(asOf: Date) {
  const settings = await prisma.accountingSettings.findUnique({ where: { id: "singleton" } });
  const from = settings?.bankPostingFrom ?? null;
  const accounts = await prisma.cashAccount.findMany({ where: { active: true }, orderBy: { code: "asc" }, include: { } });
  const glIds = accounts.map((a) => a.glAccountId).filter(Boolean) as string[];
  const gl = await prisma.account.findMany({ where: { id: { in: glIds } }, select: { id: true, code: true, nameAr: true, nameEn: true } });
  const glById = new Map(gl.map((g) => [g.id, g]));
  const events = await prisma.accountingEvent.findMany({ where: { eventType: "bank.transaction.confirmed" }, select: { sourceDocumentId: true, status: true, errorMessage: true, journalEntryId: true } });
  const evByTxn = new Map(events.map((e) => [e.sourceDocumentId, e]));
  const out = [];
  for (const a of accounts) {
    const txns = await prisma.bankTransaction.findMany({
      where: { cashAccountId: a.id, status: { not: "VOID" }, txnDate: { lte: asOf } },
      select: { id: true, txnDate: true, amount: true, status: true, reviewStatus: true, classification: true, bankReference: true, description: true, updatedAt: true },
      orderBy: { txnDate: "asc" },
    });
    const confirmed = txns.filter((t) => t.status === "CONFIRMED");
    const book = dec(a.openingBalance).add(confirmed.reduce((s, t) => s.add(t.amount), ZERO));
    const ledger = a.glAccountId ? await ledgerBalance(a.glAccountId, asOf) : null;
    const inScope = confirmed.filter((t) => from && t.txnDate >= from);
    // The receiving leg of a transfer is in the ledger through the paying leg's journal.
    const peers = await prisma.bankTransaction.findMany({ where: { id: { in: inScope.map((t) => t.id) }, classification: "INTERNAL_TRANSFER", amount: { gt: 0 } }, select: { id: true, transferPeerId: true } });
    const postedViaPeer = new Set(peers.filter((p) => p.transferPeerId && evByTxn.get(p.transferPeerId)?.status === "TRANSLATED").map((p) => p.id));
    const notPosted = inScope.filter((t) => evByTxn.get(t.id)?.status !== "TRANSLATED" && !postedViaPeer.has(t.id)).map((t) => {
      const e = evByTxn.get(t.id);
      return {
        id: t.id, date: t.txnDate, amount: dec(t.amount).toFixed(2), reference: t.bankReference, description: t.description, classification: t.classification,
        reason: t.reviewStatus !== "REVIEWED" ? "needs review in Finance" : e ? `${e.status.toLowerCase()}: ${e.errorMessage ?? ""}`.trim() : "no event",
      };
    });
    const manual = a.glAccountId && from ? await prisma.journalEntryLine.findMany({
      where: { accountId: a.glAccountId, journalEntry: { status: { in: [...POSTED] }, sourceModule: { notIn: ["bank"] }, entryDate: { gte: from, lte: asOf }, type: { not: "OPENING" } } },
      select: { debit: true, credit: true, journalEntry: { select: { entryNo: true, entryDate: true, description: true } } },
    }) : [];
    const beforeStart = from ? confirmed.filter((t) => t.txnDate < from).reduce((s, t) => s.add(t.amount), ZERO) : null;
    out.push({
      cashAccount: { id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, type: a.type },
      glAccount: a.glAccountId ? glById.get(a.glAccountId) ?? null : null,
      book: book.toFixed(2), ledger: ledger?.toFixed(2) ?? null,
      difference: ledger === null ? null : book.sub(ledger).toFixed(2),
      items: {
        openingBalanceAndBeforeStart: dec(a.openingBalance).add(beforeStart ?? ZERO).toFixed(2),
        notPosted,
        manualJournalsAfterStart: manual.map((m) => ({ entryNo: m.journalEntry.entryNo, date: m.journalEntry.entryDate, description: m.journalEntry.description, amount: dec(m.debit).sub(dec(m.credit)).toFixed(2) })),
      },
    });
  }
  return { asOf, bankPostingFrom: from, accounts: out };
}

// ─── Mappings ────────────────────────────────────────────────────────────────

export async function bankMappings() {
  const [cash, cats, settings] = await Promise.all([
    prisma.cashAccount.findMany({ orderBy: { code: "asc" }, select: { id: true, code: true, nameAr: true, nameEn: true, type: true, active: true, glAccountId: true } }),
    prisma.finCategory.findMany({ orderBy: [{ kind: "desc" }, { sortOrder: "asc" }, { code: "asc" }], select: { id: true, code: true, nameAr: true, nameEn: true, kind: true, active: true, glAccountId: true, glAccount: { select: { code: true, nameAr: true, nameEn: true, controlKind: true } } } }),
    prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { bankPostingFrom: true, ledgerCutoverDate: true } }),
  ]);
  const gl = await prisma.account.findMany({ where: { id: { in: cash.map((c) => c.glAccountId).filter(Boolean) as string[] } }, select: { id: true, code: true, nameAr: true, nameEn: true } });
  const glById = new Map(gl.map((g) => [g.id, g]));
  const counts = await prisma.accountingEvent.groupBy({ by: ["status"], where: { sourceModule: "bank" }, _count: { _all: true } });
  return {
    settings, cash: cash.map((c) => ({ ...c, glAccount: c.glAccountId ? glById.get(c.glAccountId) ?? null : null })), categories: cats,
    events: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  };
}

export async function setCashAccountGl(cashAccountId: string, accountId: string | null, userId: string) {
  return ledgerTx(async (tx) => {
    const c = await tx.cashAccount.findUnique({ where: { id: cashAccountId } });
    if (!c) throw new AccountingError("Cash account not found.", 404);
    if (accountId) {
      const a = await tx.account.findUnique({ where: { id: accountId }, include: { _count: { select: { children: true } } } });
      if (!a || !a.isActive || !a.allowPosting || a._count.children > 0) throw new AccountingError("Choose an active posting account.", 400);
      if (a.type !== "ASSET" || a.controlKind !== "CASH") throw new AccountingError(`A cash account maps to a cash ledger account (${a.code} is not one).`, 400);
      const other = await tx.cashAccount.findFirst({ where: { glAccountId: accountId, id: { not: cashAccountId } } });
      if (other) throw new AccountingError(`Ledger account ${a.code} already belongs to cash account ${other.code}; each bank account needs its own.`, 409);
    }
    const posted = await tx.accountingEvent.count({ where: { sourceModule: "bank", status: "TRANSLATED", payload: { path: ["cashAccountId"], equals: cashAccountId } } });
    if (posted > 0 && c.glAccountId !== accountId) throw new AccountingError("Lines of this cash account have already posted; its ledger account can no longer change.", 409);
    const r = await tx.cashAccount.update({ where: { id: cashAccountId }, data: { glAccountId: accountId } });
    await auditAccounting(tx, { action: "bank.map_cash", entityType: "bank", entityId: cashAccountId, userId, before: { glAccountId: c.glAccountId }, after: { glAccountId: accountId } });
    return r;
  });
}

export async function setCategoryGl(categoryId: string, accountId: string | null, userId: string) {
  return ledgerTx(async (tx) => {
    const c = await tx.finCategory.findUnique({ where: { id: categoryId } });
    if (!c) throw new AccountingError("Budget category not found.", 404);
    if (accountId) {
      const a = await tx.account.findUnique({ where: { id: accountId }, include: { _count: { select: { children: true } } } });
      if (!a || !a.isActive || !a.allowPosting || a._count.children > 0) throw new AccountingError("Choose an active posting account.", 400);
      if (["RECEIVABLE", "CUSTOMER_ADVANCES", "COMMISSION_PAYABLE", "INVENTORY", "CASH"].includes(a.controlKind)) {
        throw new AccountingError(`${a.code} is a ${a.controlKind.toLowerCase()} control account; bank lines cannot post to it through a category.`, 400);
      }
    }
    const r = await tx.finCategory.update({ where: { id: categoryId }, data: { glAccountId: accountId } });
    await auditAccounting(tx, { action: "bank.map_category", entityType: "bank", entityId: categoryId, userId, before: { glAccountId: c.glAccountId }, after: { glAccountId: accountId } });
    return r;
  });
}
