// P1 ERR-02 (owner, 12 Nov 2026): «كم على العميل؟» — ONE source for every screen and for the credit limit.
//
//   receivable          = issued invoices and debit notes (+ the opening balance) − receipts (approved collections) −
//                         credit notes. The accounting AR itself (invoicing/ar.ts arItems + ar-math agingOf), so it
//                         reconciles exactly with /api/accounting/ar/customers/[id] — never the accepted quotations.
//   approvedNotInvoiced = the customer's live orders (not cancelled / rejected; a direct sale waiting for — or refused —
//                         its discount approval counts at its REQUESTED value: gate R1 B2) × the quantity of each line not
//                         yet on an ISSUED invoice, at the line's agreed price (gate R1 M1). A completed order with an issued
//                         invoice is closed (0); orders from before the accounting go-live are already in the opening AR and
//                         are left out. Shown SEPARATELY: not a debt, counted in the limit.
//   commitment          = receivable + approvedNotInvoiced — what the credit limit is checked against.
//   acceptedQuotes      = accepted quotations not yet turned into an order — shown as «عروض مقبولة», NOT counted
//                         (owner decision 3).
//
// A line's agreed price (VAT included): its invoice line (draft or issued — the direct sale's own terms, the accountant's
// price), else the accepted quotation's line for the SKU, else the catalogue price less the order's requested discount.
// Samples are zero and add nothing.
import type { Prisma } from "@/generated/prisma/client";
import { Decimal, ZERO } from "@/lib/accounting/money";
import { riyadhDay, dayText } from "@/lib/accounting/dates";

type Db = Prisma.TransactionClient;
const D = (v: { toString(): string } | null | undefined) => new Decimal(v == null ? 0 : v.toString());
const r2 = (d: Decimal) => d.toDecimalPlaces(2);
const VAT = new Decimal("0.15");

/** Order states that are not (or no longer) a commitment. */
export const NOT_COMMITTED_STATUS = ["Cancelled", "Rejected"];

export type Exposure = {
  invoiced: Decimal; collected: Decimal; credited: Decimal;
  receivable: Decimal; overdue: Decimal; oldestOverdueDays: number;
  approvedNotInvoiced: Decimal; ordersNotInvoiced: { orderId: string; orderNumber: number; amount: Decimal }[];
  commitment: Decimal;
  acceptedQuotes: Decimal; acceptedQuoteCount: number;
  limit: Decimal | null; available: Decimal | null; usedPercent: number | null;
};

/** The exposure of each customer (customers that do not exist are absent). `exceptOrderId`: an order being completed now. */
export async function customerExposure(db: Db, customerIds: string[], now: Date = new Date(), opts: { exceptOrderId?: string | null } = {}): Promise<Map<string, Exposure>> {
  const out = new Map<string, Exposure>();
  if (!customerIds.length) return out;
  const { arItems } = await import("@/lib/services/invoicing/ar");
  const { agingOf } = await import("@/lib/services/invoicing/ar-math");
  const asOf = dayText(riyadhDay(now));
  const settings = await db.accountingSettings.findUnique({ where: { id: "singleton" }, select: { goLiveDate: true } });
  const [customers, ar, orders, quotes] = await Promise.all([
    db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, creditLimit: true } }),
    arItems(db, customerIds),
    db.order.findMany({
      where: {
        customerId: { in: customerIds }, status: { notIn: NOT_COMMITTED_STATUS },
        // Gate R1 M1: an order from before the go-live is in the opening AR already — never counted twice.
        ...(settings?.goLiveDate ? { createdAt: { gte: settings.goLiveDate } } : {}),
        ...(opts.exceptOrderId ? { id: { not: opts.exceptOrderId } } : {}),
      },
      select: ORDER_FOR_REMAINING,
    }),
    db.quote.findMany({
      where: { status: "ACCEPTED", OR: [{ customerId: { in: customerIds } }, { opportunity: { customerId: { in: customerIds } } }], orderLinks: { none: {} } },
      select: { grandTotal: true, customerId: true, opportunity: { select: { customerId: true } } },
    }),
  ]);
  const remaining = await ordersRemaining(db, orders as unknown as OrderForRemaining[]);
  for (const c of customers) {
    const b = ar.byCustomer.get(c.id) ?? { debits: [], credits: [], moves: [] };
    const aging = agingOf(b.debits, b.credits, asOf);
    const invoiced = b.debits.reduce((s, d) => s.plus(d.total), ZERO);
    const collected = b.credits.filter((x) => x.kind === "RECEIPT").reduce((s, x) => s.plus(x.amount), ZERO);
    const credited = b.credits.filter((x) => x.kind !== "RECEIPT").reduce((s, x) => s.plus(x.amount), ZERO);
    const ordersNotInvoiced: Exposure["ordersNotInvoiced"] = [];
    for (const o of orders.filter((x) => x.customerId === c.id)) {
      const amount = remaining.get(o.id) ?? ZERO;
      if (amount.greaterThan(0)) ordersNotInvoiced.push({ orderId: o.id, orderNumber: o.orderNumber, amount });
    }
    const approvedNotInvoiced = ordersNotInvoiced.reduce((s, o) => s.plus(o.amount), ZERO);
    const mine = quotes.filter((q) => (q.opportunity?.customerId ?? q.customerId) === c.id);
    const receivable = r2(aging.balance);
    const commitment = r2(receivable.plus(approvedNotInvoiced));
    const limit = c.creditLimit == null ? null : D(c.creditLimit);
    out.set(c.id, {
      invoiced: r2(invoiced), collected: r2(collected), credited: r2(credited),
      receivable, overdue: r2(aging.overdue), oldestOverdueDays: aging.oldestOverdueDays,
      approvedNotInvoiced: r2(approvedNotInvoiced), ordersNotInvoiced, commitment,
      acceptedQuotes: r2(mine.reduce((s, q) => s.plus(D(q.grandTotal)), ZERO)), acceptedQuoteCount: mine.length,
      limit, available: limit == null ? null : r2(limit.minus(commitment)),
      usedPercent: limit == null || limit.lessThanOrEqualTo(0) ? null : Math.round(commitment.dividedBy(limit).times(100).toNumber()),
    });
  }
  return out;
}

const ORDER_FOR_REMAINING = {
  id: true, orderNumber: true, customerId: true, status: true, channel: true, requestedDiscountPercent: true, discountApprovalStatus: true,
  opportunityLinks: { select: { quote: { select: { status: true, lines: { select: { productSkuId: true, unitPrice: true, discountPercent: true, taxRatePercent: true } } } } } },
  items: { select: { id: true, quantityUnits: true, quantityKg: true, productSkuId: true, productSku: { select: { price: true } } } },
} as const;
type OrderForRemaining = {
  id: string; status: string; channel: string | null; requestedDiscountPercent: { toString(): string } | null; discountApprovalStatus: string;
  opportunityLinks: { quote: { status: string; lines: { productSkuId: string | null; unitPrice: { toString(): string }; discountPercent: { toString(): string }; taxRatePercent: { toString(): string } }[] } | null }[];
  items: { id: string; quantityUnits: number | null; quantityKg: number; productSkuId: string | null; productSku: { price: number } | null }[];
};
const HUNDRED = new Decimal(100);

/**
 * What each order still commits, VAT included (gate R1 M1): Σ over its lines of (ordered − issued-invoice quantity) × the
 * line's agreed price — the invoice line's own price (draft or issued: a direct sale's terms, the accountant's price),
 * else the accepted quotation's line for the SKU, else the catalogue price less the order's requested discount (a direct
 * sale waiting for its approval counts at what it asks: gate R1 B2). A completed order with an issued invoice is closed
 * (0); an issued invoice of the order whose lines name no order line is taken off the remainder by value.
 */
export async function ordersRemaining(db: Db, orders: OrderForRemaining[]): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  if (!orders.length) return out;
  const itemIds = orders.flatMap((o) => o.items.map((i) => i.id));
  const [lines, unlinked, completions] = await Promise.all([
    itemIds.length ? db.salesInvoiceLine.findMany({
      where: { orderItemId: { in: itemIds }, invoice: { kind: "INVOICE", status: { in: ["DRAFT", "ISSUED"] } } },
      select: { orderItemId: true, quantity: true, lineTotal: true, invoice: { select: { status: true } } },
    }) : Promise.resolve([]),
    db.salesInvoice.findMany({
      where: { orderId: { in: orders.map((o) => o.id) }, kind: "INVOICE", status: "ISSUED" },
      select: { orderId: true, lines: { where: { orderItemId: null }, select: { lineTotal: true } } },
    }),
    // Gate R2 B3: the sale's OWN completion record (HrAuditLog DIRECT_SALE_COMPLETED — append-only, written by the server,
    // never by a client) names the collection the sale recorded and the discount it was completed at.
    db.hrAuditLog.findMany({
      where: { action: "DIRECT_SALE_COMPLETED", entityType: "Order", entityId: { in: orders.map((o) => o.id) } },
      orderBy: { createdAt: "asc" }, select: { entityId: true, after: true },
    }),
  ]);
  const completed = new Map(completions.map((r) => [r.entityId, (r.after ?? {}) as { collectionId?: string | null; discountPercent?: string | null }]));
  // Owner Q1 / gate R2 B3: ONLY the collection that sale recorded at «أرسل» (cash / card) and still waiting for the
  // accountant pays its order — never any other pending collection on the order or the deal (an approved receipt is in the
  // AR already and is not counted again).
  const saleCollections = [...completed.values()].map((a) => a.collectionId).filter((x): x is string => !!x);
  const pendingOwn = saleCollections.length
    ? await db.salesCollection.findMany({ where: { id: { in: saleCollections }, status: "PENDING_VERIFICATION", paymentMethod: { in: ["CASH", "POS_CARD"] } }, select: { id: true, orderId: true, amountGross: true } })
    : [];
  const { pricePendingSale } = await import("@/lib/services/sales/direct-sale");
  for (const o of orders) {
    const issuedHere = unlinked.filter((i) => i.orderId === o.id);
    if (o.status === "Completed" && issuedHere.length) { out.set(o.id, ZERO); continue; }
    // Gate R1 B2: a direct sale waiting for (or refused) its discount approval has no invoice yet — it counts at the value
    // it asks for (its own terms at the requested discount), exactly as it would complete.
    if ((o.discountApprovalStatus === "PENDING" || o.discountApprovalStatus === "REJECTED") && !lines.some((l) => o.items.some((i) => i.id === l.orderItemId))) {
      const priced = await pricePendingSale(db, o.id, D(o.requestedDiscountPercent) as never).catch(() => null);
      if (priced) { out.set(o.id, r2(D(priced.gross))); continue; }
    }
    const quoteLines = o.opportunityLinks.flatMap((l) => (l.quote && (l.quote.status === "ACCEPTED" || l.quote.status === "ISSUED") ? l.quote.lines : []));
    const disc = D(o.requestedDiscountPercent);
    // Gate R2 B4: a draft's price may only RAISE a line's value, never lower it — the floor is the accepted quotation's
    // line, else the catalogue price less the requested discount; only ISSUED quantities reduce the remainder.
    let rest = ZERO, draftValue = ZERO, issuedValue = ZERO;
    for (const it of o.items) {
      const ordered = new Decimal(it.quantityUnits != null ? String(it.quantityUnits) : it.quantityKg.toFixed(3));
      const mine = lines.filter((l) => l.orderItemId === it.id);
      const issuedLines = mine.filter((l) => l.invoice.status === "ISSUED");
      const issuedQty = issuedLines.reduce((s, l) => s.plus(D(l.quantity)), ZERO);
      issuedValue = issuedValue.plus(issuedLines.reduce((s, l) => s.plus(D(l.lineTotal)), ZERO));
      const q = mine.reduce((s, l) => s.plus(D(l.quantity)), ZERO);
      const draftUnit = q.greaterThan(0) ? mine.reduce((s, l) => s.plus(D(l.lineTotal)), ZERO).dividedBy(q) : null;
      const ql = it.productSkuId ? quoteLines.find((x) => x.productSkuId === it.productSkuId) : undefined;
      const base = ql
        ? D(ql.unitPrice).times(HUNDRED.minus(D(ql.discountPercent))).dividedBy(HUNDRED).times(HUNDRED.plus(D(ql.taxRatePercent))).dividedBy(HUNDRED)
        : it.quantityUnits != null && it.productSku && it.productSku.price > 0
          ? new Decimal(it.productSku.price.toFixed(2)).times(HUNDRED.minus(disc)).dividedBy(HUNDRED).times(VAT.plus(1))
          : ZERO;
      const unit = draftUnit && draftUnit.greaterThan(base) ? draftUnit : base;
      draftValue = draftValue.plus(ordered.times(draftUnit ?? base));
      const left = Decimal.max(ordered.minus(issuedQty), ZERO);
      rest = rest.plus(left.times(unit));
    }
    const unlinkedIssued = issuedHere.reduce((s, i) => s.plus(i.lines.reduce((t, l) => t.plus(D(l.lineTotal)), ZERO)), ZERO);
    const own = completed.get(o.id);
    const paid = pendingOwn.filter((c) => c.orderId === o.id && c.id === own?.collectionId).reduce((s, c) => s.plus(D(c.amountGross)), ZERO);
    if (o.channel === "DIRECT_SALE" && own) {
      // Gate R2 B4: a direct sale keeps its own terms (at the discount it was completed at) as the floor — a re-priced draft
      // may raise it, never lower it.
      const terms = await pricePendingSale(db, o.id, D(own.discountPercent ?? 0) as never).catch(() => null);
      const value = Decimal.max(terms ? D(terms.gross) : ZERO, draftValue);
      out.set(o.id, Decimal.max(r2(value.minus(issuedValue).minus(unlinkedIssued).minus(paid)), ZERO));
      continue;
    }
    out.set(o.id, Decimal.max(r2(rest.minus(unlinkedIssued).minus(paid)), ZERO));
  }
  return out;
}

/** One order's remaining commitment (the credit check of an order edit, a sale's approval or resubmit). */
export async function orderRemaining(db: Db, orderId: string): Promise<Decimal> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: ORDER_FOR_REMAINING });
  if (!o) return ZERO;
  return (await ordersRemaining(db, [o as unknown as OrderForRemaining])).get(orderId) ?? ZERO;
}

/** Lines at the catalogue price, VAT included (a back-office order; a line with no price adds nothing). */
export function linesValue(items: { quantityUnits: number | null; productSku: { price: number } | null }[]): Decimal {
  const net = items.reduce((s, i) => (i.quantityUnits && i.productSku && i.productSku.price > 0 ? s.plus(new Decimal(i.productSku.price.toFixed(2)).times(i.quantityUnits)) : s), ZERO);
  return r2(net.plus(r2(net.times(VAT))));
}

/** The JSON shape every screen reads (strings, two decimals). */
export function exposureJson(e: Exposure) {
  const f = (d: Decimal | null) => (d == null ? null : d.toFixed(2));
  return {
    invoiced: f(e.invoiced), collected: f(e.collected), credited: f(e.credited),
    receivable: f(e.receivable), overdue: f(e.overdue), oldestOverdueDays: e.oldestOverdueDays,
    approvedNotInvoiced: f(e.approvedNotInvoiced), ordersNotInvoiced: e.ordersNotInvoiced.map((o) => ({ orderId: o.orderId, orderNumber: o.orderNumber, amount: f(o.amount) })),
    commitment: f(e.commitment), acceptedQuotes: f(e.acceptedQuotes), acceptedQuoteCount: e.acceptedQuoteCount,
    limit: f(e.limit), available: f(e.available), usedPercent: e.usedPercent,
  };
}
export type ExposureJson = ReturnType<typeof exposureJson>;
