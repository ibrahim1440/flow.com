// Receivables reports, read from the posted ledger (open-items.ts): AR aging per invoice (each
// receivables line names the invoice or credit note it opens or settles), customer advances (the
// advances account and the customers' advance VAT), and the customer statement (the customer's
// party lines). A report "as of" a date adds up posted lines dated on or before it, so it equals the
// general ledger at every cutoff and does not change when documents are reversed or receipts
// voided later — those reversals are dated when they happen.
// Also: the queue of customer bank lines, and the customer list.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ZERO, dec } from "./money";
import { todayAccountingDate } from "./dates";
import { postedBankLines } from "./bank-posted";
import { AGING_BUCKETS, agingBucket, type Bucket } from "./stage2-service";
import { accountsBalance, openItemBalances, partyMoves, unpostedEvents } from "./open-items";

const DAY = 86_400_000;

async function roleAccount(role: string) {
  return (await prisma.accountMapping.findUnique({ where: { role }, select: { accountId: true } }))?.accountId ?? null;
}
const emptyBuckets = (): Record<Bucket, Prisma.Decimal> => ({ current: ZERO, d1_30: ZERO, d31_60: ZERO, d61_90: ZERO, d90p: ZERO });

/** Ledger balance of posted invoices as of a date (what is still owed on each), by invoice id. */
export async function invoiceLedgerOpen(invoiceIds: string[], asOf: Date = todayAccountingDate()) {
  const ar = await roleAccount("AR_CONTROL");
  const out = new Map<string, Prisma.Decimal>();
  if (!ar || !invoiceIds.length) return out;
  for (const r of await openItemBalances(ar, asOf, { itemIds: invoiceIds })) if (r.id && r.type === "SALES_INVOICE") out.set(r.id, (out.get(r.id) ?? ZERO).add(r.balance));
  return out;
}

/**
 * What each posted invoice is owed today, from the ledger. An invoice whose own journal has not
 * posted yet (policy waiting, period locked) is not in the ledger; it shows its full amount and
 * `inLedger: false`.
 */
export async function invoicesOwedNow(invoices: { id: string; totalGross: Prisma.Decimal }[]) {
  const keys = invoices.map((i) => `receivables:${i.id}:ar.invoice.posted`);
  const posted = new Set((await prisma.accountingEvent.findMany({ where: { idempotencyKey: { in: keys }, status: "TRANSLATED" }, select: { sourceDocumentId: true } })).map((e) => e.sourceDocumentId));
  const ledger = await invoiceLedgerOpen(invoices.filter((i) => posted.has(i.id)).map((i) => i.id));
  return new Map(invoices.map((i) => [i.id, posted.has(i.id) ? { open: ledger.get(i.id) ?? ZERO, inLedger: true } : { open: dec(i.totalGross), inLedger: false }]));
}

export async function arAging(asOf: Date) {
  const ar = await roleAccount("AR_CONTROL");
  const items = ar ? await openItemBalances(ar, asOf) : [];
  const invoiceIds = items.filter((i) => i.type === "SALES_INVOICE" && i.id).map((i) => i.id!);
  const invoices = new Map((await prisma.salesInvoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNo: true, dueDate: true, issueDate: true } })).map((i) => [i.id, i]));
  const customers = new Map((await prisma.customer.findMany({ where: { id: { in: [...new Set(items.map((i) => i.partyId!).filter(Boolean))] } }, select: { id: true, name: true, nameAr: true } })).map((c) => [c.id, c.nameAr ?? c.name]));

  const tot = emptyBuckets();
  const byCustomer = new Map<string, { b: Record<Bucket, Prisma.Decimal>; n: number; credits: Prisma.Decimal }>();
  const cust = (id: string) => { const e = byCustomer.get(id) ?? { b: emptyBuckets(), n: 0, credits: ZERO }; byCustomer.set(id, e); return e; };
  const open: { invoiceId: string; invoiceNo: number; customerId: string; customer: string; dueDate: Date; remaining: string; bucket: Bucket }[] = [];
  let credits = ZERO;
  for (const it of items) {
    if (it.balance.isZero() || !it.partyId) continue;
    const e = cust(it.partyId);
    const inv = it.type === "SALES_INVOICE" && it.id ? invoices.get(it.id) : undefined;
    if (inv && it.balance.isPositive()) {
      const k = agingBucket(inv.dueDate, asOf);
      e.b[k] = e.b[k].add(it.balance); e.n++; tot[k] = tot[k].add(it.balance);
      open.push({ invoiceId: inv.id, invoiceNo: inv.invoiceNo, customerId: it.partyId, customer: customers.get(it.partyId) ?? "", dueDate: inv.dueDate, remaining: it.balance.toFixed(2), bucket: k });
    } else {
      // Credit notes' unapplied balance, overpaid invoices, and credit on account.
      e.credits = e.credits.sub(it.balance); credits = credits.sub(it.balance);
    }
  }
  const openTotal = AGING_BUCKETS.reduce((s, k) => s.add(tot[k]), ZERO);
  const subledger = openTotal.sub(credits);
  const ledger = ar ? await accountsBalance([ar], asOf) : null;
  const difference = ledger === null ? null : ledger.sub(subledger);

  // Advances: per customer, the advances account and the advance VAT tagged with the customer.
  const advAcc = await roleAccount("CUSTOMER_ADVANCES");
  const vatAcc = await roleAccount("OUTPUT_VAT");
  const adv = new Map<string, { amount: Prisma.Decimal; vat: Prisma.Decimal }>();
  if (advAcc) for (const r of await openItemBalances(advAcc, asOf)) if (r.partyId) { const e = adv.get(r.partyId) ?? { amount: ZERO, vat: ZERO }; e.amount = e.amount.sub(r.balance); adv.set(r.partyId, e); }
  if (vatAcc) for (const r of await openItemBalances(vatAcc, asOf)) if (r.partyId) { const e = adv.get(r.partyId) ?? { amount: ZERO, vat: ZERO }; e.amount = e.amount.sub(r.balance); e.vat = e.vat.sub(r.balance); adv.set(r.partyId, e); }
  const advNames = new Map((await prisma.customer.findMany({ where: { id: { in: [...adv.keys()] } }, select: { id: true, name: true, nameAr: true } })).map((c) => [c.id, c.nameAr ?? c.name]));
  const advancesTotal = [...adv.values()].reduce((s, e) => s.add(e.amount), ZERO);
  const advLedger = advAcc && vatAcc ? (await accountsBalance([advAcc], asOf)).add(await partyTaggedBalance(vatAcc, asOf)).neg() : null;

  // Explanations of what is not (yet) in the ledger: documents and receipts waiting to post.
  const receipts = await prisma.customerReceipt.findMany({ where: { voided: false }, select: { bankTransactionId: true } });
  const assignedNotPosted = receipts.length - (await postedBankLines(prisma, receipts.map((r) => r.bankTransactionId))).size;
  const pendingDocs = await unpostedEvents(["ar.invoice.posted", "ar.credit_note.posted", "ar.advance.applied", "ar.credit.allocated", "ar.invoice.reversed", "ar.credit_note.reversed", "ar.advance.reversed", "ar.credit.released"]);

  return {
    asOf,
    rows: [...byCustomer.entries()].filter(([, e]) => e.n > 0 || !e.credits.isZero()).map(([customerId, e]) => ({ customerId, customer: customers.get(customerId) ?? "", invoices: e.n,
      buckets: Object.fromEntries(AGING_BUCKETS.map((k) => [k, e.b[k].toFixed(2)])) as Record<Bucket, string>,
      credits: e.credits.toFixed(2), total: AGING_BUCKETS.reduce((s, k) => s.add(e.b[k]), ZERO).sub(e.credits).toFixed(2) }))
      .sort((a, b) => a.customer.localeCompare(b.customer, "ar")),
    open: open.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.invoiceNo - b.invoiceNo).map((o) => ({ ...o, dueDate: o.dueDate })),
    totals: Object.fromEntries(AGING_BUCKETS.map((k) => [k, tot[k].toFixed(2)])) as Record<Bucket, string>,
    credits: credits.toFixed(2), subledger: subledger.toFixed(2), ledger: ledger?.toFixed(2) ?? null, difference: difference?.toFixed(2) ?? null,
    reconciled: difference !== null && difference.isZero(),
    explanation: { receiptsAssignedNotYetPosted: assignedNotPosted, documentsWaitingToPost: pendingDocs },
    advances: {
      rows: [...adv.entries()].filter(([, e]) => !e.amount.isZero()).map(([customerId, e]) => ({ customerId, customer: advNames.get(customerId) ?? "", amount: e.amount.toFixed(2), vat: e.vat.toFixed(2) })),
      total: advancesTotal.toFixed(2), ledger: advLedger?.toFixed(2) ?? null, reconciled: advLedger !== null && advLedger.equals(advancesTotal),
    },
  };
}

/** Balance of an account's lines that carry a customer (the advance VAT on output VAT). */
async function partyTaggedBalance(accountId: string, asOf: Date) {
  const r = await prisma.$queryRaw<{ s: string }[]>`
    SELECT COALESCE(SUM(l."debit" - l."credit"), 0)::text AS s
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" <= ${asOf} AND l."accountId" = ${accountId} AND l."partyType" = 'CUSTOMER'`;
  return new Prisma.Decimal(r[0].s);
}

type Kind = "invoice" | "credit_note" | "receipt" | "refund" | "reversal" | "advance" | "credit_applied" | "other";

/** Customer statement: the customer's posted lines on receivables, advances and advance VAT. */
export async function customerStatement(customerId: string, from: Date, to: Date) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new AccountingError("Customer not found.", 404);
  if (from > to) throw new AccountingError("The start date is after the end date.", 400);
  const accts = (await prisma.accountMapping.findMany({ where: { role: { in: ["AR_CONTROL", "CUSTOMER_ADVANCES", "OUTPUT_VAT"] } }, select: { accountId: true } })).map((m) => m.accountId);
  const { opening, moves } = await partyMoves(accts, customerId, from, to);
  const docIds = moves.filter((m) => m.sourceModule === "receivables").map((m) => m.sourceDocumentId!);
  const docs = new Map((await prisma.salesInvoice.findMany({ where: { id: { in: docIds } }, select: { id: true, kind: true, invoiceNo: true } })).map((d) => [d.id, d]));
  const apps = new Map((await prisma.advanceApplication.findMany({ where: { id: { in: docIds } }, select: { id: true, applicationNo: true, invoiceId: true } })).map((a) => [a.id, a]));
  const reallocs = new Map((await prisma.arAllocation.findMany({ where: { id: { in: docIds } }, select: { id: true, invoice: { select: { invoiceNo: true } }, creditNote: { select: { invoiceNo: true } } } })).map((a) => [a.id, a]));
  const txns = new Map((await prisma.bankTransaction.findMany({ where: { id: { in: moves.filter((m) => m.sourceModule === "bank").map((m) => m.sourceDocumentId!) } }, select: { id: true, bankReference: true } })).map((t) => [t.id, t]));
  let run = opening;
  const lines = moves.filter((m) => !m.net.isZero()).map((m) => {
    const reversal = !!m.eventType && /\.(reversed|voided|released)$/.test(m.eventType);
    let ref = "", refId = m.sourceDocumentId ?? m.entryId, kind: Kind = "other";
    const d = m.sourceDocumentId ? docs.get(m.sourceDocumentId) : undefined;
    if (d) { ref = `${d.kind === "CREDIT_NOTE" ? "CN" : "INV"}-${d.invoiceNo}`; kind = reversal ? "reversal" : d.kind === "CREDIT_NOTE" ? "credit_note" : "invoice"; }
    else if (m.sourceDocumentId && apps.has(m.sourceDocumentId)) { const a = apps.get(m.sourceDocumentId)!; ref = `ADV-${a.applicationNo}`; refId = a.invoiceId; kind = reversal ? "reversal" : "advance"; }
    else if (m.sourceDocumentId && reallocs.has(m.sourceDocumentId)) { const a = reallocs.get(m.sourceDocumentId)!; ref = `CN-${a.creditNote?.invoiceNo} → INV-${a.invoice.invoiceNo}`; kind = reversal ? "reversal" : "credit_applied"; }
    else if (m.sourceModule === "bank") { ref = txns.get(m.sourceDocumentId!)?.bankReference ?? `#${m.entryNo}`; kind = reversal ? "reversal" : m.net.isNegative() ? "receipt" : "refund"; }
    run = run.add(m.net);
    return { date: m.date, entryNo: m.entryNo, kind, ref, refId, text: m.description ?? "", debit: (m.net.isPositive() ? m.net : ZERO).toFixed(2), credit: (m.net.isNegative() ? m.net.neg() : ZERO).toFixed(2), balance: run.toFixed(2) };
  });
  const ledgerBalance = await accountsBalance(accts, to, customerId);
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
  const ar = await roleAccount("AR_CONTROL");
  const owed = new Map<string, Prisma.Decimal>();
  if (ar && cs.length) for (const r of await openItemBalances(ar, todayAccountingDate())) if (r.partyId) owed.set(r.partyId, (owed.get(r.partyId) ?? ZERO).add(r.balance));
  return cs.map((c) => ({ id: c.id, name: c.nameAr ?? c.name, nameEn: c.name, vatNumber: c.vatNumber, crNumber: c.crNumber, paymentTermsDays: c.paymentTermsDays, creditLimit: c.creditLimit?.toFixed(2) ?? null, openReceivables: (owed.get(c.id) ?? ZERO).toFixed(2) }));
}

export const todayOr = (v: string | null) => (v ? v : todayAccountingDate().toISOString().slice(0, 10));
export { DAY };
