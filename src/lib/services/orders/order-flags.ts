// Readiness review P1-5: the order's legacy flags «الفاتورة» (vatInvoiceStatus) and «الدفع» (paymentStatus) now follow
// the real events instead of staying «لم تصدر / غير مدفوع» forever. One recompute, called after an invoice or a credit
// note of the order is issued, a collection / receipt touching it is approved or reversed, a direct order joins a deal,
// and the order is cancelled or rejected; the migration 20261220090000_soon_batch backfills every order with the same
// rule (in SQL).
//
//   vatInvoiceStatus  "Sent"    an ISSUED tax invoice of the order (SalesInvoice.orderId) whose value is not fully
//                               cancelled by ISSUED credit notes;   else "Not Yet".
//   paymentStatus     · an INVOICED order: what its invoices are worth (less credit notes) against the receipts and
//                       collections APPLIED to them (ArApplication with a collection);
//                     · an order NOT invoiced, on a deal (gate L1, soon batch round 2) — what it is worth:
//                         a direct order («طلب مباشر»)  its link's directGross;
//                         a quotation-born order        its share of the accepted quotation's grand total (gate L7,
//                                                       round 3): an order stores no price and its kilograms can be
//                                                       edited, so an «order total» is not a reliable figure; the
//                                                       quotation total is spread across its live orders OLDEST FIRST,
//                                                       each capped by its value at the quotation's own prices (its
//                                                       kg × the quotation's gross price per kg of that SKU; an order
//                                                       holding a SKU the quotation does not price is not capped).
//                                                       What is not yet ordered sits on no order. An order left with
//                                                       nothing due (the quotation already spread) shows the
//                                                       quotation's own payment state;
//                       against: the receipts recorded for this order alone (accountant, no deal) + its share of the
//                       deal's APPROVED collections not applied to an invoice, ALLOCATED OLDEST ORDER FIRST across the
//                       deal's live uninvoiced orders. A Sales collection is recorded against the deal (it carries the
//                       deal's first order only for the branch), so the deal's money is spread, never counted twice:
//                       two direct orders of 230.00 with 460.00 collected are both «Paid»; with 300.00, the older is
//                       «Paid» and the newer «Partial Paid».
//                     · an order with no deal and no invoice: its own approved receipts against nothing due.
//                     "Paid" when all of it is paid, "Partial Paid" when some, "Not Paid" otherwise.
import type { Prisma } from "@/generated/prisma/client";

type Tx = Prisma.TransactionClient;
const cents = (v: { toString(): string } | null | undefined) => Math.round(Number(v?.toString() ?? 0) * 100);
const DEAD = ["Cancelled", "Rejected"];

export type OrderFlags = { vatInvoiceStatus: "Sent" | "Not Yet"; paymentStatus: "Paid" | "Partial Paid" | "Not Paid" };

/** Pure: the two flags from the figures (in halalas). */
export function flagsFrom(f: { invoiced: number; invoiceCount: number; due: number; paid: number }): OrderFlags {
  const vatInvoiceStatus = f.invoiceCount > 0 && f.invoiced > 0 ? "Sent" : "Not Yet";
  const paymentStatus = f.due > 0 && f.paid >= f.due ? "Paid" : f.paid > 0 ? "Partial Paid" : "Not Paid";
  return { vatInvoiceStatus, paymentStatus };
}

/**
 * Pure: the deal's unapplied money allocated oldest order first. `orders` are the deal's live uninvoiced orders in
 * creation order, each with what it is worth and what was received for it alone; returns what each is paid.
 */
export function allocateDealMoney(pool: number, orders: { due: number; own: number }[]): number[] {
  let left = Math.max(pool, 0);
  return orders.map((o) => {
    const need = Math.max(o.due - o.own, 0);
    const take = Math.min(need, left);
    left -= take;
    return o.own + take;
  });
}

/**
 * Pure (gate L7): a quotation's total spread across its orders oldest first, each capped by its value at the
 * quotation's prices (null = not priceable, no cap). Returns each order's share; what is left sits on no order.
 */
export function splitQuoteTotal(total: number, caps: (number | null)[]): number[] {
  let left = Math.max(total, 0);
  return caps.map((cap) => {
    const take = Math.min(cap === null ? left : Math.max(cap, 0), left);
    left -= take;
    return take;
  });
}

/** Pure: an order's value at a quotation's prices (halalas), or null when one of its SKUs is not on the quotation. */
export function orderValueAtQuote(items: { productSkuId: string | null; quantityKg: number }[], pricePerKg: Map<string, number>): number | null {
  let v = 0;
  for (const it of items) {
    const p = it.productSkuId ? pricePerKg.get(it.productSkuId) : undefined;
    if (p === undefined) return null;
    v += it.quantityKg * p;
  }
  return Math.round(v);
}

type InvoiceFigures = { ids: string[]; invoiced: number };
async function invoiceFigures(tx: Tx, orderId: string): Promise<InvoiceFigures> {
  const invoices = await tx.salesInvoice.findMany({ where: { orderId, kind: "INVOICE", status: "ISSUED" }, select: { id: true, grandTotal: true } });
  const ids = invoices.map((i) => i.id);
  const notes = ids.length ? await tx.salesInvoice.findMany({ where: { originalInvoiceId: { in: ids }, kind: "CREDIT_NOTE", status: "ISSUED" }, select: { grandTotal: true } }) : [];
  return { ids, invoiced: invoices.reduce((t, i) => t + cents(i.grandTotal), 0) - notes.reduce((t, n) => t + cents(n.grandTotal), 0) };
}
async function invoicedFlags(tx: Tx, f: InvoiceFigures): Promise<OrderFlags> {
  const applied = await tx.arApplication.aggregate({ where: { invoiceId: { in: f.ids }, status: "APPLIED", collectionId: { not: null } }, _sum: { amount: true } });
  return flagsFrom({ invoiced: f.invoiced, invoiceCount: f.ids.length, due: Math.max(f.invoiced, 0), paid: cents(applied._sum.amount) });
}
/** Receipts recorded for this order alone (the accountant's, with no deal). */
async function ownMoney(tx: Tx, orderId: string): Promise<number> {
  const got = await tx.salesCollection.aggregate({ where: { orderId, opportunityId: null, status: "APPROVED" }, _sum: { amountGross: true } });
  return cents(got._sum.amountGross);
}
async function write(tx: Tx, orderId: string, flags: OrderFlags) {
  await tx.order.update({ where: { id: orderId }, data: flags });
}

/** Every order of a deal, allocated together (the deal's money is shared). Returns orderId → flags. */
export async function recomputeDealOrderFlags(tx: Tx, opportunityId: string | null | undefined): Promise<Map<string, OrderFlags>> {
  const out = new Map<string, OrderFlags>();
  if (!opportunityId) return out;
  const links = await tx.opportunityOrder.findMany({
    where: { opportunityId },
    select: { orderId: true, quoteId: true, directGross: true, quote: { select: { status: true, grandTotal: true } }, order: { select: { status: true, createdAt: true } } },
  });
  links.sort((a, b) => a.order.createdAt.getTime() - b.order.createdAt.getTime() || a.orderId.localeCompare(b.orderId));
  // The deal's money not already applied to an invoice.
  const approved = await tx.salesCollection.findMany({ where: { opportunityId, status: "APPROVED" }, select: { id: true, amountGross: true } });
  const appliedOf = approved.length
    ? await tx.arApplication.aggregate({ where: { collectionId: { in: approved.map((c) => c.id) }, status: "APPLIED" }, _sum: { amount: true } })
    : null;
  const pool = approved.reduce((t, c) => t + cents(c.amountGross), 0) - cents(appliedOf?._sum.amount);

  // Gate L7: each quotation's total spread over its live orders oldest first, capped by their value at its prices.
  const quoteIds = [...new Set(links.filter((l) => l.quoteId && l.quote?.status === "ACCEPTED").map((l) => l.quoteId!))];
  const shareOf = new Map<string, number>();   // orderId → its share of its quotation
  const quoteOfOrder = new Map<string, string>();
  for (const qid of quoteIds) {
    const lines = await tx.quoteLine.findMany({ where: { quoteId: qid }, select: { productSkuId: true, quantity: true, lineTotal: true, productSku: { select: { weightGrams: true } } } });
    const kg = new Map<string, number>(), gross = new Map<string, number>();
    for (const l of lines) {
      if (!l.productSkuId || !l.productSku?.weightGrams) continue;
      kg.set(l.productSkuId, (kg.get(l.productSkuId) ?? 0) + Number(l.quantity) * l.productSku.weightGrams / 1000);
      gross.set(l.productSkuId, (gross.get(l.productSkuId) ?? 0) + cents(l.lineTotal));
    }
    const ppk = new Map<string, number>();
    for (const [sku, k] of kg) if (k > 0) ppk.set(sku, (gross.get(sku) ?? 0) / k);
    const live = links.filter((l) => l.quoteId === qid && !DEAD.includes(l.order.status));
    const caps: (number | null)[] = [];
    for (const l of live) {
      const items = await tx.orderItem.findMany({ where: { orderId: l.orderId }, select: { productSkuId: true, quantityKg: true } });
      caps.push(items.length ? orderValueAtQuote(items, ppk) : null);
    }
    const total = cents(links.find((l) => l.quoteId === qid)!.quote!.grandTotal);
    splitQuoteTotal(total, caps).forEach((share, i) => { shareOf.set(live[i].orderId, share); quoteOfOrder.set(live[i].orderId, qid); });
  }

  const pending: { orderId: string; due: number; own: number }[] = [];
  for (const l of links) {
    if (out.has(l.orderId) || pending.some((p) => p.orderId === l.orderId)) continue;
    const inv = await invoiceFigures(tx, l.orderId);
    if (inv.ids.length) { const f = await invoicedFlags(tx, inv); out.set(l.orderId, f); await write(tx, l.orderId, f); continue; }
    const own = await ownMoney(tx, l.orderId);
    if (DEAD.includes(l.order.status)) {
      const f = flagsFrom({ invoiced: 0, invoiceCount: 0, due: 0, paid: own });
      out.set(l.orderId, f); await write(tx, l.orderId, f); continue;
    }
    const due = l.directGross !== null ? cents(l.directGross) : (shareOf.get(l.orderId) ?? 0);
    pending.push({ orderId: l.orderId, due, own });
  }
  const paid = allocateDealMoney(pool, pending);
  // An order of a quotation with nothing left to carry reads the quotation's own state (its orders' paid vs due).
  const quoteState = new Map<string, { due: number; paid: number }>();
  pending.forEach((p, i) => {
    const qid = quoteOfOrder.get(p.orderId);
    if (!qid) return;
    const st = quoteState.get(qid) ?? { due: 0, paid: 0 };
    st.due += p.due; st.paid += paid[i]; quoteState.set(qid, st);
  });
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const qid = quoteOfOrder.get(p.orderId);
    const f = p.due === 0 && qid && quoteState.get(qid)!.due > 0
      ? flagsFrom({ invoiced: 0, invoiceCount: 0, due: quoteState.get(qid)!.due, paid: quoteState.get(qid)!.paid })
      : flagsFrom({ invoiced: 0, invoiceCount: 0, due: p.due, paid: paid[i] });
    out.set(p.orderId, f);
    await write(tx, p.orderId, f);
  }
  return out;
}

export async function recomputeOrderFlags(tx: Tx, orderId: string | null | undefined): Promise<OrderFlags | null> {
  if (!orderId) return null;
  const link = await tx.opportunityOrder.findFirst({ where: { orderId }, select: { opportunityId: true } });
  if (link) return (await recomputeDealOrderFlags(tx, link.opportunityId)).get(orderId) ?? null;
  const inv = await invoiceFigures(tx, orderId);
  const flags = inv.ids.length ? await invoicedFlags(tx, inv) : flagsFrom({ invoiced: 0, invoiceCount: 0, due: 0, paid: await ownMoney(tx, orderId) });
  await write(tx, orderId, flags);
  return flags;
}

/** After a collection / receipt is approved or reversed: the orders it touches — its own, its deal's, and those of the invoices it was applied to. */
export async function recomputeFlagsForCollection(tx: Tx, collectionId: string): Promise<void> {
  const c = await tx.salesCollection.findUnique({ where: { id: collectionId }, select: { orderId: true, invoiceId: true, opportunityId: true } });
  const apps = await tx.arApplication.findMany({ where: { collectionId }, select: { invoice: { select: { orderId: true } } } });
  const inv = c?.invoiceId ? await tx.salesInvoice.findUnique({ where: { id: c.invoiceId }, select: { orderId: true } }) : null;
  const done = new Set<string>();
  if (c?.opportunityId) for (const id of (await recomputeDealOrderFlags(tx, c.opportunityId)).keys()) done.add(id);
  const orders = new Set([c?.orderId, inv?.orderId, ...apps.map((a) => a.invoice.orderId)].filter((x): x is string => !!x && !done.has(x)));
  for (const o of orders) await recomputeOrderFlags(tx, o);
}

/** After an invoice or a credit note is issued: its order (a note's order is its original invoice's) — and its deal's. */
export async function recomputeFlagsForInvoice(tx: Tx, invoiceId: string): Promise<void> {
  const i = await tx.salesInvoice.findUnique({ where: { id: invoiceId }, select: { orderId: true, originalInvoice: { select: { orderId: true } } } });
  await recomputeOrderFlags(tx, i?.orderId ?? i?.originalInvoice?.orderId ?? null);
}
