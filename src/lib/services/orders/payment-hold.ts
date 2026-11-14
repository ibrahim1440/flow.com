// P1 «fake cash» hold (owner decision أ, 12 Nov 2026 — 20261231100000_direct_sale_payment_hold).
// A cash / card direct sale is exempt from the credit-limit block because it is paid at the time of sale (owner Q1 = أ).
// When that exemption is what let it through — the customer was OVER the limit — the order is HELD until the accountant
// verifies the sale's own paid-now collection:
//   «بانتظار تأكيد استلام المبلغ» Order.paymentHold = PENDING, status «Waiting Approval» (the pre-preparation status the
//     automatic preparation, the stations and the deliveries never take). Every path that moves the order on refuses it:
//     the routes here with ORDER_AWAITING_PAYMENT (409), and the database trigger Order_payment_hold_guard whatever the path.
//   collection APPROVED → RELEASED, «Waiting Preparation Review», preparation starts (the caller runs autoPrepareOrder).
//   collection REJECTED → REJECTED «رُفض الإيصال»: still held; it proceeds only through the normal credit check (the
//     customer back within the limit, or a supervisor's DIRECT_SALE override for the rep) — releaseRejectedHold.
// A sale within the limit is never held (paymentHold stays NULL). A non-NULL value records that the exemption was used.
import type { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/accounting/money";
import { customerExposure } from "@/lib/services/customers/exposure";

type Tx = Prisma.TransactionClient;

export const HELD_PAYMENT = ["PENDING", "REJECTED"] as const;
export const PAYMENT_HOLD_LABEL_AR = "بانتظار تأكيد استلام المبلغ";
export const PAYMENT_HOLD_LABEL_EN = "Awaiting payment confirmation";
export const PAYMENT_REJECTED_LABEL_AR = "رُفض الإيصال";
export const PAYMENT_REJECTED_LABEL_EN = "Receipt rejected";
const HELD_AR = "الطلب بيع مباشر بانتظار تأكيد استلام المبلغ من المحاسب — ما يتجهّز ولا يُشحن قبله.";
const HELD_EN = "This direct sale is waiting for the accountant to confirm its payment — it is not prepared or dispatched before that.";
const REJECTED_AR = "رُفض إيصال البيع المباشر — الطلب موقوف حتى يرجع العميل تحت حد الائتمان أو يعتمد المشرف تجاوز الحد.";
const REJECTED_EN = "The direct sale's receipt was rejected — the order is held until the customer is within the credit limit or a supervisor approves going over it.";

export function isPaymentHeld(hold: string | null | undefined): boolean {
  return !!hold && (HELD_PAYMENT as readonly string[]).includes(hold);
}

export function awaitingPaymentRefusal(hold: string | null | undefined) {
  const rejected = hold === "REJECTED";
  const ar = rejected ? REJECTED_AR : HELD_AR;
  return { _appCode: 409, code: "ORDER_AWAITING_PAYMENT", message: ar, error: ar, errorAr: ar, errorEn: rejected ? REJECTED_EN : HELD_EN, paymentHold: hold };
}

/** The label of an order's hold, or null. */
export function paymentHoldLabel(hold: string | null | undefined): { ar: string; en: string; tone: "warn" | "danger" } | null {
  if (hold === "PENDING") return { ar: PAYMENT_HOLD_LABEL_AR, en: PAYMENT_HOLD_LABEL_EN, tone: "warn" };
  if (hold === "REJECTED") return { ar: PAYMENT_REJECTED_LABEL_AR, en: PAYMENT_REJECTED_LABEL_EN, tone: "danger" };
  return null;
}

/** A Postgres refusal from Order_payment_hold_guard → the coded 409 (null for any other error). */
export function paymentHoldDbRefusal(err: unknown) {
  const m = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? "");
  return m.includes("ORDER_AWAITING_PAYMENT") ? awaitingPaymentRefusal("PENDING") : null;
}

/**
 * At «أرسل» of a cash / card direct sale paid now (credit "SKIP"): would the credit limit have refused it? Then the
 * exemption is what let it through, and the order is held. Pure arithmetic on the one exposure source; an override is not
 * consulted (none is consumed by a paid sale).
 */
export async function overLimitAtSale(tx: Tx, customerId: string, orderId: string, gross: string, now: Date): Promise<boolean> {
  const lim = await tx.customer.findUnique({ where: { id: customerId }, select: { creditLimit: true } });
  if (!lim || lim.creditLimit == null) return false;
  await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
  const e = (await customerExposure(tx, [customerId], now, { exceptOrderId: orderId })).get(customerId)!;
  return e.commitment.plus(new Decimal(gross)).greaterThan(e.limit!);
}

/** Hold the order (inside the sale's transaction, after the sale completed). */
export async function holdForPayment(tx: Tx, o: { id: string; orderNumber: number; customerId: string; gross: string; actor: { id: string; name: string }; collectionId: string | null }) {
  await tx.order.update({ where: { id: o.id }, data: { status: "Waiting Approval", paymentHold: "PENDING" } });
  const { appendOrderActivity } = await import("@/lib/services/order-operations");
  await appendOrderActivity(tx, { orderId: o.id, type: "DIRECT_SALE", authorId: o.actor.id, authorName: o.actor.name, message: `${PAYMENT_HOLD_LABEL_AR} — العميل فوق حد الائتمان، والطلب ما يتجهّز قبل تأكيد المحاسب`, metadata: { paymentHold: "PENDING", collectionId: o.collectionId } });
  const { audit } = await import("@/lib/hr/core");
  await audit(tx, { action: "DIRECT_SALE_PAYMENT_HOLD", entityType: "Order", entityId: o.id, actorId: o.actor.id, after: { paymentHold: "PENDING", collectionId: o.collectionId, gross: o.gross } });
  const c = await tx.customer.findUnique({ where: { id: o.customerId }, select: { name: true } });
  const { notify } = await import("@/lib/notifications/notify");
  await notify(tx, {
    event: "sales.payment_hold_pending", dedupeKey: o.id, actorId: o.actor.id, entity: { type: "Order", id: o.id },
    facts: { orderNumber: o.orderNumber, orderId: o.id, customerName: c?.name ?? null, amount: `${o.gross} ⃁` },
  });
}

/** The held order whose sale recorded this collection (its DIRECT_SALE_COMPLETED audit names it), or null. */
async function heldOrderOf(tx: Tx, collectionId: string) {
  const a = await tx.hrAuditLog.findFirst({ where: { action: "DIRECT_SALE_COMPLETED", after: { path: ["collectionId"], equals: collectionId } }, select: { entityId: true } });
  if (!a) return null;
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${a.entityId} FOR UPDATE`;
  const o = await tx.order.findUnique({ where: { id: a.entityId }, select: { id: true, orderNumber: true, ownerId: true, status: true, paymentHold: true } });
  return o && o.paymentHold === "PENDING" ? o : null;
}

/** The order whose direct sale recorded `collectionId` as its own collection, or — walking the «نسخ وتصحيح» chain back
 *  (SalesCollection.replacesCollectionId, bounded) — the one a correction of it belongs to. */
export async function saleOrderOfChain(tx: Tx, collectionId: string): Promise<{ orderId: string; saleCollectionId: string } | null> {
  let cur: string | null = collectionId;
  for (let i = 0; cur && i < 20; i++) {
    const a = await tx.hrAuditLog.findFirst({ where: { action: "DIRECT_SALE_COMPLETED", after: { path: ["collectionId"], equals: cur } }, select: { entityId: true } });
    if (a) return { orderId: a.entityId, saleCollectionId: cur };
    const prev: { replacesCollectionId: string | null } | null = await tx.salesCollection.findUnique({ where: { id: cur }, select: { replacesCollectionId: true } });
    cur = prev?.replacesCollectionId ?? null;
  }
  return null;
}

/** The sale's gross, as its DIRECT_SALE_COMPLETED audit recorded it. */
async function saleGross(db: Tx, orderId: string): Promise<Decimal> {
  const a = await db.hrAuditLog.findFirst({ where: { action: "DIRECT_SALE_COMPLETED", entityId: orderId }, orderBy: { createdAt: "desc" }, select: { after: true } });
  return new Decimal(String((a?.after as { gross?: string } | null)?.gross ?? "0"));
}

/**
 * The money that pays a held sale (owner أ on top-ups): the APPROVED collections of the sale's own «نسخ وتصحيح» chain plus
 * the APPROVED top-ups linked to the order on the server (SalesCollection.holdOrderId — set only by recordHoldTopUp). A
 * collection recorded by hand on the deal is never part of it.
 */
export async function holdPayments(db: Tx, orderId: string): Promise<{ id: string; amount: Decimal; kind: "SALE" | "TOP_UP" }[]> {
  const chain = (await saleCollectionChain(db, orderId)).filter((c) => c.status === "APPROVED").map((c) => ({ id: c.id, amount: c.amountGross, kind: "SALE" as const }));
  const tops = await db.salesCollection.findMany({ where: { holdOrderId: orderId, status: "APPROVED" }, orderBy: { createdAt: "asc" }, select: { id: true, amountGross: true } });
  return [...chain, ...tops.map((t) => ({ id: t.id, amount: new Decimal(t.amountGross.toString()), kind: "TOP_UP" as const }))];
}

/**
 * Owner decision أ (gate R3 follow-up, then the top-up decision): a REJECTED hold is released, in the approving
 * transaction, once the approved money of the sale (holdPayments) covers its gross. The order row is locked first, so two
 * approvals at once serialise: the second sees the first's money and the hold already RELEASED — it releases exactly once.
 * Short of the gross: still held — the rep is told «انعتمد X من Y — باقي Z». Returns the order released, or null.
 */
async function releaseIfCovered(tx: Tx, orderId: string, collectionId: string, actorId: string, via: { saleCollectionId?: string; topUp?: boolean }): Promise<string | null> {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
  const o = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, ownerId: true, status: true, paymentHold: true } });
  if (!o || o.paymentHold !== "REJECTED" || o.status === "Cancelled") return null;
  const gross = await saleGross(tx, o.id);
  const parts = await holdPayments(tx, o.id);
  const paid = parts.reduce((s, x) => s.plus(x.amount), new Decimal(0));
  if (paid.lessThan(gross)) {
    const short = gross.minus(paid).toFixed(2);
    const what = via.topUp ? "انعتمد الباقي المسجّل" : "التحصيل المصحّح أقل من قيمة البيع";
    const { appendOrderActivity } = await import("@/lib/services/order-operations");
    const who = await tx.employee.findUnique({ where: { id: actorId }, select: { name: true } });
    await appendOrderActivity(tx, { orderId: o.id, type: "DIRECT_SALE", authorId: actorId, authorName: who?.name ?? "—", message: `${what} — انعتمد ${paid.toFixed(2)} من ${gross.toFixed(2)} ⃁، باقي ${short} ⃁ والطلب يظل موقوف`, metadata: { paymentHold: "REJECTED", collectionId, short, paid: paid.toFixed(2), gross: gross.toFixed(2) } });
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, { event: "sales.payment_hold_decided", dedupeKey: `${o.id}:SHORT:${collectionId}`, actorId, entity: { type: "Order", id: o.id }, facts: { orderNumber: o.orderNumber, orderId: o.id, decision: "REJECT", reason: `انعتمد ${paid.toFixed(2)} من ${gross.toFixed(2)} ⃁ — باقي ${short} ⃁`, short, paid: paid.toFixed(2), gross: gross.toFixed(2) }, people: { orderOwner: o.ownerId } });
    return null;
  }
  await tx.order.update({ where: { id: o.id }, data: { paymentHold: "RELEASED", status: o.status === "Waiting Approval" ? "Waiting Preparation Review" : o.status } });
  const { audit } = await import("@/lib/hr/core");
  await audit(tx, { action: "DIRECT_SALE_PAYMENT_HOLD_RELEASED", entityType: "Order", entityId: o.id, actorId, after: {
    ...(via.topUp ? { topUpCollectionId: collectionId } : { replacementCollectionId: collectionId, saleCollectionId: via.saleCollectionId ?? null }),
    amount: paid.toFixed(2), gross: gross.toFixed(2),
    collections: parts.map((x) => ({ id: x.id, amount: x.amount.toFixed(2), kind: x.kind })),
  } });
  await decided(tx, o, actorId, "APPROVE", null, collectionId);
  await closeRequestsBoundTo(tx, o.id, actorId);
  return o.id;
}

/** approveCollection's hook (same transaction): the held sale goes to preparation. Returns the released order's id. */
export async function releaseOnCollectionApproved(tx: Tx, collectionId: string, actorId: string): Promise<string | null> {
  const o = await heldOrderOf(tx, collectionId);
  if (o) {
    await tx.order.update({ where: { id: o.id }, data: { paymentHold: "RELEASED", status: o.status === "Waiting Approval" ? "Waiting Preparation Review" : o.status } });
    await decided(tx, o, actorId, "APPROVE", null, collectionId);
    await closeRequestsBoundTo(tx, o.id, actorId);
    return o.status === "Cancelled" ? null : o.id;
  }
  const c = await tx.salesCollection.findUnique({ where: { id: collectionId }, select: { holdOrderId: true, replacesCollectionId: true } });
  // A linked top-up (owner أ): counts with the sale's chain toward the gross.
  if (c?.holdOrderId) return releaseIfCovered(tx, c.holdOrderId, collectionId, actorId, { topUp: true });
  // A correction of the sale's rejected collection (the «نسخ وتصحيح» chain from the sale's own collection).
  if (!c?.replacesCollectionId) return null;
  const sale = await saleOrderOfChain(tx, c.replacesCollectionId);
  return sale ? releaseIfCovered(tx, sale.orderId, collectionId, actorId, { saleCollectionId: sale.saleCollectionId }) : null;
}

/** rejectCollection's hook (same transaction): the order stays held, «رُفض الإيصال». A rejected TOP-UP changes nothing
 *  about the hold; the rep reads that the rest was rejected and can record it again. */
export async function holdOnCollectionRejected(tx: Tx, collectionId: string, actorId: string, reason: string, reasonCode: string | null = null): Promise<void> {
  const o = await heldOrderOf(tx, collectionId);
  if (!o) {
    const c = await tx.salesCollection.findUnique({ where: { id: collectionId }, select: { holdOrderId: true } });
    if (!c?.holdOrderId) return;
    const h = await tx.order.findUnique({ where: { id: c.holdOrderId }, select: { id: true, paymentHold: true } });
    if (!h || h.paymentHold !== "REJECTED") return;
    const gross = await saleGross(tx, h.id);
    const paid = (await holdPayments(tx, h.id)).reduce((s, x) => s.plus(x.amount), new Decimal(0));
    const who = await tx.employee.findUnique({ where: { id: actorId }, select: { name: true } });
    const { appendOrderActivity } = await import("@/lib/services/order-operations");
    await appendOrderActivity(tx, { orderId: h.id, type: "DIRECT_SALE", authorId: actorId, authorName: who?.name ?? "—", message: `المحاسب رفض الباقي المسجّل: ${reason} — الطلب يظل موقوف`, metadata: { paymentHold: "REJECTED", collectionId, topUpRejected: reason, short: Decimal.max(gross.minus(paid), new Decimal(0)).toFixed(2), paid: paid.toFixed(2), gross: gross.toFixed(2) } });
    return;
  }
  await tx.order.update({ where: { id: o.id }, data: { paymentHold: "REJECTED" } });
  await decided(tx, o, actorId, "REJECT", reason, collectionId, reasonCode === "RETURN_FOR_CORRECTION");
}

/**
 * Owner أ on top-ups: «سجّل الباقي» on the held order. After a short correction was approved, the order's own rep (or a
 * holder of customers › sales_hold) records the rest as a collection LINKED to the order on the server (holdOrderId — set
 * here only, never from the client). It waits for the accountant like any collection; its approval releases the hold
 * once the money covers the gross (releaseIfCovered). 404 for anyone else (another rep's order is not confirmed to exist).
 */
export async function recordHoldTopUp(tx: Tx, input: {
  orderId: string; actor: { id: string; name: string; permissions: unknown };
  amountGross: Decimal; collectedAt: Date; paymentMethod: string; referenceNumber: string | null; note: string | null; idempotencyKey: string;
}): Promise<{ collectionId: string; replayed: boolean }> {
  const refuse = (st: number, code: string, ar: string, en: string, extra: Record<string, unknown> = {}) => ({ _appCode: st, code, message: ar, error: ar, errorAr: ar, errorEn: en, ...extra });
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE`;
  const o = await tx.order.findUnique({ where: { id: input.orderId }, select: { id: true, orderNumber: true, ownerId: true, status: true, paymentHold: true } });
  const { mayOverrideCredit } = await import("@/lib/services/customers/credit-limit");
  if (!o || (o.ownerId !== input.actor.id && !mayOverrideCredit(input.actor.permissions as never))) throw refuse(404, "NOT_FOUND", "الطلب غير موجود.", "Order not found.");
  if (o.paymentHold !== "REJECTED" || o.status === "Cancelled") throw refuse(409, "NOT_SHORT", "الطلب ما هو موقوف بباقي مبلغ.", "The order is not held for a remaining amount.");
  const gross = await saleGross(tx, o.id);
  const paid = (await holdPayments(tx, o.id)).reduce((s, x) => s.plus(x.amount), new Decimal(0));
  if (!paid.greaterThan(0) || !paid.lessThan(gross)) throw refuse(409, "NOT_SHORT", "ما فيه باقي مسجّل لهالطلب — صحّح الإيصال من «التحصيلات» أولًا.", "There is no remaining amount on this order — correct the receipt from «Collections» first.");
  // Several top-ups may wait at once (the rep and a supervisor, or the rest in two payments); the deal's own ceiling
  // (submitCollection) refuses more than is unpaid, and the order lock makes their approvals release it once.
  const link = await tx.opportunityOrder.findFirst({ where: { orderId: o.id }, orderBy: { createdAt: "asc" }, select: { opportunityId: true } });
  if (!link) throw refuse(409, "NO_DEAL", "الطلب ما له صفقة.", "The order has no deal.");
  const { submitCollection } = await import("@/lib/services/sales/collections");
  const r = await submitCollection(tx, {
    opportunityId: link.opportunityId, amountGross: input.amountGross, currency: "SAR", collectedAt: input.collectedAt,
    paymentMethod: input.paymentMethod as never, referenceNumber: input.referenceNumber, note: input.note,
    idempotencyKey: input.idempotencyKey, submittedById: input.actor.id, orderId: o.id,
  });
  if (r.replayed) return { collectionId: r.collectionId, replayed: true };
  await tx.salesCollection.update({ where: { id: r.collectionId }, data: { holdOrderId: o.id } });
  const short = gross.minus(paid);
  const { appendOrderActivity } = await import("@/lib/services/order-operations");
  await appendOrderActivity(tx, { orderId: o.id, type: "DIRECT_SALE", authorId: input.actor.id, authorName: input.actor.name, message: `سجّل الباقي ${input.amountGross.toFixed(2)} ⃁ — ينتظر تأكيد المحاسب، ولما يتأكد يتحرك الطلب لحاله`, metadata: { paymentHold: "REJECTED", collectionId: r.collectionId, topUpPending: input.amountGross.toFixed(2), short: short.toFixed(2), paid: paid.toFixed(2), gross: gross.toFixed(2) } });
  const { audit } = await import("@/lib/hr/core");
  await audit(tx, { action: "DIRECT_SALE_PAYMENT_HOLD_TOP_UP", entityType: "Order", entityId: o.id, actorId: input.actor.id, after: { collectionId: r.collectionId, amount: input.amountGross.toFixed(2), short: short.toFixed(2), gross: gross.toFixed(2) } });
  return { collectionId: r.collectionId, replayed: false };
}

async function decided(tx: Tx, o: { id: string; orderNumber: number; ownerId: string | null }, actorId: string, decision: "APPROVE" | "REJECT", reason: string | null, collectionId: string, returned = false) {
  const who = await tx.employee.findUnique({ where: { id: actorId }, select: { name: true } });
  const { appendOrderActivity } = await import("@/lib/services/order-operations");
  await appendOrderActivity(tx, {
    orderId: o.id, type: "DIRECT_SALE", authorId: actorId, authorName: who?.name ?? "—",
    message: decision === "APPROVE" ? "تأكّد استلام المبلغ — الطلب راح للتجهيز"
      : returned ? `المحاسب رجّع الإيصال: ${reason ?? ""} — صحّحه من «التحصيلات» ويتحرك الطلب لحاله` : `${PAYMENT_REJECTED_LABEL_AR}: ${reason ?? ""} — الطلب موقوف`,
    metadata: { paymentHold: decision === "APPROVE" ? "RELEASED" : "REJECTED", collectionId, reason, returned },
  });
  const { audit } = await import("@/lib/hr/core");
  await audit(tx, { action: decision === "APPROVE" ? "DIRECT_SALE_PAYMENT_RELEASED" : "DIRECT_SALE_PAYMENT_REJECTED", entityType: "Order", entityId: o.id, actorId, after: { collectionId, reason } });
  const { notify } = await import("@/lib/notifications/notify");
  await notify(tx, {
    event: "sales.payment_hold_decided", dedupeKey: `${o.id}:${decision}:${collectionId}`, actorId, entity: { type: "Order", id: o.id },
    facts: { orderNumber: o.orderNumber, orderId: o.id, decision, reason, returned: returned ? 1 : null },
    people: { orderOwner: o.ownerId },
  });
}

/**
 * Abu Fahd R2 P3: «يفتح قفل الطلب #…» — for each listed collection, the held order (PENDING / REJECTED) whose sale it pays:
 * the sale's own collection, or any correction in its «نسخ وتصحيح» chain. Shown on every row of the chain, in both
 * accountant views (sales collections, سندات العملاء).
 */
export async function heldOrderNumbersFor(db: Tx, ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const tops = ids.length ? await db.salesCollection.findMany({ where: { id: { in: ids }, holdOrderId: { not: null } }, select: { id: true, holdOrder: { select: { orderNumber: true, paymentHold: true } } } }) : [];
  for (const t of tops) if (t.holdOrder && isPaymentHeld(t.holdOrder.paymentHold)) out[t.id] = t.holdOrder.orderNumber;
  for (const id of ids) {
    if (out[id]) continue;
    let cur: string | null = id;
    for (let i = 0; cur && i < 20; i++) {
      const a = await db.hrAuditLog.findFirst({ where: { action: "DIRECT_SALE_COMPLETED", after: { path: ["collectionId"], equals: cur } }, select: { entityId: true } });
      if (a) {
        const o = await db.order.findUnique({ where: { id: a.entityId }, select: { orderNumber: true, paymentHold: true } });
        if (o && isPaymentHeld(o.paymentHold)) out[id] = o.orderNumber;
        break;
      }
      const prev: { replacesCollectionId: string | null } | null = await db.salesCollection.findUnique({ where: { id: cur }, select: { replacesCollectionId: true } });
      cur = prev?.replacesCollectionId ?? null;
    }
  }
  return out;
}

/** The sale's own collection and its «نسخ وتصحيح» successors (the chain), oldest first. */
async function saleCollectionChain(db: Tx, orderId: string): Promise<{ id: string; status: string; amountGross: Decimal }[]> {
  const a = await db.hrAuditLog.findFirst({ where: { action: "DIRECT_SALE_COMPLETED", entityId: orderId }, orderBy: { createdAt: "desc" }, select: { after: true } });
  let cur = (a?.after as { collectionId?: string } | null)?.collectionId ?? null;
  const out: { id: string; status: string; amountGross: Decimal }[] = [];
  for (let i = 0; cur && i < 20; i++) {
    const c: { id: string; status: string; amountGross: { toString(): string } } | null = await db.salesCollection.findUnique({ where: { id: cur }, select: { id: true, status: true, amountGross: true } });
    if (!c) break;
    out.push({ id: c.id, status: c.status, amountGross: new Decimal(c.amountGross.toString()) });
    const next: { id: string } | null = await db.salesCollection.findFirst({ where: { replacesCollectionId: cur }, select: { id: true } });
    cur = next?.id ?? null;
  }
  return out;
}

/**
 * Abu Fahd R2 N1 — ONE computation of a held order's credit position, shared by the 409 of «كمّل الطلب آجل», the rep's
 * panel and the supervisor's card: the order's own share of the customer's commitment (what it still commits, plus its
 * issued invoices still open, less the money of its own collection chain not yet applied to them) — «هالطلب»: what is
 * left unpaid of it — and the rest of the commitment («عليه الحين» + «طلبات معتمدة ما انفوترت» without this order).
 * total = the customer's whole commitment (never the order twice); excess = total − limit.
 */
export async function heldOrderCreditPosition(db: Tx, orderId: string, now: Date = new Date()) {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, customerId: true } });
  if (!o) return null;
  const e = (await customerExposure(db, [o.customerId], now)).get(o.customerId)!;
  const { orderRemaining } = await import("@/lib/services/customers/exposure");
  const remaining = await orderRemaining(db as never, o.id);
  const issued = await db.salesInvoice.findMany({ where: { orderId: o.id, status: "ISSUED", kind: { in: ["INVOICE", "DEBIT_NOTE"] } }, select: { id: true, grandTotal: true } });
  const applied = issued.length ? await db.arApplication.groupBy({ by: ["invoiceId"], where: { invoiceId: { in: issued.map((i) => i.id) }, status: "APPLIED" }, _sum: { amount: true } }) : [];
  const appliedTo = new Map(applied.map((x) => [x.invoiceId, new Decimal((x._sum.amount ?? 0).toString())]));
  const issuedOpen = issued.reduce((s, i) => s.plus(new Decimal(i.grandTotal.toString()).minus(appliedTo.get(i.id) ?? new Decimal(0))), new Decimal(0));
  // The sale's approved money: its chain and its linked top-ups (owner أ).
  const chain = (await holdPayments(db, o.id)).map((c) => ({ id: c.id, amountGross: c.amount }));
  const chainApplied = chain.length ? await db.arApplication.groupBy({ by: ["collectionId"], where: { collectionId: { in: chain.map((c) => c.id) }, status: "APPLIED" }, _sum: { amount: true } }) : [];
  const appliedFrom = new Map(chainApplied.map((x) => [x.collectionId!, new Decimal((x._sum.amount ?? 0).toString())]));
  const unappliedChain = chain.reduce((s, c) => s.plus(Decimal.max(c.amountGross.minus(appliedFrom.get(c.id) ?? new Decimal(0)), new Decimal(0))), new Decimal(0));
  const share = remaining.plus(issuedOpen).minus(unappliedChain);
  const order = Decimal.max(share, new Decimal(0));
  const receivable = e.receivable.minus(issuedOpen.minus(unappliedChain));
  const approvedNotInvoiced = Decimal.max(e.approvedNotInvoiced.minus(remaining), new Decimal(0));
  const others = receivable.plus(approvedNotInvoiced);
  return { customerId: o.customerId, limit: e.limit, receivable, approvedNotInvoiced, commitment: others, order, total: others.plus(order), gross: remaining, paid: chain.reduce((s, c) => s.plus(c.amountGross), new Decimal(0)) };
}

/**
 * «رُفض الإيصال» → the order proceeds only through the normal credit check, as an unpaid (on account) direct sale: the
 * customer within the limit, or a supervisor's approved DIRECT_SALE override requested by the order's rep (consumed
 * here). Called by the rep (the order's owner) or a holder of customers › sales_hold. Returns the order's id for
 * autoPrepareOrder.
 */
export async function releaseRejectedHold(tx: Tx, input: { orderId: string; actor: { id: string; name: string; permissions: unknown }; now?: Date }): Promise<string> {
  const now = input.now ?? new Date();
  const refuse = (s: number, code: string, ar: string, en: string) => ({ _appCode: s, code, message: ar, error: ar, errorAr: ar, errorEn: en });
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE`;
  const o = await tx.order.findUnique({ where: { id: input.orderId }, select: { id: true, orderNumber: true, customerId: true, ownerId: true, status: true, paymentHold: true } });
  if (!o) throw refuse(404, "NOT_FOUND", "الطلب غير موجود.", "Order not found.");
  const { mayOverrideCredit, consumeCreditOverride, creditLimitRefusal, creditLimitRefusalBare } = await import("@/lib/services/customers/credit-limit");
  if (o.ownerId !== input.actor.id && !mayOverrideCredit(input.actor.permissions as never)) throw refuse(403, "FORBIDDEN", "يكمّل الطلب صاحبه أو المشرف.", "Only the order's rep or a supervisor continues it.");
  if (o.paymentHold !== "REJECTED" || o.status === "Cancelled") throw refuse(409, "NOT_REJECTED", "الطلب ما هو موقوف برفض إيصال.", "The order is not held by a rejected receipt.");
  // Abu Fahd R2 N1: the one computation (heldOrderCreditPosition) — «هالطلب» is what is left unpaid of the order, the rest
  // of the commitment never counts it again; the normal check is «commitment (with the order) ≤ limit».
  let ov: { overrideId: string } | null = null;
  const lim = await tx.customer.findUnique({ where: { id: o.customerId }, select: { creditLimit: true } });
  let amount = new Decimal(0);
  if (lim?.creditLimit != null) {
    await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${o.customerId} FOR UPDATE`;
    const pos = (await heldOrderCreditPosition(tx, o.id, now))!;
    amount = pos.order;
    if (pos.total.greaterThan(pos.limit!)) {
      // Gate R6 G1: only an approval asked for THIS order (its resume) or a free one — never one bound to another order or
      // a quotation.
      const { overrideTarget } = await import("@/lib/services/customers/credit-limit");
      const cands = o.ownerId ? await tx.creditLimitOverride.findMany({
        where: { customerId: o.customerId, requestedById: o.ownerId, kind: "DIRECT_SALE", status: "APPROVED", amount: { gte: amount.toFixed(2) }, expiresAt: { gt: now } },
        orderBy: { decidedAt: "asc" }, select: { id: true }, take: 20,
      }) : [];
      let hit: { id: string } | null = null;
      for (const c of cands) {
        const t = await overrideTarget(tx as never, c.id);
        if (t.quoteId || (t.orderId && t.orderId !== o.id)) continue;
        hit = c; break;
      }
      if (!hit) {
        const { customerFiguresVisible } = await import("@/lib/services/sales/customer-access");
        const me = await tx.employee.findUnique({ where: { id: input.actor.id }, select: { role: true } });
        const viewer = { id: input.actor.id, role: me?.role ?? "", permissions: input.actor.permissions } as never;
        if (!(await customerFiguresVisible(viewer, o.customerId, tx as never))) throw creditLimitRefusalBare();
        throw creditLimitRefusal({ receivable: pos.receivable, approvedNotInvoiced: pos.approvedNotInvoiced, commitment: pos.commitment, limit: pos.limit }, pos.order);
      }
      ov = { overrideId: hit.id };
      await consumeCreditOverride(tx, hit.id, o.id, input.actor.id, now);
    }
  }
  await tx.order.update({ where: { id: o.id }, data: { paymentHold: "RELEASED", status: o.status === "Waiting Approval" ? "Waiting Preparation Review" : o.status } });
  const { appendOrderActivity } = await import("@/lib/services/order-operations");
  await appendOrderActivity(tx, { orderId: o.id, type: "DIRECT_SALE", authorId: input.actor.id, authorName: input.actor.name, message: ov ? "كمل الطلب آجل باعتماد المشرف لتجاوز الحد" : "كمل الطلب آجل — العميل ضمن حد الائتمان", metadata: { paymentHold: "RELEASED", overrideId: ov?.overrideId ?? null } });
  const { audit } = await import("@/lib/hr/core");
  await audit(tx, { action: "DIRECT_SALE_PAYMENT_HOLD_LIFTED", entityType: "Order", entityId: o.id, actorId: input.actor.id, after: { amount: amount.toFixed(2), overrideId: ov?.overrideId ?? null } });
  await closeRequestsBoundTo(tx, o.id, input.actor.id, now);
  return o.id;
}

/** The deal's orders still held for their money (PENDING / REJECTED, short included), oldest first. */
export async function heldOrdersOfDeal(db: Tx, opportunityId: string): Promise<{ id: string; orderNumber: number }[]> {
  return db.order.findMany({
    where: { paymentHold: { in: [...HELD_PAYMENT] }, status: { not: "Cancelled" }, opportunityLinks: { some: { opportunityId } } },
    orderBy: { createdAt: "asc" }, select: { id: true, orderNumber: true },
  });
}

/**
 * Owner أ on the manual-collection trap: while a deal has a held order, a collection recorded from the deal (or the
 * generic collections path) is refused — 409 ORDER_PAYMENT_HELD naming the order — unless it names, explicitly, one of the
 * deal's orders that is NOT held. A held order is paid only by «سجّل الباقي» (recordHoldTopUp) or the correction flow;
 * an unnamed or ambiguous target is never guessed. Returns the order the collection may name (or undefined).
 */
export async function assertDealCollectionAllowed(db: Tx, opportunityId: string, requestedOrderId: unknown): Promise<string | undefined> {
  // Gate R6 G2: behind the deal's row lock — the lock a sale's collection (submitCollection) takes before its order is
  // held — so a collection racing a held sale on the same deal queues behind it and then sees the hold.
  await db.$queryRaw`SELECT "id" FROM "Opportunity" WHERE "id" = ${opportunityId} FOR UPDATE`;
  const held = await heldOrdersOfDeal(db, opportunityId);
  if (!held.length) return typeof requestedOrderId === "string" && requestedOrderId ? requestedOrderId : undefined;
  const target = typeof requestedOrderId === "string" && requestedOrderId ? requestedOrderId : null;
  if (target && !held.some((h) => h.id === target)) {
    const link = await db.opportunityOrder.findFirst({ where: { opportunityId, orderId: target }, select: { orderId: true } });
    if (link) return target;
  }
  const h = held.find((x) => x.id === target) ?? held[0];
  const ar = `الطلب #${h.orderNumber} موقوف بانتظار المبلغ — سجّل الباقي من الطلب`;
  throw { _appCode: 409, code: "ORDER_PAYMENT_HELD", message: ar, error: ar, errorAr: ar, errorEn: `Order #${h.orderNumber} is held for its money — record the rest from the order`, orderId: h.id, orderNumber: h.orderNumber };
}

/**
 * Abu Fahd R4 F4: what is left to pay on each REJECTED hold that has approved money (a short correction / top-ups) — the
 * lists and steps read «ناقص — باقي Z ⃁» from it, the same words as the order's chip. Keyed by order id; absent = none.
 */
export async function holdShorts(db: Tx, orders: { id: string; paymentHold?: string | null }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const o of orders) {
    if (o.paymentHold !== "REJECTED") continue;
    const paid = (await holdPayments(db, o.id)).reduce((s, x) => s.plus(x.amount), new Decimal(0));
    if (!paid.greaterThan(0)) continue;
    const gross = await saleGross(db, o.id);
    if (paid.lessThan(gross)) out.set(o.id, gross.minus(paid).toFixed(2));
  }
  return out;
}

/**
 * Gate R7 (G1 expiry, the orchestrator's option a): a held order released (or cancelled) leaves nothing to approve — the
 * PENDING over-limit requests bound to it (their resume names /api/orders/<id>/payment-hold) are closed as REJECTED with
 * the system note «الطلب انفك — ما يحتاج اعتماد», decided by the person whose act released / cancelled it (the accountant
 * who approved the money, the supervisor who continued it), audited, the requester told. The independence CHECK
 * (decider ≠ requester) is kept: a request whose requester is that same person stays PENDING — its decision is refused
 * (TARGET_RELEASED) and its card says «الطلب انفك».
 */
export async function closeRequestsBoundTo(tx: Tx, orderId: string, actorId: string, now: Date = new Date()): Promise<number> {
  const o = await tx.order.findUnique({ where: { id: orderId }, select: { customerId: true } });
  if (!o) return 0;
  const pending = await tx.creditLimitOverride.findMany({ where: { customerId: o.customerId, status: "PENDING", requestedById: { not: actorId } }, select: { id: true, requestedById: true, amount: true, kind: true, reason: true } });
  if (!pending.length) return 0;
  const { overrideTarget } = await import("@/lib/services/customers/credit-limit");
  const { audit } = await import("@/lib/hr/core");
  const { notify } = await import("@/lib/notifications/notify");
  const note = "الطلب انفك — ما يحتاج اعتماد";
  let n = 0;
  for (const r of pending) {
    if ((await overrideTarget(tx as never, r.id)).orderId !== orderId) continue;
    const done = await tx.creditLimitOverride.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: "REJECTED", decidedById: actorId, decidedAt: now, decisionNote: note } });
    if (done.count !== 1) continue;
    n++;
    await audit(tx, { action: "CREDIT_OVERRIDE_REJECTED", entityType: "Customer", entityId: o.customerId, actorId, after: { requestId: r.id, amount: r.amount.toString(), kind: r.kind, reason: r.reason, note, requestedById: r.requestedById, system: "ORDER_RELEASED", orderId } });
    await notify(tx, { event: "customers.credit_override_decided", dedupeKey: `${r.id}:REJECTED`, actorId, entity: { type: "Customer", id: o.customerId }, people: { requester: r.requestedById }, facts: { decision: "REJECT", note, amount: r.amount.toString(), customerId: o.customerId, requestId: r.id, resumable: null, system: "ORDER_RELEASED" } });
  }
  return n;
}
