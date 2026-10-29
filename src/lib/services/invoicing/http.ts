// Sales invoicing A2 — the routes' shared pieces: the viewer's customer scope, and the document as the API shows it.
import { prisma } from "@/lib/db";
import type { Permissions } from "@/lib/auth-shared";
import { seesAllInvoices } from "./access";
import { Decimal, inclusiveDifference, m2, type TaxCategory } from "./pricing";
import type { LoadedDocument } from "./service";

type Viewer = { id: string; permissions: Permissions };

/** null = every customer; otherwise the ids of the customers whose account the viewer owns. */
export async function scopedCustomerIds(user: Viewer): Promise<string[] | null> {
  if (seesAllInvoices(user.permissions)) return null;
  const rows = await prisma.customer.findMany({ where: { accountOwnerId: user.id }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function inScope(user: Viewer, customerId: string): Promise<boolean> {
  const ids = await scopedCustomerIds(user);
  return ids === null || ids.includes(customerId);
}

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const D = (v: { toString(): string } | null | undefined) => new Decimal(v == null ? 0 : v.toString());

/** The document as the screens read it (money as 2-decimal text, dates as days). */
export function documentJson(doc: LoadedDocument, extra: { open?: Decimal | null; entries?: { id: string; ref: string | null; event: string | null; status: string }[] } = {}) {
  const applied = doc.applications.filter((a) => a.status === "APPLIED").reduce((s, a) => s.plus(D(a.amount)), new Decimal(0));
  const creditUsed = doc.creditApplications.filter((a) => a.status === "APPLIED").reduce((s, a) => s.plus(D(a.amount)), new Decimal(0));
  return {
    id: doc.id, uuid: doc.uuid, kind: doc.kind, family: doc.family, status: doc.status, number: doc.number, series: doc.series,
    customerId: doc.customerId, orderId: doc.orderId, quoteId: doc.quoteId, source: doc.source, branchId: doc.branchId, channel: doc.channel, externalOrderRef: doc.externalOrderRef,
    originalInvoice: doc.originalInvoice ? { ...doc.originalInvoice, issueDate: day(doc.originalInvoice.issueDate), grandTotal: m2(doc.originalInvoice.grandTotal) } : null,
    reasonCode: doc.reasonCode, reason: doc.reason,
    issueDate: day(doc.issueDate), issueTime: doc.issueTime, issuedAt: doc.issuedAt, supplyDate: day(doc.supplyDate), supplyEndDate: day(doc.supplyEndDate),
    dueDate: day(doc.dueDate), paymentTermsDays: doc.paymentTermsDays, currency: doc.currency,
    totals: { lineExtension: m2(doc.lineExtensionTotal), discount: m2(doc.discountTotal), taxable: m2(doc.taxableTotal), tax: m2(doc.taxTotal), grand: m2(doc.grandTotal) },
    taxBreakdown: doc.taxBreakdown, buyer: doc.buyer, seller: doc.seller, notes: doc.notes,
    createdById: doc.createdById, issuedById: doc.issuedById, sodBypass: doc.sodBypass, createdAt: doc.createdAt,
    cancelledAt: doc.cancelledAt, cancelReason: doc.cancelReason,
    request: { requestedAt: doc.requestedAt, requestedById: doc.requestedById, note: doc.requestNote },
    zatca: { icv: doc.zatcaIcv?.toString() ?? null, status: doc.zatcaStatus, hash: doc.zatcaInvoiceHash, qr: doc.zatcaQr, ref: doc.zatcaXmlRef },
    lines: doc.lines.map((l) => ({
      id: l.id, position: l.position, orderItemId: l.orderItemId, deliveryId: l.deliveryId, productSkuId: l.productSkuId, originalLineId: l.originalLineId,
      description: l.description, descriptionEn: l.descriptionEn, skuCode: l.skuCode, quantity: D(l.quantity).toString(), unit: l.unit,
      unitPrice: m2(l.unitPrice), discountPercent: D(l.discountPercent).toString(), discountAmount: m2(l.discountAmount),
      taxCategory: l.taxCategory, taxRatePercent: D(l.taxRatePercent).toString(), exemptionReasonCode: l.exemptionReasonCode, exemptionReason: l.exemptionReason,
      lineNet: m2(l.lineNet), lineTax: m2(l.lineTax), lineTotal: m2(l.lineTotal),
      // «شامل؟» (WP-K): the gross as typed and «فرق التقريب» (qty × gross vs the line's value; a few halalas at most).
      priceIncludesVat: l.priceIncludesVat, unitPriceGross: l.enteredGrossUnitPrice === null ? null : m2(l.enteredGrossUnitPrice),
      roundingDifference: l.priceIncludesVat ? m2(inclusiveDifference({ quantity: D(l.quantity), unitPrice: D(l.unitPrice), discountPercent: D(l.discountPercent), taxCategory: l.taxCategory as TaxCategory, taxRatePercent: D(l.taxRatePercent), enteredGrossUnitPrice: D(l.enteredGrossUnitPrice!) })) : null,
      kind: l.kind, fixedAssetId: l.fixedAssetId, disposalKind: l.disposalKind,
    })),
    notesIssued: doc.notesIssued.map((n) => ({ ...n, issueDate: day(n.issueDate), grandTotal: m2(n.grandTotal) })),
    applications: doc.applications.map((a) => ({ id: a.id, collectionId: a.collectionId, creditNoteId: a.creditNoteId, amount: m2(a.amount), appliedDate: day(a.appliedDate), atReceipt: a.atReceipt, status: a.status, reverseReason: a.reverseReason })),
    creditApplications: doc.creditApplications.map((a) => ({ id: a.id, invoiceId: a.invoiceId, amount: m2(a.amount), appliedDate: day(a.appliedDate), status: a.status })),
    paid: m2(applied),
    open: doc.status === "ISSUED" && doc.kind !== "CREDIT_NOTE" ? m2(D(doc.grandTotal).minus(applied)) : null,
    creditLeft: doc.status === "ISSUED" && doc.kind === "CREDIT_NOTE" ? m2(D(doc.grandTotal).minus(creditUsed)) : null,
    entries: extra.entries ?? [],
  };
}
