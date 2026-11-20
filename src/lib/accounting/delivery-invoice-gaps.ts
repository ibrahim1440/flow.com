// «مفوتر غير مسلّم / مسلّم غير مفوتر» — a READ-ONLY report of the quantities where the two events the books recognise
// separately have not both happened yet: revenue is posted when an invoice is ISSUED, the cost of sales when goods
// are DELIVERED. Per order line, as of a day:
//   delivered   the deliveries dated on or before the day (partial deliveries add up);
//   invoiced    the ISSUED invoices' lines of that order line issued on or before the day (partial invoices add up);
//   gap > 0     delivered, not invoiced: cost of sales is in the books with no revenue against it;
//   gap < 0     invoiced, not delivered: revenue is in the books with no cost of sales against it.
// A CREDIT NOTE NEVER CHANGES THE QUANTITIES. It is a document on the invoice: it reduces the AMOUNT of revenue in the
// books (shown as `creditedNet`), whatever its reason. A credit note whose reason is about quantities (goods returned,
// supply cancelled) is listed apart with its quantity and amount and the cost of sales still in the books for that
// quantity — because no goods-return document exists: nothing came back into stock and no cost was reversed. The
// report never says such a quantity is «to be invoiced again»: that is a decision, not a fact of the books.
// The amounts come from the documents themselves — the invoices' net for the undelivered share, the cost issued by
// the deliveries (the cost ledger) for the uninvoiced share — never from a price list.
// Only order lines with a delivery or an issued invoice ON OR AFTER the accounting go-live date are listed: before it
// nothing was posted, so an older delivery or invoice is not «in the books» on either side. Those lines are counted
// (`beforeGoLive`), not listed. A line that straddles the date is listed and flagged (`straddlesGoLive`): its amount
// covers only what was posted.
// It shows the size of the difference. It changes nothing and is not a correction of when revenue is recognised.
import { prisma } from "@/lib/db";
import { Decimal, ZERO } from "./money";
import { dayText } from "./dates";

const D = (v: unknown) => new Decimal(String(v ?? 0));
const TOLERANCE = new Decimal("0.0005");

export type GapRow = {
  orderId: string; orderNumber: number; orderItemId: string; customerId: string; customerName: string;
  item: string; skuCode: string | null; unit: "UNIT" | "KG";
  ordered: string; delivered: string; invoiced: string;
  /** The net amount of ISSUED credit notes on this line's invoices, any reason. It reduces the amount, never a quantity. */
  creditedNet: string;
  /** Quantities older than the accounting go-live date (not in the books), for a line with activity on both sides. */
  deliveredBefore: string; invoicedBefore: string;
  /** delivered − invoiced: > 0 delivered not invoiced, < 0 invoiced not delivered. */
  gap: string; side: "DELIVERED_NOT_INVOICED" | "INVOICED_NOT_DELIVERED";
  /** The amount of the side that IS in the books for the gap quantity: cost issued, or revenue net of VAT. */
  amount: string; lastDelivery: string | null; lastInvoice: string | null;
  /** Part of this line's deliveries or invoices is older than the accounting go-live date (not in the books). */
  straddlesGoLive: boolean;
  /** An invoice line of this order line in another unit than the order's: quantities are not comparable, no gap computed. */
  unitMismatch: boolean;
};

/** An issued credit note whose reason is about quantities, on a line of an order: its figures and what the books still hold. */
export type QuantityCredit = {
  orderId: string; orderNumber: number; orderItemId: string; customerId: string; customerName: string; item: string; skuCode: string | null; unit: "UNIT" | "KG";
  notes: string[]; creditedQty: string; creditedNet: string; invoiced: string; delivered: string;
  /** The cost of sales posted for the delivered part of the credited quantity: still in the books (nothing reverses it). */
  costStillInBooks: string;
};

export async function deliveryInvoiceGaps(asOf: Date) {
  const end = new Date(asOf.getTime() + 86_400_000); // deliveries carry a timestamp: the whole business day counts
  const settings = await prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true, goLiveDate: true } });
  const goLive = settings?.accountingActive && settings.goLiveDate ? settings.goLiveDate : null;
  let beforeGoLive = 0;
  const invLines = await prisma.salesInvoiceLine.findMany({
    where: { kind: "ITEM", invoice: { kind: "INVOICE", status: "ISSUED", issueDate: { lte: asOf } } },
    select: { id: true, orderItemId: true, quantity: true, unit: true, lineNet: true, invoice: { select: { issueDate: true } } },
  });
  const linked = invLines.filter((l) => l.orderItemId);
  const unlinked = invLines.filter((l) => !l.orderItemId);
  const credits = linked.length ? await prisma.salesInvoiceLine.findMany({
    where: { originalLineId: { in: linked.map((l) => l.id) }, invoice: { kind: "CREDIT_NOTE", status: "ISSUED", issueDate: { lte: asOf } } },
    select: { originalLineId: true, quantity: true, lineNet: true, invoice: { select: { number: true, reasonCode: true } } },
  }) : [];
  const deliveries = await prisma.delivery.findMany({ where: { date: { lt: end } }, select: { id: true, orderItemId: true, date: true, quantityKg: true, quantityUnits: true } });
  const itemIds = [...new Set([...linked.map((l) => l.orderItemId as string), ...deliveries.map((d) => d.orderItemId)])];
  const head = { asOf: dayText(asOf), goLive: goLive ? dayText(goLive) : null };
  if (!itemIds.length) return { ...head, rows: [] as GapRow[], totals: totalsOf([]), beforeGoLive, straddling: 0, quantityCredits: [] as QuantityCredit[], unlinkedInvoices: unlinkedOf(unlinked, goLive) };
  const items = await prisma.orderItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, beanTypeName: true, quantityKg: true, quantityUnits: true, productSku: { select: { skuCode: true, name: true, nameAr: true } }, order: { select: { id: true, orderNumber: true, customerId: true, customer: { select: { name: true, nameAr: true } } } } },
  });
  // The cost each delivery issued (the cost ledger's movements out of the finished lots for that delivery).
  const cost = await prisma.costMove.groupBy({ by: ["sourceId"], where: { sourceType: "DELIVERY", sourceEvent: "COGS", sourceId: { in: deliveries.map((d) => d.id) } }, _sum: { value: true } });
  const costOf = new Map(cost.map((c) => [c.sourceId, D(c._sum.value).negated()]));
  // Credit notes per original line: the amount (any reason), and apart the ones whose reason is about quantities.
  const QUANTITY_REASONS = ["RETURN", "CANCELLATION"];
  const creditOf = new Map<string, { net: Decimal; qty: Decimal; qtyNet: Decimal; numbers: Set<string> }>();
  for (const c of credits) {
    const cur = creditOf.get(c.originalLineId!) ?? { net: ZERO, qty: ZERO, qtyNet: ZERO, numbers: new Set<string>() };
    cur.net = cur.net.plus(D(c.lineNet));
    if (QUANTITY_REASONS.includes(c.invoice.reasonCode ?? "")) { cur.qty = cur.qty.plus(D(c.quantity)); cur.qtyNet = cur.qtyNet.plus(D(c.lineNet)); if (c.invoice.number) cur.numbers.add(c.invoice.number); }
    creditOf.set(c.originalLineId!, cur);
  }

  const rows: GapRow[] = [];
  const quantityCredits: QuantityCredit[] = [];
  for (const it of items) {
    const unit = it.quantityUnits != null ? "UNIT" as const : "KG" as const;
    const dels = deliveries.filter((d) => d.orderItemId === it.id);
    const lines = linked.filter((l) => l.orderItemId === it.id);
    const after = (d: Date | null) => !!d && (!goLive || d >= goLive);
    const anyAfter = dels.some((d) => after(d.date)) || lines.some((l) => after(l.invoice.issueDate));
    if (!anyAfter) { beforeGoLive++; continue; }
    const qtyOf = (d: { quantityUnits: number | null; quantityKg: number }) => (unit === "UNIT" ? D(d.quantityUnits ?? 0) : D(d.quantityKg.toFixed(3)));
    const delivered = dels.reduce((s, d) => s.plus(qtyOf(d)), ZERO);
    const deliveredBefore = dels.filter((d) => !after(d.date)).reduce((s, d) => s.plus(qtyOf(d)), ZERO);
    const deliveredCost = dels.reduce((s, d) => s.plus(costOf.get(d.id) ?? ZERO), ZERO);
    const unitMismatch = lines.some((l) => l.unit !== unit);
    let invoiced = ZERO, invoicedBefore = ZERO, net = ZERO, creditedNet = ZERO, creditedQty = ZERO, creditedQtyNet = ZERO;
    const notes = new Set<string>();
    for (const l of lines) {
      const c = creditOf.get(l.id);
      invoiced = invoiced.plus(D(l.quantity));
      if (!after(l.invoice.issueDate)) invoicedBefore = invoicedBefore.plus(D(l.quantity)); else net = net.plus(D(l.lineNet));
      creditedNet = creditedNet.plus(c?.net ?? ZERO); creditedQty = creditedQty.plus(c?.qty ?? ZERO); creditedQtyNet = creditedQtyNet.plus(c?.qtyNet ?? ZERO);
      c?.numbers.forEach((n) => notes.add(n));
    }
    const straddlesGoLive = deliveredBefore.gt(0) || invoicedBefore.gt(0);
    const ident = {
      orderId: it.order.id, orderNumber: it.order.orderNumber, orderItemId: it.id, customerId: it.order.customerId, customerName: it.order.customer?.nameAr || it.order.customer?.name || "",
      item: it.productSku ? (it.productSku.nameAr || it.productSku.name || it.productSku.skuCode) : it.beanTypeName, skuCode: it.productSku?.skuCode ?? null, unit,
    };
    if (creditedQty.gt(0) && !unitMismatch) {
      // What the books still hold for the credited quantity: the cost of sales of what was delivered of it.
      const share = delivered.gt(0) ? Decimal.min(creditedQty, delivered).dividedBy(delivered) : ZERO;
      quantityCredits.push({ ...ident, notes: [...notes].sort(), creditedQty: creditedQty.toString(), creditedNet: creditedQtyNet.toFixed(2), invoiced: invoiced.toString(), delivered: delivered.toString(), costStillInBooks: deliveredCost.times(share).toFixed(2) });
    }
    const gap = delivered.minus(invoiced);
    if (!unitMismatch && gap.abs().lte(TOLERANCE)) continue;
    const side = gap.gt(0) ? "DELIVERED_NOT_INVOICED" as const : "INVOICED_NOT_DELIVERED" as const;
    // The share of what is in the books that belongs to the gap quantity. Only posted deliveries carry a cost and only
    // invoices issued since go-live carry revenue, so on a line that straddles the date this covers the posted part.
    const postedInvoiced = invoiced.minus(invoicedBefore), postedDelivered = delivered.minus(deliveredBefore);
    const amount = unitMismatch ? ZERO
      : gap.gt(0) ? (postedDelivered.gt(0) ? deliveredCost.times(Decimal.min(gap, postedDelivered)).dividedBy(postedDelivered) : ZERO)
        : (postedInvoiced.gt(0) ? Decimal.max(net.minus(creditedNet), ZERO).times(Decimal.min(gap.abs(), postedInvoiced)).dividedBy(postedInvoiced) : ZERO);
    const last = (ds: (Date | null)[]) => { const t = ds.filter((x): x is Date => !!x).map((x) => x.getTime()); return t.length ? dayText(new Date(Math.max(...t))) : null; };
    rows.push({
      ...ident,
      ordered: (unit === "UNIT" ? D(it.quantityUnits) : D(it.quantityKg.toFixed(3))).toString(), delivered: delivered.toString(), invoiced: invoiced.toString(), creditedNet: creditedNet.toFixed(2),
      deliveredBefore: deliveredBefore.toString(), invoicedBefore: invoicedBefore.toString(),
      gap: unitMismatch ? "0" : gap.toString(), side, amount: amount.toFixed(2), lastDelivery: last(dels.map((d) => d.date)), lastInvoice: last(lines.map((l) => l.invoice.issueDate)), straddlesGoLive, unitMismatch,
    });
  }
  quantityCredits.sort((a, b) => a.orderNumber - b.orderNumber);
  rows.sort((a, b) => a.side.localeCompare(b.side) || a.orderNumber - b.orderNumber);
  return { ...head, rows, totals: totalsOf(rows), beforeGoLive, straddling: rows.filter((r) => r.straddlesGoLive).length, quantityCredits, unlinkedInvoices: unlinkedOf(unlinked, goLive) };
}

function totalsOf(rows: GapRow[]) {
  const sum = (side: GapRow["side"]) => rows.filter((r) => r.side === side && !r.unitMismatch).reduce((s, r) => s.plus(D(r.amount)), ZERO).toFixed(2);
  return {
    deliveredNotInvoiced: { lines: rows.filter((r) => r.side === "DELIVERED_NOT_INVOICED" && !r.unitMismatch).length, costInBooks: sum("DELIVERED_NOT_INVOICED") },
    invoicedNotDelivered: { lines: rows.filter((r) => r.side === "INVOICED_NOT_DELIVERED" && !r.unitMismatch).length, revenueInBooks: sum("INVOICED_NOT_DELIVERED") },
    unitMismatch: rows.filter((r) => r.unitMismatch).length,
  };
}

/** Issued invoice lines that name no order line: they cannot be matched to a delivery, so they are counted, not judged. */
function unlinkedOf(all: { lineNet: unknown; invoice: { issueDate: Date | null } }[], goLive: Date | null) {
  const lines = all.filter((l) => !goLive || (!!l.invoice.issueDate && l.invoice.issueDate >= goLive));
  return { lines: lines.length, net: lines.reduce((s, l) => s.plus(D(l.lineNet)), ZERO).toFixed(2) };
}
