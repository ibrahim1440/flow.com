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
  /** `name` is the line's name (English where the catalogue has one); `nameAr` its Arabic name, when known. */
  items: { quantityKg: number; name: string; nameAr?: string | null }[];
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
 * The MEDIAN gap, in whole days, between consecutive business orders of the last 365 days — next to the mean of
 * `orderRhythm` (which it does not change). One emergency order in between halves a gap and drags the mean; the median
 * keeps the customer's usual rhythm. Same minimum as the mean: three orders (two gaps), else null. Used by «يومي» for
 * «متوقع يطلب خلال 7 أيام» (services/sales/my-day).
 */
export function medianGapDays(orders: OrderRow[], now: Date): number | null {
  const since = now.getTime() - 365 * DAY;
  const t = orders
    .filter((o) => isBusinessOrder(o.status) && o.createdAt.getTime() >= since)
    .map((o) => o.createdAt.getTime())
    .sort((a, b) => a - b);
  if (t.length < 3) return null;
  const gaps = t.slice(1).map((x, i) => (x - t[i]) / DAY).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const m = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.max(1, Math.round(m));
}

/**
 * «الأصناف المعتادة»: what the customer usually takes, in kilograms per month.
 * Σ quantityKg per item name over the business orders of the last 180 days, divided by six
 * (months), rounded to a whole kilogram; the top five by quantity. The item name is the SKU's
 * name, else the coffee product's, else the line's own bean name — the label the order shows.
 */
/**
 * THE monthly kilograms of a customer (batch 24 council fix round 1, P0-9): kg ordered in the last 90 days ÷ 3. One
 * figure everywhere — the customer page's facts row, the tier («يومي», the tier pill, Ctrl K) and «يومي»'s lists.
 */
export const MONTHLY_KG_WINDOW_DAYS = 90;
export function kgPerMonthOf(kg90: number): number {
  return Math.round(((Number.isFinite(kg90) ? kg90 : 0) / 3) * 10) / 10;
}
export function monthlyKg(orders: OrderRow[], now: Date): number {
  const since = now.getTime() - MONTHLY_KG_WINDOW_DAYS * DAY;
  let kg = 0;
  for (const o of orders) {
    const t = o.createdAt.getTime();
    if (!isBusinessOrder(o.status) || t < since || t > now.getTime()) continue;
    for (const i of o.items) if (Number.isFinite(i.quantityKg)) kg += i.quantityKg;
  }
  return kgPerMonthOf(kg);
}

export const USUAL_ITEMS_WINDOW_DAYS = 180;
export function usualItems(orders: OrderRow[], now: Date, limit = 5): { name: string; nameAr: string | null; kgPerMonth: number }[] {
  const since = now.getTime() - USUAL_ITEMS_WINDOW_DAYS * DAY;
  const sums = new Map<string, { kg: number; nameAr: string | null }>();
  for (const o of orders) {
    if (!isBusinessOrder(o.status) || o.createdAt.getTime() < since) continue;
    for (const i of o.items) {
      const name = i.name.trim();
      if (!name || !Number.isFinite(i.quantityKg)) continue;
      const cur = sums.get(name) ?? { kg: 0, nameAr: i.nameAr?.trim() || null };
      cur.kg += i.quantityKg;
      sums.set(name, cur);
    }
  }
  return [...sums.entries()]
    .map(([name, v]) => ({ name, nameAr: v.nameAr, kgPerMonth: Math.round(v.kg / (USUAL_ITEMS_WINDOW_DAYS / 30)) }))
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

// ─── Statement of account and aging (customer file, feat/customer-file) ────────────────────
//
// A STATEMENT DERIVED FROM SALES RECORDS — NOT AN ACCOUNTING LEDGER. Accounting and ZATCA are
// deferred by the owner, so nothing here posts, stores or invents an entry: a line is either a
// deal's accepted quotation (what the customer agreed to pay, VAT included — the same document
// «الرصيد المستحق» counts) or a collection Finance APPROVED against one of those deals. The
// closing figure therefore agrees with `outstandingBalance` by construction (see `unapplied`).

export type StatementDocument = {
  opportunityId: string;
  dealTitle: string;
  quoteId: string;
  quoteNumber: string;
  revision: number;
  /** When the customer accepted it (falls back to the caller's choice of date when absent). */
  at: Date;
  grandTotal: Decimal;
  /**
   * The first delivery of an order made from this quotation, if any: payment terms run from
   * when the goods left, and from acceptance when nothing has been delivered yet.
   */
  firstDeliveryAt: Date | null;
};
export type StatementPayment = {
  id: string;
  opportunityId: string;
  at: Date;
  amountGross: Decimal;
  method: string;
  orderNumber: number | null;
  reference: string | null;
};
export type StatementLine =
  | { kind: "document"; key: string; at: Date; quoteId: string; quoteNumber: string; revision: number; opportunityId: string; dealTitle: string; debit: Decimal; credit: Decimal; balance: Decimal }
  | { kind: "payment"; key: string; at: Date; paymentId: string; method: string; orderNumber: number | null; reference: string | null; opportunityId: string; dealTitle: string; debit: Decimal; credit: Decimal; balance: Decimal };

export const AGING_BUCKETS = ["notDue", "d1_30", "d31_60", "d61_90", "d90plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Whole Riyadh calendar days from `from` to `to` (negative when `to` is earlier). */
export function riyadhDayDiff(from: Date, to: Date): number {
  const day = (d: Date) => Math.floor((d.getTime() + RIYADH_OFFSET) / DAY);
  return day(to) - day(from);
}

/** The bucket of an unpaid amount `daysOverdue` days past its due date (≤ 0 → not due yet). */
export function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "notDue";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d90plus";
}

/**
 * «كشف الحساب» and «أعمار الديون».
 *
 * Lines: every document and approved payment of the deals in scope, oldest first (a document
 * before a payment at the same instant), with a running balance = Σ debit − Σ credit.
 *
 * Open documents and aging: per deal, unpaid = its document − its approved payments, as
 * `outstandingBalance` (never below zero for a deal: an overpayment on one deal does not pay
 * another's). The unpaid amount is due `termsDays` (the customer's payment terms; none → 0) after
 * the first delivery of an order made from the document, or after acceptance when nothing has
 * been delivered, and is aged in Riyadh calendar days past that date.
 *
 * Totals: debit, credit, net (= the last running balance), outstanding (= Σ unpaid, the figure
 * «الرصيد المستحق» shows) and unapplied (= outstanding − net ≥ 0: approved money beyond a deal's
 * document, shown as a credit rather than silently netted against another deal).
 */
export function statementOfAccount(
  docs: StatementDocument[],
  payments: StatementPayment[],
  opts: { termsDays: number | null; now: Date },
): {
  lines: StatementLine[];
  totals: { debit: Decimal; credit: Decimal; net: Decimal; outstanding: Decimal; unapplied: Decimal };
  open: { opportunityId: string; dealTitle: string; quoteId: string; quoteNumber: string; total: Decimal; paid: Decimal; unpaid: Decimal; dueAt: Date; basis: "delivery" | "acceptance"; daysOverdue: number; bucket: AgingBucket }[];
  aging: Record<AgingBucket, Decimal> & { total: Decimal };
} {
  const title = new Map(docs.map((d) => [d.opportunityId, d.dealTitle]));
  const docDeals = new Set(docs.map((d) => d.opportunityId));
  // A payment counts only against a deal that has a document in scope (as outstandingBalance).
  const pays = payments.filter((p) => docDeals.has(p.opportunityId));
  type Raw = { at: Date; order: number; key: string; debit: Decimal; credit: Decimal; make: (bal: Decimal) => StatementLine };
  const raw: Raw[] = [
    ...docs.map((d): Raw => ({
      at: d.at, order: 0, key: `q-${d.quoteId}`, debit: roundMoney(d.grandTotal), credit: ZERO,
      make: (balance) => ({ kind: "document", key: `q-${d.quoteId}`, at: d.at, quoteId: d.quoteId, quoteNumber: d.quoteNumber, revision: d.revision, opportunityId: d.opportunityId, dealTitle: d.dealTitle, debit: roundMoney(d.grandTotal), credit: ZERO, balance }),
    })),
    ...pays.map((p): Raw => ({
      at: p.at, order: 1, key: `c-${p.id}`, debit: ZERO, credit: roundMoney(p.amountGross),
      make: (balance) => ({ kind: "payment", key: `c-${p.id}`, at: p.at, paymentId: p.id, method: p.method, orderNumber: p.orderNumber, reference: p.reference, opportunityId: p.opportunityId, dealTitle: title.get(p.opportunityId) ?? "", debit: ZERO, credit: roundMoney(p.amountGross), balance }),
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.order - b.order || a.key.localeCompare(b.key));
  let bal = ZERO, debit = ZERO, credit = ZERO;
  const lines = raw.map((r) => {
    debit = debit.plus(r.debit);
    credit = credit.plus(r.credit);
    bal = roundMoney(bal.plus(r.debit).minus(r.credit));
    return r.make(bal);
  });

  const paid = new Map<string, Decimal>();
  for (const p of pays) paid.set(p.opportunityId, (paid.get(p.opportunityId) ?? ZERO).plus(p.amountGross));
  const terms = Math.max(0, opts.termsDays ?? 0);
  const aging = Object.fromEntries(AGING_BUCKETS.map((b) => [b, ZERO])) as Record<AgingBucket, Decimal>;
  const open = [];
  let outstanding = ZERO;
  for (const d of docs) {
    const p = roundMoney(paid.get(d.opportunityId) ?? ZERO);
    const unpaid = roundMoney(d.grandTotal.minus(p));
    if (!unpaid.greaterThan(0)) continue;
    const basisAt = d.firstDeliveryAt ?? d.at;
    const dueAt = new Date(basisAt.getTime() + terms * DAY);
    const daysOverdue = riyadhDayDiff(dueAt, opts.now);
    const bucket = agingBucket(daysOverdue);
    aging[bucket] = aging[bucket].plus(unpaid);
    outstanding = outstanding.plus(unpaid);
    open.push({ opportunityId: d.opportunityId, dealTitle: d.dealTitle, quoteId: d.quoteId, quoteNumber: d.quoteNumber, total: roundMoney(d.grandTotal), paid: p, unpaid, dueAt, basis: d.firstDeliveryAt ? "delivery" as const : "acceptance" as const, daysOverdue, bucket });
  }
  open.sort((a, b) => b.daysOverdue - a.daysOverdue || a.quoteNumber.localeCompare(b.quoteNumber));
  outstanding = roundMoney(outstanding);
  const net = roundMoney(debit.minus(credit));
  for (const b of AGING_BUCKETS) aging[b] = roundMoney(aging[b]);
  return {
    lines,
    totals: { debit: roundMoney(debit), credit: roundMoney(credit), net, outstanding, unapplied: roundMoney(outstanding.minus(net)) },
    open,
    aging: { ...aging, total: outstanding },
  };
}

/**
 * The credit limit against what is owed. Displayed and warned about — never enforced: there is
 * no owner rule that refuses a quotation or an order over the limit (CRM.md backend
 * dependencies: "a field and enforcement rules"; only the field was decided).
 *   used       — the outstanding balance (`outstandingBalance`, VAT included);
 *   available  — limit − used, never below zero;
 *   percent    — used / limit, whole percent (null without a positive limit);
 *   over       — used is above the limit.
 */
export function creditPosition(limit: Decimal | null, used: Decimal): {
  limit: Decimal; used: Decimal; available: Decimal; percent: number | null; over: boolean;
} | null {
  if (limit == null) return null;
  const available = limit.minus(used);
  return {
    limit: roundMoney(limit),
    used: roundMoney(used),
    available: available.greaterThan(0) ? roundMoney(available) : ZERO,
    percent: limit.greaterThan(0) ? Math.round(used.dividedBy(limit).times(100).toNumber()) : null,
    over: used.greaterThan(limit),
  };
}
