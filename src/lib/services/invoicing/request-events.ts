// «طلب فاتورة ضريبية» (BATCH 22 WP-C) — the request history rows (append-only, 20261126090000_invoice_requests) and the
// request notifications, written inside the caller's transaction (so they exist exactly when the change committed).
import type { Prisma } from "@/generated/prisma/client";
import { notify } from "@/lib/notifications/notify";
import { RETURN_REASON_LABEL, type ReturnReason } from "./request-math";

type Tx = Prisma.TransactionClient;

export type RequestEventKind = "REQUESTED" | "WITHDRAWN" | "RETURNED" | "EDITED_BY_ACCOUNTANT" | "ISSUED" | "CANCELLED";

export async function writeRequestEvent(tx: Tx, e: { invoiceId: string; kind: RequestEventKind; actorId: string; reasonCode?: string | null; reason?: string | null; diff?: unknown }) {
  await tx.salesInvoiceRequestEvent.create({
    data: {
      invoiceId: e.invoiceId, kind: e.kind, actorId: e.actorId, reasonCode: e.reasonCode ?? null, reason: e.reason ?? null,
      ...(e.diff ? { diff: e.diff as Prisma.InputJsonValue } : {}),
    },
  });
}

type Head = { id: string; customerId: string; grandTotal: { toString(): string }; buyer: unknown; orderId: string | null; number?: string | null };
const buyerName = (b: unknown) => ((b && typeof b === "object" ? (b as { name?: string; nameEn?: string | null }) : {}));
const amount = (v: { toString(): string }) => `${Number(v.toString()).toFixed(2)} SAR`;

/** «finance.invoice_requested» to the issuers (the accounting module required by the catalogue). */
export async function notifyRequested(tx: Tx, doc: Head, actorId: string, at: Date) {
  const [who, order] = await Promise.all([
    tx.employee.findUnique({ where: { id: actorId }, select: { name: true } }),
    doc.orderId ? tx.order.findUnique({ where: { id: doc.orderId }, select: { orderNumber: true } }) : Promise.resolve(null),
  ]);
  const b = buyerName(doc.buyer);
  await notify(tx, {
    event: "finance.invoice_requested", dedupeKey: `${doc.id}:${at.toISOString()}`, actorId,
    facts: { invoiceId: doc.id, customerName: b.name ?? "", customerNameEn: b.nameEn ?? b.name ?? "", amount: amount(doc.grandTotal), requesterName: who?.name ?? "", orderNumber: order?.orderNumber ?? null },
    entity: { type: "SalesInvoice", id: doc.id },
  });
}

/** «sales.invoice_request_returned» to the requester, with the reason. */
export async function notifyReturned(tx: Tx, doc: Head, requesterId: string, actorId: string, code: ReturnReason, reason: string, at: Date) {
  const b = buyerName(doc.buyer);
  await notify(tx, {
    event: "sales.invoice_request_returned", dedupeKey: `${doc.id}:${at.toISOString()}`, actorId,
    people: { requester: requesterId },
    facts: { invoiceId: doc.id, customerName: b.name ?? "", customerNameEn: b.nameEn ?? b.name ?? "", reasonAr: RETURN_REASON_LABEL[code][0], reasonEn: RETURN_REASON_LABEL[code][1], reason: reason.slice(0, 300) },
    entity: { type: "SalesInvoice", id: doc.id },
  });
}

/** «sales.invoice_issued» to the requester and the order's owner: Sales may now print / download it. */
export async function notifyIssued(tx: Tx, doc: Head & { number: string }, requesterId: string | null, actorId: string) {
  const order = doc.orderId ? await tx.order.findUnique({ where: { id: doc.orderId }, select: { ownerId: true } }) : null;
  if (!requesterId && !order?.ownerId) return;
  const b = buyerName(doc.buyer);
  await notify(tx, {
    event: "sales.invoice_issued", dedupeKey: doc.id, actorId,
    people: { requester: requesterId, orderOwner: order?.ownerId ?? null },
    facts: { invoiceId: doc.id, number: doc.number, customerName: b.name ?? "", customerNameEn: b.nameEn ?? b.name ?? "", amount: amount(doc.grandTotal) },
    entity: { type: "SalesInvoice", id: doc.id },
  });
}
