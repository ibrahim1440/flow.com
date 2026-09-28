// Receivables reports: AR aging with tie-out to the receivables control account, customer
// advances with tie-out to the advances (and advance-VAT) ledger lines, the customer statement tied to
// the customer's party lines, the queue of customer bank lines, and the customer list.
// "As of" a date: an allocation counts from its date until the day it was switched off, and a
// receipt counts only once its bank line has posted — the same dates the ledger carries.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ZERO, dec } from "./money";
import { accountingDateOf, todayAccountingDate } from "./dates";
import { postedBankLines } from "./bank-posted";
import { AGING_BUCKETS, agingBucket, type Bucket } from "./stage2-service";

const DAY = 86_400_000;
const nextDay = (asOf: Date) => new Date(asOf.getTime() + 21 * 3600 * 1000);   // start of the next Riyadh day

async function roleAccount(role: string) {
  return (await prisma.accountMapping.findUnique({ where: { role }, select: { accountId: true } }))?.accountId ?? null;
}
async function balance(accountIds: string[], asOf: Date, partyId?: string, partyOnly = false) {
  if (!accountIds.length) return ZERO;
  const r = await prisma.$queryRaw<{ s: string }[]>`
    SELECT COALESCE(SUM(l."debit" - l."credit"), 0)::text AS s
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" <= ${asOf} AND l."accountId" IN (${Prisma.join(accountIds)})
       ${partyId ? Prisma.sql`AND l."partyType" = 'CUSTOMER' AND l."partyId" = ${partyId}` : partyOnly ? Prisma.sql`AND l."partyType" = 'CUSTOMER'` : Prisma.empty}`;
  return new Prisma.Decimal(r[0].s);
}

/** Allocations that count as of a date (receipt allocations only from posted bank lines). */
async function allocationsAsOf(asOf: Date, where: Prisma.ArAllocationWhereInput = {}) {
  const after = nextDay(asOf);
  const rows = await prisma.arAllocation.findMany({
    where: { ...where, allocatedOn: { lte: asOf }, OR: [{ active: true }, { removedAt: { gte: after } }] },
    include: { receipt: { select: { bankTransactionId: true } } },
  });
  const posted = await postedBankLines(prisma, rows.filter((r) => r.receipt).map((r) => r.receipt!.bankTransactionId));
  return rows.filter((r) => !r.receipt || posted.has(r.receipt.bankTransactionId));
}

/** Customer receipts whose bank line has posted and was not voided by the date. */
async function postedReceiptsAsOf(asOf: Date, customerId?: string) {
  const after = nextDay(asOf);
  const rs = await prisma.customerReceipt.findMany({ where: { ...(customerId ? { customerId } : {}) }, include: { customer: { select: { name: true, nameAr: true } } } });
  const txns = new Map((await prisma.bankTransaction.findMany({ where: { id: { in: rs.map((r) => r.bankTransactionId) } }, select: { id: true, txnDate: true, status: true, voidedAt: true, bankReference: true, voidReason: true } })).map((t) => [t.id, t]));
  const posted = await postedBankLines(prisma, rs.map((r) => r.bankTransactionId));
  return rs.filter((r) => posted.has(r.bankTransactionId)).map((r) => ({ ...r, txn: txns.get(r.bankTransactionId)! }))
    .filter((r) => r.txn.txnDate <= asOf && !(r.txn.status === "VOID" && r.txn.voidedAt && r.txn.voidedAt < after));
}

export async function arAging(asOf: Date) {
  const invoices = await prisma.salesInvoice.findMany({ where: { kind: "INVOICE", status: "POSTED", issueDate: { lte: asOf } }, include: { customer: { select: { id: true, name: true, nameAr: true } } }, orderBy: [{ dueDate: "asc" }, { invoiceNo: "asc" }] });
  const allocs = await allocationsAsOf(asOf);
  const byInvoice = new Map<string, Prisma.Decimal>();
  for (const a of allocs) byInvoice.set(a.invoiceId, (byInvoice.get(a.invoiceId) ?? ZERO).add(a.amount));
  const tot: Record<Bucket, Prisma.Decimal> = { current: ZERO, d1_30: ZERO, d31_60: ZERO, d61_90: ZERO, d90p: ZERO };
  const byCustomer = new Map<string, { customer: string; b: Record<Bucket, Prisma.Decimal>; n: number; credits: Prisma.Decimal }>();
  const cust = (id: string, name: string) => { const e = byCustomer.get(id) ?? { customer: name, b: { current: ZERO, d1_30: ZERO, d31_60: ZERO, d61_90: ZERO, d90p: ZERO }, n: 0, credits: ZERO }; byCustomer.set(id, e); return e; };
  for (const inv of invoices) {
    const open = dec(inv.totalGross).sub(byInvoice.get(inv.id) ?? ZERO);
    if (open.lte(0)) continue;
    const k = agingBucket(inv.dueDate, asOf);
    const e = cust(inv.customerId, inv.customer.nameAr ?? inv.customer.name);
    e.b[k] = e.b[k].add(open); e.n++; tot[k] = tot[k].add(open);
  }
  // Unapplied credits: credit notes not (yet) used, and receipt receivables parts not allocated.
  const cns = await prisma.salesInvoice.findMany({ where: { kind: "CREDIT_NOTE", status: "POSTED", issueDate: { lte: asOf } }, include: { customer: { select: { name: true, nameAr: true } } } });
  const usedByCn = new Map<string, Prisma.Decimal>();
  for (const a of allocs) if (a.creditNoteId) usedByCn.set(a.creditNoteId, (usedByCn.get(a.creditNoteId) ?? ZERO).add(a.amount));
  let credits = ZERO;
  for (const c of cns) { const left = dec(c.totalGross).sub(usedByCn.get(c.id) ?? ZERO); if (!left.isZero()) { cust(c.customerId, c.customer.nameAr ?? c.customer.name).credits = cust(c.customerId, "").credits.add(left); credits = credits.add(left); } }
  const receipts = await postedReceiptsAsOf(asOf);
  const usedByReceipt = new Map<string, Prisma.Decimal>();
  for (const a of allocs) if (a.receiptId) usedByReceipt.set(a.receiptId, (usedByReceipt.get(a.receiptId) ?? ZERO).add(a.amount));
  for (const r of receipts) { const left = dec(r.arAmount).sub(usedByReceipt.get(r.id) ?? ZERO); if (!left.isZero()) { cust(r.customerId, r.customer.nameAr ?? r.customer.name).credits = cust(r.customerId, "").credits.add(left); credits = credits.add(left); } }

  const openTotal = AGING_BUCKETS.reduce((s, k) => s.add(tot[k]), ZERO);
  const subledger = openTotal.sub(credits);
  const ar = await roleAccount("AR_CONTROL");
  const ledger = ar ? await balance([ar], asOf) : null;
  const assignedNotPosted = await prisma.customerReceipt.count({ where: { voided: false } }) - (await postedBankLines(prisma, (await prisma.customerReceipt.findMany({ where: { voided: false }, select: { bankTransactionId: true } })).map((r) => r.bankTransactionId))).size;
  const pendingDocs = await prisma.accountingEvent.count({ where: { sourceModule: "receivables", status: { in: ["PENDING", "BLOCKED", "FAILED"] } } });
  const difference = ledger === null ? null : ledger.sub(subledger);

  // Advances: per customer, receipts' advance parts less applications (as of), and the ledger.
  const after = nextDay(asOf);
  const apps = await prisma.advanceApplication.findMany({ where: { appliedOn: { lte: asOf }, OR: [{ status: "POSTED" }, { reversedAt: { gte: after } }] } });
  const adv = new Map<string, { customer: string; amount: Prisma.Decimal; vat: Prisma.Decimal }>();
  for (const r of receipts) { const e = adv.get(r.customerId) ?? { customer: r.customer.nameAr ?? r.customer.name, amount: ZERO, vat: ZERO }; e.amount = e.amount.add(r.advanceAmount); e.vat = e.vat.add(r.advanceVat); adv.set(r.customerId, e); }
  for (const a of apps) { const e = adv.get(a.customerId); if (e) { e.amount = e.amount.sub(a.amount); e.vat = e.vat.sub(a.vatPortion); } }
  const advancesTotal = [...adv.values()].reduce((s, e) => s.add(e.amount), ZERO);
  const advAcc = await roleAccount("CUSTOMER_ADVANCES");
  const vatAcc = await roleAccount("OUTPUT_VAT");
  const advLedger = advAcc && vatAcc ? (await balance([advAcc], asOf)).add(await balance([vatAcc], asOf, undefined, true)).neg() : null;

  return {
    asOf,
    rows: [...byCustomer.entries()].map(([customerId, e]) => ({ customerId, customer: e.customer, invoices: e.n,
      buckets: Object.fromEntries(AGING_BUCKETS.map((k) => [k, e.b[k].toFixed(2)])) as Record<Bucket, string>,
      credits: e.credits.toFixed(2), total: AGING_BUCKETS.reduce((s, k) => s.add(e.b[k]), ZERO).sub(e.credits).toFixed(2) }))
      .sort((a, b) => a.customer.localeCompare(b.customer, "ar")),
    totals: Object.fromEntries(AGING_BUCKETS.map((k) => [k, tot[k].toFixed(2)])) as Record<Bucket, string>,
    credits: credits.toFixed(2), subledger: subledger.toFixed(2), ledger: ledger?.toFixed(2) ?? null, difference: difference?.toFixed(2) ?? null,
    reconciled: difference !== null && difference.isZero(),
    explanation: { receiptsAssignedNotYetPosted: assignedNotPosted, documentsWaitingToPost: pendingDocs },
    advances: {
      rows: [...adv.entries()].filter(([, e]) => !e.amount.isZero()).map(([customerId, e]) => ({ customerId, customer: e.customer, amount: e.amount.toFixed(2), vat: e.vat.toFixed(2) })),
      total: advancesTotal.toFixed(2), ledger: advLedger?.toFixed(2) ?? null, reconciled: advLedger !== null && advLedger.equals(advancesTotal),
    },
  };
}

type Mv = { date: Date; kind: "invoice" | "credit_note" | "receipt" | "refund" | "reversal"; ref: string; refId: string; text: string; debit: Prisma.Decimal; credit: Prisma.Decimal };

export async function customerStatement(customerId: string, from: Date, to: Date) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new AccountingError("Customer not found.", 404);
  if (from > to) throw new AccountingError("The start date is after the end date.", 400);
  const docs = await prisma.salesInvoice.findMany({ where: { customerId, status: { in: ["POSTED", "REVERSED"] }, issueDate: { lte: to } }, orderBy: { issueDate: "asc" } });
  const moves: Mv[] = [];
  for (const d of docs) {
    const ref = `${d.kind === "CREDIT_NOTE" ? "CN" : "INV"}-${d.invoiceNo}`;
    const g = dec(d.totalGross);
    if (d.kind === "INVOICE") moves.push({ date: d.issueDate, kind: "invoice", ref, refId: d.id, text: `فاتورة ${ref}${d.description ? ` — ${d.description}` : ""}`, debit: g, credit: ZERO });
    else moves.push({ date: d.issueDate, kind: "credit_note", ref, refId: d.id, text: `إشعار دائن ${ref} — ${d.reason ?? ""}`, debit: ZERO, credit: g });
    if (d.status === "REVERSED" && d.reversedAt) {
      const day = accountingDateOf(d.reversedAt);
      moves.push({ date: day, kind: "reversal", ref, refId: d.id, text: `عكس ${ref} — ${d.reversalReason ?? ""}`, debit: d.kind === "INVOICE" ? ZERO : g, credit: d.kind === "INVOICE" ? g : ZERO });
    }
  }
  const receipts = await prisma.customerReceipt.findMany({ where: { customerId } });
  const posted = await postedBankLines(prisma, receipts.map((r) => r.bankTransactionId));
  const txns = new Map((await prisma.bankTransaction.findMany({ where: { id: { in: receipts.map((r) => r.bankTransactionId) } } })).map((t) => [t.id, t]));
  for (const r of receipts.filter((x) => posted.has(x.bankTransactionId))) {
    const t = txns.get(r.bankTransactionId)!;
    const amt = dec(r.amount);
    const ref = t.bankReference ?? `RC-${r.receiptNo}`;
    moves.push({ date: t.txnDate, kind: amt.isPositive() ? "receipt" : "refund", ref, refId: r.id, text: amt.isPositive() ? `تحصيل ${ref}${dec(r.advanceAmount).gt(0) ? ` (منه دفعة مقدمة ${dec(r.advanceAmount).toFixed(2)})` : ""}` : `رد مبلغ ${ref}`, debit: amt.isNegative() ? amt.abs() : ZERO, credit: amt.isPositive() ? amt : ZERO });
    if (t.status === "VOID" && t.voidedAt) moves.push({ date: accountingDateOf(t.voidedAt), kind: "reversal", ref, refId: r.id, text: `إلغاء الحركة البنكية — ${t.voidReason ?? ""}`, debit: amt.isPositive() ? amt : ZERO, credit: amt.isNegative() ? amt.abs() : ZERO });
  }
  moves.sort((a, b) => a.date.getTime() - b.date.getTime() || a.ref.localeCompare(b.ref));
  let opening = ZERO;
  const within = moves.filter((m) => { if (m.date < from) { opening = opening.add(m.debit).sub(m.credit); return false; } return m.date <= to; });
  let run = opening;
  const lines = within.map((m) => { run = run.add(m.debit).sub(m.credit); return { ...m, debit: m.debit.toFixed(2), credit: m.credit.toFixed(2), balance: run.toFixed(2) }; });
  const accts = (await prisma.accountMapping.findMany({ where: { role: { in: ["AR_CONTROL", "CUSTOMER_ADVANCES", "OUTPUT_VAT"] } }, select: { accountId: true } })).map((m) => m.accountId);
  const ledgerBalance = await balance(accts, to, customerId);
  const open = await prisma.salesInvoice.count({ where: { customerId, kind: "INVOICE", status: "POSTED" } });
  return {
    customer: { id: customer.id, name: customer.nameAr ?? customer.name, vatNumber: customer.vatNumber, crNumber: customer.crNumber, paymentTermsDays: customer.paymentTermsDays },
    from, to, opening: opening.toFixed(2), lines, closing: run.toFixed(2), ledgerBalance: ledgerBalance.toFixed(2), reconciled: ledgerBalance.equals(run), postedInvoices: open,
  };
}

/** Customer bank lines (receipts and refunds) with their assignment and posting state. */
export async function receiptsQueue() {
  const lines = await prisma.bankTransaction.findMany({
    where: { classification: { in: ["CUSTOMER_RECEIPT", "CUSTOMER_REFUND"] }, status: "CONFIRMED" },
    orderBy: [{ txnDate: "desc" }, { createdAt: "desc" }], take: 200,
    include: { cashAccount: { select: { code: true } }, matches: { where: { active: true, targetType: "SALES_COLLECTION" } } },
  });
  const receipts = new Map((await prisma.customerReceipt.findMany({ where: { bankTransactionId: { in: lines.map((l) => l.id) } }, include: { customer: { select: { name: true, nameAr: true } }, allocations: { where: { active: true }, include: { invoice: { select: { invoiceNo: true } } } } } })).map((r) => [r.bankTransactionId, r]));
  const events = new Map((await prisma.accountingEvent.findMany({ where: { idempotencyKey: { in: lines.map((l) => `bank:${l.id}:confirmed`) } }, select: { sourceDocumentId: true, status: true, errorMessage: true } })).map((e) => [e.sourceDocumentId, e]));
  const collections = new Map((await prisma.salesCollection.findMany({ where: { id: { in: lines.flatMap((l) => l.matches.map((m) => m.targetId)) } }, include: { customer: { select: { id: true, name: true, nameAr: true } }, order: { select: { orderNumber: true } } } })).map((c) => [c.id, c]));
  const settings = await prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { advanceVatTreatment: true, bankPostingFrom: true } });
  return {
    settings,
    rows: lines.map((l) => {
      const r = receipts.get(l.id);
      const c = l.matches[0] ? collections.get(l.matches[0].targetId) : undefined;
      const ev = events.get(l.id);
      return {
        id: l.id, txnDate: l.txnDate, amount: l.amount.toFixed(2), classification: l.classification, reviewStatus: l.reviewStatus, bankReference: l.bankReference, description: l.description, counterparty: l.counterparty, cashAccount: l.cashAccount.code,
        collection: c ? { id: c.id, reference: c.referenceNumber, customerId: c.customer?.id ?? null, customer: c.customer ? c.customer.nameAr ?? c.customer.name : null, orderNumber: c.order?.orderNumber ?? null, status: c.status } : null,
        receipt: r ? { id: r.id, receiptNo: r.receiptNo, customerId: r.customerId, customer: r.customer.nameAr ?? r.customer.name, arAmount: r.arAmount.toFixed(2), advanceAmount: r.advanceAmount.toFixed(2), advanceVat: r.advanceVat.toFixed(2), allocations: r.allocations.map((a) => ({ invoiceNo: a.invoice.invoiceNo, amount: a.amount.toFixed(2) })) } : null,
        posting: ev ? { status: ev.status, reason: ev.errorMessage } : null,
        beforeStart: settings?.bankPostingFrom ? l.txnDate < settings.bankPostingFrom : true,
      };
    }),
  };
}

export async function customersForReceivables(q?: string | null) {
  const text = q?.trim();
  const cs = await prisma.customer.findMany({ where: text ? { OR: [{ name: { contains: text, mode: "insensitive" } }, { nameAr: { contains: text, mode: "insensitive" } }, { vatNumber: { contains: text } }] } : {}, orderBy: { name: "asc" }, take: 200 });
  const open = await prisma.salesInvoice.groupBy({ by: ["customerId"], where: { customerId: { in: cs.map((c) => c.id) }, kind: "INVOICE", status: "POSTED" }, _sum: { totalGross: true } });
  const allocs = await prisma.arAllocation.findMany({ where: { active: true, invoice: { customerId: { in: cs.map((c) => c.id) } } }, select: { amount: true, invoice: { select: { customerId: true } } } });
  const owed = new Map(open.map((o) => [o.customerId, dec(o._sum.totalGross)]));
  for (const a of allocs) owed.set(a.invoice.customerId, (owed.get(a.invoice.customerId) ?? ZERO).sub(a.amount));
  return cs.map((c) => ({ id: c.id, name: c.nameAr ?? c.name, nameEn: c.name, vatNumber: c.vatNumber, crNumber: c.crNumber, paymentTermsDays: c.paymentTermsDays, creditLimit: c.creditLimit?.toFixed(2) ?? null, openReceivables: (owed.get(c.id) ?? ZERO).toFixed(2) }));
}

export const todayOr = (v: string | null) => (v ? v : todayAccountingDate().toISOString().slice(0, 10));
export { DAY };
