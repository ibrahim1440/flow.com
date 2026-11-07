// «طلب مباشر» — an order placed without a quotation gets a deal (owner decision, option A, Nov 2026).
//
// Before this, only a quotation turned into an order linked the order to a deal (quote-to-order.ts), so an order a rep
// placed directly had no deal: nothing to record a collection against (collections.ts asks for the deal) and therefore
// no commission (accrual.ts shares a collection by the deal's owners). On live, orders #1, #2 and #5 were in that state.
//
// The rule, one function for both doors (POST /api/orders and «اربط بصفقة», POST /api/orders/[id]/deal):
//   · the order already has a deal → nothing happens (idempotent; never a second deal for one order);
//   · a deal the caller chose → it, after the checks below;
//   · else, on creation, the customer's newest OPEN deal the creator can see → linked;
//   · else a deal is OPENED FOR the order: owner — the creator when they are a scoped sales rep (it is their book),
//     else the customer's account owner when there is one, else the creator; title «طلب مباشر — <customer>»; amount =
//     the order's value VAT included (the deal amount convention: a quotation-born deal carries the quotation's grand
//     total); stage = the stage configured for the Quotation purpose; outcome WON at once (the order IS the customer's
//     commitment), with one stage event «تلقائي: طلب مباشر».
// The order's value is priced like an invoice drafted from the order (invoicing/service.ts): the SKU's catalogue price ×
// the ordered quantity, VAT at the standard rate. It is SNAPSHOT on the link (OpportunityOrder.directGross / directTax),
// so a later price change does not move what the customer owes; a deal with no accepted quotation collects against the
// sum of its direct orders (collections.ts `eligibleDocument`), so the collection and the commission run exactly as on a
// quotation-born order: same submitCollection, same Finance approval, same accrual by the deal's owner.
//
// Deliberately NOT done here:
//   · no `sales.deal_stage_changed` automation event for the deal opened for an order — its only consumers are the
//     WhatsApp / e-mail status rules, and nothing may be sent to a customer because an order was placed;
//   · no notification (the order itself already emits `order.created`);
//   · an order a rep places for an UNASSIGNED customer (orders › unassigned_customers) opens no deal — owner decision
//     3 Nov 2026: such an order assigns nothing and earns no commission, and a deal held would pull the customer into
//     the rep's book (scope.ts `ownedCustomerWhere`). «اربط بصفقة» by a supervisor can still link it later.
import { Prisma } from "@/generated/prisma/client";
import { hasModuleAccess, type Permissions } from "@/lib/auth-shared";
import { audit } from "@/lib/hr/core";
import { appendOrderActivity } from "@/lib/services/order-operations";
import { DEFAULT_VAT_RATE } from "@/lib/services/invoicing/pricing";
import { voidDirectSaleDrafts } from "@/lib/services/invoicing/service";
import { seesAllSales } from "./scope";
import { requireStageFor } from "./stages";
import { syncDealAmount } from "./deal-amount";
import { recomputeOrderFlags } from "@/lib/services/orders/order-flags";

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;
const ZERO = new Decimal(0);
const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const DIRECT_ORDER_REASON = "تلقائي: طلب مباشر";
export const DIRECT_ORDER_CANCEL_REASON = "تلقائي: إلغاء الطلب";
/** Order statuses whose value no longer counts (eligibleDocument, the deal amount). */
export const DEAD_ORDER_STATUSES = ["Cancelled", "Rejected"] as const;
export const directOrderRequestKey = (orderId: string) => `direct-order:${orderId}`;
export const directDealTitle = (customer: { name: string; nameAr: string | null }) => `طلب مباشر — ${customer.nameAr || customer.name}`.slice(0, 200);

export type Actor = { id: string; name: string; permissions: Permissions | Record<string, unknown> };
const refuse = (status: number, code: string, ar: string, en: string) => ({ _appCode: status, code, message: ar, errorAr: ar, error: ar, errorEn: en });

/** The order's value, VAT included — catalogue price × ordered quantity (units for a SKU line, else kilograms). Pure. */
export function priceDirectOrder(items: { quantityUnits: number | null; quantityKg: number; price: number | null }[], vatPercent = DEFAULT_VAT_RATE): { net: Decimal; tax: Decimal; gross: Decimal } {
  let net = ZERO;
  for (const i of items) {
    const price = i.price && i.price > 0 ? new Decimal(i.price.toFixed(2)) : ZERO;
    const qty = new Decimal(String(i.quantityUnits ?? i.quantityKg ?? 0));
    net = net.plus(round2(price.times(qty)));
  }
  net = round2(net);
  const tax = round2(net.times(new Decimal(vatPercent)).dividedBy(100));
  return { net, tax, gross: round2(net.plus(tax)) };
}

async function orderValue(tx: Tx, orderId: string) {
  const items = await tx.orderItem.findMany({ where: { orderId }, select: { quantityUnits: true, quantityKg: true, productSku: { select: { price: true } } } });
  return priceDirectOrder(items.map((i) => ({ quantityUnits: i.quantityUnits, quantityKg: i.quantityKg, price: i.productSku?.price ?? null })));
}

/**
 * Who owns the deal opened for a direct order (owner decisions, gate M3 / L2). Pure.
 *   · the customer has an ACTIVE account owner → that owner, whoever placed the order — commission follows the book
 *     (a rep who only holds some deal on another rep's account does not earn on it);
 *   · no account owner (the pool) → the creator, but only when the creator is a rep (holds the sales module);
 *   · otherwise null → NO deal is opened: an operations or other non-sales user's order for a pool customer stays
 *     unlinked, exactly like a rep's order for a pool customer (owner decision 3 Nov 2026).
 */
export function directDealOwner(actor: Actor, customer: { accountOwnerId: string | null }, accountOwnerActive: boolean): string | null {
  if (customer.accountOwnerId && accountOwnerActive) return customer.accountOwnerId;
  if (customer.accountOwnerId) return hasModuleAccess(actor.permissions as Permissions, "sales") ? actor.id : null;
  return hasModuleAccess(actor.permissions as Permissions, "sales") ? actor.id : null;
}

/** The deals this actor may link a direct order of this customer to: their own, or every one with the all-sales view. */
function dealScope(actor: Actor, ownerForNoSales: string | null) {
  if (seesAllSales(actor.permissions)) return {};
  if (!hasModuleAccess(actor.permissions as Permissions, "sales")) return { ownerId: ownerForNoSales ?? "__none__" };
  return { ownerId: actor.id };
}

export type LinkResult = { opportunityId: string; created: boolean; linked: boolean; replayed: boolean; gross: string; tax: string };

/**
 * Link a quotation-less order to a deal, or open one for it. Runs inside the caller's transaction; the order row is
 * locked, so two calls for one order serialise and the second sees the first link (`replayed`).
 *   mode "create": at order creation (`chosen` from the order form when the customer has several open deals);
 *   mode "link":   «اربط بصفقة» — `chosen` = an OPEN or WON deal of the same customer in scope, or null for «صفقة جديدة تلقائية».
 */
export async function linkDirectOrderDeal(tx: Tx, input: { orderId: string; actor: Actor; chosenOpportunityId?: string | null; mode: "create" | "link" }): Promise<LinkResult> {
  const { orderId, actor } = input;
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, customerId: true, status: true, customer: { select: { id: true, name: true, nameAr: true, accountOwnerId: true } }, opportunityLinks: { select: { opportunityId: true }, take: 1 } },
  });
  if (!order) throw refuse(404, "NOT_FOUND", "الطلب غير موجود.", "Order not found.");
  const existing = order.opportunityLinks[0];
  if (existing) {
    if (input.mode === "link") throw refuse(409, "ALREADY_LINKED", "الطلب مربوط بصفقة من قبل.", "This order is already linked to a deal.");
    return { opportunityId: existing.opportunityId, created: false, linked: false, replayed: true, gross: "0.00", tax: "0.00" };
  }
  const value = await orderValue(tx, orderId);
  const accountOwner = order.customer.accountOwnerId
    ? await tx.employee.findUnique({ where: { id: order.customer.accountOwnerId }, select: { active: true } })
    : null;
  const owner = directDealOwner(actor, order.customer, !!accountOwner?.active);
  const scope = dealScope(actor, owner);
  const linkStatuses = input.mode === "link" ? (["OPEN", "WON"] as const) : (["OPEN"] as const);

  let opportunityId: string | null = null;
  if (input.chosenOpportunityId) {
    const d = await tx.opportunity.findFirst({ where: { id: input.chosenOpportunityId, ...scope }, select: { id: true, customerId: true, outcome: true } });
    // Another rep's deal, or no such deal: the same 404 (scope.ts NOT_FOUND rule).
    if (!d) throw refuse(404, "DEAL_NOT_FOUND", "الصفقة غير موجودة.", "Deal not found.");
    if (d.customerId !== order.customerId) throw refuse(409, "DEAL_OTHER_CUSTOMER", "الصفقة لعميل آخر غير عميل الطلب.", "The deal belongs to another customer.");
    if (!(linkStatuses as readonly string[]).includes(d.outcome)) throw refuse(409, "DEAL_CLOSED", "الصفقة خاسرة — اختر صفقة مفتوحة أو رابحة.", "The deal is lost; choose an open or won deal.");
    opportunityId = d.id;
  } else if (input.mode === "create") {
    const newest = await tx.opportunity.findFirst({ where: { customerId: order.customerId, outcome: "OPEN", ...scope }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], select: { id: true } });
    opportunityId = newest?.id ?? null;
  }

  let created = false;
  if (!opportunityId) {
    // Nobody to own it (a non-rep's order for a pool customer): the order stays unlinked — no deal, no commission.
    if (!owner) {
      if (input.mode === "link") throw refuse(409, "NO_DEAL_OWNER", "العميل بلا مسؤول؛ يربط المندوب أو المشرف الطلب بصفقة.", "The customer has no account owner; a rep or a supervisor links the order.");
      return { opportunityId: "", created: false, linked: false, replayed: false, gross: value.gross.toFixed(2), tax: value.tax.toFixed(2) };
    }
    const stage = await requireStageFor(tx, "QUOTATION");
    const now = new Date();
    const deal = await tx.opportunity.create({
      data: { title: directDealTitle(order.customer), customerId: order.customerId, stageId: stage.id, outcome: "WON", closedAt: now, amount: value.gross.toFixed(2), currency: "SAR", probability: 100, ownerId: owner },
      select: { id: true },
    });
    await tx.opportunityStageEvent.create({ data: { opportunityId: deal.id, toStageId: stage.id, fromOutcome: null, toOutcome: "WON", reason: DIRECT_ORDER_REASON, actorId: actor.id } });
    opportunityId = deal.id;
    created = true;
  }

  const prior = await tx.opportunityOrder.count({ where: { opportunityId } });
  await tx.opportunityOrder.create({
    data: { opportunityId, quoteId: null, orderId, isFirstOrder: prior === 0, requestKey: directOrderRequestKey(orderId), createdById: actor.id, directGross: value.gross.toFixed(2), directTax: value.tax.toFixed(2) },
  });
  // P1-4 / M2: a deal that also carries a quotation is valued quotation + direct orders (an auto deal keeps its own).
  if (!created) await syncDealAmount(tx, opportunityId);
  // Soon batch round 2 (gate L1): the deal's money is now shared with this order (oldest order first).
  await recomputeOrderFlags(tx, orderId);
  await appendOrderActivity(tx, {
    orderId, type: "DEAL_LINKED", authorId: actor.id, authorName: actor.name,
    message: created ? `فُتحت صفقة للطلب (${DIRECT_ORDER_REASON})` : "رُبط الطلب بصفقة",
    metadata: { opportunityId, created, mode: input.mode, gross: value.gross.toFixed(2), tax: value.tax.toFixed(2) },
  });
  await audit(tx, {
    action: created ? "DIRECT_ORDER_DEAL_CREATED" : "DIRECT_ORDER_DEAL_LINKED", entityType: "Order", entityId: orderId, actorId: actor.id,
    after: { opportunityId, orderNumber: order.orderNumber, created, mode: input.mode, owner, gross: value.gross.toFixed(2), tax: value.tax.toFixed(2) },
  });
  return { opportunityId, created, linked: true, replayed: false, gross: value.gross.toFixed(2), tax: value.tax.toFixed(2) };
}

/** Who may use «اربط بصفقة» on this order: its owner, a supervisor (lead_assign), or the admin role (with the sales view). */
export function mayLinkOrderDeal(actor: Actor, order: { ownerId: string | null }): boolean {
  if (order.ownerId && order.ownerId === actor.id) return true;
  return seesAllSales(actor.permissions);
}

// ── claims and the order's later life (gate H1 / M1) ─────────────────────────────────────────────────────────────

/**
 * What is already claimed against a deal's money: Sales collections on the deal, and the accountant's receipts on the
 * invoices of its (live) direct orders — APPROVED or PENDING_VERIFICATION, gross. The one ceiling both paths share.
 */
export async function dealClaims(tx: Tx, opportunityId: string): Promise<{ sales: Decimal; receipts: Decimal; total: Decimal }> {
  const orders = await tx.opportunityOrder.findMany({ where: { opportunityId, quoteId: null }, select: { orderId: true } });
  const [s, r] = await Promise.all([
    tx.salesCollection.aggregate({ where: { opportunityId, status: { in: ["APPROVED", "PENDING_VERIFICATION"] } }, _sum: { amountGross: true } }),
    orders.length
      ? tx.salesCollection.aggregate({ where: { source: "ACCOUNTANT", opportunityId: null, orderId: { in: orders.map((o) => o.orderId) }, status: { in: ["APPROVED", "PENDING_VERIFICATION"] } }, _sum: { amountGross: true } })
      : Promise.resolve({ _sum: { amountGross: null } }),
  ]);
  const sales = new Decimal((s._sum.amountGross ?? 0).toString());
  const receipts = new Decimal((r._sum.amountGross ?? 0).toString());
  return { sales, receipts, total: sales.plus(receipts) };
}

/** Was this deal opened for a direct order (its stage history carries «تلقائي: طلب مباشر»)? */
async function isAutoDeal(tx: Tx, opportunityId: string): Promise<boolean> {
  return (await tx.opportunityStageEvent.count({ where: { opportunityId, reason: DIRECT_ORDER_REASON } })) > 0;
}

/**
 * An order's value changed (lines edited), or the order ended (cancelled / rejected / deleted). Runs in the caller's
 * transaction, after the change is written.
 *   edit:   the link's snapshot is re-priced; refused (409, Arabic) when the deal's new collectable value would fall
 *           below what is already claimed on it — the order cannot be cut under money already received or recorded.
 *   end:    the order's value stops counting (eligibleDocument skips dead orders; a deleted order's link is removed).
 * Both are refused (Arabic 409) when the deal's claims would exceed its document after the change. Otherwise an auto
 * deal's amount follows its live direct orders, and one left with none (and so nothing claimed) is LOST «تلقائي: إلغاء
 * الطلب» (closed, a stage event, no automation event).
 */
export async function refreshDirectOrderDeal(tx: Tx, input: { orderId: string; actorId: string; change: "edit" | "end"; remove?: boolean }) {
  // D10 gate M2: a direct sale's invoice draft leaves the accountant's queue with its order (never issued for nothing).
  if (input.change === "end") {
    const voided = await voidDirectSaleDrafts(tx, { orderId: input.orderId, actorId: input.actorId, reason: "تلقائي: انلغى الطلب" });
    if (voided.length) await audit(tx, { action: "DIRECT_SALE_INVOICE_VOIDED", entityType: "Order", entityId: input.orderId, actorId: input.actorId, after: { invoiceIds: voided } });
  }
  const links = await tx.opportunityOrder.findMany({ where: { orderId: input.orderId, quoteId: null, directGross: { not: null } }, select: { id: true, opportunityId: true } });
  for (const link of links) {
    await tx.$queryRaw`SELECT "id" FROM "Opportunity" WHERE "id" = ${link.opportunityId} FOR UPDATE`;
    if (input.change === "edit") {
      const v = await orderValue(tx, input.orderId);
      await tx.opportunityOrder.update({ where: { id: link.id }, data: { directGross: v.gross.toFixed(2), directTax: v.tax.toFixed(2) } });
    } else if (input.remove) {
      await tx.opportunityOrder.delete({ where: { id: link.id } });
    }
    const live = await tx.opportunityOrder.findMany({
      where: { opportunityId: link.opportunityId, quoteId: null, directGross: { not: null }, order: { status: { notIn: [...DEAD_ORDER_STATUSES] } } },
      select: { directGross: true },
    });
    const liveGross = round2(live.reduce((t, r) => t.plus(new Decimal(r.directGross!.toString())), ZERO));
    const claims = await dealClaims(tx, link.opportunityId);
    const quote = await tx.quote.findFirst({ where: { opportunityId: link.opportunityId, status: "ACCEPTED" }, orderBy: { revision: "desc" }, select: { grandTotal: true } });
    const documentGross = liveGross.plus(quote ? new Decimal(quote.grandTotal.toString()) : ZERO);
    // One rule for every change (gate M1 / round 2 N1, N2): the deal's claims — Sales collections approved + pending, and
    // the accountant's receipts on its direct orders — may never exceed its document once this change is applied (the
    // edited value, or the document WITHOUT this order when it is cancelled / rejected / deleted). Refused in Arabic,
    // nothing written (the caller's transaction rolls back), so no commission can accrue on an order that is gone.
    if (claims.total.greaterThan(documentGross)) {
      if (input.change === "edit") {
        throw refuse(409, "BELOW_COLLECTED",
          `لا يمكن تقليل الطلب تحت ما سُجّل تحصيله على صفقته (${claims.total.toFixed(2)} ر.س). اعكس التحصيل أو أصدر إشعارًا دائنًا أولًا.`,
          `The order cannot be cut below what is already collected on its deal (${claims.total.toFixed(2)} SAR). Reverse the collection or issue a credit note first.`);
      }
      throw refuse(409, "ORDER_HAS_COLLECTIONS",
        `لا يمكن ${input.remove ? "حذف" : "إلغاء"} الطلب وعلى صفقته تحصيل مسجّل (${claims.total.toFixed(2)} ر.س) أكبر مما يبقى بدونه (${documentGross.toFixed(2)} ر.س) — ارفض التحصيل المعلّق أو اعكس المعتمد أولًا، أو أصدر إشعارًا دائنًا.`,
        `The order cannot be ${input.remove ? "deleted" : "cancelled"}: its deal carries ${claims.total.toFixed(2)} SAR of collections, more than the ${documentGross.toFixed(2)} SAR left without it. Reject the pending collection or reverse the approved one first, or issue a credit note.`);
    }
    if (!(await isAutoDeal(tx, link.opportunityId))) {
      await syncDealAmount(tx, link.opportunityId);
      // «بيع مباشر» D1: the order that WON this (until then OPEN) deal ended, and nothing else keeps it won → OPEN again.
      if (input.change === "end" && live.length === 0 && !quote) await reopenAfterDirectSale(tx, { opportunityId: link.opportunityId, orderId: input.orderId, actorId: input.actorId });
      continue;
    }
    const deal = await tx.opportunity.findUnique({ where: { id: link.opportunityId }, select: { outcome: true, stageId: true } });
    if (!deal) continue;
    // Past the rule above, claims ≤ the remaining document: the auto deal's amount is the remaining value; with no live
    // order left and nothing claimed it is LOST.
    if (live.length === 0 && !quote) {
      if (claims.total.isZero()) {
        if (deal.outcome !== "LOST") {
          await tx.opportunity.update({ where: { id: link.opportunityId }, data: { outcome: "LOST", closedAt: new Date(), lostReason: DIRECT_ORDER_CANCEL_REASON, amount: "0.00" } });
          await tx.opportunityStageEvent.create({ data: { opportunityId: link.opportunityId, fromStageId: deal.stageId, toStageId: deal.stageId, fromOutcome: deal.outcome, toOutcome: "LOST", reason: DIRECT_ORDER_CANCEL_REASON, actorId: input.actorId } });
        }
      } else {
        await tx.opportunity.update({ where: { id: link.opportunityId }, data: { amount: claims.total.toFixed(2) } });
      }
    } else {
      await tx.opportunity.update({ where: { id: link.opportunityId }, data: { amount: liveGross.toFixed(2) } });
    }
    await audit(tx, { action: "DIRECT_ORDER_DEAL_REFRESHED", entityType: "Order", entityId: input.orderId, actorId: input.actorId, after: { opportunityId: link.opportunityId, change: input.change, removed: !!input.remove, liveGross: liveGross.toFixed(2), claimed: claims.total.toFixed(2) } });
  }
}

export const DIRECT_SALE_REOPEN_REASON = "تلقائي: رجعت الصفقة مفتوحة — انلغى الطلب";

/**
 * D1 (orchestrator default within the owner's «يرجع تلقائي», 6 Nov 2026): a direct sale that WON a deal which was OPEN
 * before it puts the deal back — OPEN, its stage before the sale — once that order is cancelled, rejected or deleted, and
 * only when no other live order or accepted quotation keeps it won (the caller checked). The state before the sale is
 * read from the sale's own audit row (DIRECT_SALE_COMPLETED.after.priorDeal). A deal closed by hand since is left alone.
 */
async function reopenAfterDirectSale(tx: Tx, input: { opportunityId: string; orderId: string; actorId: string }) {
  const sale = await tx.hrAuditLog.findFirst({ where: { action: "DIRECT_SALE_COMPLETED", entityType: "Order", entityId: input.orderId }, orderBy: { createdAt: "desc" }, select: { after: true } });
  const prior = (sale?.after as { priorDeal?: { id?: string; outcome?: string; stageId?: string; amount?: string | null } | null } | null)?.priorDeal;
  if (!prior || prior.id !== input.opportunityId || prior.outcome !== "OPEN" || !prior.stageId) return;
  const deal = await tx.opportunity.findUnique({ where: { id: input.opportunityId }, select: { outcome: true, stageId: true } });
  if (!deal || deal.outcome !== "WON") return;
  const won = await tx.opportunityStageEvent.findFirst({ where: { opportunityId: input.opportunityId, toOutcome: "WON" }, orderBy: { createdAt: "desc" }, select: { reason: true } });
  if (won?.reason !== "تلقائي: بيع مباشر") return;
  const stage = await tx.pipelineStage.findUnique({ where: { id: prior.stageId }, select: { id: true, isActive: true } });
  const toStageId = stage?.isActive ? stage.id : deal.stageId;
  // Gate L2: the deal's amount before the sale comes back too (not the cancelled sale's).
  await tx.opportunity.update({ where: { id: input.opportunityId }, data: { outcome: "OPEN", closedAt: null, stageId: toStageId, ...(prior.amount != null ? { amount: prior.amount } : {}) } });
  await tx.opportunityStageEvent.create({ data: { opportunityId: input.opportunityId, fromStageId: deal.stageId, toStageId, fromOutcome: "WON", toOutcome: "OPEN", reason: DIRECT_SALE_REOPEN_REASON, actorId: input.actorId } });
  await appendOrderActivity(tx, { orderId: input.orderId, type: "DEAL_REOPENED", authorId: input.actorId, authorName: "النظام", message: DIRECT_SALE_REOPEN_REASON, metadata: { opportunityId: input.opportunityId, toStageId } });
  await audit(tx, { action: "DIRECT_SALE_DEAL_REOPENED", entityType: "Order", entityId: input.orderId, actorId: input.actorId, after: { opportunityId: input.opportunityId, toStageId } });
}

/** The accountant's receipts already on this order's invoices (APPROVED / PENDING), for the «اربط بصفقة» warning. */
export async function receiptsOnOrder(tx: Tx | Pick<Tx, "salesCollection">, orderId: string): Promise<string> {
  const r = await tx.salesCollection.aggregate({ where: { source: "ACCOUNTANT", opportunityId: null, orderId, status: { in: ["APPROVED", "PENDING_VERIFICATION"] } }, _sum: { amountGross: true } });
  return new Decimal((r._sum.amountGross ?? 0).toString()).toFixed(2);
}
