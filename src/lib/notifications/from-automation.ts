// The automation pipeline as the notifications' event source (feat/notifications).
//
// Every hook point that raises an automation event (emitAutomationEvent, in the transaction of the
// change) also passes it here, BEFORE the automation's own "does any rule listen?" short-cut — so a
// notification never depends on a WhatsApp rule existing. Only the events below are notified; the
// rest return at once without a read. One more pipeline was not added: the same call, the same
// transaction, the same hook points.
import type { Prisma } from "@/generated/prisma/client";
import { notify } from "./notify";
import { checkCreditStandingLater } from "./credit-watch";
import type { Facts } from "./catalog";

type Tx = Prisma.TransactionClient;
type Input = { eventType: string; subjectType: string; subjectId: string; payload?: Prisma.InputJsonObject; actorId?: string | null };

export const NOTIFIED_AUTOMATION_EVENTS: ReadonlySet<string> = new Set([
  "order.created", "order.status_changed", "order.progress_changed",
  "production.order_created", "production.batch_roasted",
  "sales.quote_status_changed", "sales.collection_status_changed",
  "finance.approval_requested", "finance.approval_decided",
]);

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
const custName = (c: { name: string; nameAr: string | null } | null | undefined) => (c ? c.nameAr || c.name : "");
/** A minute bucket: the same transition of the same record within one minute is one notification. */
const minute = () => new Date().toISOString().slice(0, 16);
const money = (v: { toString(): string } | null | undefined, cur = "SAR") => (v == null ? "" : `${Number(v.toString()).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur === "SAR" ? "ر.س" : cur}`);

async function orderFacts(tx: Tx, orderId: string) {
  const o = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, orderNumber: true, ownerId: true,
      customer: { select: { id: true, name: true, nameAr: true, accountOwnerId: true } },
      opportunityLinks: { take: 1, orderBy: { createdAt: "desc" }, select: { quote: { select: { quoteNumber: true } }, opportunity: { select: { ownerId: true } } } },
    },
  });
  return o;
}

/** Notify for one automation event, if it is one the catalogue covers. Never reads otherwise. */
export async function notifyFromAutomationEvent(tx: Tx, e: Input): Promise<void> {
  if (!NOTIFIED_AUTOMATION_EVENTS.has(e.eventType)) return;
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const actorId = e.actorId ?? null;
  const entity = { type: e.subjectType, id: e.subjectId };

  switch (e.eventType) {
    case "order.created": {
      const o = await orderFacts(tx, e.subjectId);
      if (!o) return;
      const link = o.opportunityLinks[0];
      await notify(tx, {
        event: "sales.order_created", dedupeKey: o.id, actorId, entity,
        facts: { orderNumber: o.orderNumber, customerName: custName(o.customer), quoteNumber: link?.quote?.quoteNumber ?? null },
        people: { dealOwner: link?.opportunity.ownerId, customerOwner: o.customer?.accountOwnerId, orderOwner: o.ownerId },
      });
      return;
    }
    case "order.status_changed":
    case "order.progress_changed": {
      const from = str(p.from);
      const to = str(p.to);
      let status: string | null = null;
      if (e.eventType === "order.progress_changed") status = to === "part_delivered" ? "part_delivered" : null;
      else if (to === "Completed" || to === "On Hold" || to === "Cancelled") status = to;
      else if (from === "On Hold") status = "resumed";
      if (!status) return;
      const o = await orderFacts(tx, e.subjectId);
      if (!o) return;
      await notify(tx, {
        event: "sales.order_status", dedupeKey: `${o.id}:${status}:${minute()}`, actorId, entity,
        facts: { orderNumber: o.orderNumber, status, customerName: custName(o.customer), reason: str(p.reason) },
        people: { orderOwner: o.ownerId, customerOwner: o.customer?.accountOwnerId },
      });
      // A first delivery starts the payment terms: the customer's standing may change.
      if (status === "Completed" || status === "part_delivered") checkCreditStandingLater([o.customer?.id]);
      return;
    }
    case "production.order_created": {
      const po = await tx.productionOrder.findUnique({
        where: { id: e.subjectId },
        select: { id: true, productionNumber: true, targetUnits: true, expectedGreenBeanKg: true, productSku: { select: { skuCode: true, nameAr: true, name: true } } },
      });
      if (!po) return;
      await notify(tx, {
        event: "production.order_created", dedupeKey: po.id, actorId, entity,
        facts: { productionNumber: po.productionNumber, units: po.targetUnits, sku: po.productSku.nameAr || po.productSku.name || po.productSku.skuCode, skuEn: po.productSku.name || po.productSku.skuCode, greenKg: Math.round(po.expectedGreenBeanKg * 100) / 100, productionOrderId: po.id },
      });
      return;
    }
    case "production.batch_roasted": {
      const b = await tx.roastingBatch.findUnique({ where: { id: e.subjectId }, select: { id: true, batchNumber: true, status: true, product: { select: { productNameAr: true, productNameEn: true } } } });
      if (!b || b.status !== "Pending QC") return;
      await notify(tx, {
        event: "quality.batch_pending", dedupeKey: b.id, actorId, entity,
        facts: { batchNumber: b.batchNumber, productName: b.product ? b.product.productNameAr || b.product.productNameEn : "", productNameEn: b.product?.productNameEn ?? "" },
      });
      return;
    }
    case "sales.quote_status_changed": {
      const to = str(p.to);
      if (to === "ISSUED" && p.byAccounting === true) {
        const q = await tx.quote.findUnique({ where: { id: e.subjectId }, select: { id: true, quoteNumber: true, opportunity: { select: { ownerId: true, customer: { select: { name: true, nameAr: true } } } } } });
        if (!q) return;
        await notify(tx, {
          event: "sales.quote_issued_by_accounting", dedupeKey: `${q.id}:ISSUED`, actorId, entity,
          facts: { quoteNumber: q.quoteNumber, customerName: custName(q.opportunity.customer), quoteId: q.id },
          people: { dealOwner: q.opportunity.ownerId },
        });
        return;
      }
      if (to !== "ACCEPTED" && to !== "REJECTED" && to !== "EXPIRED") return;
      const q = await tx.quote.findUnique({ where: { id: e.subjectId }, select: { id: true, quoteNumber: true, opportunity: { select: { ownerId: true, customerId: true, customer: { select: { name: true, nameAr: true } } } } } });
      if (!q) return;
      await notify(tx, {
        event: "sales.quote_decided", dedupeKey: `${q.id}:${to}`, actorId, entity,
        facts: { quoteNumber: q.quoteNumber, status: to, customerName: custName(q.opportunity.customer), quoteId: q.id },
        people: { dealOwner: q.opportunity.ownerId },
      });
      if (to === "ACCEPTED") checkCreditStandingLater([q.opportunity.customerId]);
      return;
    }
    case "sales.collection_status_changed": {
      const to = str(p.to);
      const c = await tx.salesCollection.findUnique({
        where: { id: e.subjectId },
        select: { id: true, customerId: true, referenceNumber: true, receiptNumber: true, decisionReasonCode: true, source: true, amountGross: true, currency: true, submittedById: true, submittedBy: { select: { name: true } }, customer: { select: { name: true, nameAr: true } }, opportunity: { select: { customer: { select: { name: true, nameAr: true } } } } },
      });
      if (!c) return;
      const customerName = custName(c.customer ?? c.opportunity?.customer ?? null);
      if (to === "PENDING_VERIFICATION") {
        // An accountant's receipt (no deal) is not Finance's commission queue: only the accountants are told.
        if (c.source !== "ACCOUNTANT") {
          await notify(tx, {
            event: "finance.collection_pending", dedupeKey: c.id, actorId, entity,
            facts: { customerName, amount: money(c.amountGross, c.currency), submitterName: c.submittedBy.name },
          });
        }
        await notify(tx, {
          event: "finance.receipt_pending", dedupeKey: c.id, actorId, entity,
          facts: { customerName, amount: money(c.amountGross, c.currency), submitterName: c.submittedBy.name },
        });
      } else if (to === "APPROVED" || to === "REJECTED" || to === "REVERSED") {
        await notify(tx, {
          event: "sales.collection_decided", dedupeKey: `${c.id}:${to}`, actorId, entity,
          facts: { status: to, reference: c.receiptNumber ?? c.referenceNumber, customerName, amount: money(c.amountGross, c.currency), returned: to === "REJECTED" && c.decisionReasonCode === "RETURN_FOR_CORRECTION" ? "yes" : "no" },
          people: { submitter: c.submittedById },
        });
        if (to !== "REJECTED") checkCreditStandingLater([c.customerId]);
      }
      return;
    }
    case "finance.approval_requested": {
      const r = await tx.finApprovalRequest.findUnique({ where: { id: e.subjectId } });
      if (!r) return;
      const { eligibleApprovers } = await import("@/lib/automation/context");
      const approvers = r.assignedToId ? [r.assignedToId] : (await eligibleApprovers(tx, r)).map((x) => x.id);
      await notify(tx, {
        event: "finance.approval_requested", dedupeKey: r.id, actorId, entity,
        facts: { type: r.type, summary: r.summary } as Facts,
        people: { approvers: approvers.filter((id) => id !== r.requestedBy) },
      });
      return;
    }
    case "finance.approval_decided": {
      const r = await tx.finApprovalRequest.findUnique({ where: { id: e.subjectId } });
      if (!r) return;
      const decision = str(p.decision) ?? r.status;
      await notify(tx, {
        event: "finance.approval_decided", dedupeKey: `${r.id}:${decision}`, actorId, entity,
        facts: { type: r.type, summary: r.summary, decision },
        people: { requester: r.requestedBy },
      });
      return;
    }
  }
}
