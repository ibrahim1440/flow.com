// Decision 6 (owner, 7 Nov 2026): an ACCOUNTANT receipt («سند قبض» recorded by the accountant) that pays an invoice of a
// rep's DEAL counts as the rep's collection — in the commission engine, the my-day bar, the targets screen and the
// reports, which all read ONE source: CollectionEvent (status RECORDED). So the receipt gets commission events of its own.
//
// One event per (receipt, deal) for the part of the receipt APPLIED to that deal's invoices — the deal of an invoice is
// the deal of its order (OpportunityOrder), else of its quotation. VAT is the invoice's own share (taxTotal ÷ grandTotal).
// Parts paying the opening balance, staying an advance, or paying an invoice with no deal create no event.
//
// syncAccountantReceiptEvents brings the receipt's events in line with its applications, idempotently, wherever they
// change: at its approval, when G2 applies it at an invoice's issue, on a manual application or un-application, and on
// its reversal. An unchanged part changes nothing (a replay creates nothing); a changed or vanished part REVERSES its
// event (the engine's recomputation posts the negative difference) and, if money is still applied, a fresh event carries
// the new amount (externalRef `${collectionId}:${dealId}`, then `:2`, `:3` … for later ones — the unique
// (sourceSystem, externalRef) index is the last guard against a duplicate). SalesCollection.collectionEventId stays NULL
// for an accountant receipt (CHECK SalesCollection_event_matches_status); the externalRef is the link.
// A Sales receipt is never touched here: it already has its own event from its approval.
import { Prisma } from "@/generated/prisma/client";
import { accrueForCollection } from "@/lib/services/commissions/accrual";

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;
const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** The commission source of every collection event (sales/collections.ts COLLECTION_SOURCE). */
const SOURCE = "MANUAL_FINANCE_VERIFICATION";

export type EventChange = { dealId: string; action: "created" | "reversed"; eventId: string; amountGross: string };

export async function syncAccountantReceiptEvents(tx: Tx, collectionId: string, actorId: string | null): Promise<EventChange[]> {
  const c = await tx.salesCollection.findUnique({ where: { id: collectionId }, select: { id: true, source: true, status: true, customerId: true, collectedAt: true, currency: true } });
  if (!c || c.source !== "ACCOUNTANT") return [];

  // What the receipt pays per deal now (nothing once it is not APPROVED).
  const want = new Map<string, { gross: Decimal; tax: Decimal; orderId: string | null }>();
  if (c.status === "APPROVED") {
    const apps = await tx.arApplication.findMany({
      where: { collectionId, status: "APPLIED" },
      select: { amount: true, invoice: { select: { orderId: true, quoteId: true, grandTotal: true, taxTotal: true } } },
    });
    const orderIds = [...new Set(apps.map((a) => a.invoice.orderId).filter((x): x is string => !!x))];
    const quoteIds = [...new Set(apps.map((a) => a.invoice.quoteId).filter((x): x is string => !!x))];
    const [links, quotes] = await Promise.all([
      orderIds.length ? tx.opportunityOrder.findMany({ where: { orderId: { in: orderIds } }, orderBy: { createdAt: "asc" }, select: { orderId: true, opportunityId: true } }) : [],
      quoteIds.length ? tx.quote.findMany({ where: { id: { in: quoteIds } }, select: { id: true, opportunityId: true } }) : [],
    ]);
    const dealOfOrder = new Map<string, string>();
    for (const l of links) if (!dealOfOrder.has(l.orderId)) dealOfOrder.set(l.orderId, l.opportunityId);
    for (const a of apps) {
      const deal = (a.invoice.orderId && dealOfOrder.get(a.invoice.orderId)) || (a.invoice.quoteId && quotes.find((q) => q.id === a.invoice.quoteId)?.opportunityId) || null;
      if (!deal) continue;
      const amount = new Decimal(a.amount.toString());
      const grand = new Decimal(a.invoice.grandTotal.toString());
      const tax = grand.isZero() ? new Decimal(0) : amount.times(new Decimal(a.invoice.taxTotal.toString())).dividedBy(grand);
      const w = want.get(deal) ?? { gross: new Decimal(0), tax: new Decimal(0), orderId: a.invoice.orderId };
      want.set(deal, { gross: w.gross.plus(amount), tax: w.tax.plus(tax), orderId: w.orderId ?? a.invoice.orderId });
    }
  }

  // Gate H2 — never twice for the same money: a deal's accountant event is capped at what the deal's issued documents
  // still leave uncollected — Σ its issued invoices / debit notes − its issued credit notes (VAT included, as the events
  // are), less every OTHER live collection event on the deal (its Sales receipts' and other accountant receipts').
  for (const [deal, w] of want) {
    const [dealOrders, dealQuotes] = await Promise.all([
      tx.opportunityOrder.findMany({ where: { opportunityId: deal }, select: { orderId: true } }),
      tx.quote.findMany({ where: { opportunityId: deal }, select: { id: true } }),
    ]);
    const invoices = await tx.salesInvoice.findMany({
      where: { status: "ISSUED", kind: { in: ["INVOICE", "DEBIT_NOTE"] }, OR: [{ orderId: { in: dealOrders.map((o) => o.orderId) } }, { quoteId: { in: dealQuotes.map((q) => q.id) } }] },
      select: { id: true, kind: true, grandTotal: true },
    });
    const notes = invoices.length ? await tx.salesInvoice.findMany({ where: { status: "ISSUED", kind: "CREDIT_NOTE", originalInvoiceId: { in: invoices.map((x) => x.id) } }, select: { kind: true, grandTotal: true } }) : [];
    const docs = [...invoices, ...notes];
    const document = docs.reduce((t, d) => (d.kind === "CREDIT_NOTE" ? t.minus(d.grandTotal.toString()) : t.plus(d.grandTotal.toString())), new Decimal(0));
    const others = await tx.collectionEvent.aggregate({
      where: { opportunityId: deal, status: "RECORDED", NOT: { externalRef: { startsWith: `${collectionId}:` } } },
      _sum: { amountGross: true },
    });
    const room = Decimal.max(document.minus(new Decimal((others._sum.amountGross ?? 0).toString())), new Decimal(0));
    if (w.gross.greaterThan(room)) {
      const ratio = w.gross.isZero() ? new Decimal(0) : room.dividedBy(w.gross);
      want.set(deal, { gross: room, tax: w.tax.times(ratio), orderId: w.orderId });
    }
  }

  const existing = await tx.collectionEvent.findMany({
    where: { sourceSystem: SOURCE, externalRef: { startsWith: `${collectionId}:` } },
    orderBy: { externalRef: "asc" },
    select: { id: true, externalRef: true, status: true, opportunityId: true, amountGross: true },
  });
  const changes: EventChange[] = [];
  const deals = new Set([...want.keys(), ...existing.filter((e) => e.status === "RECORDED").map((e) => e.opportunityId!).filter(Boolean)]);
  // Deal order, so two syncs touching the same deals take the event / period locks in one order.
  for (const deal of [...deals].sort()) {
    const live = existing.filter((e) => e.opportunityId === deal && e.status === "RECORDED");
    const w = want.get(deal);
    const gross = w ? r2(w.gross) : null;
    if (gross && live.length === 1 && new Decimal(live[0].amountGross.toString()).equals(gross)) continue; // unchanged
    for (const e of live) {
      await tx.collectionEvent.update({ where: { id: e.id }, data: { status: "REVERSED", reversedAt: new Date() } });
      await accrueForCollection(tx, e.id, actorId);
      changes.push({ dealId: deal, action: "reversed", eventId: e.id, amountGross: new Decimal(e.amountGross.toString()).toFixed(2) });
    }
    if (!w || !gross || !gross.greaterThan(0)) continue;
    const prior = existing.filter((e) => e.opportunityId === deal).length;
    const created = await tx.collectionEvent.create({
      data: {
        sourceSystem: SOURCE, externalRef: prior === 0 ? `${collectionId}:${deal}` : `${collectionId}:${deal}:${prior + 1}`, status: "RECORDED",
        customerId: c.customerId, opportunityId: deal, orderId: w.orderId, amountGross: gross.toFixed(2), amountTax: r2(w.tax).toFixed(2), amountNonQualifying: "0",
        currency: c.currency, collectedAt: c.collectedAt, note: "سند قبض المحاسب على فاتورة صفقة مندوب",
      },
      select: { id: true },
    });
    await accrueForCollection(tx, created.id, actorId);
    changes.push({ dealId: deal, action: "created", eventId: created.id, amountGross: gross.toFixed(2) });
  }
  return changes;
}

/**
 * Gate M1: a deal's Sales receipt was approved or reversed — the accountant receipts paying that deal's invoices are
 * re-synced in the same transaction, so a capped event grows back when the Sales money goes (and never doubles when new
 * Sales money arrives). Lock order: the deal (the caller holds its receipt), then the receipts by id.
 */
export async function resyncDealAccountantReceipts(tx: Tx, opportunityId: string | null, actorId: string | null): Promise<EventChange[]> {
  if (!opportunityId) return [];
  const [orders, quotes] = await Promise.all([
    tx.opportunityOrder.findMany({ where: { opportunityId }, select: { orderId: true } }),
    tx.quote.findMany({ where: { opportunityId }, select: { id: true } }),
  ]);
  if (!orders.length && !quotes.length) return [];
  const receipts = await tx.arApplication.findMany({
    where: {
      status: "APPLIED", collection: { source: "ACCOUNTANT" },
      invoice: { OR: [{ orderId: { in: orders.map((o) => o.orderId) } }, { quoteId: { in: quotes.map((q) => q.id) } }] },
    },
    distinct: ["collectionId"], select: { collectionId: true },
  });
  // Also those with a live event on the deal but nothing applied any more (their event must go).
  const withEvents = await tx.collectionEvent.findMany({ where: { sourceSystem: SOURCE, opportunityId, status: "RECORDED", externalRef: { contains: ":" } }, select: { externalRef: true } });
  const ids = new Set<string>([...receipts.map((r) => r.collectionId!).filter(Boolean), ...withEvents.map((e) => e.externalRef.split(":")[0])]);
  const out: EventChange[] = [];
  for (const id of [...ids].sort()) out.push(...(await syncAccountantReceiptEvents(tx, id, actorId)));
  return out;
}
