import { prisma } from "@/lib/db";
import { accountingRoute, body } from "@/lib/accounting/http";
import { AccountingError } from "@/lib/accounting/errors";
import { invoicesOwedNow } from "@/lib/accounting/receivables-reports";
import { deleteDraftSalesDoc, updateDraftSalesDoc, invoiceOpen, invoiceBalances, advanceBalance } from "@/lib/accounting/receivables-service";
import { dec } from "@/lib/accounting/money";
import { parseSalesBody } from "../../parse";

export const GET = accountingRoute(null, async ({ params }) => {
  const d = await prisma.salesInvoice.findUnique({
    where: { id: params.id },
    include: { customer: true, originalInvoice: { select: { id: true, invoiceNo: true, totalGross: true } }, lines: { orderBy: { lineNo: "asc" }, include: { account: { select: { code: true, nameAr: true, nameEn: true } } } },
      creditNotes: { select: { id: true, invoiceNo: true, status: true, totalGross: true, issueDate: true } } },
  });
  if (!d) throw new AccountingError("Document not found.", 404);
  const [events, audit, roles, allocations, credited] = await Promise.all([
    prisma.accountingEvent.findMany({ where: { sourceModule: "receivables", sourceDocumentId: d.id }, orderBy: { createdAt: "asc" }, select: { id: true, eventType: true, status: true, errorMessage: true, journalEntryId: true } }),
    prisma.finAuditLog.findMany({ where: { entityId: d.id }, orderBy: { createdAt: "asc" }, select: { action: true, userId: true, createdAt: true, reason: true } }),
    prisma.accountMapping.findMany({ where: { role: { in: ["AR_CONTROL", "OUTPUT_VAT", "SALES_RETURNS"] } }, include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } } }),
    prisma.arAllocation.findMany({ where: d.kind === "INVOICE" ? { invoiceId: d.id } : { creditNoteId: d.id }, orderBy: { createdAt: "asc" },
      include: { receipt: { select: { receiptNo: true, bankTransactionId: true } }, creditNote: { select: { invoiceNo: true } }, application: { select: { applicationNo: true, status: true } }, invoice: { select: { invoiceNo: true } } } }),
    d.kind === "INVOICE" ? prisma.salesInvoice.aggregate({ where: { originalInvoiceId: d.id, status: { in: ["DRAFT", "SUBMITTED", "APPROVED", "POSTED"] } }, _sum: { totalGross: true } }) : null,
  ]);
  const journals = await prisma.journalEntry.findMany({ where: { id: { in: events.map((e) => e.journalEntryId).filter(Boolean) as string[] } }, select: { id: true, entryNo: true, status: true, isProvisional: true } });
  const ids = [...new Set([d.createdBy, d.submittedBy, d.approvedBy, d.postedBy, d.rejectedBy, d.reversedBy, ...audit.map((a) => a.userId)].filter(Boolean) as string[])];
  const names = Object.fromEntries((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  const order = d.orderId ? await prisma.order.findUnique({ where: { id: d.orderId }, select: { id: true, orderNumber: true, status: true } }) : null;
  const role = Object.fromEntries(roles.map((r) => [r.role, r.account]));
  const who = d.customer.nameAr ?? d.customer.name;
  // The journal it will post (or did): the same rule as translators/receivables.ts.
  const preview = d.kind === "INVOICE" ? [
    { account: role.AR_CONTROL ?? null, debit: dec(d.totalGross).toFixed(2), credit: "", party: who },
    ...d.lines.map((l) => ({ account: l.account, debit: "", credit: l.net.toFixed(2), party: null as string | null })),
    ...(dec(d.totalVat).gt(0) ? [{ account: role.OUTPUT_VAT ?? null, debit: "", credit: dec(d.totalVat).toFixed(2), party: null }] : []),
  ] : [
    { account: role.SALES_RETURNS ?? null, debit: dec(d.totalNet).toFixed(2), credit: "", party: null as string | null },
    ...(dec(d.totalVat).gt(0) ? [{ account: role.OUTPUT_VAT ?? null, debit: dec(d.totalVat).toFixed(2), credit: "", party: null }] : []),
    { account: role.AR_CONTROL ?? null, debit: "", credit: dec(d.totalGross).toFixed(2), party: who },
  ];
  const adv = await advanceBalance(prisma, d.customerId);
  return {
    ...d, names, events, journals, audit, preview, order,
    // open: owed as the ledger sees it (posted receipts only); allocatable: what may still be
    // allocated (every active allocation reserves); awaitingReceipt: the difference.
    ...(d.kind === "INVOICE" && d.status === "POSTED" ? await (async () => {
      const b = (await invoiceBalances(prisma, [d.id])).get(d.id);
      const owed = (await invoicesOwedNow([d])).get(d.id)!;
      return { open: owed.open.toFixed(2), inLedger: owed.inLedger, allocatable: (await invoiceOpen(prisma, d.id)).toFixed(2), awaitingReceipt: (b?.awaiting ?? dec(0)).toFixed(2) };
    })() : { open: null, allocatable: null, awaitingReceipt: null }),
    creditable: d.kind === "INVOICE" ? dec(d.totalGross).sub(dec(credited?._sum.totalGross)).toFixed(2) : null,
    customerAdvance: adv.amount.toFixed(2),
    allocations: allocations.map((a) => ({
      id: a.id, amount: a.amount.toFixed(2), allocatedOn: a.allocatedOn, active: a.active, removedAt: a.removedAt, invoiceNo: a.invoice.invoiceNo,
      source: a.receipt ? { kind: "RECEIPT", label: `RC-${a.receipt.receiptNo}` } : a.creditNote ? { kind: "CREDIT_NOTE", label: `CN-${a.creditNote.invoiceNo}` } : { kind: "ADVANCE", label: `ADV-${a.application?.applicationNo}` },
    })),
  };
});

export const PATCH = accountingRoute("ar_invoice_create", async ({ user, request, params }) => updateDraftSalesDoc(params.id, parseSalesBody(await body(request)), user.id));
export const DELETE = accountingRoute("ar_invoice_create", ({ user, params }) => deleteDraftSalesDoc(params.id, user.id));
