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
  const preview = [
    ...b.lines.map((l) => ({ account: l.account, debit: l.net.toFixed(2), credit: "", party: null as string | null })),
    ...(dec(b.totalVat).gt(0) ? [{ account: role.INPUT_VAT ?? null, debit: dec(b.totalVat).toFixed(2), credit: "", party: null }] : []),
    { account: role.AP_CONTROL ?? null, debit: "", credit: dec(b.totalGross).toFixed(2), party: b.supplier.name },
  ];
  const paidTotal = paid.reduce((s, m) => s.add(m.amount), ZERO);
  return {
    ...b, names, events, journals, audit, preview, purchaseObligation: po,
    obligation: obligation ? { id: obligation.id, status: obligation.status, amount: obligation.amount, dueDate: obligation.dueDate, paid: paidTotal.toFixed(2), remaining: dec(obligation.amount).sub(paidTotal).toFixed(2) } : null,
    payments: paid.map((m) => ({ transactionId: m.transaction.id, date: m.transaction.txnDate, reference: m.transaction.bankReference, amount: m.amount })),
  };
});

export const PATCH = accountingRoute("ap_bill_create", async ({ user, request, params }) => updateDraftBill(params.id, parseBillBody(await body(request)), user.id));
export const DELETE = accountingRoute("ap_bill_create", ({ user, params }) => deleteDraftBill(params.id, user.id));
