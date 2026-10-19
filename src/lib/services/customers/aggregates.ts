// Customer account figures — pure functions over rows the caller has already read and scoped.
//
// No database and no HTTP here, so every definition below can be asserted directly
// (tests/sales/unit/customer-account.test.ts). The route (/api/customers/[id]/account) decides
// WHICH rows the caller may see; this file only decides what a figure means. Every figure is
// computed from records that already exist — orders, accepted quotations and finance-approved
// collections. Nothing is estimated and nothing is stored.
//
// ── What the system does NOT have (checked against the schema, not assumed) ──
// There is no invoice and no accounts-receivable model (schema.prisma, CollectionEvent and
// SalesCollection notes), and an order carries no price: OrderItem has quantities only. So:
//   * money comes from the ACCEPTED quotation of a deal — the document the customer agreed to
//     and the one a collection is recorded against (services/sales/collections.ts
//     `eligibleDocument`): one per deal, the newest accepted revision;
//   * money received comes from SalesCollection rows Finance APPROVED (the only state that is
//     money everyone agrees arrived; pending is a claim, reversed is undone);
//   * quantities and dates come from orders.

import { Decimal, ZERO, roundMoney } from "../commissions/engine";

export { Decimal };

const DAY = 86_400_000;
const RIYADH_OFFSET = 3 * 3_600_000;

/**
 * Orders that never became business. A cancelled or rejected order is not a purchase: it is
 * left out of «آخر طلب», the order rhythm, the monthly quantity and the usual items. (It is
 * still listed in the orders tab, with its status.)
 */
export const NON_BUSINESS_ORDER_STATUSES = ["Cancelled", "Rejected"] as const;
export const isBusinessOrder = (status: string) =>
  !(NON_BUSINESS_ORDER_STATUSES as readonly string[]).includes(status);

export type OrderRow = {
  id: string;
  orderNumber: number;
  createdAt: Date;
  status: string;
  items: { quantityKg: number; name: string }[];
};

/** "YYYY-MM" of the Riyadh month containing `at`. */
export function riyadhMonthKey(at: Date): string {
  const r = new Date(at.getTime() + RIYADH_OFFSET);
  return `${r.getUTCFullYear()}-${String(r.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The twelve COMPLETE Riyadh months before the month of `now`, oldest first — the current month
 * is still running, and a bar for half a month next to eleven whole ones reads as a drop.
 */
export function lastTwelveMonths(now: Date): string[] {
  const r = new Date(now.getTime() + RIYADH_OFFSET);
  const out: string[] = [];
  for (let i = 12; i >= 1; i--) {
    const d = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * «الكمية الشهرية»: kilograms ordered per Riyadh calendar month — the twelve complete months
 * before the current one, then (last element) the current month so far, flagged `partial`.
 * Σ OrderItem.quantityKg of the business orders created in that month, by order date.
 * quantityKg is what every downstream report reads; for SKU lines it is units × pack weight.
 */
export function monthlyQuantities(orders: OrderRow[], now: Date): { month: string; kg: number; partial?: true }[] {
  const months = [...lastTwelveMonths(now), riyadhMonthKey(now)];
  const sums = new Map(months.map((m) => [m, 0]));
  for (const o of orders) {
    if (!isBusinessOrder(o.status)) continue;
    const key = riyadhMonthKey(o.createdAt);
    if (!sums.has(key)) continue;
    sums.set(key, sums.get(key)! + o.items.reduce((s, i) => s + (Number.isFinite(i.quantityKg) ? i.quantityKg : 0), 0));
  }
  return months.map((m, i) => (i === 12 ? { month: m, kg: round1(sums.get(m)!), partial: true as const } : { month: m, kg: round1(sums.get(m)!) }));
}

/**
 * «آخر طلب» and the order rhythm.
 *   lastOrder     — the newest business order and how many whole days ago it was placed;
 *   cadenceDays   — the average gap, in days, between consecutive business orders placed in
 *                   the last 365 days, rounded. Needs at least three such orders (two gaps):
 *                   one gap is a coincidence, not a rhythm. Otherwise null («غير كافٍ»).
 */
export function orderRhythm(orders: OrderRow[], now: Date): {
  lastOrder: { id: string; orderNumber: number; createdAt: Date; daysAgo: number } | null;
  cadenceDays: number | null;
  ordersLast12Months: number;
} {
  const business = orders.filter((o) => isBusinessOrder(o.status)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const last = business[0] ?? null;
  const since = now.getTime() - 365 * DAY;
  const recent = business.filter((o) => o.createdAt.getTime() >= since);
  let cadenceDays: number | null = null;
  if (recent.length >= 3) {
    const span = recent[0].createdAt.getTime() - recent[recent.length - 1].createdAt.getTime();
    cadenceDays = Math.round(span / (recent.length - 1) / DAY);
  }
  return {
    lastOrder: last
      ? { id: last.id, orderNumber: last.orderNumber, createdAt: last.createdAt, daysAgo: Math.max(0, Math.floor((now.getTime() - last.createdAt.getTime()) / DAY)) }
      : null,
    cadenceDays,
    ordersLast12Months: recent.length,
  };
}

/**
 * «الأصناف المعتادة»: what the customer usually takes, in kilograms per month.
 * Σ quantityKg per item name over the business orders of the last 180 days, divided by six
 * (months), rounded to a whole kilogram; the top five by quantity. The item name is the SKU's
 * name, else the coffee product's, else the line's own bean name — the label the order shows.
 */
export const USUAL_ITEMS_WINDOW_DAYS = 180;
export function usualItems(orders: OrderRow[], now: Date, limit = 5): { name: string; kgPerMonth: number }[] {
  const since = now.getTime() - USUAL_ITEMS_WINDOW_DAYS * DAY;
  const sums = new Map<string, number>();
  for (const o of orders) {
    if (!isBusinessOrder(o.status) || o.createdAt.getTime() < since) continue;
    for (const i of o.items) {
      const name = i.name.trim();
      if (!name || !Number.isFinite(i.quantityKg)) continue;
      sums.set(name, (sums.get(name) ?? 0) + i.quantityKg);
    }
  }
  return [...sums.entries()]
    .map(([name, kg]) => ({ name, kgPerMonth: Math.round(kg / (USUAL_ITEMS_WINDOW_DAYS / 30)) }))
    .filter((x) => x.kgPerMonth > 0)
    .sort((a, b) => b.kgPerMonth - a.kgPerMonth || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** A deal's accepted quotation — the newest accepted revision (one per deal by construction). */
export type AcceptedDocument = {
  opportunityId: string;
  quoteId: string;
  quoteNumber: string;
  acceptedAt: Date | null;
  grandTotal: Decimal;
  taxTotal: Decimal;
};

/** One accepted document per deal: the highest revision, as `eligibleDocument` chooses it. */
export function acceptedDocumentPerDeal<T extends { opportunityId: string; revision: number }>(quotes: T[]): T[] {
  const best = new Map<string, T>();
  for (const q of quotes) {
    const cur = best.get(q.opportunityId);
    if (!cur || q.revision > cur.revision) best.set(q.opportunityId, q);
  }
  return [...best.values()];
}

/**
 * «مبيعات 12 شهرًا»: the value, EXCLUDING VAT, of the quotations this customer accepted in
 * the last 365 days — Σ (grandTotal − taxTotal) of each deal's accepted quotation whose
 * acceptedAt falls in the window. The comparison is the same sum over the 365 days before
 * that; changePercent is null when that earlier sum is zero (no base to compare with).
 *
 * Why accepted quotations: an order carries no price in this system and there is no invoice,
 * so the accepted quotation is the only priced commitment of the customer. Orders placed
 * without a quotation (the order screen's own path) have no value anywhere and are NOT in this
 * figure; the screen says so.
 */
export function salesLast12Months(docs: AcceptedDocument[], now: Date): {
  net: Decimal; previousNet: Decimal; changePercent: number | null; documents: number;
} {
  const end = now.getTime();
  const start = end - 365 * DAY;
  const prevStart = start - 365 * DAY;
  let net = ZERO, prev = ZERO, n = 0;
  for (const d of docs) {
    if (!d.acceptedAt) continue;
    const t = d.acceptedAt.getTime();
    const value = d.grandTotal.minus(d.taxTotal);
    if (t > start && t <= end) { net = net.plus(value); n++; }
    else if (t > prevStart && t <= start) prev = prev.plus(value);
  }
  net = roundMoney(net);
  prev = roundMoney(prev);
  const changePercent = prev.greaterThan(0) ? Math.round(net.minus(prev).dividedBy(prev).times(100).toNumber()) : null;
  return { net, previousNet: prev, changePercent, documents: n };
}

/**
 * «الرصيد المستحق»: what the customer still owes against what it agreed to.
 * For each deal with an accepted quotation: its grand total (VAT included — the amount the
 * customer pays) less the APPROVED collections recorded against that deal, never below zero
 * for a deal (an overpayment on one deal does not pay another's). Summed over the deals.
 * Exactly the per-deal `unpaidGross` of services/sales/collections.ts `collectionSummary`,
 * added up across the customer's deals — the same definition the deal page shows.
 * Pending collections are a claim, not a payment, and do not reduce it.
 */
export function outstandingBalance(
  docs: { opportunityId: string; grandTotal: Decimal }[],
  approved: { opportunityId: string; amountGross: Decimal }[],
): { outstanding: Decimal; documents: number; openDocuments: number } {
  const paid = new Map<string, Decimal>();
  for (const c of approved) paid.set(c.opportunityId, (paid.get(c.opportunityId) ?? ZERO).plus(c.amountGross));
  let total = ZERO, open = 0;
  for (const d of docs) {
    const unpaid = roundMoney(d.grandTotal.minus(paid.get(d.opportunityId) ?? ZERO));
    if (unpaid.greaterThan(0)) { total = total.plus(unpaid); open++; }
  }
  return { outstanding: roundMoney(total), documents: docs.length, openDocuments: open };
}
