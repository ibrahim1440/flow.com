import { prisma } from "@/lib/db";
import { accountingRoute, body } from "@/lib/accounting/http";
import { AccountingError } from "@/lib/accounting/errors";
import { deleteDraftBill, updateDraftBill } from "@/lib/accounting/payables-service";
import { dec, ZERO } from "@/lib/accounting/money";
import { parseBillBody } from "../parse";

export const GET = accountingRoute(null, async ({ params }) => {
  const b = await prisma.supplierBill.findUnique({
    where: { id: params.id },
    include: { supplier: true, lines: { orderBy: { lineNo: "asc" }, include: { account: { select: { code: true, nameAr: true, nameEn: true } } } } },
  });
  if (!b) throw new AccountingError("Bill not found.", 404);
  const [events, audit, roles, obligation, po] = await Promise.all([
    prisma.accountingEvent.findMany({ where: { sourceModule: "payables", sourceDocumentId: b.id }, orderBy: { createdAt: "asc" }, select: { id: true, eventType: true, status: true, errorMessage: true, journalEntryId: true } }),
    prisma.finAuditLog.findMany({ where: { entityType: "accounting.bill", entityId: b.id }, orderBy: { createdAt: "asc" }, select: { action: true, userId: true, createdAt: true, reason: true } }),
    prisma.accountMapping.findMany({ where: { role: { in: ["AP_CONTROL", "INPUT_VAT", "GRNI"] } }, include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } } }),
    b.obligationId ? prisma.finObligation.findUnique({ where: { id: b.obligationId } }) : null,
    b.purchaseObligationId ? prisma.finObligation.findUnique({ where: { id: b.purchaseObligationId }, select: { id: true, description: true, amount: true, status: true } }) : null,
  ]);
  const journals = await prisma.journalEntry.findMany({ where: { id: { in: events.map((e) => e.journalEntryId).filter(Boolean) as string[] } }, select: { id: true, entryNo: true, status: true, isProvisional: true } });
  const ids = [...new Set([b.createdBy, b.submittedBy, b.approvedBy, b.postedBy, b.rejectedBy, b.reversedBy, ...audit.map((a) => a.userId)].filter(Boolean) as string[])];
  const names = Object.fromEntries((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  const paid = obligation ? await prisma.bankTransactionMatch.findMany({ where: { targetType: "OBLIGATION", targetId: obligation.id, active: true, transaction: { status: { not: "VOID" } } }, include: { transaction: { select: { id: true, txnDate: true, bankReference: true } } } }) : [];
  const role = Object.fromEntries(roles.map((r) => [r.role, r.account]));
  // What the ledger entry will be (or was): the same rule as translators/payables.ts.
  // A supplier credit note posts the other way round: Dr AP_CONTROL / Cr lines · Cr INPUT_VAT.
  const preview = b.kind === "CREDIT_NOTE" ? [
    { account: role.AP_CONTROL ?? null, debit: dec(b.totalGross).toFixed(2), credit: "", party: b.supplier.name as string | null },
    ...b.lines.map((l) => ({ account: l.account, debit: "", credit: l.net.toFixed(2), party: null as string | null })),
    ...(dec(b.totalVat).gt(0) ? [{ account: role.INPUT_VAT ?? null, debit: "", credit: dec(b.totalVat).toFixed(2), party: null }] : []),
  ] : [
    ...b.lines.map((l) => ({ account: l.account, debit: l.net.toFixed(2), credit: "", party: null as string | null })),
    ...(dec(b.totalVat).gt(0) ? [{ account: role.INPUT_VAT ?? null, debit: dec(b.totalVat).toFixed(2), credit: "", party: null }] : []),
    { account: role.AP_CONTROL ?? null, debit: "", credit: dec(b.totalGross).toFixed(2), party: b.supplier.name },
  ];
  const paidTotal = paid.reduce((s, m) => s.add(m.amount), ZERO);
  // Stage 4b supplier credits: the credited bill, credit notes against this bill, applications
  // (active and released), the SUPPLIER_CREDIT inventory documents that settle stock lines, and
  // what each credit-note line refers to.
  const isCn = b.kind === "CREDIT_NOTE";
  const [originalBill, creditNotes, creditAllocations, settlements, returnDocs, receiptLines] = await Promise.all([
    b.originalBillId ? prisma.supplierBill.findUnique({ where: { id: b.originalBillId }, select: { id: true, billNo: true, supplierInvoiceNo: true, totalGross: true, status: true } }) : null,
    isCn ? [] : prisma.supplierBill.findMany({ where: { originalBillId: b.id }, orderBy: { billNo: "asc" }, select: { id: true, billNo: true, supplierInvoiceNo: true, status: true, totalGross: true, billDate: true } }),
    prisma.apCreditAllocation.findMany({ where: isCn ? { creditNoteId: b.id } : { billId: b.id }, orderBy: { createdAt: "asc" } }),
    isCn ? prisma.invDocument.findMany({ where: { type: "SUPPLIER_CREDIT", billLineId: { in: b.lines.map((l) => l.id) } }, orderBy: { docNo: "asc" }, select: { id: true, docNo: true, status: true, docDate: true, billLineId: true, provisional: true } }) : [],
    isCn ? prisma.invDocument.findMany({ where: { id: { in: b.lines.map((l) => l.invDocumentId).filter(Boolean) as string[] } }, select: { id: true, docNo: true, docDate: true } }) : [],
    isCn ? prisma.invDocLine.findMany({ where: { id: { in: b.lines.map((l) => l.invDocLineId).filter(Boolean) as string[] } }, select: { id: true, document: { select: { id: true, docNo: true } }, item: { select: { code: true, name: true, nameAr: true } } } }) : [],
  ]);
  const counterpart = new Map((await prisma.supplierBill.findMany({ where: { id: { in: creditAllocations.map((a) => (isCn ? a.billId : a.creditNoteId)) } }, select: { id: true, billNo: true } })).map((x) => [x.id, x.billNo]));
  const settleEvents = new Map((await prisma.accountingEvent.findMany({ where: { idempotencyKey: { in: settlements.map((s) => `inventory:${s.id}:inv.document.posted`) } }, select: { sourceDocumentId: true, status: true, errorMessage: true } })).map((e) => [e.sourceDocumentId, e]));
  const applied = creditAllocations.filter((a) => a.active).reduce((s, a) => s.add(a.amount), ZERO);
  const liveCredits = creditNotes.filter((c) => c.status !== "REVERSED").reduce((s, c) => s.add(c.totalGross), ZERO);
  // Open posted bills of the supplier a posted credit note can be applied to (gross − credits − payments).
  const openBills = isCn && b.status === "POSTED" ? await (async () => {
    const bills = await prisma.supplierBill.findMany({ where: { supplierId: b.supplierId, kind: "BILL", status: "POSTED" }, orderBy: { billNo: "asc" }, select: { id: true, billNo: true, supplierInvoiceNo: true, totalGross: true, obligationId: true, dueDate: true } });
    const cr = new Map((await prisma.apCreditAllocation.groupBy({ by: ["billId"], where: { billId: { in: bills.map((x) => x.id) }, active: true }, _sum: { amount: true } })).map((x) => [x.billId, dec(x._sum.amount)]));
    const obIds = bills.map((x) => x.obligationId).filter(Boolean) as string[];
    const pd = new Map((obIds.length ? await prisma.bankTransactionMatch.groupBy({ by: ["targetId"], where: { targetType: "OBLIGATION", targetId: { in: obIds }, active: true, transaction: { status: { not: "VOID" } } }, _sum: { amount: true } }) : []).map((x) => [x.targetId, dec(x._sum.amount)]));
    return bills.map((x) => ({ id: x.id, billNo: x.billNo, supplierInvoiceNo: x.supplierInvoiceNo, dueDate: x.dueDate, open: dec(x.totalGross).sub(cr.get(x.id) ?? ZERO).sub(pd.get(x.obligationId ?? "") ?? ZERO).toFixed(2) })).filter((x) => Number(x.open) > 0);
  })() : [];
  return {
    ...b, names, events, journals, audit, preview, purchaseObligation: po,
    originalBill, creditNotes, openBills,
    creditable: isCn ? null : dec(b.totalGross).sub(liveCredits).toFixed(2),
    creditApplied: applied.toFixed(2), creditLeft: isCn ? dec(b.totalGross).sub(applied).toFixed(2) : null,
    creditAllocations: creditAllocations.map((a) => ({ id: a.id, creditNoteId: a.creditNoteId, billId: a.billId, counterpartNo: counterpart.get(isCn ? a.billId : a.creditNoteId) ?? null, amount: a.amount.toFixed(2), allocatedOn: a.allocatedOn, active: a.active, removedAt: a.removedAt })),
    settlements: settlements.map((s) => ({ ...s, lineNo: b.lines.find((l) => l.id === s.billLineId)?.lineNo ?? null, ledger: settleEvents.get(s.id) ? { status: settleEvents.get(s.id)!.status, reason: settleEvents.get(s.id)!.errorMessage } : null })),
    lineRefs: Object.fromEntries(b.lines.map((l) => {
      const rd = l.invDocumentId ? returnDocs.find((x) => x.id === l.invDocumentId) : undefined;
      const rl = l.invDocLineId ? receiptLines.find((x) => x.id === l.invDocLineId) : undefined;
      return [l.id, rd ? { documentId: rd.id, label: `#${rd.docNo}` } : rl ? { documentId: rl.document.id, label: `#${rl.document.docNo} · ${rl.item.code} · ${rl.item.nameAr ?? rl.item.name}` } : null];
    })),
    obligation: obligation ? { id: obligation.id, status: obligation.status, amount: obligation.amount, dueDate: obligation.dueDate, paid: paidTotal.toFixed(2), remaining: dec(obligation.amount).sub(paidTotal).toFixed(2) } : null,
    payments: paid.map((m) => ({ transactionId: m.transaction.id, date: m.transaction.txnDate, reference: m.transaction.bankReference, amount: m.amount })),
  };
});

export const PATCH = accountingRoute("ap_bill_create", async ({ user, request, params }) => updateDraftBill(params.id, parseBillBody(await body(request)), user.id));
export const DELETE = accountingRoute("ap_bill_create", ({ user, params }) => deleteDraftBill(params.id, user.id));
